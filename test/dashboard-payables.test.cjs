const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { Kysely, PostgresDialect } = require("kysely");

const source = readFileSync(
  join(__dirname, "..", "src", "modules", "dashboard", "dashboard.service.ts"),
  "utf8",
);
const match = source.match(/payable_totals as \(([\s\S]*?)\)\s*select\s+p\.year/);
assert.ok(match, "Não foi encontrada a consulta de contas do dashboard");

const payableQuery = match[1]
  .replace("${tenantId}::uuid", "'tenant-a'")
  .replaceAll("jsonb_agg", "json_group_array")
  .replaceAll("jsonb_build_object", "json_object")
  .replaceAll("'[]'::jsonb", "'[]'")
  .replace(/o\.(due_date|amount)::text/g, "cast(o.$1 as text)");

test("listas incluem somente ocorrências abertas do tenant nas janelas corretas", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table calendar (today integer);
      insert into calendar values (100);
      create table payables (id text, tenant_id text, description text);
      create table payable_occurrences (
        id text, payable_id text, tenant_id text, status text, due_date integer, amount integer
      );
      insert into payables values
        ('p1', 'tenant-a', 'Energia'), ('p2', 'tenant-a', 'Internet'),
        ('p3', 'tenant-a', 'Outra'), ('p4', 'tenant-b', 'Outro tenant');
      insert into payable_occurrences values
        ('o1', 'p1', 'tenant-a', 'OPEN', 98, 1240),
        ('o2', 'p2', 'tenant-a', 'OPEN', 100, 199),
        ('o3', 'p3', 'tenant-a', 'OPEN', 107, null),
        ('o4', 'p3', 'tenant-a', 'OPEN', 108, 500),
        ('o5', 'p1', 'tenant-a', 'PAID', 99, 500),
        ('o6', 'p4', 'tenant-b', 'OPEN', 99, 500),
        ('o7', 'p1', 'tenant-a', 'CANCELED', 101, 500),
        ('o8', 'p1', 'tenant-a', 'OPEN', null, 500);
    `);
    const result = db.prepare(payableQuery).get();
    assert.equal(result.overdue_count, 1);
    assert.equal(result.next_7_days_count, 2);
    assert.equal(result.next_7_days_amount, 199);
    assert.deepEqual(JSON.parse(result.overdue_items), [
      { id: "o1", payableId: "p1", description: "Energia", dueDate: "98", expectedAmount: "1240" },
    ]);
    assert.deepEqual(JSON.parse(result.next_7_days_items), [
      { id: "o2", payableId: "p2", description: "Internet", dueDate: "100", expectedAmount: "199" },
      { id: "o3", payableId: "p3", description: "Outra", dueDate: "107", expectedAmount: null },
    ]);
  } finally {
    db.close();
  }
});

test("cache do resumo não expõe detalhes a quem não tem payables:read", async () => {
  Object.assign(process.env, {
    SUPABASE_DB_URL: "postgresql://localhost/test",
    SUPABASE_DB_OWNER_URL: "postgresql://localhost/test",
    SUPABASE_URL: "https://example.test",
    SUPABASE_JWKS_URL: "https://example.test/jwks",
    SUPABASE_SERVICE_KEY: "test",
    APP_BASE_DOMAIN: "example.test",
  });
  const { DashboardService } = require("../dist/modules/dashboard/dashboard.service");
  const database = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const payable = { id: "o1", payableId: "p1", description: "Energia", dueDate: "2026-11-18", expectedAmount: "1240.00" };
  let queries = 0;
  const executor = new Proxy(database.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") {
        return async (query) => {
          if (query.sql.includes("dashboard_contribution_type_id")) {
            return { rows: [{ contribution_type_id: null, contribution_type_name: null, total: null, contribution_types: [] }] };
          }
          queries++;
          return {
            rows: [{
              year: 2026, month: 11, today: "2026-11-20", week_start: "2026-11-16", week_starts_on: 1,
              income_week: "0", income_previous_week: "0", income_month: "0",
              income_week_count: 0, income_previous_week_count: 0, income_month_count: 0,
              expense_week: "0", expense_month: "0", expense_year: "0",
              expense_week_count: 0, expense_month_count: 0, expense_year_count: 0,
              kinds_week: {}, kinds_previous_week: {}, kinds_month: {},
              opening_balance: null, opening_defined: false, cash_on_hand: null,
              month_balance: "0", final_balance: null, accumulated: null,
              active_members: 0, contributors_month: 0, construction_total: "0", construction_count: 0,
              overdue_count: 1, next_7_days_count: 0, next_7_days_amount: "0",
              overdue_items: [payable], next_7_days_items: [],
            }],
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new DashboardService({
    withTenantTx: async (_context, callback) => callback({ getExecutor: () => executor }),
  });

  const allowed = await service.getSummary("tenant-a", "user-a", true);
  const denied = await service.getSummary("tenant-a", "user-b", false);
  assert.deepEqual(allowed.payables.overdue, [payable]);
  assert.equal(denied.payables.overdue, null);
  assert.equal(denied.payables.next7Days, null);
  assert.equal(denied.payables.overdueCount, 1);
  assert.equal(queries, 1);

  const deniedFirst = await service.getSummary("tenant-b", "user-b", false);
  const allowedAfter = await service.getSummary("tenant-b", "user-a", true);
  assert.equal(deniedFirst.payables.overdue, null);
  assert.deepEqual(allowedAfter.payables.overdue, [payable]);
  assert.equal(queries, 2);
});
