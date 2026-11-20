import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { Request, Response } from "express";
import { Observable, catchError, from, mergeMap, of, throwError } from "rxjs";
import { sql } from "kysely";
import { TenantTransactions } from "../database/database.module";
import { TenantContext } from "../tenant/tenant-context";
import { REQUIRE_IDEMPOTENCY_KEY } from "./require-idempotency.decorator";

interface IdempotencyRow {
  request_hash: string;
  status_code: number | null;
  response: unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly transactions: TenantTransactions,
    private readonly tenantContext: TenantContext,
  ) {}

  intercept(
    execution: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_IDEMPOTENCY_KEY,
      [execution.getHandler(), execution.getClass()],
    );
    if (!required) return next.handle();

    const request = execution
      .switchToHttp()
      .getRequest<
        Request & { tenantContext?: { tenantId?: string; userId?: string } }
      >();
    const response = execution.switchToHttp().getResponse<Response>();
    const context = this.tenantContext.current();
    const tenantId = context?.tenantId;
    const userId = context?.userId;
    const keyHeader = request.header("Idempotency-Key");
    const key = keyHeader?.trim();

    if (!key) {
      throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    }
    if (key.length > 200 || !tenantId || !userId) {
      throw new BadRequestException({ code: "VALIDATION_ERROR" });
    }

    const requestHash = createHash("sha256")
      .update(stableJson(request.body ?? {}))
      .digest("hex");

    return from(this.reserve(tenantId, userId, key, requestHash)).pipe(
      mergeMap((cached) => {
        if (cached) {
          response.status(cached.status_code ?? 200);
          return of(cached.response);
        }

        return next.handle().pipe(
          mergeMap(async (body) => {
            await this.complete(
              tenantId,
              userId,
              key,
              response.statusCode,
              body,
            );
            return body;
          }),
          catchError((error: unknown) =>
            from(this.release(tenantId, userId, key)).pipe(
              mergeMap(() => throwError(() => error)),
            ),
          ),
        );
      }),
    );
  }

  private reserve(
    tenantId: string,
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyRow | undefined> {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const inserted = await sql<{ key: string }>`
        insert into idempotency_keys (tenant_id, key, request_hash)
        values (${tenantId}::uuid, ${key}, ${requestHash})
        on conflict (tenant_id, key) do nothing
        returning key
      `.execute(trx);
      if (inserted.rows.length) return undefined;

      const existing = await sql<IdempotencyRow>`
        select request_hash, status_code, response
          from idempotency_keys
         where tenant_id = ${tenantId}::uuid and key = ${key}
      `.execute(trx);
      const row = existing.rows[0];
      if (!row)
        throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
      if (row.request_hash !== requestHash) {
        throw new UnprocessableEntityException({
          code: "IDEMPOTENCY_KEY_REUSED",
        });
      }
      if (row.status_code === null) {
        throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS" });
      }
      return row;
    });
  }

  private complete(
    tenantId: string,
    userId: string,
    key: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      await sql`
        update idempotency_keys
           set status_code = ${statusCode}, response = ${JSON.stringify(body)}::jsonb
         where tenant_id = ${tenantId}::uuid and key = ${key}
      `.execute(trx);
    });
  }

  private release(
    tenantId: string,
    userId: string,
    key: string,
  ): Promise<void> {
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      await sql`
        delete from idempotency_keys
         where tenant_id = ${tenantId}::uuid and key = ${key} and status_code is null
      `.execute(trx);
    });
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
