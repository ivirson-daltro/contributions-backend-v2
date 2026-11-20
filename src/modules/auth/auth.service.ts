import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { Kysely, sql } from "kysely";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { permissionsForRoles } from "../../common/authorization/permissions";
import { DATABASE, Database } from "../../common/database/database.module";
import { AcceptInvitationDto } from "./auth.dto";
import { SUPABASE_ADMIN } from "./auth.tokens";

export interface MembershipSummary {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  roles: string[];
  mfa: {
    required: boolean;
    satisfied: boolean;
  };
}

interface MembershipRow {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  roles: string[];
}

interface MeRow {
  display_name: string | null;
  memberships: MembershipRow[];
}

interface InvitationPreviewRow {
  tenant_name: string;
  tenant_slug: string;
  email: string;
  name: string | null;
  roles: string[];
  expires_at: Date;
  status: string;
}

interface AccountExistsRow {
  account_exists: boolean;
}

interface TenantSettingsRow {
  status: string;
  timezone: string;
  week_starts_on: number;
  allow_future_dates: boolean;
  payable_window_days: number;
  payable_alert_days: number;
  attachment_max_mb: number;
  attachment_max_files: number;
  require_mfa_roles: string[];
  cascade_reopen: boolean;
}

interface AcceptInvitationRow {
  tenant_id: string;
  membership_id: string;
  roles: string[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE) private readonly database: Kysely<Database>,
    @Inject(SUPABASE_ADMIN) private readonly supabase: SupabaseClient,
  ) {}

  async getMe(user: AuthenticatedUser, tenantId?: string) {
    if (
      tenantId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        tenantId,
      )
    ) {
      throw new BadRequestException({ code: "VALIDATION_ERROR" });
    }

    const profile = await this.withUserTx(user.userId, async (trx) => {
      const result = await sql<MeRow>`
        select
          up.display_name,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'tenantId', memberships.tenant_id,
                'slug', memberships.slug,
                'name', memberships.tenant_name,
                'status', memberships.membership_status,
                'roles', to_jsonb(memberships.roles)
              ) order by memberships.tenant_name
            ) filter (where memberships.membership_id is not null),
            '[]'::jsonb
          ) as memberships
        from (select ${user.userId}::uuid as user_id) current_user_row
        left join user_profiles up on up.user_id = current_user_row.user_id
        left join lateral (
          select tm.id as membership_id, tm.tenant_id, t.slug::text as slug,
                 t.name as tenant_name, tm.status as membership_status,
                 coalesce(array_agg(mr.role order by mr.role)
                   filter (where mr.role is not null), array[]::text[]) as roles
            from tenant_memberships tm
            join tenants t on t.id = tm.tenant_id
            left join membership_roles mr on mr.membership_id = tm.id
           where tm.user_id = current_user_row.user_id
           group by tm.id, t.id
        ) memberships on true
        group by up.display_name
      `.execute(trx);
      return result.rows[0];
    });

    const memberships = await Promise.all(
      (profile?.memberships ?? []).map((membership) =>
        this.withMembershipMfa(user.userId, membership, user.aal),
      ),
    );
    const response = {
      user: {
        id: user.userId,
        email: user.email ?? null,
        displayName: profile?.display_name ?? null,
      },
      memberships,
    };

    if (!tenantId) return response;

    const membership = response.memberships.find(
      (item) => item.tenantId === tenantId,
    );
    if (!membership || membership.status !== "ACTIVE") {
      throw new ForbiddenException({ code: "MEMBERSHIP_INACTIVE" });
    }

    const tenant = await this.withTenantUserTx(
      user.userId,
      tenantId,
      async (trx) => {
        const result = await sql<TenantSettingsRow>`
        select t.status, t.timezone, ts.week_starts_on, ts.allow_future_dates,
               ts.payable_window_days, ts.payable_alert_days,
               ts.attachment_max_mb, ts.attachment_max_files,
               ts.require_mfa_roles, ts.cascade_reopen
          from tenants t
          join tenant_settings ts on ts.tenant_id = t.id
         where t.id = ${tenantId}::uuid
      `.execute(trx);
        return result.rows[0];
      },
    );
    if (!tenant) throw new NotFoundException({ code: "NOT_FOUND" });

    const mfaRequired = membership.roles.some((role) =>
      tenant.require_mfa_roles.includes(role),
    );

    return {
      ...response,
      permissions: permissionsForRoles(membership.roles),
      tenant: {
        status: tenant.status,
        timezone: tenant.timezone,
        settings: {
          weekStartsOn: tenant.week_starts_on,
          allowFutureDates: tenant.allow_future_dates,
          payableWindowDays: tenant.payable_window_days,
          payableAlertDays: tenant.payable_alert_days,
          attachmentMaxMb: tenant.attachment_max_mb,
          attachmentMaxFiles: tenant.attachment_max_files,
          requireMfaRoles: tenant.require_mfa_roles,
          cascadeReopen: tenant.cascade_reopen,
        },
      },
      mfa: { required: mfaRequired, satisfied: user.aal === "aal2" },
    };
  }

  async getInvitationPreview(token: string) {
    const tokenHash = this.hashToken(token);
    const result = await sql<InvitationPreviewRow>`
      select * from v2_invitation_preview(${tokenHash})
    `.execute(this.database);
    const invitation = result.rows[0];
    if (!invitation) throw new NotFoundException({ code: "NOT_FOUND" });

    const accountResult = await sql<AccountExistsRow>`
      select v2_invitation_account_exists(${tokenHash}) as account_exists
    `.execute(this.database);

    return {
      tenant: { name: invitation.tenant_name, slug: invitation.tenant_slug },
      email: invitation.email,
      ...(invitation.name ? { name: invitation.name } : {}),
      roles: invitation.roles,
      status: invitation.status,
      expiresAt: invitation.expires_at,
      accountExists: accountResult.rows[0]?.account_exists ?? false,
    };
  }

  async acceptInvitation(
    token: string,
    body: AcceptInvitationDto,
    authenticatedUser?: AuthenticatedUser,
  ) {
    const tokenHash = this.hashToken(token);
    const invitationResult = await sql<InvitationPreviewRow>`
      select * from v2_invitation_preview(${tokenHash})
    `.execute(this.database);
    const invitation = invitationResult.rows[0];
    if (!invitation) throw new NotFoundException({ code: "NOT_FOUND" });
    if (invitation.status !== "PENDING")
      this.throwInvitationState(invitation.status);

    const accountResult = await sql<AccountExistsRow>`
      select v2_invitation_account_exists(${tokenHash}) as account_exists
    `.execute(this.database);
    const accountExists = accountResult.rows[0]?.account_exists ?? false;

    let userId = authenticatedUser?.userId;
    let createdUserId: string | undefined;
    let displayName: string | null = null;

    if (authenticatedUser) {
      if (body.displayName !== undefined || body.password !== undefined) {
        throw new BadRequestException({ code: "VALIDATION_ERROR" });
      }
    } else {
      if (accountExists) {
        throw new UnauthorizedException({ code: "UNAUTHENTICATED" });
      }
      if (!body.displayName || !body.password) {
        throw new BadRequestException({ code: "VALIDATION_ERROR" });
      }

      const { data, error } = await this.supabase.auth.admin.createUser({
        email: invitation.email,
        password: body.password,
        email_confirm: true,
        user_metadata: { display_name: body.displayName },
      });
      if (error || !data.user) {
        if (error?.message.toLowerCase().includes("already been registered")) {
          throw new ConflictException({
            code: "ACCOUNT_EXISTS_LOGIN_REQUIRED",
          });
        }
        throw new InternalServerErrorException({ code: "INTERNAL" });
      }
      userId = data.user.id;
      createdUserId = data.user.id;
      displayName = body.displayName;
    }

    try {
      const accepted = await this.database
        .transaction()
        .execute(async (trx) => {
          const result = await sql<AcceptInvitationRow>`
          select tenant_id, membership_id, roles
            from v2_accept_invitation(
              ${tokenHash}, ${userId}::uuid, ${displayName}
            )
        `.execute(trx);
          return result.rows[0];
        });
      if (!accepted)
        throw new InternalServerErrorException({ code: "INTERNAL" });
      return {
        tenantId: accepted.tenant_id,
        membershipId: accepted.membership_id,
      };
    } catch (error) {
      if (createdUserId) await this.compensateAuthUser(createdUserId);
      this.throwInvitationError(error);
    }
  }

  private async withMembershipMfa(
    userId: string,
    membership: MembershipRow,
    aal?: string,
  ): Promise<MembershipSummary> {
    const settings = await this.withTenantUserTx(
      userId,
      membership.tenantId,
      async (trx) => {
        const result = await sql<Pick<TenantSettingsRow, "require_mfa_roles">>`
          select require_mfa_roles
            from tenant_settings
           where tenant_id = ${membership.tenantId}::uuid
        `.execute(trx);
        return result.rows[0];
      },
    );
    if (!settings) {
      throw new InternalServerErrorException({ code: "INTERNAL" });
    }

    return {
      ...membership,
      mfa: {
        required: membership.roles.some((role) =>
          settings.require_mfa_roles.includes(role),
        ),
        satisfied: aal === "aal2",
      },
    };
  }

  private async withUserTx<T>(
    userId: string,
    operation: (trx: Kysely<Database>) => Promise<T>,
  ) {
    return this.database.transaction().execute(async (trx) => {
      await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
      return operation(trx);
    });
  }

  private async withTenantUserTx<T>(
    userId: string,
    tenantId: string,
    operation: (trx: Kysely<Database>) => Promise<T>,
  ) {
    return this.database.transaction().execute(async (trx) => {
      await sql`select set_config('app.user_id', ${userId}, true),
                       set_config('app.tenant_id', ${tenantId}, true)`.execute(
        trx,
      );
      return operation(trx);
    });
  }

  private hashToken(token: string): string {
    if (token.length < 32 || token.length > 512) {
      throw new NotFoundException({ code: "NOT_FOUND" });
    }
    return createHash("sha256").update(token).digest("hex");
  }

  private async compensateAuthUser(userId: string) {
    const { error } = await this.supabase.auth.admin.deleteUser(userId);
    if (error)
      this.logger.error("Failed to compensate a newly created Auth user");
  }

  private throwInvitationState(status: string): never {
    if (status === "REVOKED" || status === "EXPIRED" || status === "ACCEPTED") {
      throw new GoneException({ code: "INVITATION_EXPIRED", status });
    }
    throw new UnprocessableEntityException({ code: "INVITATION_EXPIRED" });
  }

  private throwInvitationError(error: unknown): never {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("INVITATION_NOT_FOUND")) {
      throw new NotFoundException({ code: "NOT_FOUND" });
    }
    if (
      message.includes("INVITATION_ALREADY_USED") ||
      message.includes("INVITATION_REVOKED") ||
      message.includes("INVITATION_EXPIRED")
    ) {
      throw new GoneException({ code: "INVITATION_EXPIRED" });
    }
    if (message.includes("INVITATION_EMAIL_MISMATCH")) {
      throw new ForbiddenException({ code: "INVITATION_EMAIL_MISMATCH" });
    }
    if (message.includes("TENANT_UNAVAILABLE")) {
      throw new HttpException({ code: "TENANT_SUSPENDED" }, HttpStatus.LOCKED);
    }
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException
    ) {
      throw error;
    }
    throw new InternalServerErrorException({ code: "INTERNAL" });
  }
}
