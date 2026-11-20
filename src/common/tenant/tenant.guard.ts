import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sql } from "kysely";
import { AuthenticatedRequest } from "../auth/authenticated-user";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { TenantTransactions } from "../database/database.module";
import { TenantContext } from "./tenant-context";
import { TENANT_OPTIONAL_KEY } from "./tenant-optional.decorator";

interface MembershipContextRow {
  membership_id: string;
  membership_status: string;
  tenant_status: string;
  timezone: string;
  roles: string[];
}

interface TenantSettingsRow {
  require_mfa_roles: string[];
}

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly transactions: TenantTransactions,
    private readonly tenantContext: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.authenticatedUser;
    const tenantOptional = this.reflector.getAllAndOverride<boolean>(
      TENANT_OPTIONAL_KEY,
      [context.getHandler(), context.getClass()],
    );

    const tenantHeader = request.headers["x-tenant-id"];
    const tenantId = Array.isArray(tenantHeader)
      ? tenantHeader[0]
      : tenantHeader;

    if (!user && !tenantId && tenantOptional) return true;
    if (!user) throw new UnauthorizedException({ code: "UNAUTHENTICATED" });

    if (!tenantId) {
      if (tenantOptional) return true;
      throw new BadRequestException({ code: "TENANT_REQUIRED" });
    }
    if (!tenantIdPattern.test(tenantId)) {
      throw new BadRequestException({ code: "VALIDATION_ERROR" });
    }

    const membership = await this.transactions.withUserTx(
      user.userId,
      async (transaction) => {
        const result = await sql<MembershipContextRow>`
          select tm.id as membership_id, tm.status as membership_status,
                 t.status as tenant_status, t.timezone,
                 coalesce(array_agg(mr.role order by mr.role)
                   filter (where mr.role is not null), array[]::text[]) as roles
            from tenant_memberships tm
            join tenants t on t.id = tm.tenant_id
            left join membership_roles mr on mr.membership_id = tm.id
           where tm.user_id = ${user.userId}::uuid
             and tm.tenant_id = ${tenantId}::uuid
           group by tm.id, t.id
        `.execute(transaction);
        return result.rows[0];
      },
    );

    if (!membership) throw new NotFoundException({ code: "NOT_FOUND" });
    if (membership.membership_status !== "ACTIVE") {
      throw new ForbiddenException({ code: "MEMBERSHIP_INACTIVE" });
    }

    if (membership.tenant_status === "CANCELLED") {
      const allowedCancelledExport =
        request.method === "GET" && request.url.includes("/tenant/export");
      if (!allowedCancelledExport) {
        throw new HttpException(
          { code: "TENANT_CANCELLED" },
          HttpStatus.LOCKED,
        );
      }
    } else if (
      membership.tenant_status === "SUSPENDED" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      throw new HttpException({ code: "TENANT_SUSPENDED" }, HttpStatus.LOCKED);
    }

    const settings = await this.transactions.withTenantTx(
      { tenantId, userId: user.userId },
      async (transaction) => {
        const result = await sql<TenantSettingsRow>`
          select require_mfa_roles from tenant_settings
           where tenant_id = ${tenantId}::uuid
        `.execute(transaction);
        return result.rows[0];
      },
    );
    if (!settings) throw new ServiceUnavailableException({ code: "INTERNAL" });

    this.tenantContext.setTenant({
      requestId: this.tenantContext.current()?.requestId ?? "",
      tenantId,
      userId: user.userId,
      membershipId: membership.membership_id,
      roles: membership.roles,
      tenantStatus: membership.tenant_status,
      timezone: membership.timezone,
      requireMfaRoles: settings.require_mfa_roles,
    });
    request.requestId = this.tenantContext.current()?.requestId;
    request.tenantContext = this.tenantContext.current();

    if (membership.tenant_status === "PAST_DUE") {
      context
        .switchToHttp()
        .getResponse()
        .setHeader("X-Tenant-Warning", "PAST_DUE");
    }
    return true;
  }
}
