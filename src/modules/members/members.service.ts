import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Kysely, sql } from "kysely";
import { AuditService } from "../../common/audit/audit.service";
import { Database, TenantTransactions } from "../../common/database/database.module";
import { pageResponse, parsePagination } from "../../common/http/pagination";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import { CreateMemberDto, MemberQueryDto, UpdateMemberDto } from "./members.dto";

type MemberStatus = "ACTIVE" | "INACTIVE" | "TRANSFERRED" | "DECEASED";

export interface Member {
  id: string;
  name: string;
  memberType: { id: string; description: string };
  status: MemberStatus;
  phone: string | null;
  email: string | null;
  gender: string | null;
  birthDate: string | null;
  entryDate: string | null;
  baptismDate: string | null;
  zipCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  consentAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const memberJson = sql`
  jsonb_build_object(
    'id', m.id, 'name', m.name,
    'memberType', jsonb_build_object('id', mt.id, 'description', mt.description),
    'status', m.status, 'phone', m.phone, 'email', m.email, 'gender', m.gender,
    'birthDate', to_char(m.birth_date, 'YYYY-MM-DD'),
    'entryDate', to_char(m.entry_date, 'YYYY-MM-DD'),
    'baptismDate', to_char(m.baptism_date, 'YYYY-MM-DD'),
    'zipCode', m.zip_code, 'street', m.street, 'number', m.number,
    'complement', m.complement, 'neighborhood', m.neighborhood, 'city', m.city,
    'state', m.state, 'consentAt', m.consent_at, 'createdBy', m.created_by,
    'createdAt', m.created_at, 'updatedAt', m.updated_at
  )
`;

@Injectable()
export class MembersService {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string, userId: string, query: MemberQueryDto, canReadDetail: boolean) {
    const pagination = parsePagination({ ...query }, ["name", "type", "createdAt"]);
    const columns = { name: "name", type: "type_description", createdAt: "created_at" } as const;
    const ordering = sql.raw(`${columns[query.sort ?? "name"]} ${query.order === "desc" ? "desc" : "asc"}, id ${query.order === "desc" ? "desc" : "asc"}`);
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const result = await sql<{
        data: { id: string; name: string; memberType: Member["memberType"]; status: MemberStatus; phone: string | null }[];
        total: string;
      }>`
        with filtered as (
          select m.id, m.name, mt.description as type_description, m.created_at,
                 jsonb_build_object(
                   'id', m.id, 'name', m.name,
                   'memberType', jsonb_build_object('id', mt.id, 'description', mt.description),
                   'status', m.status, 'phone', case when ${canReadDetail} then m.phone else null end
                 ) as item
            from members m
            join member_types mt on mt.tenant_id = m.tenant_id and mt.id = m.member_type_id
           where m.tenant_id = ${tenantId}::uuid and m.deleted_at is null
             and (${query.q || null}::text is null or app_norm(m.name) like '%' || app_norm(${query.q || null}::text) || '%')
             and (${query.memberTypeId ?? null}::uuid is null or m.member_type_id = ${query.memberTypeId ?? null}::uuid)
             and (${query.status ?? "ACTIVE"} = 'ALL' or m.status = ${query.status ?? "ACTIVE"})
        ), paged as (
          select item, row_number() over (order by ${ordering}) as ordinal
            from filtered order by ${ordering}
           limit ${pagination.pageSize} offset ${pagination.offset}
        )
        select (select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb) from paged) as data,
               count(*)::text as total from filtered
      `.execute(trx);
      const row = result.rows[0];
      if (!row) throw new InternalServerErrorException({ code: "INTERNAL" });
      return pageResponse(row.data, Number(row.total), pagination);
    });
  }

  listTypes(tenantId: string, userId: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const result = await sql<{ id: string; description: string }>`
        select id, description from member_types
         where tenant_id = ${tenantId}::uuid and active
         order by description, id
      `.execute(trx);
      return result.rows;
    });
  }

  get(tenantId: string, userId: string, id: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, (trx) => this.findMember(trx, tenantId, id));
  }

  async create(tenant: TenantRequestContext, userId: string, payload: CreateMemberDto, force: boolean) {
    this.checkWriteAccess(tenant, userId, payload);
    const tenantId = tenant.tenantId!;
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      await this.validateType(trx, tenantId, payload.memberTypeId);
      if (!force) {
        const duplicates = await sql<{ id: string; name: string }>`
          select id, name from members
           where tenant_id = ${tenantId}::uuid and deleted_at is null and status = 'ACTIVE'
             and app_norm(name) = app_norm(${payload.name})
             and (
               (${payload.birthDate ?? null}::date is not null and birth_date = ${payload.birthDate ?? null}::date)
               or (${payload.email ?? null}::text is not null and lower(btrim(email)) = lower(btrim(${payload.email ?? null}::text)))
               or (${payload.phone ?? null}::text is not null
                   and regexp_replace(${payload.phone ?? null}::text, '\\D', '', 'g') <> ''
                   and regexp_replace(phone, '\\D', '', 'g') = regexp_replace(${payload.phone ?? null}::text, '\\D', '', 'g'))
             )
           order by name, id limit 5
        `.execute(trx);
        if (duplicates.rows.length) {
          throw new ConflictException({
            code: "POSSIBLE_DUPLICATE",
            detail: "Há possíveis membros duplicados. Confirme para cadastrar mesmo assim.",
            errors: duplicates.rows,
          });
        }
      }
      const inserted = await sql<{ id: string }>`
        insert into members
          (tenant_id, name, member_type_id, status, phone, email, gender, birth_date,
           entry_date, baptism_date, zip_code, street, number, complement, neighborhood,
           city, state, consent_at, created_by)
        values
          (${tenantId}::uuid, ${payload.name}, ${payload.memberTypeId}::uuid,
           ${payload.status ?? "ACTIVE"}, ${payload.phone ?? null}, ${payload.email ?? null},
           ${payload.gender ?? null}, ${payload.birthDate ?? null}::date,
           ${payload.entryDate ?? null}::date, ${payload.baptismDate ?? null}::date,
           ${payload.zipCode ?? null}, ${payload.street ?? null}, ${payload.number ?? null},
           ${payload.complement ?? null}, ${payload.neighborhood ?? null}, ${payload.city ?? null},
           ${payload.state ?? null}, case when ${payload.consent ?? false} then now() else null end,
           ${userId}::uuid)
        returning id
      `.execute(trx);
      const id = inserted.rows[0]?.id;
      if (!id) throw new InternalServerErrorException({ code: "INTERNAL" });
      const member = await this.findMember(trx, tenantId, id);
      await this.audit.record(trx, { action: "MEMBER_CREATED", entity: "member", entityId: id });
      return member;
    });
  }

  async update(tenant: TenantRequestContext, userId: string, id: string, payload: UpdateMemberDto) {
    this.checkWriteAccess(tenant, userId, payload);
    const tenantId = tenant.tenantId!;
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const before = await this.findMember(trx, tenantId, id, true);
      this.checkWriteAccess(tenant, userId, payload, before.createdBy);
      if (payload.memberTypeId !== undefined) await this.validateType(trx, tenantId, payload.memberTypeId);
      await sql`
        update members set
          name = ${payload.name ?? before.name},
          member_type_id = ${payload.memberTypeId ?? before.memberType.id}::uuid,
          status = ${payload.status ?? before.status},
          phone = ${payload.phone !== undefined ? payload.phone : before.phone},
          email = ${payload.email !== undefined ? payload.email : before.email},
          gender = ${payload.gender !== undefined ? payload.gender : before.gender},
          birth_date = ${payload.birthDate !== undefined ? payload.birthDate : before.birthDate}::date,
          entry_date = ${payload.entryDate !== undefined ? payload.entryDate : before.entryDate}::date,
          baptism_date = ${payload.baptismDate !== undefined ? payload.baptismDate : before.baptismDate}::date,
          zip_code = ${payload.zipCode !== undefined ? payload.zipCode : before.zipCode},
          street = ${payload.street !== undefined ? payload.street : before.street},
          number = ${payload.number !== undefined ? payload.number : before.number},
          complement = ${payload.complement !== undefined ? payload.complement : before.complement},
          neighborhood = ${payload.neighborhood !== undefined ? payload.neighborhood : before.neighborhood},
          city = ${payload.city !== undefined ? payload.city : before.city},
          state = ${payload.state !== undefined ? payload.state : before.state},
          consent_at = case when ${payload.consent ?? null}::boolean is null then consent_at
                            when ${payload.consent ?? null}::boolean then coalesce(consent_at, now())
                            else null end
         where tenant_id = ${tenantId}::uuid and id = ${id}::uuid and deleted_at is null
      `.execute(trx);
      const member = await this.findMember(trx, tenantId, id);
      await this.audit.record(trx, {
        action: "MEMBER_UPDATED", entity: "member", entityId: id,
        after: { changedFields: Object.keys(payload) },
      });
      return member;
    });
  }

  async delete(tenant: TenantRequestContext, userId: string, id: string) {
    this.checkWriteAccess(tenant, userId, {});
    const tenantId = tenant.tenantId!;
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const member = await this.findMember(trx, tenantId, id, true);
      this.checkWriteAccess(tenant, userId, {}, member.createdBy);
      const linked = await sql<{ status: string }>`
        select status from tenant_memberships
         where tenant_id = ${tenantId}::uuid and member_id = ${id}::uuid
         for update
      `.execute(trx);
      if (linked.rows.some((membership) => membership.status === "ACTIVE")) {
        throw new ConflictException({ code: "MEMBER_HAS_ACCESS" });
      }
      await sql`
        update members set deleted_at = now()
         where tenant_id = ${tenantId}::uuid and id = ${id}::uuid and deleted_at is null
      `.execute(trx);
      await this.audit.record(trx, { action: "MEMBER_DELETED", entity: "member", entityId: id });
      return { id };
    });
  }

  private checkWriteAccess(
    tenant: TenantRequestContext,
    userId: string,
    payload: UpdateMemberDto,
    createdBy?: string | null,
  ) {
    if (!tenant.permissions.includes("members:manage")) throw new ForbiddenException({ code: "FORBIDDEN" });
    if (tenant.permissions.includes("members:write")) return;
    if (createdBy !== undefined && createdBy !== userId) throw new ForbiddenException({ code: "FORBIDDEN" });
    if (Object.keys(payload).some((key) => key !== "name" && key !== "memberTypeId")) {
      throw new ForbiddenException({ code: "FORBIDDEN" });
    }
  }

  private async validateType(trx: Kysely<Database>, tenantId: string, id: string) {
    const result = await sql<{ id: string }>`
      select id from member_types where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
        and active for share
    `.execute(trx);
    if (!result.rows[0]) {
      throw new UnprocessableEntityException({ code: "INVALID_REFERENCE", detail: "Tipo de membro inválido ou inativo." });
    }
  }

  private async findMember(trx: Kysely<Database>, tenantId: string, id: string, lock = false): Promise<Member> {
    const result = await sql<{ item: Member }>`
      select ${memberJson} as item from members m
      join member_types mt on mt.tenant_id = m.tenant_id and mt.id = m.member_type_id
      where m.tenant_id = ${tenantId}::uuid and m.id = ${id}::uuid and m.deleted_at is null
      ${lock ? sql`for update of m` : sql``}
    `.execute(trx);
    const member = result.rows[0]?.item;
    if (!member) throw new NotFoundException({ code: "MEMBER_NOT_FOUND" });
    return member;
  }
}
