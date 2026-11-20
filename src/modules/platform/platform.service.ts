import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Kysely, sql } from "kysely";
import { createHash, randomBytes } from "node:crypto";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import {
  DATABASE,
  Database,
  TenantTransactions,
} from "../../common/database/database.module";
import { CreateTenantDto, IssueAdminInvitationDto } from "./platform.dto";

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  trial_ends_at: Date | null;
  timezone: string;
}

export interface TenantListRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  timezone: string;
  trial_ends_at: Date | null;
  created_at: Date;
  active_users: number;
  active_members: number;
  storage_bytes: number;
  has_active_tenant_admin: boolean;
  pending_admin_invitation_expires_at: Date | null;
}

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    @Inject(DATABASE) private readonly database: Kysely<Database>,
    private readonly transactions: TenantTransactions,
  ) {}

  async ensurePlatformAdmin(user: AuthenticatedUser): Promise<void> {
    const result = await sql<{ exists: boolean }>`
      select v2_is_platform_admin(${user.userId}::uuid) as exists
    `.execute(this.database);

    if (!result.rows[0]?.exists) {
      throw new ForbiddenException({ code: "FORBIDDEN" });
    }
    if (user.aal !== "aal2") {
      throw new ForbiddenException({ code: "MFA_REQUIRED" });
    }
  }

  async listTenants(user: AuthenticatedUser) {
    await this.ensurePlatformAdmin(user);
    const result = await this.transactions.withUserTx(user.userId, (trx) =>
      sql<TenantListRow>`
        select * from v2_platform_list_tenants()
      `.execute(trx),
    );

    return {
      items: result.rows.map((tenant) => ({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        timezone: tenant.timezone,
        trialEndsAt: tenant.trial_ends_at,
        createdAt: tenant.created_at,
        metrics: {
          activeUsers: tenant.active_users,
          activeMembers: tenant.active_members,
          storageBytes: tenant.storage_bytes,
        },
        hasActiveTenantAdmin: tenant.has_active_tenant_admin,
        pendingAdminInvitationExpiresAt:
          tenant.pending_admin_invitation_expires_at,
      })),
      meta: { count: result.rows.length },
    };
  }

  async createTenant(user: AuthenticatedUser, payload: CreateTenantDto) {
    await this.ensurePlatformAdmin(user);

    if (!payload.name || !payload.slug || !payload.adminEmail) {
      throw new BadRequestException({ code: "VALIDATION_ERROR" });
    }

    const expiresAt = payload.expiresAt
      ? new Date(payload.expiresAt)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const token = this.makeInviteToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const tenant = await this.transactions.withUserTx(
      user.userId,
      async (trx) => {
        const result = await sql<{ tenant_id: string }>`
        select v2_platform_create_tenant(
          ${payload.slug},
          ${payload.name},
          ${payload.document ?? null},
          ${payload.timezone ?? "America/Sao_Paulo"},
          ${payload.adminEmail},
          ${payload.adminName ?? payload.name},
          ${tokenHash},
          ${expiresAt.toISOString()}
        ) as tenant_id
      `.execute(trx);

        const tenantId = result.rows[0]?.tenant_id;
        if (!tenantId) {
          throw new InternalServerErrorException({ code: "INTERNAL" });
        }

        const tenantResult = await sql<TenantRow>`
        select id, slug, name, status, trial_ends_at, timezone
          from tenants where id = ${tenantId}::uuid
      `.execute(trx);
        return tenantResult;
      },
    );

    return {
      tenant: tenant.rows[0],
      invite: {
        token,
        expiresAt,
        email: payload.adminEmail,
        roles: ["TENANT_ADMIN"],
      },
    };
  }

  async issueAdminInvitation(
    user: AuthenticatedUser,
    tenantId: string,
    payload: IssueAdminInvitationDto,
  ) {
    await this.ensurePlatformAdmin(user);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        tenantId,
      )
    ) {
      throw new BadRequestException({ code: "VALIDATION_ERROR" });
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const token = this.makeInviteToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const invitationId = await this.transactions.withUserTx(
      user.userId,
      async (trx) => {
        const result = await sql<{ invitation_id: string }>`
          select v2_platform_issue_admin_invitation(
            ${tenantId}::uuid,
            ${payload.email},
            ${payload.name},
            ${tokenHash},
            ${expiresAt.toISOString()}
          ) as invitation_id
        `.execute(trx);
        return result.rows[0]?.invitation_id;
      },
    );

    if (!invitationId) {
      throw new InternalServerErrorException({ code: "INTERNAL" });
    }

    return {
      tenantId,
      invitation: {
        id: invitationId,
        token,
        expiresAt,
        email: payload.email,
        roles: ["TENANT_ADMIN"],
      },
    };
  }

  async findTenantBySlug(slug: string) {
    const result = await sql<TenantRow>`
      select id, slug, name, status, trial_ends_at, timezone
        from tenants where lower(slug) = lower(${slug})
    `.execute(this.database);

    const tenant = result.rows[0];
    if (!tenant) throw new NotFoundException({ code: "NOT_FOUND" });
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      timezone: tenant.timezone,
      trialEndsAt: tenant.trial_ends_at,
    };
  }

  private makeInviteToken() {
    return `invite_${randomBytes(32).toString("base64url")}`;
  }
}
