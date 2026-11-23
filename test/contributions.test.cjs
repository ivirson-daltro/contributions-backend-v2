const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
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
const { ContributionsService } = require("../dist/modules/contributions/contributions.service");
const { ContributionsReportService, reportDocument } = require("../dist/modules/contributions/contributions-report.service");
const { createContributionSchema, contributionQuerySchema, contributionReportQuerySchema } = require("../dist/modules/contributions/contributions.dto");

function executorWith(run) {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  return new Proxy(db.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") return run;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function serviceWith(run, audit = { record: async () => {} }) {
  const executor = executorWith(run);
  return new ContributionsService({
    withTenantTx: async (_context, callback) => callback({ getExecutor: () => executor }),
  }, audit);
}

function pdfText(pdf) {
  const zlib = require("node:zlib");
  const raw = pdf.toString("latin1");
  const texts = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const end = raw.indexOf("endstream", match.index);
    try {
      const stream = zlib.inflateSync(pdf.subarray(match.index + match[0].length, end)).toString("latin1");
      for (const entry of stream.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
        texts.push([...entry[1].matchAll(/<([0-9a-f]+)>/gi)].map((part) => Buffer.from(part[1], "hex").toString("latin1")).join(""));
      }
    } catch (error) {
      if (error.code !== "Z_DATA_ERROR") throw error;
    }
  }
  return texts.join("");
}

const uuid = (digit) => `00000000-0000-4000-8000-00000000000${digit}`;
const payload = {
  contributionTypeId: uuid(1), paymentMethodId: uuid(2),
  memberId: uuid(3), amount: "850.00", occurredOn: "2026-11-12",
};

test("valida valores, datas, filtros e recusa anexos ainda não suportados", () => {
  assert.equal(createContributionSchema.safeParse(payload).success, true);
  for (const amount of ["0.00", "-1", "1.001", "1000000000000.00"]) {
    assert.equal(createContributionSchema.safeParse({ ...payload, amount }).success, false);
  }
  assert.equal(createContributionSchema.safeParse({ ...payload, occurredOn: "2026-02-30" }).success, false);
  assert.equal(createContributionSchema.safeParse({ ...payload, attachmentIds: [uuid(4)] }).success, false);
  assert.equal(contributionQuerySchema.safeParse({ from: "2026-11-02", to: "2026-11-01" }).success, false);
});

