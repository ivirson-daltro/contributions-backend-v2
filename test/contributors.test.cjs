const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { Kysely, PostgresDialect } = require("kysely");
const PdfPrinter = require("pdfmake");

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
const { ContributorsService, contributorsDocument } = require("../dist/modules/members/contributors.service");
const { contributorYearQuerySchema, contributorReportQuerySchema } = require("../dist/modules/members/contributors.dto");
const { MembersController } = require("../dist/modules/members/members.controller");
const { REQUIRED_PERMISSIONS_KEY } = require("../dist/common/authorization/require-permissions.decorator");

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.function("app_norm", (value) => value === null ? null : value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase());
  sqlite.exec(`
    create table members (id text, tenant_id text, name text, member_type_id text, status text, deleted_at text);
    create table member_types (id text, tenant_id text, description text);
    create table contribution_types (id text, tenant_id text, counts_as_contributor integer);
    create table contributions (tenant_id text, member_id text, contribution_type_id text, status text, occurred_on text, category_snapshot text);
    insert into member_types values ('type', 'a', 'Membro'), ('visitor', 'a', 'Visitante'), ('type', 'b', 'Membro');
    insert into contribution_types values ('yes', 'a', 1), ('no', 'a', 0), ('yes', 'b', 1);
    insert into members values ('ana', 'a', 'Ana', 'type', 'ACTIVE', null),
      ('bia', 'a', 'Bia', 'visitor', 'INACTIVE', null), ('deleted', 'a', 'Excluído', 'type', 'ACTIVE', '2026-01-01'),
      ('other', 'b', 'Outro tenant', 'type', 'ACTIVE', null), ('no', 'a', 'Sem contribuições', 'type', 'ACTIVE', null);
    insert into contributions values
      ('a','ana','yes','ACTIVE','2026-01-01','TITHE'), ('a','ana','yes','ACTIVE','2026-01-20','TITHE'),
      ('a','ana','yes','ACTIVE','2026-12-31','TITHE'), ('a','ana','yes','VOIDED','2026-03-01','TITHE'),
      ('a','ana','yes','ACTIVE','2026-05-01','OFFERING'), ('a','ana','no','ACTIVE','2026-06-01','TITHE'),
      ('a','ana','yes','ACTIVE','2027-01-01','TITHE'),
      ('a','bia','yes','ACTIVE','2026-02-01','TITHE'), ('a','deleted','yes','ACTIVE','2026-03-01','TITHE'),
      ('a','no','no','ACTIVE','2026-04-01','TITHE'),
      ('a',null,'yes','ACTIVE','2026-04-01','TITHE'), ('b','other','yes','ACTIVE','2026-04-01','TITHE');
  `);
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const executor = new Proxy(db.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") return async ({ sql, parameters }) => {
        if (sql.includes("from tenants t")) {
          return { rows: [{ name: "Igreja", document: null, timezone: "America/Sao_Paulo", display_name: "Admin" }] };
        }
        const adapted = sql
          .replace("array_agg(distinct extract(month from c.occurred_on)::int)", "json_group_array(distinct cast(strftime('%m', c.occurred_on) as integer))")
          .replace(/::(?:uuid|date|text)/g, "")
          .replace(/\$(\d+)/g, "?$1");
        const rows = sqlite.prepare(adapted).all(...parameters);
        return { rows: rows.map((row) => ({ ...row, contributed_months: row.contributed_months ? JSON.parse(row.contributed_months) : null })) };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const contexts = [];
  const logos = { getForReport: async () => null };
  const service = new ContributorsService({
    withTenantTx: async (context, callback) => {
      contexts.push(context);
      return callback({ getExecutor: () => executor });
    },
  }, logos);
  return { service, sqlite, contexts, logos, queryable: { getExecutor: () => executor } };
}

test("matriz anual conta cada mês uma vez, respeita filtros e isolamento", async () => {
  const { service, sqlite, contexts } = setup();
  try {
    const result = await service.list("a", "user", { year: "2026" });
    assert.equal(result.meta.total, 2);
    assert.deepEqual(result.data.map((item) => item.name), ["Ana", "Bia"]);
    assert.deepEqual(result.data[0].months, [true, false, false, false, true, false, false, false, false, false, false, true]);
    assert.deepEqual(result.data[1].months, [false, true, false, false, false, false, false, false, false, false, false, false]);
    assert.deepEqual(result.data[0].memberType, { id: "type", description: "Membro" });
    const filtered = await service.list("a", "user", { year: "2026", q: "aNA" });
    assert.equal(filtered.meta.total, 1);
    const page = await service.list("a", "user", { year: "2026", page: "2", pageSize: "1", order: "desc" });
    assert.equal(page.meta.total, 2);
    assert.deepEqual(page.data.map((item) => item.name), ["Ana"]);
    const empty = await service.list("a", "user", { year: "2026", page: "9", pageSize: "1" });
    assert.equal(empty.meta.total, 2);
    assert.deepEqual(empty.data, []);
    const byType = await service.list("a", "user", { year: "2026", sort: "type", order: "desc" });
    assert.deepEqual(byType.data.map((item) => item.name), ["Bia", "Ana"]);
    assert.equal((await service.list("a", "user", { year: "2025" })).meta.total, 0);
    assert.deepEqual(contexts[0], { tenantId: "a", userId: "user" });
  } finally {
    sqlite.close();
  }
});

