\set ON_ERROR_STOP on
do $$
begin
  assert (select count(*) from pg_tables where schemaname = 'public') = 29, 'tabelas esperadas';
  -- nenhum resíduo de coexistência
  assert not exists (select 1 from information_schema.columns where table_schema = 'public'
    and column_name in ('storage_layout','legacy_source','classification_source','genre','closed_by','value','date')),
    'sem colunas legadas';
  assert to_regclass('public.v2_migration_config') is null and to_regclass('public.v2_user_map') is null;
  -- toda tabela com tenant_id tem RLS ligada
  assert not exists (
    select 1 from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relispartition
       and not c.relrowsecurity), 'RLS em toda tabela com tenant_id';
  assert (select count(*) from pg_policies where schemaname = 'public' and policyname = 'tenant_isolation') >= 18;
  -- dinheiro é numeric(14,2)
  assert (select count(*) from information_schema.columns where table_schema = 'public'
           and data_type in ('real','double precision')) = 0, 'sem ponto flutuante';
  -- seed de tenant novo é idempotente e completo
  insert into tenants (id, slug, name) values ('a0000000-0000-4000-8000-0000000000aa', 'nova', 'Nova Igreja');
  perform v2_seed_tenant_defaults('a0000000-0000-4000-8000-0000000000aa');
  perform v2_seed_tenant_defaults('a0000000-0000-4000-8000-0000000000aa');
  assert (select count(*) from contribution_types where tenant_id = 'a0000000-0000-4000-8000-0000000000aa') = 5;
  assert (select count(*) from fee_rules where tenant_id = 'a0000000-0000-4000-8000-0000000000aa') = 2;
  assert (select count(*) from pg_class where relname like 'audit_log_20%' and relispartition) >= 4, 'partições de auditoria';
  -- app_norm imutável e funcionando
  assert app_norm('  Dízimo ') = 'dizimo';
end $$;
-- limpa o tenant de teste (sem admin: usa bypass)
begin;
select set_config('app.bypass_guards','on',true);
delete from fee_rules where tenant_id = 'a0000000-0000-4000-8000-0000000000aa';
delete from expense_categories where tenant_id = 'a0000000-0000-4000-8000-0000000000aa';
delete from payment_methods where tenant_id = 'a0000000-0000-4000-8000-0000000000aa';
delete from contribution_types where tenant_id = 'a0000000-0000-4000-8000-0000000000aa';
delete from member_types where tenant_id = 'a0000000-0000-4000-8000-0000000000aa';
delete from tenant_settings where tenant_id = 'a0000000-0000-4000-8000-0000000000aa';
delete from tenants where id = 'a0000000-0000-4000-8000-0000000000aa';
commit;
\echo '[ok] 10_assert_schema'
