import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { environment } from "../../config/env";

export interface Database {
  [table: string]: Record<string, unknown>;
}

export const DATABASE = Symbol("DATABASE");

export interface TenantTransactionContext {
  tenantId: string;
  userId: string;
}

@Injectable()
export class TenantTransactions {
  constructor(@Inject(DATABASE) private readonly database: Kysely<Database>) {}

  withTenantTx<T>(
    context: TenantTransactionContext,
    operation: (transaction: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`
        select set_config('app.tenant_id', ${context.tenantId}, true),
               set_config('app.user_id', ${context.userId}, true)
      `.execute(transaction);
      return operation(transaction);
    });
  }

  withUserTx<T>(
    userId: string,
    operation: (transaction: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`select set_config('app.user_id', ${userId}, true)`.execute(
        transaction,
      );
      return operation(transaction);
    });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: () =>
        new Kysely<Database>({
          dialect: new PostgresDialect({
            pool: new Pool({
              connectionString: environment.SUPABASE_DB_URL,
              max: 10,
              idleTimeoutMillis: 30_000,
            }),
          }),
        }),
    },
    TenantTransactions,
  ],
  exports: [DATABASE, TenantTransactions],
})
export class DatabaseModule {}
