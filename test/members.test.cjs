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
const { MembersService } = require("../dist/modules/members/members.service");
const { permissionsForRoles } = require("../dist/common/authorization/permissions");
const { createMemberSchema, updateMemberSchema } = require("../dist/modules/members/members.dto");

function serviceWith(run, auditRecords = []) {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const executor = new Proxy(db.getExecutor(), {
    get(target, property) {
      if (property === "executeQuery") return run;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new MembersService({
    withTenantTx: async (_context, callback) => callback({ getExecutor: () => executor }),
  }, { record: async (_trx, record) => auditRecords.push(record) });
}

const typeId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-8000-000000000004";
const tenant = (roles) => ({ tenantId: "tenant-a", roles, permissions: permissionsForRoles(roles) });
const member = (createdBy = userId) => ({
  id: memberId, name: "Ana", memberType: { id: typeId, description: "Membro" },
  status: "ACTIVE", phone: "123", email: null, gender: null, birthDate: null,
  entryDate: null, baptismDate: null, zipCode: null, street: null, number: null,
  complement: null, neighborhood: null, city: null, state: null, consentAt: null,
  createdBy, createdAt: "2026-01-01", updatedAt: "2026-01-01",
});
const code = (expected) => (error) => error.getResponse().code === expected;

test("tesoureiro cria somente nome e tipo; outros perfis podem completar dados", async () => {
  const audits = [];
  let inserted;
  const service = serviceWith(async ({ sql, parameters }) => {
    if (sql.includes("from member_types")) return { rows: [{ id: typeId }] };
    if (sql.includes("app_norm(name)")) return { rows: [] };
    if (sql.includes("insert into members")) {
      inserted = parameters;
      return { rows: [{ id: memberId }] };
    }
    if (sql.includes("select") && sql.includes("as item from members")) return { rows: [{ item: member() }] };
    throw new Error(`Consulta inesperada: ${sql}`);
  }, audits);
  const body = { name: "Ana", memberTypeId: typeId };
  await service.create(tenant(["TREASURER"]), userId, body, false);
  assert.ok(inserted.includes(userId));
  assert.equal(audits[0].action, "MEMBER_CREATED");
  await assert.rejects(service.create(tenant(["TREASURER"]), userId, { ...body, phone: "123" }, false), code("FORBIDDEN"));
  await service.create(tenant(["SECRETARY"]), userId, { ...body, phone: "123" }, false);
  await service.create(tenant(["TREASURER", "TENANT_ADMIN"]), userId, { ...body, phone: "123" }, false);
  assert.equal(createMemberSchema.safeParse({ ...body, email: "invalido" }).success, false);
  assert.equal(updateMemberSchema.safeParse({}).success, false);
});

test("tesoureiro edita e exclui apenas cadastros próprios e campos básicos", async () => {
  for (const owner of [otherId, null]) {
    let writes = 0;
    const service = serviceWith(async ({ sql }) => {
      if (sql.includes("as item from members")) return { rows: [{ item: member(owner) }] };
      if (sql.includes("update members")) writes++;
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    await assert.rejects(service.update(tenant(["TREASURER"]), userId, memberId, { name: "Novo" }), code("FORBIDDEN"));
    await assert.rejects(service.delete(tenant(["TREASURER"]), userId, memberId), code("FORBIDDEN"));
    assert.equal(writes, 0);
  }
  const audits = [];
  let writes = 0;
  const service = serviceWith(async ({ sql, parameters }) => {
    if (sql.includes("as item from members")) return { rows: [{ item: member() }] };
    if (sql.includes("from tenant_memberships")) return { rows: [] };
    if (sql.includes("update members")) {
      writes++;
      if (sql.includes("member_type_id =")) {
        assert.ok(parameters.includes("123"));
        assert.ok(parameters.includes("Novo"));
      }
      return { rows: [] };
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  }, audits);
  await assert.rejects(service.update(tenant(["TREASURER"]), userId, memberId, { phone: null }), code("FORBIDDEN"));
  await service.update(tenant(["TREASURER"]), userId, memberId, { name: "Novo" });
  await service.delete(tenant(["TREASURER"]), userId, memberId);
  assert.equal(writes, 2);
  assert.deepEqual(audits.map((record) => record.action), ["MEMBER_UPDATED", "MEMBER_DELETED"]);
});

test("secretaria e administrador gerenciam registros antigos; acesso ativo impede exclusão", async () => {
  let writes = 0;
  let active = true;
  const service = serviceWith(async ({ sql }) => {
    if (sql.includes("as item from members")) return { rows: [{ item: member(null) }] };
    if (sql.includes("from tenant_memberships")) return { rows: [{ status: active ? "ACTIVE" : "SUSPENDED" }] };
    if (sql.includes("update members")) { writes++; return { rows: [] }; }
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  await service.update(tenant(["SECRETARY"]), userId, memberId, { phone: "456" });
  await assert.rejects(service.delete(tenant(["TENANT_ADMIN"]), userId, memberId), code("MEMBER_HAS_ACCESS"));
  assert.equal(writes, 1);
  active = false;
  await service.delete(tenant(["TENANT_ADMIN"]), userId, memberId);
  assert.equal(writes, 2);
  await assert.rejects(service.update(tenant(["FISCAL"]), userId, memberId, { name: "Novo" }), code("FORBIDDEN"));
});

test("listagem filtra tenant, status e exclusão, sem expor telefone ao fiscal", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.function("app_norm", (value) => value === null ? null : value.toLowerCase());
    db.exec(`
      create table members (id text, tenant_id text, name text, member_type_id text, status text, phone text, created_at text, deleted_at text);
      create table member_types (id text, tenant_id text, description text);
      insert into member_types values ('type', 'a', 'Membro'), ('type', 'b', 'Membro');
      insert into members values
        ('1', 'a', 'Ana', 'type', 'ACTIVE', '123', '2026-01-01', null),
        ('2', 'a', 'Bia', 'type', 'INACTIVE', '456', '2026-01-02', null),
        ('3', 'a', 'Clara', 'type', 'ACTIVE', '789', '2026-01-03', '2026-02-01'),
        ('4', 'b', 'Dora', 'type', 'ACTIVE', '999', '2026-01-04', null);
    `);
    const service = serviceWith(async (compiled) => {
      const query = compiled.sql.replace(/\$\d+/g, "?").replace(/::(?:uuid|text|jsonb)/g, "")
        .replaceAll("jsonb_build_object", "json_object")
        .replaceAll("jsonb_agg(item order by ordinal)", "json_group_array(json(item) order by ordinal)");
      const row = db.prepare(query).get(...compiled.parameters);
      return { rows: [{ ...row, data: JSON.parse(row.data) }] };
    });
    const active = await service.list("a", userId, {}, false);
    assert.equal(active.meta.total, 1);
    assert.equal(active.data[0].phone, null);
    const all = await service.list("a", userId, { status: "ALL", pageSize: "1", page: "2" }, true);
    assert.equal(all.meta.total, 2);
    assert.equal(all.data[0].phone, "456");
    const filtered = await service.list("a", userId, { q: "an" }, true);
    assert.equal(filtered.data[0].name, "Ana");
  } finally {
    db.close();
  }
});

test("duplicidade retorna candidatos e force permite confirmação", async () => {
  let writes = 0;
  const service = serviceWith(async ({ sql }) => {
    if (sql.includes("from member_types")) return { rows: [{ id: typeId }] };
    if (sql.includes("app_norm(name)")) return { rows: [{ id: memberId, name: "Ana" }] };
    if (sql.includes("insert into members")) { writes++; return { rows: [{ id: memberId }] }; }
    if (sql.includes("as item from members")) return { rows: [{ item: member() }] };
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const body = { name: "Ana", memberTypeId: typeId, birthDate: "2000-01-01" };
  await assert.rejects(service.create(tenant(["SECRETARY"]), userId, body, false), (error) => {
    assert.equal(error.getResponse().code, "POSSIBLE_DUPLICATE");
    assert.deepEqual(error.getResponse().errors, [{ id: memberId, name: "Ana" }]);
    return true;
  });
  await service.create(tenant(["SECRETARY"]), userId, body, true);
  assert.equal(writes, 1);
});

test("rotas de membros e catálogo são registradas sem encobrir lookup e all", async () => {
  const { NestFactory } = require("@nestjs/core");
  const { SwaggerModule, DocumentBuilder } = require("@nestjs/swagger");
  const { AppModule } = require("../dist/app.module");
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix("v1");
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    assert.ok(document.paths["/v1/members"].get);
    assert.ok(document.paths["/v1/members"].post);
    assert.ok(document.paths["/v1/members/{id}"].get);
    assert.ok(document.paths["/v1/members/{id}"].put);
    assert.ok(document.paths["/v1/members/{id}"].delete);
    assert.ok(document.paths["/v1/catalogs/member-types"].get);
    await app.init();
    const routes = app.getHttpAdapter().getInstance().router.stack
      .filter((layer) => layer.route && layer.route.methods.get)
      .map((layer) => layer.route.path);
    assert.ok(routes.indexOf("/v1/members/lookup") >= 0);
    assert.ok(routes.indexOf("/v1/members/all") >= 0);
    assert.ok(routes.indexOf("/v1/members/:id") > routes.indexOf("/v1/members/lookup"));
    assert.ok(routes.indexOf("/v1/members/:id") > routes.indexOf("/v1/members/all"));
  } finally {
    await app.close();
  }
});
