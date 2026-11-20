import { Injectable } from "@nestjs/common";
import { Kysely, sql } from "kysely";
import { TenantContext } from "../tenant/tenant-context";
import { Database } from "../database/database.module";

export interface AuditRecord {
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source?: "APP" | "V1" | "SYSTEM";
}

@Injectable()
export class AuditService {
  constructor(private readonly tenantContext: TenantContext) {}

  async record(
    transaction: Kysely<Database>,
    record: AuditRecord,
  ): Promise<void> {
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new Error(
        "AuditService.record requires a tenant transaction context",
      );
    }

    await sql`
      insert into audit_log (
        tenant_id, actor_user_id, actor_membership_id, action, entity, entity_id,
        "before", "after", reason, request_id, source
      ) values (
        ${context.tenantId}::uuid,
        ${context.userId ?? null}::uuid,
        ${context.membershipId ?? null}::uuid,
        ${record.action}, ${record.entity}, ${record.entityId ?? null},
        ${record.before === undefined ? null : JSON.stringify(record.before)}::jsonb,
        ${record.after === undefined ? null : JSON.stringify(record.after)}::jsonb,
        ${record.reason ?? null}, ${context.requestId}, ${record.source ?? "APP"}
      )
    `.execute(transaction);
  }
}
