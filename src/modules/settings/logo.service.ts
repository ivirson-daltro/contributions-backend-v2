import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
// sharp uses export = and this project does not enable esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import sharp = require("sharp");
import { AuditService } from "../../common/audit/audit.service";
import { TenantTransactions } from "../../common/database/database.module";
import { environment } from "../../config/env";

interface LogoFile {
  buffer: Buffer;
  size: number;
  mimetype: string;
}

export enum LogoTheme {
  Light = "LIGHT",
  Dark = "DARK",
}

@Injectable()
export class LogoService {
  private readonly logger = new Logger(LogoService.name);
  private readonly storage = createClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).storage.from("tenant-logos");

  constructor(private readonly transactions: TenantTransactions, private readonly audit: AuditService) {}

  async get(tenantId: string, userId: string, theme: LogoTheme = LogoTheme.Light, fallback = true) {
    const logo = await this.find(tenantId, userId, theme, fallback);
    if (!logo) throw new NotFoundException({ code: "LOGO_NOT_FOUND" });
    return logo;
  }

  async getForReport(tenantId: string, userId: string): Promise<string | null> {
    const logo = await this.find(tenantId, userId, LogoTheme.Light, false);
    if (!logo) return null;
    if (logo.contentType !== "image/webp") {
      return `data:${logo.contentType};base64,${logo.data.toString("base64")}`;
    }
    try {
      const png = await sharp(logo.data).png().toBuffer();
      return `data:image/png;base64,${png.toString("base64")}`;
    } catch (error) {
      this.logger.error(`Falha ao converter logo do tenant ${tenantId}`, error instanceof Error ? error.stack : undefined);
      throw new InternalServerErrorException({ code: "LOGO_PROCESSING_ERROR" });
    }
  }

  private async find(tenantId: string, userId: string, theme: LogoTheme, fallback: boolean) {
    const row = await this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const result = await sql<{ object_key: string; content_type: string }>`
        select object_key, content_type from tenant_logos
        where tenant_id = ${tenantId}::uuid and theme = ${theme}
      `.execute(trx);
      if (result.rows[0]) return result.rows[0];
      if (theme === LogoTheme.Dark && fallback) {
        const fallback = await sql<{ object_key: string; content_type: string }>`
          select object_key, content_type from tenant_logos
          where tenant_id = ${tenantId}::uuid and theme = 'LIGHT'
        `.execute(trx);
        return fallback.rows[0];
      }
      return undefined;
    });
    if (!row) return null;
    const { data, error } = await this.storage.download(row.object_key);
    if (error || !data) {
      this.logger.error(`Falha ao carregar logo do tenant ${tenantId}: ${error?.message ?? "objeto ausente"}`);
      throw new InternalServerErrorException({ code: "LOGO_STORAGE_ERROR" });
    }
    return { contentType: row.content_type, data: Buffer.from(await data.arrayBuffer()) };
  }

  async upload(tenantId: string, userId: string, theme: LogoTheme, file?: LogoFile) {
    if (!file || file.size < 1 || file.size > 2_097_152 || !this.validImage(file)) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", detail: "Envie uma imagem PNG, JPEG ou WebP de até 2 MB." });
    }
    const key = `${tenantId}/${randomUUID()}`;
    let uploaded = false;
    let previous: string | undefined;
    try {
      await this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext('tenant-logo'), hashtext(${tenantId}))`.execute(trx);
        const existing = await sql<{ object_key: string }>`
          select object_key from tenant_logos where tenant_id = ${tenantId}::uuid and theme = ${theme}
        `.execute(trx);
        previous = existing.rows[0]?.object_key;
        const { error } = await this.storage.upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
        if (error) {
          this.logger.error(`Falha ao salvar logo do tenant ${tenantId}: ${error.message}`);
          throw new InternalServerErrorException({ code: "LOGO_STORAGE_ERROR" });
        }
        uploaded = true;
        await sql`
          insert into tenant_logos (tenant_id, theme, object_key, content_type)
          values (${tenantId}::uuid, ${theme}, ${key}, ${file.mimetype})
          on conflict (tenant_id, theme) do update set object_key = excluded.object_key, content_type = excluded.content_type
        `.execute(trx);
        await this.audit.record(trx, { action: "TENANT_LOGO_UPDATED", entity: "tenant", entityId: tenantId, after: { theme } });
      });
    } catch (error) {
      if (uploaded) await this.removeObject(key);
      throw error;
    }
    if (previous) await this.removeObject(previous);
    return { updated: true };
  }

  private validImage(file: LogoFile): boolean {
    const bytes = file.buffer;
    return (file.mimetype === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (file.mimetype === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || (file.mimetype === "image/webp" && bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
  }

  private async removeObject(key: string) {
    const { error } = await this.storage.remove([key]);
    if (error) this.logger.warn(`Não foi possível limpar imagem substituída: ${error.message}`);
  }
}
