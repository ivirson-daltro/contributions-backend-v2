import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { AuditService } from "../../common/audit/audit.service";
import { TenantTransactions } from "../../common/database/database.module";
import { pageResponse, parsePagination } from "../../common/http/pagination";
import {
  ContributionQueryDto,
  CreateContributionDto,
  OptionsQueryDto,
} from "./contributions.dto";

export interface ContributionItem {
  id: string;
  occurredOn: string;
  amount: string;
  member: { id: string; name: string } | null;
  type: { id: string; description: string; category: string };
  method: { id: string; description: string; kind: string };
  observation: string | null;
  status: string;
  attachmentsCount: number;
  version: number;
}

interface ContributionListRow {
  data: ContributionItem[];
  total: string;
  active_count: string;
  active_amount: string;
}

interface IdempotencyRow {
  request_hash: string;
  status_code: number | null;
  response: ContributionItem | null;
}

export interface OptionRow {
  id: string;
  description: string;
  category?: string;
  kind?: string;
  requiresMember?: boolean;
  countsForFees?: boolean;
  countsAsContributor?: boolean;
}

@Injectable()
export class ContributionsService {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string, userId: string, query: ContributionQueryDto) {
    const pagination = parsePagination({ ...query }, ["date", "amount", "member"]);
    const columns = {
      date: "f.occurred_on",
      amount: "f.amount",
      member: "f.member_name",
    } as const;
    const sort = columns[query.sort ?? "date"];
    const direction = pagination.order === "asc" ? "asc" : "desc";
    const ordering = sql.raw(`${sort} ${direction} nulls last, f.id ${direction}`);
    const defaultPeriod = !query.from && !query.to
      ? sql`
          and c.occurred_on >= date_trunc('month', now() at time zone t.timezone)::date
          and c.occurred_on < (date_trunc('month', now() at time zone t.timezone) + interval '1 month')::date
        `
      : sql``;

    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const result = await sql<ContributionListRow>`
        with filtered as (
          select c.id, c.occurred_on, c.amount, c.status, m.name as member_name,
                 jsonb_build_object(
                   'id', c.id,
                   'occurredOn', to_char(c.occurred_on, 'YYYY-MM-DD'),
                   'amount', c.amount::text,
                   'member', case when m.id is null then null
                     else jsonb_build_object('id', m.id, 'name', m.name) end,
                   'type', jsonb_build_object(
                     'id', ct.id, 'description', ct.description, 'category', c.category_snapshot),
                   'method', jsonb_build_object(
                     'id', pm.id, 'description', pm.description, 'kind', c.kind_snapshot),
                   'observation', c.observation,
                   'status', c.status,
                   'attachmentsCount', (
                     select count(*) from attachments a
                      where a.tenant_id = c.tenant_id and a.contribution_id = c.id
                        and a.status = 'CONFIRMED'
                   ),
                   'version', c.version
                 ) as item
            from contributions c
            join tenants t on t.id = c.tenant_id
            join contribution_types ct on ct.tenant_id = c.tenant_id and ct.id = c.contribution_type_id
            join payment_methods pm on pm.tenant_id = c.tenant_id and pm.id = c.payment_method_id
            left join members m on m.tenant_id = c.tenant_id and m.id = c.member_id
           where c.tenant_id = ${tenantId}::uuid
             ${defaultPeriod}
             and (${query.memberId ?? null}::uuid is null or c.member_id = ${query.memberId ?? null}::uuid)
             and (${query.typeId ?? null}::uuid is null or c.contribution_type_id = ${query.typeId ?? null}::uuid)
             and (${query.methodId ?? null}::uuid is null or c.payment_method_id = ${query.methodId ?? null}::uuid)
             and (${query.from ?? null}::date is null or c.occurred_on >= ${query.from ?? null}::date)
             and (${query.to ?? null}::date is null or c.occurred_on <= ${query.to ?? null}::date)
             and (${query.q || null}::text is null or app_norm(m.name) like '%' || app_norm(${query.q || null}::text) || '%')
             and (${query.status ?? "ACTIVE"} = 'ALL' or c.status = ${query.status ?? "ACTIVE"})
        ),
        paged as (
          select f.item, row_number() over (order by ${ordering}) as ordinal
            from filtered f
           order by ${ordering}
           limit ${pagination.pageSize} offset ${pagination.offset}
        )
        select
          (select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb) from paged) as data,
          count(*)::text as total,
          count(*) filter (where status = 'ACTIVE')::text as active_count,
          coalesce(sum(amount) filter (where status = 'ACTIVE'), 0)::text as active_amount
          from filtered
      `.execute(trx);
      const row = result.rows[0];
      if (!row) throw new InternalServerErrorException({ code: "INTERNAL" });
      return pageResponse(row.data, Number(row.total), pagination, {
        amount: row.active_amount,
        count: Number(row.active_count),
      });
    });
  }

  listTypes(tenantId: string, userId: string, query: OptionsQueryDto) {
    return this.listOptions(tenantId, userId, query, "contribution_types");
  }

  listMethods(tenantId: string, userId: string, query: OptionsQueryDto) {
    return this.listOptions(tenantId, userId, query, "payment_methods");
  }

  private listOptions(
    tenantId: string,
    userId: string,
    query: OptionsQueryDto,
    table: "contribution_types" | "payment_methods",
  ) {
    const pagination = parsePagination({ ...query });
    const extra = table === "contribution_types"
      ? sql`'category', category, 'requiresMember', requires_member,
            'countsForFees', counts_for_fees, 'countsAsContributor', counts_as_contributor`
      : sql`'kind', coalesce(kind, 'OTHER')`;
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const result = await sql<{ data: OptionRow[]; total: string }>`
        with filtered as (
          select id, description, jsonb_build_object(
            'id', id, 'description', description, ${extra}
          ) as item
            from ${sql.table(table)}
           where tenant_id = ${tenantId}::uuid and active
             and (${query.q || null}::text is null or
                  app_norm(description) like '%' || app_norm(${query.q || null}::text) || '%')
        ),
        paged as (
          select item, description, id from filtered
           order by description, id
           limit ${pagination.pageSize} offset ${pagination.offset}
        )
        select (select coalesce(jsonb_agg(item order by description, id), '[]'::jsonb) from paged) as data,
               count(*)::text as total
          from filtered
      `.execute(trx);
      const row = result.rows[0];
      if (!row) throw new InternalServerErrorException({ code: "INTERNAL" });
      return pageResponse(row.data, Number(row.total), pagination);
    });
  }

  lookupMembers(tenantId: string, userId: string, q?: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const result = await sql<{
        id: string;
        name: string;
        member_type: { id: string; description: string };
      }>`
        select m.id, m.name,
               jsonb_build_object('id', mt.id, 'description', mt.description) as member_type
          from members m
          join member_types mt on mt.tenant_id = m.tenant_id and mt.id = m.member_type_id
         where m.tenant_id = ${tenantId}::uuid and m.status = 'ACTIVE' and m.deleted_at is null
           and (${q || null}::text is null or app_norm(m.name) like '%' || app_norm(${q || null}::text) || '%')
         order by m.name, m.id
         limit 20
      `.execute(trx);
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        memberType: row.member_type,
      }));
    });
  }

  async create(
    tenantId: string,
    userId: string,
    keyHeader: string | undefined,
    payload: CreateContributionDto,
  ): Promise<ContributionItem> {
    const key = keyHeader?.trim();
    if (!key) throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    if (key.length > 200) throw new BadRequestException({ code: "VALIDATION_ERROR" });
    const hash = createHash("sha256")
      .update(JSON.stringify([
        "POST /contributions", userId, payload.contributionTypeId,
        payload.paymentMethodId, payload.memberId ?? null, payload.amount,
        payload.occurredOn, payload.observation ?? null,
      ]))
      .digest("hex");

    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const reserved = await sql<{ key: string }>`
        insert into idempotency_keys (tenant_id, key, request_hash)
        values (${tenantId}::uuid, ${key}, ${hash})
        on conflict (tenant_id, key) do nothing
        returning key
      `.execute(trx);
      if (!reserved.rows.length) {
        const existing = await sql<IdempotencyRow>`
          select request_hash, status_code, response from idempotency_keys
           where tenant_id = ${tenantId}::uuid and key = ${key}
        `.execute(trx);
        const row = existing.rows[0];
        if (!row) {
          throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
        }
        if (row.request_hash !== hash) {
          throw new UnprocessableEntityException({ code: "IDEMPOTENCY_KEY_REUSED" });
        }
        if (row.status_code === null) {
          throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
        }
        if (row.status_code !== 201 || !row.response) {
          throw new InternalServerErrorException({ code: "INTERNAL" });
        }
        return row.response;
      }

      const typeResult = await sql<{
        id: string; description: string; category: string; requires_member: boolean;
      }>`
        select id, description, category, requires_member from contribution_types
         where tenant_id = ${tenantId}::uuid and id = ${payload.contributionTypeId}::uuid
           and active for share
      `.execute(trx);
      const type = typeResult.rows[0];
      if (!type) throw new UnprocessableEntityException({ code: "INVALID_REFERENCE", detail: "Tipo de contribuição inválido ou inativo." });

      const methodResult = await sql<{ id: string; description: string; kind: string }>`
        select id, description, coalesce(kind, 'OTHER') as kind from payment_methods
         where tenant_id = ${tenantId}::uuid and id = ${payload.paymentMethodId}::uuid
           and active for share
      `.execute(trx);
      const method = methodResult.rows[0];
      if (!method) throw new UnprocessableEntityException({ code: "INVALID_REFERENCE", detail: "Meio de pagamento inválido ou inativo." });
      if (type.requires_member && !payload.memberId) {
        throw new UnprocessableEntityException({ code: "MEMBER_REQUIRED" });
      }

      let member: ContributionItem["member"] = null;
      if (payload.memberId) {
        const memberResult = await sql<{ id: string; name: string }>`
          select id, name from members
           where tenant_id = ${tenantId}::uuid and id = ${payload.memberId}::uuid
             and status = 'ACTIVE' and deleted_at is null for share
        `.execute(trx);
        member = memberResult.rows[0] ?? null;
        if (!member) throw new UnprocessableEntityException({ code: "INVALID_REFERENCE", detail: "Membro inválido ou inativo." });
      }

      const settings = await sql<{ allow_future_dates: boolean; today: string }>`
        select s.allow_future_dates, to_char(now() at time zone t.timezone, 'YYYY-MM-DD') as today
          from tenants t join tenant_settings s on s.tenant_id = t.id
         where t.id = ${tenantId}::uuid
      `.execute(trx);
      const config = settings.rows[0];
      if (!config) throw new InternalServerErrorException({ code: "INTERNAL" });
      if (!config.allow_future_dates && payload.occurredOn > config.today) {
        throw new UnprocessableEntityException({ code: "FUTURE_DATE_NOT_ALLOWED" });
      }

      const closed = await sql<{ closed: boolean }>`
        select v2_is_month_closed(${tenantId}::uuid, ${payload.occurredOn}::date) as closed
      `.execute(trx);
      if (!closed.rows[0]) throw new InternalServerErrorException({ code: "INTERNAL" });
      if (closed.rows[0].closed) throw new ConflictException({ code: "MONTH_CLOSED" });

      const inserted = await sql<{ id: string; amount: string; version: number }>`
        insert into contributions
          (tenant_id, member_id, contribution_type_id, payment_method_id, amount,
           occurred_on, observation, category_snapshot, kind_snapshot, created_by)
        values
          (${tenantId}::uuid, ${payload.memberId ?? null}::uuid,
           ${type.id}::uuid, ${method.id}::uuid, ${payload.amount}::numeric,
           ${payload.occurredOn}::date, ${payload.observation ?? null}, null, null, ${userId}::uuid)
        returning id, amount::text, version
      `.execute(trx);
      const created = inserted.rows[0];
      if (!created) throw new InternalServerErrorException({ code: "INTERNAL" });
      const response: ContributionItem = {
        id: created.id,
        occurredOn: payload.occurredOn,
        amount: created.amount,
        member,
        type: { id: type.id, description: type.description, category: type.category },
        method: { id: method.id, description: method.description, kind: method.kind },
        observation: payload.observation ?? null,
        status: "ACTIVE",
        attachmentsCount: 0,
        version: created.version,
      };
      await this.audit.record(trx, {
        action: "CONTRIBUTION_CREATED",
        entity: "contribution",
        entityId: created.id,
        after: response,
      });
      await sql`
        update idempotency_keys
           set status_code = 201, response = ${JSON.stringify(response)}::jsonb
         where tenant_id = ${tenantId}::uuid and key = ${key}
      `.execute(trx);
      return response;
    });
  }
}