test("listagem soma e conta todo o filtro, não apenas a página", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.function("app_norm", (value) => value === null ? null : value.toLowerCase());
    db.exec(`
      create table contributions (
        id text, tenant_id text, occurred_on text, amount numeric, status text,
        member_id text, contribution_type_id text, payment_method_id text,
        category_snapshot text, kind_snapshot text, observation text, version integer
      );
      create table contribution_types (id text, tenant_id text, description text);
      create table payment_methods (id text, tenant_id text, description text, kind text);
      create table members (id text, tenant_id text, name text);
      create table tenants (id text, timezone text);
      create table attachments (tenant_id text, contribution_id text, status text);
      insert into tenants values ('tenant-a', 'America/Sao_Paulo'), ('tenant-b', 'Pacific/Kiritimati');
      insert into contribution_types values ('type', 'tenant-a', 'Dizimo'), ('type-b', 'tenant-b', 'Dizimo');
      insert into payment_methods values ('method', 'tenant-a', 'Pix', 'PIX'), ('method-b', 'tenant-b', 'Pix', 'PIX');
      insert into members values ('member', 'tenant-a', 'Ana'), ('member-b', 'tenant-b', 'Ana');
      insert into contributions values
        ('a', 'tenant-a', '2026-11-01', 100, 'ACTIVE', 'member', 'type', 'method', 'TITHE', 'PIX', null, 1),
        ('b', 'tenant-a', '2026-11-02', 200, 'ACTIVE', 'member', 'type', 'method', 'TITHE', 'PIX', null, 1),
        ('c', 'tenant-a', '2026-11-03', 500, 'VOIDED', 'member', 'type', 'method', 'TITHE', 'PIX', null, 1),
        ('d', 'tenant-b', '2026-12-01', 900, 'ACTIVE', 'member-b', 'type-b', 'method-b', 'TITHE', 'PIX', null, 1),
        ('e', 'tenant-a', '2026-10-31', 50, 'ACTIVE', 'member', 'type', 'method', 'TITHE', 'PIX', null, 1),
        ('f', 'tenant-a', '2026-12-01', 30, 'ACTIVE', 'member', 'type', 'method', 'TITHE', 'PIX', null, 1),
        ('g', 'tenant-a', '2026-11-30', 70, 'ACTIVE', 'member', 'type', 'method', 'TITHE', 'PIX', null, 1);
    `);
    const service = serviceWith(async (compiled) => {
      const query = compiled.sql
        .replace(/\$\d+/g, "?")
        .replace(
          "(date_trunc('month', now() at time zone t.timezone) + interval '1 month')::date",
          "(case when t.timezone = 'Pacific/Kiritimati' then '2027-01-01' else '2026-12-01' end)",
        )
        .replace(
          "date_trunc('month', now() at time zone t.timezone)::date",
          "(case when t.timezone = 'Pacific/Kiritimati' then '2026-12-01' else '2026-11-01' end)",
        )
        .replace(/::(?:uuid|date|text|jsonb)/g, "")
        .replace(/to_char\(c\.occurred_on, 'YYYY-MM-DD'\)/g, "c.occurred_on")
        .replaceAll("jsonb_build_object", "json_object")
        .replaceAll("jsonb_agg(item order by ordinal)", "json_group_array(json(item) order by ordinal)");
      const row = db.prepare(query).get(...compiled.parameters);
      return { rows: [{ ...row, data: JSON.parse(row.data) }] };
    });
    const result = await service.list("tenant-a", "user", { status: "ALL", pageSize: "1", page: "2", q: "ana" });
    assert.equal(result.data.length, 1);
    assert.equal(result.meta.total, 4);
    assert.equal(result.meta.totals.count, 3);
    assert.equal(Number(result.meta.totals.amount), 370);
    const previous = await service.list("tenant-a", "user", { from: "2026-10-01", to: "2026-10-31" });
    assert.equal(previous.meta.total, 1);
    assert.equal(previous.data[0].id, "e");
    const since = await service.list("tenant-a", "user", { from: "2026-12-01" });
    assert.equal(since.meta.total, 1);
    assert.equal(since.data[0].id, "f");
    const until = await service.list("tenant-a", "user", { to: "2026-10-31" });
    assert.equal(until.meta.total, 1);
    assert.equal(until.data[0].id, "e");
    const otherTimezone = await service.list("tenant-b", "user", {});
    assert.equal(otherTimezone.meta.total, 1);
    assert.equal(otherTimezone.data[0].id, "d");
  } finally {
    db.close();
  }
});

