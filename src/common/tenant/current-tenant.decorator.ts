import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { TenantRequestContext } from "./tenant-context";

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context
      .switchToHttp()
      .getRequest<{ tenantContext?: TenantRequestContext }>().tenantContext,
);
