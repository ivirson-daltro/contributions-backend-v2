\set ON_ERROR_STOP on
-- Regras de negócio no banco, isolamento por tenant (RLS) e imutabilidade, como o Nest as exercita.
select set_config('app.bypass_guards', 'off', false);

-- Tenant B (outra igreja) — criado direto (a criação real é pelo ADMIN global; coberta em 35_assert_platform)
insert into tenants (id, slug, name, status) values ('b0b0b0b0-0000-4000-8000-000000000002', 'igreja-b', 'Igreja B', 'ACTIVE');
select v2_seed_tenant_defaults('b0b0b0b0-0000-4000-8000-000000000002');
insert into members (id, tenant_id, name, member_type_id)
select 'b1000000-0000-4000-8000-000000000001', tenant_id, 'Membro B', id
  from member_types where tenant_id = 'b0b0b0b0-0000-4000-8000-000000000002' limit 1;

-- 1. RLS: ibg_api só enxerga o tenant da transação ---------------------------------------------
begin;
set local role ibg_api;
select set_config('app.tenant_id', 'a1b2c3d4-0000-4000-8000-000000000001', true);
do $$
begin
  assert (select count(*) from members) = 4, 'A vê só os seus membros';
  assert not exists (select 1 from members where name = 'Membro B'), 'A não vê o tenant B';
  assert (select count(*) from tenants) = 1;
  -- escrever em outro tenant é recusado pela policy
  begin
    insert into members (tenant_id, name, member_type_id)
    values ('b0b0b0b0-0000-4000-8000-000000000002', 'invasor', (select id from member_types limit 1));
    assert false, 'deveria falhar';
  exception when insufficient_privilege or check_violation then null; end;
  -- FK composta impede apontar para membro de outro tenant
  begin
    insert into contributions (tenant_id, member_id, contribution_type_id, payment_method_id, amount, occurred_on)
    values (app_tenant_id(), 'b1000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 10, '2026-11-09');
    assert false, 'deveria falhar';
  exception when foreign_key_violation then null; end;
end $$;
rollback;

begin;
set local role ibg_api;
select set_config('app.tenant_id', 'b0b0b0b0-0000-4000-8000-000000000002', true);
do $$ begin
  assert (select count(*) from members) = 1, 'B vê só o seu';
  assert (select count(*) from contributions) = 0;
end $$;
rollback;

-- sem tenant definido, nada é visível
begin;
set local role ibg_api;
do $$ begin assert (select count(*) from contributions) = 0 and (select count(*) from members) = 0; end $$;
rollback;

-- 2. Travas de negócio (como ibg_api, tenant A) ------------------------------------------------
begin;
set local role ibg_api;
select set_config('app.tenant_id', 'a1b2c3d4-0000-4000-8000-000000000001', true);
do $$
declare c uuid; v1 int; v2 int; m text;
begin
  -- mês fechado (set/2026) bloqueia criar despesa, editar contribuição e baixar
  begin
    insert into expenses (tenant_id, description, amount, occurred_on) values (app_tenant_id(), 'x', 10, '2026-09-20');
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MONTH_CLOSED%', m; end;
  begin
    update expenses set occurred_on = '2026-09-10' where id = '70000000-0000-4000-8000-000000000001';  -- mover PARA mês fechado
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MONTH_CLOSED%', m; end;
  begin
    update expenses set description = 'mexeu' where id = '70000000-0000-4000-8000-000000000004';       -- editar DENTRO de mês fechado
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MONTH_CLOSED%', m; end;
  begin
    update monthly_balances set opening_balance = 5 where id = 'b0000000-0000-4000-8000-000000000001';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MONTH_CLOSED%', m; end;

  begin
    update monthly_balances set cash_on_hand = 50 where id = 'b0000000-0000-4000-8000-000000000001';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MONTH_CLOSED%', m; end;

  -- saldo em mãos é obrigatório para fechar; zero é válido e entra no snapshot
  insert into monthly_balances (tenant_id, year, month, opening_balance)
  values (app_tenant_id(), 2099, 1, 100);
  begin
    update monthly_balances set closed_at = now(), closing_snapshot = '{}'::jsonb where year = 2099 and month = 1;
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'CASH_ON_HAND_REQUIRED%', m; end;
  begin
    update monthly_balances set cash_on_hand = -1 where year = 2099 and month = 1;
    assert false;
  exception when check_violation then null; end;
  update monthly_balances set cash_on_hand = 25.50 where year = 2099 and month = 1;
  assert (v2_month_snapshot(app_tenant_id(), 2099, 1, 100, 'APP', 25.50)->>'balance')::numeric = 0;
  assert (v2_month_snapshot(app_tenant_id(), 2099, 1, 100, 'APP', 25.50)->>'final_balance')::numeric = 25.50;
  assert (v2_month_snapshot(app_tenant_id(), 2099, 1, 100, 'APP', 25.50)->>'accumulated')::numeric = 125.50;
  update monthly_balances set closed_at = now(),
         closing_snapshot = v2_month_snapshot(app_tenant_id(), 2099, 1, 100, 'APP', 25.50)
   where year = 2099 and month = 1;
  begin
    update monthly_balances set cash_on_hand = 0 where year = 2099 and month = 1;
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MONTH_CLOSED%', m; end;
  update monthly_balances set closed_at = null, closing_snapshot = null where year = 2099 and month = 1;
  update monthly_balances set cash_on_hand = 30 where year = 2099 and month = 1;
  delete from monthly_balances where year = 2099 and month = 1;

  -- histórico financeiro não é apagado
  begin
    delete from contributions where id = '60000000-0000-4000-8000-000000000001';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'DELETE_FORBIDDEN%', m; end;
  begin
    delete from expenses where id = '70000000-0000-4000-8000-000000000001';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'DELETE_FORBIDDEN%', m; end;

  -- membro obrigatório em Dízimo, opcional em Oferta
  begin
    insert into contributions (tenant_id, contribution_type_id, payment_method_id, amount, occurred_on)
    values (app_tenant_id(), '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 10, '2026-11-09');
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'MEMBER_REQUIRED%', m; end;
  insert into contributions (tenant_id, contribution_type_id, payment_method_id, amount, occurred_on)
  values (app_tenant_id(), '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 33.33, '2026-11-09')
  returning id into c;
  assert (select category_snapshot || '/' || kind_snapshot from contributions where id = c) = 'OFFERING/CASH', 'snapshot no insert';

  -- snapshot é histórico: reclassificar o tipo NÃO muda o lançamento antigo
  update contribution_types set category = 'OTHER' where id = '30000000-0000-4000-8000-000000000002';
  assert (select category_snapshot from contributions where id = c) = 'OFFERING';

  -- versão otimista incrementa; cancelamento lógico funciona
  select version into v1 from contributions where id = c;
  update contributions set observation = 'ok' where id = c;
  select version into v2 from contributions where id = c;
  assert v2 = v1 + 1, 'version++';
  update contributions set status = 'VOIDED', voided_at = now(), void_reason = 'teste' where id = c;
  assert (select status from contributions where id = c) = 'VOIDED';

  -- unicidade de catálogo ignora caixa/acento
  begin
    insert into payment_methods (tenant_id, description, kind) values (app_tenant_id(), 'PIX ', 'PIX');
    assert false;
  exception when unique_violation then null; end;

  -- no máximo um pagamento ativo por ocorrência
  begin
    insert into payments (tenant_id, occurrence_id, expense_id, paid_at, paid_amount)
    values (app_tenant_id(), 'a0000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000004', '2026-10-01', 1);
    assert false;
  exception when sqlstate 'P0001' then null;     -- (mês de baixa fechado também barra; ambos protegem)
           when unique_violation then null; end;
end $$;
rollback;

-- 3. Último TENANT_ADMIN ------------------------------------------------------------------------------
do $$
declare m text;
begin
  begin
    delete from membership_roles where role = 'TENANT_ADMIN' and tenant_id = 'a1b2c3d4-0000-4000-8000-000000000001';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'LAST_TENANT_ADMIN%', m; end;
  begin
    update tenant_memberships set status = 'SUSPENDED'
     where user_id = 'd0000000-0000-4000-8000-000000000001';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'LAST_TENANT_ADMIN%', m; end;
  -- com um segundo TENANT_ADMIN ativo, pode remover o primeiro
  insert into membership_roles (tenant_id, membership_id, role)
  select tenant_id, id, 'TENANT_ADMIN' from tenant_memberships where user_id = 'd0000000-0000-4000-8000-000000000002';
  delete from membership_roles
   where role = 'TENANT_ADMIN' and membership_id = (select id from tenant_memberships where user_id = 'd0000000-0000-4000-8000-000000000001');
  -- perfis se somam (TREASURER + TENANT_ADMIN na mesma associação)
  assert (select count(*) from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
           where tm.user_id = 'd0000000-0000-4000-8000-000000000002') = 2, 'múltiplos perfis por associação';
end $$;

-- 4. Auditoria append-only -----------------------------------------------------------------------
do $$
declare m text;
begin
  begin
    update audit_log set action = 'X';
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'AUDIT_IMMUTABLE%', m; end;
  begin
    delete from audit_log;
    assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'AUDIT_IMMUTABLE%', m; end;
end $$;
begin;
set local role ibg_api;
select set_config('app.tenant_id', 'a1b2c3d4-0000-4000-8000-000000000001', true);
do $$ begin
  begin update audit_log set action = 'X'; assert false; exception when insufficient_privilege then null; end;
  insert into audit_log (tenant_id, action, entity) values (app_tenant_id(), 'T', 'test');   -- inserir pode
end $$;
rollback;

-- 5. Role da API não vê a infraestrutura da migração nem escapa pelo schema etl/legacy ----------------
begin;
set local role ibg_api;
do $$ begin
  begin perform 1 from etl.config; assert false; exception when insufficient_privilege then null; end;
  begin perform 1 from legacy.members; assert false; exception when insufficient_privilege then null; end;
end $$;
rollback;
\echo '[ok] 30_assert_rules'