test("cadastro exige membro e impede lançamentos futuros ou em mês fechado", async () => {
  const conditions = [
    { type: { requires_member: true }, body: { ...payload, memberId: null }, code: "MEMBER_REQUIRED" },
    { today: "2026-11-01", code: "FUTURE_DATE_NOT_ALLOWED" },
    { closed: true, code: "MONTH_CLOSED" },
  ];
  for (const condition of conditions) {
    let writes = 0;
    const service = serviceWith(async ({ sql }) => {
      if (sql.includes("insert into idempotency_keys")) return { rows: [{ key: "key" }] };
      if (sql.includes("from contribution_types")) return { rows: [{ id: uuid(1), description: "Tipo", category: "TITHE", requires_member: false, ...condition.type }] };
      if (sql.includes("from payment_methods")) return { rows: [{ id: uuid(2), description: "Pix", kind: "PIX" }] };
      if (sql.includes("from members")) return { rows: [{ id: uuid(3), name: "Ana" }] };
      if (sql.includes("from tenants")) return { rows: [{ allow_future_dates: false, today: condition.today ?? "2026-11-20" }] };
      if (sql.includes("v2_is_month_closed")) return { rows: [{ closed: condition.closed ?? false }] };
      if (sql.includes("insert into contributions")) writes++;
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    await assert.rejects(service.create("tenant", "user", "key", condition.body ?? payload),
      (error) => error.getResponse().code === condition.code);
    assert.equal(writes, 0);
  }
});

test("repetição da chave devolve resposta anterior e rejeita outro corpo", async () => {
  let stored;
  let writes = 0;
  let audits = 0;
  const service = serviceWith(async (query) => {
    const { sql, parameters } = query;
    if (sql.includes("insert into idempotency_keys")) {
      if (stored) return { rows: [] };
      stored = { request_hash: parameters[2], status_code: null, response: null };
      return { rows: [{ key: "key" }] };
    }
    if (sql.includes("select request_hash")) return { rows: [stored] };
    if (sql.includes("from contribution_types")) return { rows: [{ id: uuid(1), description: "Tipo", category: "TITHE", requires_member: true }] };
    if (sql.includes("from payment_methods")) return { rows: [{ id: uuid(2), description: "Pix", kind: "PIX" }] };
    if (sql.includes("from members")) return { rows: [{ id: uuid(3), name: "Ana" }] };
    if (sql.includes("from tenants")) return { rows: [{ allow_future_dates: false, today: "2026-11-20" }] };
    if (sql.includes("v2_is_month_closed")) return { rows: [{ closed: false }] };
    if (sql.includes("insert into contributions")) {
      writes++;
      return { rows: [{ id: uuid(4), amount: "850.00", version: 1 }] };
    }
    if (sql.includes("update idempotency_keys")) {
      stored.status_code = 201;
      stored.response = JSON.parse(parameters[0]);
      return { rows: [] };
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  }, { record: async () => { audits++; } });
  const created = await service.create("tenant", "user", "key", payload);
  assert.deepEqual(await service.create("tenant", "user", "key", payload), created);
  await assert.rejects(service.create("tenant", "user", "key", { ...payload, amount: "1.00" }),
    (error) => error.getResponse().code === "IDEMPOTENCY_KEY_REUSED");
  assert.equal(writes, 1);
  assert.equal(audits, 1);
});

test("Swagger expõe rotas, headers, filtros e campos do cadastro", async () => {
  const { NestFactory } = require("@nestjs/core");
  const { SwaggerModule, DocumentBuilder } = require("@nestjs/swagger");
  const { AppModule } = require("../dist/app.module");
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix("v1");
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    const contributions = document.paths["/v1/contributions"];
    assert.ok(contributions.get);
    assert.ok(contributions.post);
    assert.ok(document.paths["/v1/catalogs/contribution-types"].get);
    assert.ok(document.paths["/v1/catalogs/payment-methods"].get);
    assert.ok(document.paths["/v1/members/lookup"].get);
    const report = document.paths["/v1/contributions/report"].get;
    assert.ok(report.parameters.some((parameter) => parameter.name === "from" && parameter.required));
    assert.ok(report.parameters.some((parameter) => parameter.name === "to" && parameter.required));
    assert.ok(report.parameters.some((parameter) => parameter.name === "x-tenant-id" && parameter.required));
    assert.equal(report.responses["200"].content["application/pdf"].schema.format, "binary");
    assert.ok(contributions.get.parameters.some((parameter) => parameter.name === "from"));
    assert.ok(contributions.get.parameters.some((parameter) => parameter.name === "x-tenant-id"));
    assert.ok(contributions.post.parameters.some((parameter) => parameter.name === "Idempotency-Key" && parameter.required));
    const schema = contributions.post.requestBody.content["application/json"].schema;
    assert.deepEqual(schema.required, ["contributionTypeId", "paymentMethodId", "amount", "occurredOn"]);
    assert.equal(schema.properties.attachmentIds.maxItems, 0);
  } finally {
    await app.close();
  }
});

test("relatório valida datas inclusivas e período de até 366 dias", () => {
  for (const query of [
    { from: "2026-11-01", to: "2026-11-30" },
    { from: "2024-01-01", to: "2024-12-31" },
    { from: "2026-11-01", to: "2026-11-01" },
  ]) assert.equal(contributionReportQuerySchema.safeParse(query).success, true);
  for (const query of [
    {}, { from: "2026-11-01" }, { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-11-02", to: "2026-11-01" },
    { from: "2024-01-01", to: "2025-01-01" },
  ]) assert.equal(contributionReportQuerySchema.safeParse(query).success, false);
});

test("PDF usa dados ativos do tenant e datas inclusivas; mantém agrupamento e totais exatos", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table tenants (id text, name text, document text, timezone text);
      create table user_profiles (user_id text, display_name text);
      create table contribution_types (id text, tenant_id text, description text);
      create table payment_methods (id text, tenant_id text, description text, kind text);
      create table members (id text, tenant_id text, name text);
      create table contributions (
        id text, tenant_id text, occurred_on text, amount text, status text,
        member_id text, contribution_type_id text, payment_method_id text,
        category_snapshot text, kind_snapshot text
      );
      insert into tenants values ('a', 'Igreja Exemplo', null, 'America/Sao_Paulo');
      insert into user_profiles values ('u', 'Emissor');
      insert into contribution_types values ('t', 'a', 'Dízimo'), ('tb', 'b', 'Dízimo');
      insert into payment_methods values ('p', 'a', 'Pix principal', 'PIX'), ('d', 'a', 'Dinheiro', 'CASH'), ('pb', 'b', 'Pix', 'PIX');
      insert into members values ('m', 'a', 'Pessoa');
      insert into contributions values
        ('1', 'a', '2026-11-01', '999999999999.99', 'ACTIVE', 'm', 't', 'p', 'TITHE', 'PIX'),
        ('2', 'a', '2026-11-30', '0.02', 'ACTIVE', null, 't', 'p', 'OFFERING', 'CASH'),
        ('3', 'a', '2026-11-15', '0.10', 'ACTIVE', 'm', 't', 'd', 'TITHE', 'CASH'),
        ('4', 'a', '2026-11-15', '999.00', 'VOIDED', 'm', 't', 'p', 'TITHE', 'PIX'),
        ('5', 'b', '2026-11-15', '999.00', 'ACTIVE', null, 'tb', 'pb', 'TITHE', 'PIX'),
        ('6', 'a', '2026-10-31', '999.00', 'ACTIVE', 'm', 't', 'p', 'TITHE', 'PIX'),
        ('7', 'a', '2026-12-01', '999.00', 'ACTIVE', 'm', 't', 'p', 'TITHE', 'PIX');
    `);
    let rows;
    let txContext;
    const executor = executorWith(async (compiled) => {
      const query = compiled.sql
        .replace(/\$\d+/g, "?")
        .replace(/::(?:uuid|date|text)/g, "")
        .replace(/to_char\(c\.occurred_on, 'YYYY-MM-DD'\)/g, "c.occurred_on");
      const result = db.prepare(query).all(...compiled.parameters);
      if (query.includes("from contributions c")) rows = result;
      return { rows: result };
    });
    const service = new ContributionsReportService({
      withTenantTx: async (context, callback) => {
        txContext = context;
        return callback({ getExecutor: () => executor });
      },
    });
    const period = { from: "2026-11-01", to: "2026-11-30" };
    const pdf = await service.generate("a", { userId: "u" }, period);
    assert.deepEqual(txContext, { tenantId: "a", userId: "u" });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.toString("latin1"), /\/Subtype\s*\/Image\b/);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.occurred_on).sort(), ["2026-11-01", "2026-11-15", "2026-11-30"]);
    const content = reportDocument({ name: "Igreja", document: null, timezone: "UTC", display_name: "Emissor" }, "Emissor", period, rows, new Date("2026-11-30T12:00:00Z")).content;
    const serialized = JSON.stringify(content);
    for (const expected of ["Pix principal", "Dinheiro", "1.000.000.000.000,11", "999.999.999.999,99", "0,12", "Ofertas", "R$ 0,02", "30/11/2026"]) {
      assert.ok(serialized.includes(expected), expected);
    }
    // Extract the generated PDF's compressed text streams, not just its input definition.
    const text = pdfText(pdf);
    assert.ok(text.includes("Pix principal"));
    assert.ok(text.includes("1.000.000.000.000,11"));
    assert.ok(!text.includes("Pix × demais"));
    const emptyPdf = await service.generate("a", { userId: "u" }, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(emptyPdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdfText(emptyPdf).includes("Sem contribuições no período"));
  } finally {
    db.close();
  }
});

test("logo é incluída no topo e copiada para o build", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const definition = reportDocument(
    { name: "Igreja", document: null, timezone: "UTC", display_name: null },
    "Emissor", { from: "2026-11-01", to: "2026-11-30" }, [], new Date(),
  );
  const logo = definition.content[0];
  assert.equal(logo.alignment, "center");
  assert.deepEqual(logo.fit, [114, 33]);
  assert.deepEqual(fs.readFileSync(logo.image), fs.readFileSync(path.join(__dirname, "..", "assets", "logo.png")));
});

test("relatório termina com linhas para tesoureiros e cinco membros do conselho fiscal", async () => {
  const definition = reportDocument(
    { name: "Igreja", document: null, timezone: "UTC", display_name: null },
    "Emissor", { from: "2026-11-01", to: "2026-11-30" }, [], new Date(),
  );
  const signatureRows = definition.content.filter((item) => item.columns);
  assert.deepEqual(signatureRows.map((row) => row.columns.filter((column) => column.table).length), [2, 3, 2]);
  assert.ok(signatureRows[0].margin[1] >= 30);
  const signatures = signatureRows.flatMap((row) => row.columns.filter((column) => column.table));
  assert.deepEqual(signatures.map((signature) => signature.table.body[1][0].text), [
    "1º Tesoureiro(a)", "2º Tesoureiro(a)",
    "Conselho Fiscal 1", "Conselho Fiscal 2", "Conselho Fiscal 3",
    "Conselho Fiscal 4", "Conselho Fiscal 5",
  ]);
  for (const row of signatureRows) assert.equal(row.unbreakable, true);
  for (const signature of signatures) {
    assert.deepEqual(signature.table.body[0][0].border, [false, false, false, true]);
  }
  const { renderReport } = require("../dist/common/pdf/report-layout");
  const text = pdfText(await renderReport(definition));
  assert.ok(text.includes("1º Tesoureiro(a)"));
  assert.ok(text.includes("2º Tesoureiro(a)"));
  for (let index = 1; index <= 5; index++) assert.ok(text.includes(`Conselho Fiscal ${index}`));
});

test("resumo distribui meios, categorias e destinações em três colunas", async () => {
  const row = {
    occurred_on: "2026-11-01", member_name: "Pessoa", type_description: "Tipo",
    method_id: "p", method_description: "Pix", kind: "PIX", category: "TITHE", amount: "1.00",
  };
  const definition = reportDocument(
    { name: "Igreja", document: null, timezone: "UTC", display_name: null },
    "Emissor", { from: "2026-11-01", to: "2026-11-30" },
    [row, { ...row, kind: "CASH", category: "OFFERING", amount: "2.00" },
      { ...row, category: "CONSTRUCTION_OFFERING", amount: "3.00" },
      { ...row, category: "MISSIONS", amount: "4.00" },
      { ...row, category: "INCOME", amount: "5.00" }],
    new Date(),
  );
  const summary = definition.content.find((item) => item.table?.body[0]?.[0]?.stack);
  const sections = summary.table.body[0];
  assert.deepEqual(sections.map((section) => section.stack[0].text), ["ENTRADAS", "CONTRIBUIÇÕES", "DESTINAÇÃO"]);
  assert.deepEqual(sections.map((section) => section.stack[1].table.body.map((cells) => cells.map((cell) => cell.text))), [
    [["Pix", "R$ 13,00"], ["Dinheiro", "R$ 2,00"]],
    [["Dízimos", "R$ 1,00"], ["Ofertas", "R$ 2,00"], ["Rendimentos", "R$ 5,00"]],
    [["Oferta de construção", "R$ 3,00"], ["Missões", "R$ 4,00"]],
  ]);
  assert.ok(sections.every((section) => section.fillColor === "#eeeeee"));
  const { renderReport } = require("../dist/common/pdf/report-layout");
  const text = pdfText(await renderReport(definition));
  assert.ok(text.includes("DESTINAÇÃO"));
  assert.ok(text.includes("Missões"));
});

test("total geral aparece entre linhas com valor à direita, sem comparação Pix", async () => {
  const definition = reportDocument(
    { name: "Igreja", document: null, timezone: "UTC", display_name: null },
    "Emissor", { from: "2026-11-01", to: "2026-11-30" }, [], new Date(),
  );
  const total = definition.content.find((item) => item.table?.body[0]?.[0]?.text === "Total geral");
  assert.deepEqual(total.table.widths, ["*", "auto"]);
  assert.equal(total.table.body[0][0].bold, true);
  assert.deepEqual(total.table.body[0][1], {
    text: "R$ 0,00", bold: true, fontSize: 11, alignment: "right", noWrap: true,
  });
  assert.ok(total.layout.hLineWidth(0) > 0);
  assert.ok(total.layout.hLineWidth(1) > 0);
  assert.equal(total.layout.vLineWidth(0), 0);
  const { renderReport } = require("../dist/common/pdf/report-layout");
  const text = pdfText(await renderReport(definition));
  assert.ok(text.includes("Total geral"));
  assert.ok(!text.includes("Pix × demais"));
});

test("relatório com mais de 2000 contribuições é gerado diretamente sem truncamento", async () => {
  const row = {
    occurred_on: "2026-11-01", member_name: "Pessoa", type_description: "Tipo",
    method_id: "p", method_description: "Pix", kind: "PIX", category: "TITHE", amount: "0.01",
  };
  const executor = executorWith(async ({ sql }) => ({
    rows: sql.includes("from tenants t")
      ? [{ name: "Igreja", document: null, timezone: "UTC", display_name: null }]
      : Array.from({ length: 2001 }, () => row),
  }));
  const service = new ContributionsReportService({
    withTenantTx: async (_context, callback) => callback({ getExecutor: () => executor }),
  });
  const pdf = await service.generate("a", { userId: "u" }, { from: "2026-11-01", to: "2026-11-30" });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const text = pdfText(pdf);
  assert.ok(text.includes("Total geralR$ 20,01"));
  assert.ok(text.indexOf("1º Tesoureiro(a)") > text.indexOf("Total geralR$ 20,01"));
  for (let index = 1; index <= 5; index++) assert.ok(text.includes(`Conselho Fiscal ${index}`));
});

test("relatório apresenta blocos com faixa cinza e subtotal separado dos lançamentos", () => {
  const row = {
    occurred_on: "2026-11-01", member_name: "Pessoa", type_description: "Tipo",
    method_id: "p", method_description: "Pix", kind: "PIX", category: "TITHE", amount: "1.25",
  };
  const definition = reportDocument(
    { name: "Igreja", document: null, timezone: "UTC", display_name: null },
    "Emissor", { from: "2026-11-01", to: "2026-11-30" },
    [row, { ...row, amount: "0.10" }, { ...row, method_id: "d", method_description: "Dinheiro", kind: "CASH" }],
    new Date("2026-11-30T12:00:00Z"),
  );
  const block = definition.content.find((item) => item.table);
  const body = block.table.body;
  assert.equal(block.table.headerRows, 1);
  assert.equal(body[1][0].text, "Pix");
  assert.equal(body[1][0].fillColor, "#eeeeee");
  assert.equal(body[1][0].colSpan, 5);
  assert.equal(body[4][0].text, "Subtotal");
  assert.equal(body[4][4].text, "R$ 1,35");
  assert.equal(body[4][4].alignment, "right");
  assert.equal(body[5][0].text, "Dinheiro");
  assert.equal(body[7][4].text, "R$ 1,25");
  for (const index of [1, 2, 4, 5, 6, 7, 8]) assert.ok(block.layout.hLineWidth(index) > 0);
  assert.equal(block.layout.hLineWidth(3), 0);
  assert.equal(block.layout.vLineWidth(0), 0);
});
