-- =============================================================================
-- IBG v2 · BANCO NOVO 04/10 · Contribuições, despesas e saldos mensais
-- -----------------------------------------------------------------------------
-- Dinheiro em numeric(14,2); dia de negócio em `date` (fuso do tenant); cancelamento
-- lógico (VOIDED) em vez de DELETE; `version` para concorrência otimista.
-- =============================================================================

create table contributions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  member_id            uuid,
  contribution_type_id uuid not null,
  payment_method_id    uuid not null,
  amount               numeric(14,2) not null check (amount > 0),
  occurred_on          date not null,
  observation          text,
  status               text not null default 'ACTIVE' check (status in ('ACTIVE','VOIDED')),
  voided_at            timestamptz,
  voided_by            uuid,
  void_reason          text,
  category_snapshot    text not null,   -- categoria do tipo NO MOMENTO do lançamento
  kind_snapshot        text not null,   -- kind do meio de pagamento NO MOMENTO do lançamento
  version              int  not null default 1,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint contributions_tenant_id_uk unique (tenant_id, id),
  constraint contributions_void_ck check ((status = 'VOIDED') = (voided_at is not null)),
  constraint contributions_member_fk foreign key (tenant_id, member_id)
    references members (tenant_id, id),
  constraint contributions_type_fk foreign key (tenant_id, contribution_type_id)
    references contribution_types (tenant_id, id),
  constraint contributions_method_fk foreign key (tenant_id, payment_method_id)
    references payment_methods (tenant_id, id)
);
create index contributions_tenant_date_idx   on contributions (tenant_id, occurred_on desc) where status = 'ACTIVE';
create index contributions_tenant_member_idx on contributions (tenant_id, member_id, occurred_on) where status = 'ACTIVE';
create index contributions_tenant_type_idx   on contributions (tenant_id, contribution_type_id, occurred_on);
create index contributions_tenant_method_idx on contributions (tenant_id, payment_method_id, occurred_on);

create table expenses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  description text,
  amount      numeric(14,2) not null,
  occurred_on date not null,
  category_id uuid,
  notes       text,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE','VOIDED')),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text,
  origin      text not null default 'MANUAL' check (origin in ('MANUAL','PAYABLE')),
  version     int  not null default 1,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint expenses_tenant_id_uk unique (tenant_id, id),
  constraint expenses_amount_ck check (status = 'VOIDED' or amount > 0),
  constraint expenses_void_ck   check ((status = 'VOIDED') = (voided_at is not null)),
  constraint expenses_category_fk foreign key (tenant_id, category_id)
    references expense_categories (tenant_id, id)
);
create index expenses_tenant_date_idx     on expenses (tenant_id, occurred_on desc) where status = 'ACTIVE';
create index expenses_tenant_category_idx on expenses (tenant_id, category_id, occurred_on);

-- Snapshots do catálogo: reclassificar um tipo/meio depois NÃO reescreve o histórico.
-- INSERT: preenche se vier nulo (a carga da v1 já envia o valor); UPDATE: só se o tipo/meio mudou.
create or replace function v2_contribution_snapshots() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' and new.category_snapshot is null)
     or (tg_op = 'UPDATE' and new.contribution_type_id is distinct from old.contribution_type_id) then
    select category into new.category_snapshot from contribution_types
     where tenant_id = new.tenant_id and id = new.contribution_type_id;
  end if;
  if (tg_op = 'INSERT' and new.kind_snapshot is null)
     or (tg_op = 'UPDATE' and new.payment_method_id is distinct from old.payment_method_id) then
    select kind into new.kind_snapshot from payment_methods
     where tenant_id = new.tenant_id and id = new.payment_method_id;
  end if;
  return new;
end $$;

create trigger trg_v2_snapshots before insert or update on contributions
  for each row execute function v2_contribution_snapshots();

-- ----------------------------- monthly_balances ------------------------------
create table monthly_balances (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id),
  year                    int  not null check (year between 2000 and 2200),
  month                   int  not null check (month between 1 and 12),
  opening_balance         numeric(14,2) not null default 0,
  opening_source          text not null default 'MANUAL'
                          check (opening_source in ('MANUAL','CARRIED_OVER','ADJUSTED')),
  adjustment_reason       text,
  notes                   text,
  closed_at               timestamptz,
  closed_by_membership_id uuid,
  closing_snapshot        jsonb,
  reopened_at             timestamptz,
  reopened_by             uuid,
  reopen_reason           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint monthly_balances_tenant_id_uk unique (tenant_id, id),
  constraint monthly_balances_period_uk unique (tenant_id, year, month),
  constraint monthly_balances_closed_ck check ((closed_at is null) = (closing_snapshot is null))
);

create trigger trg_v2_touch before update on monthly_balances
  for each row execute function v2_touch_updated_at();

-- Foto do mês: usada no fechamento, em relatórios e no painel de meses passados
create or replace function v2_month_snapshot(
  p_tenant uuid, p_year int, p_month int, p_opening numeric, p_source text default 'APP'
) returns jsonb
language sql stable as $$
  with bounds as (
    select make_date(p_year, p_month, 1) as d0,
           (make_date(p_year, p_month, 1) + interval '1 month')::date as d1
  ),
  inc as (
    select coalesce(sum(c.amount), 0) as total, count(*) as qty
      from contributions c, bounds b
     where c.tenant_id = p_tenant and c.status = 'ACTIVE'
       and c.occurred_on >= b.d0 and c.occurred_on < b.d1
  ),
  exp as (
    select coalesce(sum(e.amount), 0) as total, count(*) as qty
      from expenses e, bounds b
     where e.tenant_id = p_tenant and e.status = 'ACTIVE'
       and e.occurred_on >= b.d0 and e.occurred_on < b.d1
  ),
  inc_cat as (
    select coalesce(jsonb_object_agg(k, t), '{}'::jsonb) as j from (
      select c.category_snapshot as k, sum(c.amount) as t
        from contributions c, bounds b
       where c.tenant_id = p_tenant and c.status = 'ACTIVE'
         and c.occurred_on >= b.d0 and c.occurred_on < b.d1
       group by 1) s
  ),
  inc_kind as (
    select coalesce(jsonb_object_agg(k, t), '{}'::jsonb) as j from (
      select c.kind_snapshot as k, sum(c.amount) as t
        from contributions c, bounds b
       where c.tenant_id = p_tenant and c.status = 'ACTIVE'
         and c.occurred_on >= b.d0 and c.occurred_on < b.d1
       group by 1) s
  ),
  exp_cat as (
    select coalesce(jsonb_object_agg(k, t), '{}'::jsonb) as j from (
      select coalesce(e.category_id::text, 'NONE') as k, sum(e.amount) as t
        from expenses e, bounds b
       where e.tenant_id = p_tenant and e.status = 'ACTIVE'
         and e.occurred_on >= b.d0 and e.occurred_on < b.d1
       group by 1) s
  )
  select jsonb_build_object(
    'year', p_year, 'month', p_month,
    'opening', coalesce(p_opening, 0),
    'income', inc.total, 'income_count', inc.qty,
    'expense', exp.total, 'expense_count', exp.qty,
    'balance', inc.total - exp.total,
    'accumulated', coalesce(p_opening, 0) + inc.total - exp.total,
    'income_by_category', inc_cat.j,
    'income_by_kind', inc_kind.j,
    'expense_by_category', exp_cat.j,
    'source', p_source,
    'computed_at', now())
  from inc, exp, inc_cat, inc_kind, exp_cat
$$;
