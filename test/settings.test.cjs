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
const { CatalogsService } = require("../dist/modules/settings/catalogs.service");
const { LogoService } = require("../dist/modules/settings/logo.service");
const { SettingsController } = require("../dist/modules/settings/settings.controller");
const { CatalogsController } = require("../dist/modules/settings/catalogs.controller");
const { REQUIRED_PERMISSIONS_KEY } = require("../dist/common/authorization/require-permissions.decorator");

function transactions(run, contexts = []) {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const executor = new Proxy(db.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") return run;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { withTenantTx: async (context, callback) => {
    contexts.push(context);
    return callback({ getExecutor: () => executor });
  } };
}
const code = (expected) => (error) => error.getResponse().code === expected;

test("logo exige imagem válida e usa somente metadados do tenant solicitado", async () => {
  const contexts = [];
  const service = new LogoService(transactions(async ({ sql, parameters }) => {
    assert.match(sql, /where tenant_id/);
    assert.ok(parameters.includes("tenant-a"));
    return { rows: [{ object_key: "tenant-a/key", content_type: "image/png" }] };
  }, contexts), { record: async () => {} });
  let downloaded;
  service.storage = {
    download: async (key) => { downloaded = key; return { data: new Blob(["png"]), error: null }; },
  };
  await assert.rejects(service.upload("tenant-a", "user", "LIGHT", { buffer: Buffer.from("fake"), size: 4, mimetype: "image/png" }), code("VALIDATION_ERROR"));
  await assert.rejects(service.upload("tenant-a", "user", "DARK", { buffer: Buffer.alloc(1), size: 2097153, mimetype: "image/png" }), code("VALIDATION_ERROR"));
  const result = await service.get("tenant-a", "user", "LIGHT");
  assert.equal(downloaded, "tenant-a/key");
  assert.equal(result.contentType, "image/png");
  assert.deepEqual(contexts, [{ tenantId: "tenant-a", userId: "user" }]);
});

test("logo escura usa a clara apenas quando não existe uma imagem escura", async () => {
  const rows = new Map([["LIGHT", { object_key: "tenant-a/light", content_type: "image/png" }]]);
  const service = new LogoService(transactions(async ({ sql, parameters }) => {
    assert.ok(parameters.includes("tenant-a"));
    const theme = sql.includes("theme = 'LIGHT'") ? "LIGHT" : parameters[1];
    const row = rows.get(theme);
    return { rows: row ? [row] : [] };
  }), { record: async () => {} });
  const downloads = [];
  service.storage = {
    download: async (key) => { downloads.push(key); return { data: new Blob([key]), error: null }; },
  };
  await service.get("tenant-a", "user", "DARK");
  assert.equal(downloads.at(-1), "tenant-a/light");
  await assert.rejects(service.get("tenant-a", "user", "DARK", false), code("LOGO_NOT_FOUND"));
  rows.set("DARK", { object_key: "tenant-a/dark", content_type: "image/jpeg" });
  const dark = await service.get("tenant-a", "user", "DARK");
  assert.equal(downloads.at(-1), "tenant-a/dark");
  assert.equal(dark.contentType, "image/jpeg");
  await service.get("tenant-a", "user", "LIGHT");
  assert.equal(downloads.at(-1), "tenant-a/light");
});

test("relatórios usam somente a logo clara do tenant, com conversão de WebP", async () => {
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 5, height: 3, channels: 3, background: "#123456" } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const objects = new Map([
    ["a/light", png], ["b/light", jpeg], ["c/light", webp], ["d/dark", png],
  ]);
  const metadata = new Map([
    ["a:LIGHT", { object_key: "a/light", content_type: "image/png" }],
    ["b:LIGHT", { object_key: "b/light", content_type: "image/jpeg" }],
    ["c:LIGHT", { object_key: "c/light", content_type: "image/webp" }],
    ["d:DARK", { object_key: "d/dark", content_type: "image/png" }],
  ]);
  const contexts = [];
  const service = new LogoService(transactions(async ({ parameters }) => ({
    rows: metadata.has(`${parameters[0]}:${parameters[1]}`) ? [metadata.get(`${parameters[0]}:${parameters[1]}`)] : [],
  }), contexts), { record: async () => {} });
  const downloads = [];
  service.storage = {
    download: async (key) => { downloads.push(key); return { data: new Blob([objects.get(key)]), error: null }; },
  };
  const { reportHeader, reportLayout, renderReport } = require("../dist/common/pdf/report-layout");
  for (const [tenant, format] of [["a", "png"], ["b", "jpeg"], ["c", "png"]]) {
    const image = await service.getForReport(tenant, "user");
    assert.ok(image.startsWith(`data:image/${format};base64,`));
    const bytes = Buffer.from(image.split(",")[1], "base64");
    assert.equal((await sharp(bytes).metadata()).format, format);
    const content = reportHeader({ name: "Igreja", document: null, timezone: "UTC", logo: image }, "Relatório", "2026", "Emissor", new Date());
    const pdf = await renderReport(reportLayout(content));
    assert.match(pdf.toString("latin1"), /\/Subtype\s*\/Image\b/);
  }
  assert.equal(await service.getForReport("d", "user"), null);
  assert.deepEqual(downloads, ["a/light", "b/light", "c/light"]);
  assert.deepEqual(contexts.map((context) => context.tenantId), ["a", "b", "c", "d"]);
});

