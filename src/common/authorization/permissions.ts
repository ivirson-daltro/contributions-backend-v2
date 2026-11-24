export const ROLE_PERMISSIONS = {
  TENANT_ADMIN: [
    "dashboard:read",
    "fees:calculate",
    "members:read-list",
    "members:read-detail",
    "members:write",
    "members:manage",
    "contributors-report:read",
    "users:manage",
    "catalogs:read",
    "catalogs:write",
    "contributions:read",
    "contributions:write",
    "contributions-report:generate",
    "expenses:read",
    "expenses:write",
    "expenses-report:generate",
    "month:set-opening-balance",
    "month:set-cash-on-hand",
    "month:close",
    "month:reopen",
    "payables:read",
    "payables:write",
    "audit:read",
    "tenant-settings:write",
    "data:export",
  ],
  TREASURER: [
    "dashboard:read",
    "fees:calculate",
    "members:read-list",
    "members:read-detail",
    "members:manage",
    "catalogs:read",
    "catalogs:write",
    "contributions:read",
    "contributions:write",
    "contributions-report:generate",
    "expenses:read",
    "expenses:write",
    "expenses-report:generate",
    "month:set-opening-balance",
    "month:set-cash-on-hand",
    "month:close",
    "month:reopen",
    "payables:read",
    "payables:write",
  ],
  SECRETARY: [
    "dashboard:read",
    "members:read-list",
    "members:read-detail",
    "members:write",
    "members:manage",
    "catalogs:read",
    "contributions:read",
    "contributions:write",
  ],
  FISCAL: [
    "dashboard:read",
    "members:read-list",
    "catalogs:read",
    "contributions:read",
    "expenses:read",
    "payables:read",
    "audit:read",
  ],
  PRESIDENT: [
    "dashboard:read",
    "members:read-list",
    "members:read-detail",
    "contributors-report:read",
    "catalogs:read",
    "contributions:read",
    "expenses:read",
    "month:reopen",
    "payables:read",
    "audit:read",
  ],
} as const;

export type TenantRole = keyof typeof ROLE_PERMISSIONS;
export type Permission = (typeof ROLE_PERMISSIONS)[TenantRole][number];

export function permissionsForRoles(roles: readonly string[]): Permission[] {
  const permissions = new Set<Permission>();
  for (const role of roles) {
    if (role in ROLE_PERMISSIONS) {
      for (const permission of ROLE_PERMISSIONS[role as TenantRole]) {
        permissions.add(permission);
      }
    }
  }
  return [...permissions].sort();
}
