import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { Permission, permissionsForRoles } from "../authorization/permissions";

export interface TenantRequestContext {
  requestId: string;
  tenantId?: string;
  userId?: string;
  membershipId?: string;
  roles: string[];
  permissions: Permission[];
  tenantStatus?: string;
  timezone?: string;
  requireMfaRoles: string[];
}

@Injectable()
export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantRequestContext>();

  run(requestId: string, callback: () => void): void {
    this.storage.run(
      { requestId, roles: [], permissions: [], requireMfaRoles: [] },
      callback,
    );
  }

  current(): TenantRequestContext | undefined {
    return this.storage.getStore();
  }

  setTenant(
    context: Omit<TenantRequestContext, "requestId" | "permissions"> & {
      requestId?: string;
    },
  ): void {
    const current = this.storage.getStore();
    if (!current) return;
    Object.assign(current, context, {
      permissions: permissionsForRoles(context.roles),
    });
  }
}