test("falhas de armazenamento ou conversão da logo do relatório não são ocultadas", async () => {
  const service = new LogoService(transactions(async () => ({
    rows: [{ object_key: "tenant/light", content_type: "image/webp" }],
  })), { record: async () => {} });
  service.logger = { error: () => {} };
  service.storage = { download: async () => ({ data: null, error: { message: "falha" } }) };
  await assert.rejects(service.getForReport("tenant", "user"), code("LOGO_STORAGE_ERROR"));
  service.storage = { download: async () => ({ data: new Blob(["webp inválido"]), error: null }) };
  await assert.rejects(service.getForReport("tenant", "user"), code("LOGO_PROCESSING_ERROR"));
});

test("substituir logo de um tema preserva a imagem do outro tema", async () => {
  const rows = new Map([["LIGHT", "tenant-a/light"], ["DARK", "tenant-a/dark"]]);
  const audits = [];
  const removed = [];
  const service = new LogoService(transactions(async ({ sql, parameters }) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("select object_key")) {
      const key = rows.get(parameters[1]);
      return { rows: key ? [{ object_key: key }] : [] };
    }
    if (sql.includes("insert into tenant_logos")) {
      rows.set(parameters[1], parameters[2]);
      return { rows: [] };
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  }), { record: async (_trx, record) => audits.push(record) });
  service.storage = {
    upload: async () => ({ error: null }),
    remove: async (keys) => { removed.push(...keys); return { error: null }; },
  };
  const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await service.upload("tenant-a", "user", "DARK", { buffer, size: buffer.length, mimetype: "image/png" });
  assert.equal(rows.get("LIGHT"), "tenant-a/light");
  assert.notEqual(rows.get("DARK"), "tenant-a/dark");
  assert.deepEqual(removed, ["tenant-a/dark"]);
  assert.deepEqual(audits[0].after, { theme: "DARK" });
});

test("catálogo em uso exige confirmação para reclassificação e não pode ser excluído", async () => {
  const contexts = [];
  let writes = 0;
  const item = { id: "id", description: "Pix", active: true, kind: "PIX", usageCount: 1 };
  const service = new CatalogsService(transactions(async ({ sql, parameters }) => {
    assert.ok(parameters.includes("tenant-a"));
    if (sql.includes("for update")) return { rows: [{ id: "id" }] };
    if (sql.includes("jsonb_build_object")) return { rows: [{ item }] };
    if (sql.includes("update") || sql.includes("delete")) { writes++; return { rows: [] }; }
    throw new Error(`Consulta inesperada: ${sql}`);
  }, contexts), { record: async () => {} });
  await assert.rejects(service.update("tenant-a", "user", "payment-methods", "id", { kind: "CASH" }, false), code("CONFIRMATION_REQUIRED"));
  await assert.rejects(service.delete("tenant-a", "user", "payment-methods", "id"), code("IN_USE"));
  assert.equal(writes, 0);
  await service.update("tenant-a", "user", "payment-methods", "id", { kind: "CASH" }, true);
  assert.equal(writes, 1);
  assert.ok(contexts.every((context) => context.tenantId === "tenant-a" && context.userId === "user"));
});

test("escritas de configurações exigem permissões correspondentes", () => {
  for (const method of ["updateTenant", "updatePreferences", "uploadLogo"]) {
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, SettingsController.prototype[method]), ["tenant-settings:write"]);
  }
  for (const method of ["create", "update", "delete"]) {
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, CatalogsController.prototype[method]), ["catalogs:write"]);
  }
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, CatalogsController.prototype.updateFees), ["tenant-settings:write"]);
});

test("substituição de taxas permite trocar nomes sem conflito transitório", async () => {
  const rows = [
    { id: "00000000-0000-4000-8000-000000000001", name: "A", percent: "2.00", rounding: "HALF_UP_2", active: true, sortOrder: 0 },
    { id: "00000000-0000-4000-8000-000000000002", name: "B", percent: "5.00", rounding: "HALF_UP_2", active: true, sortOrder: 1 },
  ];
  const service = new CatalogsService(transactions(async ({ sql, parameters }) => {
    if (sql.includes("select id from tenants") || sql.includes("delete from fee_rules")) return { rows: [] };
    if (sql.includes("from fee_rules") && sql.includes("select")) return { rows: rows.map((row) => ({ ...row })) };
    if (sql.includes("update fee_rules")) {
      const id = parameters[parameters.length - 1];
      const name = parameters[0];
      assert.ok(!rows.some((row) => row.id !== id && row.name === name), `nome duplicado ${name}`);
      rows.find((row) => row.id === id).name = name;
      return { rows: [] };
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  }), { record: async () => {} });
  const updated = await service.updateFees("tenant-a", "user", { rules: [
    { ...rows[0], name: "B" }, { ...rows[1], name: "A" },
  ] });
  assert.deepEqual(updated.map((row) => row.name), ["B", "A"]);
});
