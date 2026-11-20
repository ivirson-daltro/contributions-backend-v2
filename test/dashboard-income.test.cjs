const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const source = readFileSync(
  join(__dirname, "..", "src", "modules", "dashboard", "dashboard.service.ts"),
  "utf8",
);
const match = source.match(/income_totals as \(([\s\S]*?)\),\s*expense_totals as \(/);
assert.ok(match, "Não foi encontrada a consulta de entradas do dashboard");

// Datas são dias inteiros para executar o mesmo filtro em SQLite sem um servidor.
const incomeQuery = match[1]
  .replace("${tenantId}::uuid", "'tenant-a'")
  .replace("least(", "min(");
const day = (date) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

function calculate(calendar, contributions) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table calendar (today integer, week_start integer, month_start integer);
      create table contributions (tenant_id text, status text, occurred_on integer, amount integer);
    `);
    db.prepare("insert into calendar values (?, ?, ?)").run(
      day(calendar.today),
      day(calendar.weekStart),
      day(calendar.monthStart),
    );
    const insert = db.prepare("insert into contributions values (?, ?, ?, ?)");
    for (const contribution of contributions) {
      insert.run(
        contribution.tenant ?? "tenant-a",
        contribution.status ?? "ACTIVE",
        day(contribution.date),
        contribution.cents,
      );
    }
    return db.prepare(incomeQuery).get();
  } finally {
    db.close();
  }
}

test("entradas mensais incluem o início do mês, sem incluir outros tenants ou canceladas", () => {
  const result = calculate(
    { today: "2026-11-20", weekStart: "2026-11-16", monthStart: "2026-11-01" },
    [
      { date: "2026-11-01", cents: 595214 },
      { date: "2026-11-10", cents: 423057 },
      { date: "2026-11-01", cents: 10000, status: "VOIDED" },
      { date: "2026-11-01", cents: 10000, tenant: "tenant-b" },
    ],
  );
  assert.equal(result.month, 1018271);
  assert.equal(result.month_count, 2);
  assert.equal(result.previous_week, 423057);
  assert.equal(result.previous_week_count, 1);
  assert.equal(result.week, 0);
});

test("semana anterior continua incluindo dias do ano anterior", () => {
  const result = calculate(
    { today: "2026-01-03", weekStart: "2025-12-29", monthStart: "2026-01-01" },
    [
      { date: "2025-12-27", cents: 12500 },
      { date: "2026-01-02", cents: 30000 },
    ],
  );
  assert.equal(result.previous_week, 12500);
  assert.equal(result.previous_week_count, 1);
  assert.equal(result.week, 30000);
  assert.equal(result.month, 30000);
  assert.equal(result.month_count, 1);
});
