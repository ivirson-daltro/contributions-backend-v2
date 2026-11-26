const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { Kysely, PostgresDialect } = require("kysely");

const source = readFileSync(join(__dirname, "..", "src", "modules", "dashboard", "dashboard.service.ts"), "utf8");
const match = source.match(/select coalesce\(sum\(c\.amount\), 0\.00\)::text([\s\S]*?)\s*\) end as total/);
assert.ok(match, "Não foi encontrado o cálculo do indicador por tipo");
const query = `select coalesce(sum(c.amount), 0.00)${match[1]}`
  .replace("${tenantId}::uuid", "'tenant-a'")
  .replace("(now() at time zone t.timezone)::date", "'2026-11-25'")
  .replace("selected.id", "'type-1'");

test("total acumulado considera somente contribuições ativas do tipo e igreja até hoje", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table tenants (id text, timezone text);
      create table contributions (tenant_id text, contribution_type_id text, status text, occurred_on text, amount integer);
      insert into tenants values ('tenant-a', 'America/Sao_Paulo'), ('tenant-b', 'America/Sao_Paulo');
      insert into contributions values
        ('tenant-a', 'type-1', 'ACTIVE', '2020-01-01', 100),
        ('tenant-a', 'type-1', 'ACTIVE', '2026-11-25', 50),
        ('tenant-a', 'type-1', 'ACTIVE', '2026-11-26', 500),
        ('tenant-a', 'type-1', 'VOIDED', '2026-01-01', 500),
        ('tenant-a', 'type-2', 'ACTIVE', '2026-01-01', 500),
        ('tenant-b', 'type-1', 'ACTIVE', '2026-01-01', 500);
    `);
    assert.equal(Object.values(db.prepare(query).get())[0], 150);
    db.exec("delete from contributions where tenant_id = 'tenant-a' and contribution_type_id = 'type-1'");
    assert.equal(Object.values(db.prepare(query).get())[0], 0);
  } finally {
    db.close();
  }
});

test("personalização valida o tipo da igreja, registra auditoria e aceita restaurar o padrão", async () => {
  Object.assign(process.env, {
    SUPABASE_DB_URL: "postgresql://localhost/test",
    SUPABASE_DB_OWNER_URL: "postgresql://localhost/test",
    SUPABASE_URL: "https://example.test",
    SUPABASE_JWKS_URL: "https://example.test/jwks",
    SUPABASE_SERVICE_KEY: "test",
    APP_BASE_DOMAIN: "example.test",
  });
  const { DashboardService } = require("../dist/modules/dashboard/dashboard.service");
  const { dashboardCardSchema } = require("../dist/modules/dashboard/dashboard.dto");
  const { DashboardController } = require("../dist/modules/dashboard/dashboard.controller");
  const { REQUIRED_PERMISSIONS_KEY } = require("../dist/common/authorization/require-permissions.decorator");
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, DashboardController.prototype.updateCard), ["tenant-settings:write"]);
  assert.equal(dashboardCardSchema.safeParse({}).success, false);
  assert.equal(dashboardCardSchema.safeParse({ contributionTypeId: "invalid" }).success, false);
  assert.equal(dashboardCardSchema.safeParse({ contributionTypeId: null }).success, true);

  const database = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const queries = [];
  let validType = true;
  const executor = new Proxy(database.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") return async (query) => {
        queries.push(query);
        if (query.sql.includes("for update")) return { rows: [{ contribution_type_id: null }] };
        if (query.sql.includes("from contribution_types")) return { rows: validType ? [{ id: "type-a" }] : [] };
        return { rows: [] };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const audits = [];
  const service = new DashboardService({
    withTenantTx: async (context, callback) => {
      assert.deepEqual(context, { tenantId: "tenant-a", userId: "user-a" });
      return callback({ getExecutor: () => executor });
    },
  }, { record: async (_transaction, record) => audits.push(record) });
  await service.updateCard("tenant-a", "user-a", "type-a");
  assert.match(queries[1].sql, /tenant_id = \$1::uuid and id = \$2::uuid and active/);
  assert.deepEqual(queries[1].parameters, ["tenant-a", "type-a"]);
  assert.deepEqual(audits[0].after, { contributionTypeId: "type-a" });
  validType = false;
  await assert.rejects(service.updateCard("tenant-a", "user-a", "other-type"), { status: 400 });
  assert.equal(audits.length, 1);
  await service.updateCard("tenant-a", "user-a", null);
  assert.deepEqual(audits[1].after, { contributionTypeId: null });
  await database.destroy();
});
