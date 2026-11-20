-- =============================================================================
-- IBG v2 · BANCO NOVO 07/10 · Auditoria, taxas, idempotência, outbox e seed de tenant
-- =============================================================================

-- Append-only, particionada por mês
create table audit_log (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  created_at          timestamptz not null default now(),
  actor_user_id       uuid,          -- auth.users.id
  actor_membership_id uuid,
  legacy_actor_id     uuid,          -- app_users.id da v1 (só registros migrados)
  action              text not null,
  entity              text not null,
  entity_id           text,
  "before"            jsonb,
  "after"             jsonb,
  reason              text,
  request_id          text,
  ip                  inet,
  user_agent          text,
  source              text not null default 'APP' check (source in ('APP','V1','SYSTEM')),
  primary key (id, created_at)
) partition by range (created_at);
create index audit_log_tenant_time_idx   on audit_log (tenant_id, created_at desc);
create index audit_log_tenant_entity_idx on audit_log (tenant_id, entity, entity_id);

create table audit_log_default partition of audit_log default;

-- Cria a partição do mês de p_day (idempotente). O job mensal chama com 3 meses de folga
-- para a DEFAULT ficar vazia (criar partição quando há linhas na DEFAULT para o intervalo falha).
create or replace function v2_ensure_audit_partition(p_day date) returns void
language plpgsql as $$
declare
  d0 date := date_trunc('month', p_day)::date;
  d1 date := (date_trunc('month', p_day) + interval '1 month')::date;
  p  text := 'audit_log_' || to_char(d0, 'YYYYMM');
begin
  if to_regclass(format('public.%I', p)) is null then
    execute format('create table %I partition of audit_log for values from (%L) to (%L)', p, d0, d1);
  end if;
end $$;

-- mês atual + 3 meses à frente (a carga da v1 cria os meses históricos que precisar)
do $$
declare d date := date_trunc('month', current_date)::date;
begin
  for i in 0..3 loop
    perform v2_ensure_audit_partition((d + make_interval(months => i))::date);
  end loop;
end $$;

-- Imutabilidade: UPDATE/DELETE só em manutenção explícita (set_config('app.audit_maintenance','on',true))
create or replace function v2_audit_append_only() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.audit_maintenance', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'AUDIT_IMMUTABLE: audit_log é append-only' using errcode = 'P0001';
end $$;

create trigger trg_audit_append_only
  before update or delete on audit_log
  for each row execute function v2_audit_append_only();

-- ---------------------------------- fee_rules --------------------------------
create table fee_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  name       text not null,
  percent    numeric(5,2) not null check (percent >= 0),
  -- HALF_UP_2: centavo mais próximo. LEGACY_CENTS_09: comportamento da v1 (descarta centavos
  -- e fixa 0,09; base zero => 0,09), mantido só até a decisão de negócio.
  rounding   text not null default 'HALF_UP_2' check (rounding in ('HALF_UP_2','LEGACY_CENTS_09')),
  active     boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint fee_rules_name_uk unique (tenant_id, name)
);

-- ------------------------- idempotência e outbox -----------------------------
create table idempotency_keys (
  tenant_id    uuid not null references tenants(id),
  key          text not null,
  request_hash text not null,
  status_code  int,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, key)
);
create index idempotency_keys_created_idx on idempotency_keys (created_at);

create table outbox_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id),
  type         text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);
create index outbox_pending_idx on outbox_events (created_at) where processed_at is null;

-- --------------------------- seed de um novo tenant --------------------------
-- Chamada SOMENTE por v2_platform_create_tenant (criação de igreja pelo ADMIN global). Idempotente.
-- Não existe cadastro público de igrejas.
create or replace function v2_seed_tenant_defaults(p_tenant uuid) returns void
language plpgsql as $$
begin
  insert into tenant_settings (tenant_id) values (p_tenant) on conflict do nothing;

  insert into member_types (tenant_id, description)
  select p_tenant, v.d from (values ('Membro'),('Congregado'),('Visitante'),('Líder')) v(d)
   where not exists (select 1 from member_types t
                      where t.tenant_id = p_tenant and app_norm(t.description) = app_norm(v.d));

  insert into contribution_types
    (tenant_id, description, category, requires_member, counts_for_fees, counts_as_contributor)
  select p_tenant, v.d, v.c, v.rm, v.cf, v.cc
    from (values
      ('Dízimo',               'TITHE',                 true,  true,  true),
      ('Oferta',               'OFFERING',              false, true,  false),
      ('Oferta de Construção', 'CONSTRUCTION_OFFERING', false, false, false),
      ('Missões',              'MISSIONS',              false, false, false),
      ('Rendimentos',          'INCOME',                false, false, false)
    ) v(d, c, rm, cf, cc)
   where not exists (select 1 from contribution_types t
                      where t.tenant_id = p_tenant and app_norm(t.description) = app_norm(v.d));

  insert into payment_methods (tenant_id, description, kind)
  select p_tenant, v.d, v.k
    from (values ('Dinheiro','CASH'),('Pix','PIX'),('Cartão','CARD'),('Transferência','TRANSFER')) v(d, k)
   where not exists (select 1 from payment_methods t
                      where t.tenant_id = p_tenant and app_norm(t.description) = app_norm(v.d));

  insert into expense_categories (tenant_id, description)
  select p_tenant, v.d
    from (values ('Energia elétrica'),('Água'),('Aluguel'),('Manutenção'),('Material de consumo'),
                 ('Ação social'),('Eventos'),('Missões'),('Salários e encargos'),('Outros')) v(d)
   where not exists (select 1 from expense_categories t
                      where t.tenant_id = p_tenant and app_norm(t.description) = app_norm(v.d));

  insert into fee_rules (tenant_id, name, percent, rounding, sort_order)
  values (p_tenant, 'ASBARE', 2, 'HALF_UP_2', 1), (p_tenant, 'Plano Cooperativo', 5, 'HALF_UP_2', 2)
  on conflict (tenant_id, name) do nothing;
end $$;
