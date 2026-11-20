import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { MfaGuard } from "./mfa.guard";
import { TenantContext } from "./tenant-context";
import { TenantGuard } from "./tenant.guard";

@Global()
@Module({
  providers: [
    TenantContext,
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: MfaGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [TenantContext],
})
export class TenantModule {}
