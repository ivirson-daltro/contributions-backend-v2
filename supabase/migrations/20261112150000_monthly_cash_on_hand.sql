-- IBG v2 · saldo em mãos por mês (delta da especificação 2.2)
-- Migration incremental: as migrations 20261112120001-10 já podem estar aplicadas.

alter table monthly_balances
  add column cash_on_hand numeric(14,2),
  add column cash_on_hand_notes text,
  add column cash_on_hand_by uuid,
  add column cash_on_hand_at timestamptz,
  add constraint monthly_balances_cash_on_hand_ck
    check (cash_on_hand is null or cash_on_hand >= 0);

-- Meses fechados antes desta migration não tinham o campo; preserva seus totais com zero.
update monthly_balances
   set cash_on_hand = 0,
       closing_snapshot = closing_snapshot || jsonb_build_object(
         'cash_on_hand', 0,
         'final_balance', coalesce((closing_snapshot ->> 'balance')::numeric, 0)
       )
 where closed_at is not null
   and closing_snapshot is not null;

drop function v2_month_snapshot(uuid, integer, integer, numeric, text);

create function v2_month_snapshot(
  p_tenant uuid,
  p_year int,
  p_month int,
  p_opening numeric,
  p_source text default 'APP',
  p_cash numeric default 0
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
    'cash_on_hand', coalesce(p_cash, 0),
    'final_balance', inc.total - exp.total + coalesce(p_cash, 0),
    'accumulated', coalesce(p_opening, 0) + inc.total - exp.total + coalesce(p_cash, 0),
    'income_by_category', inc_cat.j,
    'income_by_kind', inc_kind.j,
    'expense_by_category', exp_cat.j,
    'source', p_source,
    'computed_at', now())
  from inc, exp, inc_cat, inc_kind, exp_cat
$$;

revoke all on function v2_month_snapshot(uuid, integer, integer, numeric, text, numeric)
  from public, anon, authenticated;
grant execute on function v2_month_snapshot(uuid, integer, integer, numeric, text, numeric)
  to ibg_api;

create or replace function v2_guard_closed_opening() returns trigger
language plpgsql as $$
begin
  if not v2_guard_bypassed()
     and old.closed_at is not null and new.closed_at is not null
     and (new.opening_balance is distinct from old.opening_balance
          or new.cash_on_hand is distinct from old.cash_on_hand) then
    raise exception 'MONTH_CLOSED: abertura e saldo em mãos de %/% não mudam com o mês fechado', new.month, new.year
      using errcode = 'P0001';
  end if;

  if not v2_guard_bypassed() and old.closed_at is null and new.closed_at is not null
     and new.cash_on_hand is null then
    raise exception 'CASH_ON_HAND_REQUIRED: informe o saldo em mãos de %/% antes de fechar o mês', new.month, new.year
      using errcode = 'P0001';
  end if;

  return new;
end $$;