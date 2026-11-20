import { SetMetadata } from "@nestjs/common";

export const TENANT_OPTIONAL_KEY = "tenantOptional";
export const TenantOptional = () => SetMetadata(TENANT_OPTIONAL_KEY, true);

export const SKIP_MFA_KEY = "skipMfa";
export const SkipMfa = () => SetMetadata(SKIP_MFA_KEY, true);
