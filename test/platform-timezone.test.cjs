const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Kysely, PostgresDialect } = require("kysely");

Object.assign(process.env, {
  NODE_ENV: "test",
  SUPABASE_DB_URL: "postgresql://localhost/test",
  SUPABASE_DB_OWNER_URL: "postgresql://localhost/test",
  SUPABASE_URL: "https://example.test",
  SUPABASE_JWKS_URL: "https://example.test/jwks",
  SUPABASE_SERVICE_KEY: "test",
  APP_BASE_DOMAIN: "example.test",
});
require("reflect-metadata");
const { PlatformService } = require("../dist/modules/platform/platform.service");

test("nova igreja usa o fuso de São Paulo quando não informado", async () => {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  let timezone;
  const executor = new Proxy(db.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") return async ({ sql, parameters }) => {
        if (sql.includes("v2_is_platform_admin")) return { rows: [{ exists: true }] };
        if (sql.includes("v2_platform_create_tenant")) {
          timezone = parameters[3];
          return { rows: [{ tenant_id: "tenant-id" }] };
        }
        if (sql.includes("from tenants")) return { rows: [{ id: "tenant-id", timezone }] };
        throw new Error(`Consulta inesperada: ${sql}`);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const queryable = { getExecutor: () => executor };
  const service = new PlatformService(queryable, {
    withUserTx: async (_user, operation) => operation(queryable),
  });
  const result = await service.createTenant({ userId: "user", aal: "aal2" }, {
    name: "Igreja", slug: "igreja", adminEmail: "admin@example.com",
  });
  assert.equal(timezone, "America/Sao_Paulo");
  assert.equal(result.tenant.timezone, "America/Sao_Paulo");
});
