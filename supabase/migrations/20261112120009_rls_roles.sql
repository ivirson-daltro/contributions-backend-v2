-- =============================================================================
-- IBG v2 · BANCO NOVO 09/10 · Row Level Security e role da API
-- -----------------------------------------------------------------------------
--  * O Nest conecta como `ibg_api` (não dono, sem BYPASSRLS) e define app.tenant_id /
--    app.user_id por transação (withTenantTx).
--  * Dono da tabela e service_role ignoram as policies (migrations, jobs, carga).
--  * anon/authenticated (API de dados do Supabase) ficam SEM acesso.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ibg_api') then
    -- defina a senha fora do repositório: alter role ibg_api password '<secret>';
    create role ibg_api login noinherit;
  end if;
end $$;

-- ------------------------ isolamento por tenant_id ---------------------------
do $$
declare t text;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and not c.relispartition
       and c.relname not in ('tenant_memberships', 'membership_roles')   -- policies próprias abaixo
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

-- ------------------------------ policies próprias ----------------------------
alter table tenants enable row level security;
create policy tenants_visible on tenants for select
  using (id = app_tenant_id()
         or id in (select tm.tenant_id from tenant_memberships tm where tm.user_id = app_user_id()));
create policy tenants_update_current on tenants for update
  using (id = app_tenant_id()) with check (id = app_tenant_id());

-- A API lista as associações do usuário ANTES de saber o tenant (só app.user_id definido)
alter table tenant_memberships enable row level security;
create policy memberships_visible on tenant_memberships
  using (tenant_id = app_tenant_id() or user_id = app_user_id())
  with check (tenant_id = app_tenant_id());

alter table membership_roles enable row level security;
create policy roles_visible on membership_roles
  using (tenant_id = app_tenant_id()
         or membership_id in (select tm.id from tenant_memberships tm where tm.user_id = app_user_id()))
  with check (tenant_id = app_tenant_id());

alter table user_profiles enable row level security;
create policy profiles_self_or_peers on user_profiles for select
  using (user_id = app_user_id()
         or user_id in (select tm.user_id from tenant_memberships tm where tm.tenant_id = app_tenant_id()));
create policy profiles_self_write on user_profiles for update
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy profiles_self_insert on user_profiles for insert
  with check (user_id = app_user_id());

alter table platform_admins enable row level security;
create policy platform_admins_self on platform_admins for select using (user_id = app_user_id());

-- --------------------------------- privilégios -------------------------------
grant usage on schema public to ibg_api;
grant select, insert, update, delete on all tables in schema public to ibg_api;
grant usage, select on all sequences in schema public to ibg_api;
grant execute on all functions in schema public to ibg_api;

-- auditoria é append-only também por privilégio
revoke update, delete, truncate on audit_log from ibg_api;

-- partições só via tabela-mãe (a RLS da mãe não vale em acesso direto)
do $$
declare p text;
begin
  for p in
    select c.relname from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relispartition and c.relkind in ('r', 'p')
  loop
    execute format('revoke all on %I from ibg_api', p);
  end loop;
end $$;

-- API de dados do Supabase: nenhum acesso
revoke all on all tables in schema public from anon, authenticated;