test("tipos configurados determinam os contribuintes e meses, independentemente da categoria", async () => {
  const { service, sqlite } = setup();
  try {
    const before = await service.list("a", "user", { year: "2026" });
    assert.deepEqual(before.data.map((item) => item.name), ["Ana", "Bia"]);
    assert.equal(before.data[0].months[4], true);
    assert.equal(before.data[0].months[5], false);
    sqlite.prepare("update contribution_types set counts_as_contributor = 1 where tenant_id = ? and id = ?").run("a", "no");
    const after = await service.list("a", "user", { year: "2026" });
    assert.deepEqual(after.data.map((item) => item.name), ["Ana", "Bia", "Sem contribuições"]);
    assert.equal(after.data[0].months[5], true);
    assert.equal(after.data[2].months[3], true);
  } finally {
    sqlite.close();
  }
});

test("PDF usa a mesma matriz, sem paginação, e indica ausência de contribuintes", async () => {
  const { service, sqlite, queryable, logos } = setup();
  try {
    const logo = await require("sharp")({ create: { width: 3, height: 3, channels: 3, background: "#123456" } }).png().toBuffer();
    const logoCalls = [];
    logos.getForReport = async (tenantId, userId) => {
      logoCalls.push({ tenantId, userId });
      return `data:image/png;base64,${logo.toString("base64")}`;
    };
    const rows = await service.findAll(queryable, "a", { year: "2026" });
    const list = await service.list("a", "user", { year: "2026", pageSize: "1" });
    assert.deepEqual(rows[0], list.data[0]);
    assert.equal(rows.length, 2);
    const header = { name: "Igreja", document: null, timezone: "America/Sao_Paulo" };
    const document = await contributorsDocument(header, "Admin", "2026", rows, new Date("2026-01-01T12:00:00Z"));
    const table = document.content.find((item) => item.table).table;
    assert.equal(table.body.length, 3);
    assert.equal(table.body[1][0].text, "Ana");
    assert.equal(document.pageOrientation ?? "portrait", "portrait");
    assert.equal(table.body[0].length, 3);
    assert.deepEqual(table.body[1][2].columns.map((badge) => badge.svg.match(/>(Jan|Mai|Dez)<\/text>/)?.[1]), ["Jan", "Mai", "Dez"]);
    assert.ok(table.body[1][2].columns.every((badge) => badge.svg.includes('fill="#17365d"')));
    const empty = await contributorsDocument(header, "Admin", "2026", [], new Date());
    assert.ok(empty.content.some((item) => item.text === "Nenhum contribuinte no período."));
    const pdf = await service.report("a", { userId: "user" }, { year: "2026" });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.toString("latin1"), /\/Subtype\s*\/Image\b/);
    assert.deepEqual(logoCalls[0], { tenantId: "a", userId: "user" });
    assert.match(pdf.toString("latin1"), /\/MediaBox \[0 0 595\.28 841\.89\]/);
    for (let month = 1; month <= 12; month++) {
      sqlite.prepare("insert into contributions values (?, ?, ?, ?, ?, ?)").run("a", "ana", "yes", "ACTIVE", `2026-${String(month).padStart(2, "0")}-15`, "TITHE");
    }
    const fullYearPdf = await service.report("a", { userId: "user" }, { year: "2026" });
    assert.equal(fullYearPdf.subarray(0, 5).toString(), "%PDF-");
  } finally {
    sqlite.close();
  }
});

test("centraliza verticalmente as células, inclusive com texto quebrado e em outras páginas", async () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: String(index),
    name: index % 2 === 0 ? "Um nome de membro suficientemente longo para ocupar várias linhas no relatório" : "Ana",
    memberType: { id: "type", description: index % 2 ? "Um tipo de membro suficientemente longo para ocupar várias linhas" : "Membro" },
    months: [true, false, true, false, false, false, false, false, false, false, false, false],
  }));
  const header = { name: "Igreja", document: null, timezone: "America/Sao_Paulo" };
  const definition = await contributorsDocument(header, "Admin", "2026", rows, new Date());
  const printer = new PdfPrinter({
    Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" },
  });
  const pdf = printer.createPdfKitDocument(definition);
  const lineHeight = pdf.font("Helvetica").fontSize(9).currentLineHeight();
  let checked = 0;
  for (const page of pdf._pdfMakePages) {
    let rowStart = 0;
    for (let index = 0; index < page.items.length; index++) {
      const current = page.items[index];
      if (current.type === "vector") rowStart = index + 1;
      if (current.type !== "svg" || Math.abs(current.item.x - 255.28) > 0.01) continue;
      const lines = page.items.slice(rowStart, index).filter((item) => item.type === "line").map((item) => item.item);
      const name = lines.filter((line) => Math.abs(line.x - 40) < 0.01);
      const type = lines.filter((line) => Math.abs(line.x - 164.28) < 0.01);
      assert.ok(name.length && type.length);
      const center = (cell) => (cell[0].y + cell.at(-1).y + lineHeight) / 2;
      const badgeCenter = current.item.y + current.item._height / 2;
      assert.ok(Math.abs(center(name) - badgeCenter) < 0.001);
      assert.ok(Math.abs(center(type) - badgeCenter) < 0.001);
      checked++;
    }
  }
  assert.equal(checked, rows.length);
  assert.ok(pdf._pdfMakePages.length > 1);
  pdf.end();
  pdf.resume();
});

test("ano, paginação e permissões são validados", () => {
  for (const year of ["", "0000", "9999", "26", "202a"]) {
    assert.equal(contributorYearQuerySchema.safeParse({ year }).success, false);
  }
  assert.equal(contributorYearQuerySchema.safeParse({ year: "2026", page: "0" }).success, false);
  assert.equal(contributorReportQuerySchema.safeParse({ year: "2026", page: "1" }).success, false);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, MembersController.prototype.contributorsYear), ["contributors-report:read"]);
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, MembersController.prototype.contributorsReport), ["contributors-report:read"]);
});
