import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Kysely, sql } from "kysely";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { DATABASE, Database } from "../../common/database/database.module";
import {
  CancelRequestDto,
  TenantSettingsDto,
  TenantUpdateDto,
} from "./tenant.dto";

@Injectable()
export class TenantService {
  constructor(@Inject(DATABASE) private readonly database: Kysely<Database>) {}

  async getTenantSummary(user: AuthenticatedUser, tenantId?: string) {
    const targetTenantId = tenantId ?? user.userId;
    if (!targetTenantId) {
      throw new BadRequestException({ code: "TENANT_REQUIRED" });
    }

    const result = await sql<{
      id: string;
      slug: string;
      name: string;
      status: string;
      timezone: string;
      document: string | null;
      trial_ends_at: Date | null;
    }>`
      select id, slug, name, status, timezone, document, trial_ends_at
        from tenants
       where id = ${targetTenantId}::uuid
    `.execute(this.database);

    const tenant = result.rows[0];
    if (!tenant) throw new NotFoundException({ code: "NOT_FOUND" });

    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      timezone: tenant.timezone,
      document: tenant.document,
      trialEndsAt: tenant.trial_ends_at,
    };
  }

  async updateTenant(
    user: AuthenticatedUser,
    tenantId: string,
    payload: TenantUpdateDto,
  ) {
    const hasPermission = await this.userHasRole(
      user.userId,
      tenantId,
      "TENANT_ADMIN",
    );
    if (!hasPermission) throw new ForbiddenException({ code: "FORBIDDEN" });

    if (payload.name) {
      await sql`
        update tenants
           set name = ${payload.name}, updated_at = now()
         where id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.document !== undefined) {
      await sql`
        update tenants
           set document = ${payload.document}, updated_at = now()
         where id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.timezone) {
      await sql`
        update tenants
           set timezone = ${payload.timezone}, updated_at = now()
         where id = ${tenantId}::uuid
      `.execute(this.database);
    }

    return this.getTenantSummary(user, tenantId);
  }

  async getSettings(user: AuthenticatedUser, tenantId: string) {
    const hasPermission = await this.userHasRole(
      user.userId,
      tenantId,
      "TENANT_ADMIN",
    );
    if (!hasPermission) throw new ForbiddenException({ code: "FORBIDDEN" });

    const result = await sql<{
      week_starts_on: number;
      allow_future_dates: boolean;
      payable_window_days: number;
      payable_alert_days: number;
      attachment_max_mb: number;
      attachment_max_files: number;
      require_mfa_roles: string[];
      cascade_reopen: boolean;
    }>`
      select week_starts_on, allow_future_dates, payable_window_days, payable_alert_days,
             attachment_max_mb, attachment_max_files, require_mfa_roles, cascade_reopen
        from tenant_settings
       where tenant_id = ${tenantId}::uuid
    `.execute(this.database);

    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: "NOT_FOUND" });

    return {
      weekStartsOn: row.week_starts_on,
      allowFutureDates: row.allow_future_dates,
      payableWindowDays: row.payable_window_days,
      payableAlertDays: row.payable_alert_days,
      attachmentMaxMb: row.attachment_max_mb,
      attachmentMaxFiles: row.attachment_max_files,
      requireMfaRoles: row.require_mfa_roles,
      cascadeReopen: row.cascade_reopen,
    };
  }

  async updateSettings(
    user: AuthenticatedUser,
    tenantId: string,
    payload: TenantSettingsDto,
  ) {
    const hasPermission = await this.userHasRole(
      user.userId,
      tenantId,
      "TENANT_ADMIN",
    );
    if (!hasPermission) throw new ForbiddenException({ code: "FORBIDDEN" });

    if (payload.weekStartsOn !== undefined) {
      await sql`
        update tenant_settings
           set week_starts_on = ${payload.weekStartsOn}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.allowFutureDates !== undefined) {
      await sql`
        update tenant_settings
           set allow_future_dates = ${payload.allowFutureDates}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.payableWindowDays !== undefined) {
      await sql`
        update tenant_settings
           set payable_window_days = ${payload.payableWindowDays}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.payableAlertDays !== undefined) {
      await sql`
        update tenant_settings
           set payable_alert_days = ${payload.payableAlertDays}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.attachmentMaxMb !== undefined) {
      await sql`
        update tenant_settings
           set attachment_max_mb = ${payload.attachmentMaxMb}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.attachmentMaxFiles !== undefined) {
      await sql`
        update tenant_settings
           set attachment_max_files = ${payload.attachmentMaxFiles}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.requireMfaRoles !== undefined) {
      await sql`
        update tenant_settings
           set require_mfa_roles = ${payload.requireMfaRoles}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }
    if (payload.cascadeReopen !== undefined) {
      await sql`
        update tenant_settings
           set cascade_reopen = ${payload.cascadeReopen}, updated_at = now()
         where tenant_id = ${tenantId}::uuid
      `.execute(this.database);
    }

    return this.getSettings(user, tenantId);
  }

  async createExportJob(user: AuthenticatedUser, tenantId: string) {
    const hasPermission = await this.userHasRole(
      user.userId,
      tenantId,
      "TENANT_ADMIN",
    );
    if (!hasPermission) throw new ForbiddenException({ code: "FORBIDDEN" });
    return { jobId: "tenant-export-job-" + Date.now(), status: "queued" };
  }

  async getExportJob(user: AuthenticatedUser, tenantId: string, jobId: string) {
    const hasPermission = await this.userHasRole(
      user.userId,
      tenantId,
      "TENANT_ADMIN",
    );
    if (!hasPermission) throw new ForbiddenException({ code: "FORBIDDEN" });
    return { jobId, status: "queued", downloadUrl: `/exports/${jobId}` };
  }

  async cancelRequest(
    user: AuthenticatedUser,
    tenantId: string,
    payload: CancelRequestDto,
  ) {
    const hasPermission = await this.userHasRole(
      user.userId,
      tenantId,
      "TENANT_ADMIN",
    );
    if (!hasPermission) throw new ForbiddenException({ code: "FORBIDDEN" });

    await sql`
      insert into audit_log (tenant_id, actor_user_id, actor_membership_id, action, entity, entity_id, "after", source)
      values (
        ${tenantId}::uuid,
        ${user.userId}::uuid,
        (select id from tenant_memberships where tenant_id = ${tenantId}::uuid and user_id = ${user.userId}::uuid and status = 'ACTIVE' limit 1),
        'tenant.cancel_request', 'tenant', ${tenantId},
        ${JSON.stringify({ reason: payload.reason })}::jsonb,
        'APP'
      )
    `.execute(this.database);

    return { status: "queued", reason: payload.reason };
  }

  private async userHasRole(
    userId: string,
    tenantId: string,
    role: string,
  ): Promise<boolean> {
    const result = await sql<{ exists: boolean }>`
      select exists (
        select 1
          from tenant_memberships tm
          join membership_roles mr on mr.membership_id = tm.id
         where tm.user_id = ${userId}::uuid
           and tm.tenant_id = ${tenantId}::uuid
           and tm.status = 'ACTIVE'
           and mr.role = ${role}
      ) as exists
    `.execute(this.database);

    return Boolean(result.rows[0]?.exists);
  }
}
