-- =============================================================================
-- IBG v2 · BANCO NOVO 08/10 · Travas de negócio no banco (defesa em profundidade)
-- -----------------------------------------------------------------------------
-- A API devolve erros amigáveis (409 MONTH_CLOSED etc.); estes triggers garantem que nenhum
-- caminho (job, script, SQL manual) viole a regra. Mensagens começam com o código do erro
-- (errcode P0001 + prefixo) para a API mapear.
-- Manutenção/carga excepcional: select set_config('app.bypass_guards','on',true) na transação.
-- Nomes trg_v2_z_* rodam DEPOIS dos triggers de snapshot/touch.
-- =============================================================================

create or replace function v2_guard_bypassed() returns boolean
language sql stable as $$ select coalesce(current_setting('app.bypass_guards', true), '') = 'on' $$;

create or replace function v2_is_month_closed(p_tenant uuid, p_day date) returns boolean
language sql stable as $$
  select p_day is not null and exists (
    select 1 from monthly_balances mb
     where mb.tenant_id = p_tenant
       and mb.year  = extract(year  from p_day)::int
       and mb.month = extract(month from p_day)::int
       and mb.closed_at is not null)
$$;

-- 1. Mês fechado bloqueia criar/editar/cancelar lançamentos e baixas ------------------
create or replace function v2_guard_closed_month() returns trigger
language plpgsql as $$
declare d_old date; d_new date; t uuid;
begin
  if v2_guard_bypassed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  t := case when tg_op = 'INSERT' then new.tenant_id else old.tenant_id end;

  if tg_table_name = 'payments' then
    if tg_op <> 'INSERT' then d_old := old.paid_at; end if;
    if tg_op <> 'DELETE' then d_new := new.paid_at; end if;
  else  -- contributions, expenses
    if tg_op <> 'INSERT' then d_old := old.occurred_on; end if;
    if tg_op <> 'DELETE' then d_new := new.occurred_on; end if;
  end if;

  if v2_is_month_closed(t, d_old) then
    raise exception 'MONTH_CLOSED: o mês % está fechado', to_char(d_old, 'MM/YYYY') using errcode = 'P0001';
  end if;
  if d_new is distinct from d_old and v2_is_month_closed(t, d_new) then
    raise exception 'MONTH_CLOSED: o mês % está fechado', to_char(d_new, 'MM/YYYY') using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger trg_v2_z_month_guard before insert or update or delete on contributions
  for each row execute function v2_guard_closed_month();
create trigger trg_v2_z_month_guard before insert or update or delete on expenses
  for each row execute function v2_guard_closed_month();
create trigger trg_v2_z_month_guard before insert or update or delete on payments
  for each row execute function v2_guard_closed_month();

-- saldo de abertura de mês fechado não muda (reabrir primeiro)
create or replace function v2_guard_closed_opening() returns trigger
language plpgsql as $$
begin
  if not v2_guard_bypassed()
     and old.closed_at is not null and new.closed_at is not null
     and new.opening_balance is distinct from old.opening_balance then
    raise exception 'MONTH_CLOSED: o saldo de abertura de %/% não pode mudar com o mês fechado', new.month, new.year
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_v2_z_opening_guard before update on monthly_balances
  for each row execute function v2_guard_closed_opening();

-- 2. Histórico financeiro não é apagado (cancelamento lógico) ------------------------
create or replace function v2_forbid_delete() returns trigger
language plpgsql as $$
begin
  if v2_guard_bypassed() then return old; end if;
  raise exception 'DELETE_FORBIDDEN: % não pode ser apagado; use o cancelamento (status = VOIDED/REVERSED)', tg_table_name
    using errcode = 'P0001';
end $$;

create trigger trg_v2_z_no_delete before delete on contributions for each row execute function v2_forbid_delete();
create trigger trg_v2_z_no_delete before delete on expenses      for each row execute function v2_forbid_delete();
create trigger trg_v2_z_no_delete before delete on payments      for each row execute function v2_forbid_delete();

-- 3. Membro obrigatório conforme o tipo (revalidado em criação E edição) --------------
create or replace function v2_validate_contribution() returns trigger
language plpgsql as $$
declare v_req boolean;
begin
  if v2_guard_bypassed() or new.status = 'VOIDED' then return new; end if;
  if tg_op = 'UPDATE' and new.member_id is not distinct from old.member_id
     and new.contribution_type_id is not distinct from old.contribution_type_id then
    return new;
  end if;
  select requires_member into v_req from contribution_types
   where tenant_id = new.tenant_id and id = new.contribution_type_id;
  if coalesce(v_req, true) and new.member_id is null then
    raise exception 'MEMBER_REQUIRED: o tipo de contribuição exige membro' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_v2_z_validate before insert or update on contributions
  for each row execute function v2_validate_contribution();

-- 4. Concorrência otimista: a API faz "update ... where id = $1 and version = $2" ----
create or replace function v2_bump_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

create trigger trg_v2_z_version before update on contributions for each row execute function v2_bump_version();
create trigger trg_v2_z_version before update on expenses      for each row execute function v2_bump_version();
create trigger trg_v2_z_version before update on payables      for each row execute function v2_bump_version();
