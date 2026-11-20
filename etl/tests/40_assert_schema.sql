\set ON_ERROR_STOP on
do $$
begin
  -- nenhuma coluna/tabela/função da camada de coexistência
  assert not exists (select 1 from information_schema.columns where table_schema = 'public'
     and column_name in ('storage_layout','legacy_source','classification_source','genre','value','date','deleted_at') and table_name <> 'members'),
     'sem colunas legadas (members.deleted_at é da v2)';
  assert not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('v2_cfg','v2_legacy_tenant_id','v2_money','v2_contributions_sync','v2_expenses_sync','v2_backfill_memberships')), 'sem funções de coexistência';
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname in ('trg_v2_sync','trg_v2_legacy_attach','trg_v2_audit_sync','trg_v2_payment_sync','trg_v2_defaults'));
  assert to_regclass('public.v2_migration_config') is null and to_regclass('public.v2_user_map') is null;
  -- todas as tabelas com tenant_id têm RLS ligada
  assert not exists (select 1 from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relispartition and not c.relrowsecurity), 'RLS em todas as tabelas de tenant';
  -- sem constraint pendente de validação
  assert not exists (select 1 from pg_constraint where connamespace = 'public'::regnamespace and not convalidated), 'nada NOT VALID';
  -- sem DEFAULT de tenant_id (a API passa o tenant explicitamente)
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id' and column_default is not null);
end $$;
\echo '[ok] 40_assert_schema'
