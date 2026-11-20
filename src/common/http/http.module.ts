import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { AuditService } from "../audit/audit.service";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { ProblemDetailsFilter } from "./problem-details.filter";

@Global()
@Module({
  providers: [
    AuditService,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [AuditService],
})
export class HttpModule {}
