import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Kysely, sql } from "kysely";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { Database, TenantTransactions } from "../../common/database/database.module";
import { CatalogDto, FeeRulesDto } from "./catalogs.dto";

type CatalogKind = "member-types" | "contribution-types" | "payment-methods" | "expense-categories";
const catalogTables: Record<CatalogKind, string> = {
  "member-types": "member_types", "contribution-types": "contribution_types",
  "payment-methods": "payment_methods", "expense-categories": "expense_categories",
};

export interface CatalogItem {
  id: string;
  description: string;
  active: boolean;
  category?: string;
  kind?: string;
  requiresMember?: boolean;
  countsForFees?: boolean;
  countsAsContributor?: boolean;
  usageCount: number;
}

@Injectable()
export class CatalogsService {
  constructor(private readonly transactions: TenantTransactions, private readonly audit: AuditService) {}

  list(tenantId: string, userId: string, kind: string) {
    const catalog = this.catalog(kind);
    return this.transactions.withTenantTx({ tenantId, userId }, (trx) => this.findItems(trx, tenantId, catalog));
  }

  create(tenantId: string, userId: string, kind: string, body: CatalogDto) {
    const catalog = this.catalog(kind);
    this.validate(catalog, body, true);
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const extraColumns = catalog === "contribution-types"
        ? sql`, category, requires_member, counts_for_fees, counts_as_contributor`
        : catalog === "payment-methods" ? sql`, kind` : sql``;
      const extraValues = catalog === "contribution-types"
        ? sql`, ${body.category}, ${body.requiresMember ?? true}, ${body.countsForFees ?? false}, ${body.countsAsContributor ?? false}`
        : catalog === "payment-methods" ? sql`, ${body.kind}` : sql``;
      const result = await sql<{ id: string }>`
        insert into ${sql.table(catalogTables[catalog])} (tenant_id, description, active ${extraColumns})
        values (${tenantId}::uuid, ${body.description}, ${body.active ?? true} ${extraValues}) returning id
      `.execute(trx);
      const id = result.rows[0].id;
      await this.audit.record(trx, { action: "CATALOG_CREATED", entity: catalogTables[catalog], entityId: id });
      return this.findItem(trx, tenantId, catalog, id);
    });
  }

  update(tenantId: string, userId: string, kind: string, id: string, body: CatalogDto, confirm: boolean) {
    const catalog = this.catalog(kind);
    this.validate(catalog, body, false);
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      await this.lockItem(trx, tenantId, catalog, id);
      const before = await this.findItem(trx, tenantId, catalog, id);
      const classificationChanged = (["category", "kind", "requiresMember", "countsForFees", "countsAsContributor"] as const)
        .some((key) => body[key] !== undefined && body[key] !== before[key]);
      if (before.usageCount > 0 && classificationChanged && !confirm) {
        throw new ConflictException({ code: "CONFIRMATION_REQUIRED", detail: "O item já foi usado. Confirme a alteração de classificação." });
      }
      const extra = catalog === "contribution-types"
        ? sql`, category = ${body.category ?? before.category}, requires_member = ${body.requiresMember ?? before.requiresMember},
               counts_for_fees = ${body.countsForFees ?? before.countsForFees},
               counts_as_contributor = ${body.countsAsContributor ?? before.countsAsContributor}`
        : catalog === "payment-methods" ? sql`, kind = ${body.kind ?? before.kind}` : sql``;
      await sql`
        update ${sql.table(catalogTables[catalog])}
           set description = ${body.description ?? before.description}, active = ${body.active ?? before.active} ${extra}
         where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
      `.execute(trx);
      const after = await this.findItem(trx, tenantId, catalog, id);
      await this.audit.record(trx, { action: "CATALOG_UPDATED", entity: catalogTables[catalog], entityId: id, before, after });
      return after;
    });
  }

  delete(tenantId: string, userId: string, kind: string, id: string) {
    const catalog = this.catalog(kind);
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      await this.lockItem(trx, tenantId, catalog, id);
      const before = await this.findItem(trx, tenantId, catalog, id);
      if (before.usageCount) throw new ConflictException({ code: "IN_USE", detail: "Item em uso. Inative-o em vez de excluir." });
      await sql`delete from ${sql.table(catalogTables[catalog])} where tenant_id = ${tenantId}::uuid and id = ${id}::uuid`.execute(trx);
      await this.audit.record(trx, { action: "CATALOG_DELETED", entity: catalogTables[catalog], entityId: id, before });
      return { id };
    });
  }

  listFees(tenantId: string, userId: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, (trx) => this.findFees(trx, tenantId));
  }

  updateFees(tenantId: string, userId: string, body: FeeRulesDto) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      await sql`select id from tenants where id = ${tenantId}::uuid for update`.execute(trx);
      const before = await this.findFees(trx, tenantId);
      const existing = new Set(before.map((rule) => rule.id));
      if (body.rules.some((rule) => rule.id && !existing.has(rule.id))) {
        throw new BadRequestException({ code: "INVALID_REFERENCE", detail: "Regra de taxa inválida." });
      }
      const keep = body.rules.flatMap((rule) => rule.id ? [rule.id] : []);
      await sql`delete from fee_rules where tenant_id = ${tenantId}::uuid and not (id = any(${keep}::uuid[]))`.execute(trx);
      for (const rule of body.rules) {
        if (rule.id && before.some((previous) => previous.id === rule.id && previous.name !== rule.name)) {
          await sql`update fee_rules set name = ${`__renaming_${randomUUID()}`} where tenant_id = ${tenantId}::uuid and id = ${rule.id}::uuid`.execute(trx);
        }
      }
      for (const rule of body.rules) {
        if (rule.id) {
          await sql`
            update fee_rules set name = ${rule.name}, percent = ${rule.percent}::numeric,
              rounding = ${rule.rounding}, active = ${rule.active}, sort_order = ${rule.sortOrder}
             where tenant_id = ${tenantId}::uuid and id = ${rule.id}::uuid
          `.execute(trx);
        } else {
          await sql`
            insert into fee_rules (tenant_id, name, percent, rounding, active, sort_order)
            values (${tenantId}::uuid, ${rule.name}, ${rule.percent}::numeric, ${rule.rounding}, ${rule.active}, ${rule.sortOrder})
          `.execute(trx);
        }
      }
      const after = await this.findFees(trx, tenantId);
      await this.audit.record(trx, { action: "FEE_RULES_UPDATED", entity: "tenant", entityId: tenantId, before, after });
      return after;
    });
  }

  private catalog(kind: string): CatalogKind {
    if (!Object.prototype.hasOwnProperty.call(catalogTables, kind)) throw new NotFoundException({ code: "NOT_FOUND" });
    return kind as CatalogKind;
  }

  private validate(kind: CatalogKind, body: CatalogDto, create: boolean) {
    const allowed = kind === "contribution-types"
      ? ["description", "active", "category", "requiresMember", "countsForFees", "countsAsContributor"]
      : kind === "payment-methods" ? ["description", "active", "kind"] : ["description", "active"];
    if (Object.keys(body).some((key) => !allowed.includes(key)) || !Object.keys(body).length ||
        (create && (!body.description || (kind === "contribution-types" && !body.category) || (kind === "payment-methods" && !body.kind)))) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", detail: "Campos inválidos para este catálogo." });
    }
  }

  private async lockItem(trx: Kysely<Database>, tenantId: string, kind: CatalogKind, id: string) {
    const result = await sql<{ id: string }>`
      select id from ${sql.table(catalogTables[kind])} where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update
    `.execute(trx);
    if (!result.rows[0]) throw new NotFoundException({ code: "NOT_FOUND" });
  }

  private async findItem(trx: Kysely<Database>, tenantId: string, kind: CatalogKind, id: string) {
    const items = await this.findItems(trx, tenantId, kind, id);
    if (!items[0]) throw new NotFoundException({ code: "NOT_FOUND" });
    return items[0];
  }

  private async findItems(trx: Kysely<Database>, tenantId: string, kind: CatalogKind, id?: string): Promise<CatalogItem[]> {
    const extra = kind === "contribution-types"
      ? sql`, 'category', c.category, 'requiresMember', c.requires_member, 'countsForFees', c.counts_for_fees, 'countsAsContributor', c.counts_as_contributor`
      : kind === "payment-methods" ? sql`, 'kind', c.kind` : sql``;
    const usage = kind === "member-types" ? sql`(select count(*) from members x where x.tenant_id = c.tenant_id and x.member_type_id = c.id)`
      : kind === "contribution-types" ? sql`(select count(*) from contributions x where x.tenant_id = c.tenant_id and x.contribution_type_id = c.id)`
      : kind === "payment-methods" ? sql`(select count(*) from contributions x where x.tenant_id = c.tenant_id and x.payment_method_id = c.id)`
      : sql`((select count(*) from expenses x where x.tenant_id = c.tenant_id and x.category_id = c.id)
           + (select count(*) from payables x where x.tenant_id = c.tenant_id and x.category_id = c.id))`;
    const result = await sql<{ item: CatalogItem }>`
      select jsonb_build_object('id', c.id, 'description', c.description, 'active', c.active,
        'usageCount', ${usage} ${extra}) as item from ${sql.table(catalogTables[kind])} c
       where c.tenant_id = ${tenantId}::uuid and (${id ?? null}::uuid is null or c.id = ${id ?? null}::uuid)
       order by c.description, c.id
    `.execute(trx);
    return result.rows.map((row) => row.item);
  }

  private async findFees(trx: Kysely<Database>, tenantId: string) {
    const result = await sql<{ id: string; name: string; percent: string; rounding: string; active: boolean; sortOrder: number }>`
      select id, name, percent::text, rounding, active, sort_order as "sortOrder" from fee_rules
       where tenant_id = ${tenantId}::uuid order by sort_order, name, id
    `.execute(trx);
    return result.rows;
  }
}
