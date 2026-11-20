import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticatedRequest } from "../auth/authenticated-user";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { TenantContext } from "./tenant-context";
import { SKIP_MFA_KEY } from "./tenant-optional.decorator";

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContext,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const skipMfa = this.reflector.getAllAndOverride<boolean>(SKIP_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipMfa || isPublic) return true;

    const tenant = this.tenantContext.current();
    if (!tenant?.tenantId) return true;
    const user = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().authenticatedUser;
    const required = tenant.roles.some((role) =>
      tenant.requireMfaRoles.includes(role),
    );
    if (required && user?.aal !== "aal2") {
      throw new ForbiddenException({ code: "MFA_REQUIRED" });
    }
    return true;
  }
}
