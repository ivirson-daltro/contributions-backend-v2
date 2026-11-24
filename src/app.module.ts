import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./common/auth/auth.module";
import { DatabaseModule } from "./common/database/database.module";
import { HttpModule } from "./common/http/http.module";
import { TenantModule } from "./common/tenant/tenant.module";
import { AuthModule as AuthFeatureModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { ContributionsModule } from "./modules/contributions/contributions.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { MembersModule } from "./modules/members/members.module";

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    TenantModule,
    HttpModule,
    AuthFeatureModule,
    PlatformModule,
    DashboardModule,
    ContributionsModule,
    MembersModule,
    HealthModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
