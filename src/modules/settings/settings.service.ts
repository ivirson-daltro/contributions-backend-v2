import { Injectable, NotFoundException } from "@nestjs/common";
import { Kysely, sql } from "kysely";
import { AuditService } from "../../common/audit/audit.service";
import { Database, TenantTransactions } from "../../common/database/database.module";
import { TenantSettingsDto, TenantUpdateDto } from "../tenant/tenant.dto";

export interface TenantInfo { name: string; document: string | null; timezone: string }
export interface Preferences {
  weekStartsOn: number;
  allowFutureDates: boolean;
  payableWindowDays: number;
  payableAlertDays: number;
  attachmentMaxMb: number;
  attachmentMaxFiles: number;
  requireMfaRoles: string[];
  cascadeReopen: boolean;
}

@Injectable()
export class SettingsService {
  constructor(private readonly transactions: TenantTransactions, private readonly audit: AuditService) {}

  getTenant(tenantId: string, userId: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, (trx) => this.findTenant(trx, tenantId));
  }

  updateTenant(tenantId: string, userId: string, body: TenantUpdateDto) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const before = await this.findTenant(trx, tenantId, true);
      await sql`
        update tenants set name = ${body.name ?? before.name},
          document = ${body.document !== undefined ? body.document : before.document},
          timezone = 'America/Sao_Paulo'
         where id = ${tenantId}::uuid
      `.execute(trx);
      const after = await this.findTenant(trx, tenantId);
      await this.audit.record(trx, { action: "TENANT_UPDATED", entity: "tenant", entityId: tenantId, before, after });
      return after;
    });
  }

  getPreferences(tenantId: string, userId: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, (trx) => this.findPreferences(trx, tenantId));
  }

  updatePreferences(tenantId: string, userId: string, body: TenantSettingsDto) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const before = await this.findPreferences(trx, tenantId, true);
      await sql`
        update tenant_settings set
          week_starts_on = ${body.weekStartsOn ?? before.weekStartsOn},
          allow_future_dates = ${body.allowFutureDates ?? before.allowFutureDates},
          payable_window_days = ${body.payableWindowDays ?? before.payableWindowDays},
          payable_alert_days = ${body.payableAlertDays ?? before.payableAlertDays},
          attachment_max_mb = ${body.attachmentMaxMb ?? before.attachmentMaxMb},
          attachment_max_files = ${body.attachmentMaxFiles ?? before.attachmentMaxFiles},
          require_mfa_roles = ${body.requireMfaRoles ?? before.requireMfaRoles}::text[],
          cascade_reopen = ${body.cascadeReopen ?? before.cascadeReopen}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(trx);
      const after = await this.findPreferences(trx, tenantId);
      await this.audit.record(trx, { action: "TENANT_SETTINGS_UPDATED", entity: "tenant_settings", entityId: tenantId, before, after });
      return after;
    });
  }

  private async findTenant(trx: Kysely<Database>, tenantId: string, lock = false): Promise<TenantInfo> {
    const result = await sql<TenantInfo>`
      select name, document, timezone from tenants where id = ${tenantId}::uuid ${lock ? sql`for update` : sql``}
    `.execute(trx);
    if (!result.rows[0]) throw new NotFoundException({ code: "NOT_FOUND" });
    return result.rows[0];
  }

  private async findPreferences(trx: Kysely<Database>, tenantId: string, lock = false): Promise<Preferences> {
    const result = await sql<{ item: Preferences }>`
      select jsonb_build_object(
        'weekStartsOn', week_starts_on, 'allowFutureDates', allow_future_dates,
        'payableWindowDays', payable_window_days, 'payableAlertDays', payable_alert_days,
        'attachmentMaxMb', attachment_max_mb, 'attachmentMaxFiles', attachment_max_files,
        'requireMfaRoles', require_mfa_roles, 'cascadeReopen', cascade_reopen
      ) as item from tenant_settings where tenant_id = ${tenantId}::uuid ${lock ? sql`for update` : sql``}
    `.execute(trx);
    if (!result.rows[0]) throw new NotFoundException({ code: "NOT_FOUND" });
    return result.rows[0].item;
  }
}
