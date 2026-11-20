import type { TenantRequestContext } from "../tenant/tenant-context";

export interface AuthenticatedUser {
  userId: string;
  aal?: string;
  email?: string;
}

export interface AuthenticatedRequest {
  headers: {
    authorization?: string;
    "x-tenant-id"?: string | string[];
  };
  method: string;
  url: string;
  authenticatedUser?: AuthenticatedUser;
  requestId?: string;
  tenantContext?: TenantRequestContext;
}
