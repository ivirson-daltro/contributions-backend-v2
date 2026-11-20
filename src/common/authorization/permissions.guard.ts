import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Permission } from "./permissions";
import { REQUIRED_PERMISSIONS_KEY } from "./require-permissions.decorator";
import { TenantContext } from "../tenant/tenant-context";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContext,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;
    const granted = new Set(this.tenantContext.current()?.permissions ?? []);
    if (required.every((permission) => granted.has(permission))) return true;
    throw new ForbiddenException({ code: "FORBIDDEN" });
  }
}
