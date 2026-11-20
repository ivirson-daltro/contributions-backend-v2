\set ON_ERROR_STOP on
-- ADMIN global x TENANT_ADMIN, convite por link, e o isolamento do ADMIN global sobre dados de igreja.

insert into auth.users (id, email) values
  ('e0000000-0000-4000-8000-000000000001', 'root@plataforma.com'),
  ('e0000000-0000-4000-8000-000000000002', 'pastor@igrejac.com'),
  ('e0000000-0000-4000-8000-000000000003', 'intruso@ex.com'),
  ('e0000000-0000-4000-8000-000000000004', 'dono@igrejad.com');
-- bootstrap do primeiro ADMIN global (manual, como dono do banco)
\set email 'root@plataforma.com'
\i supabase/bootstrap/platform_admin.sql

-- 1. ADMIN global cria a igreja C e o convite do primeiro TENANT_ADMIN --------------------------
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
select v2_platform_create_tenant('igreja-c', 'Igreja C', null, 'America/Sao_Paulo',
         'pastor@igrejac.com', 'Pastor C', 'hash-c-1', now() + interval '7 days') as tid \gset
commit;
select set_config('test.tid', :'tid', false) \gset

do $$
declare t uuid := current_setting('test.tid')::uuid;
begin
  assert (select status from tenants where id = t) = 'TRIAL';
  assert (select count(*) from contribution_types where tenant_id = t) = 5, 'catálogos semeados';
  assert (select count(*) from fee_rules where tenant_id = t) = 2;
  assert (select count(*) from invitations where tenant_id = t and created_by_platform and roles = array['TENANT_ADMIN']) = 1;
  assert (select count(*) from tenant_memberships where tenant_id = t) = 0, 'ninguém tem acesso até aceitar o link';
  assert (select count(*) from audit_log where tenant_id = t and action = 'platform.tenant.created') = 1, 'ato visível à igreja';
  assert (select count(*) from platform_audit_log where action = 'platform.tenant.created') = 1;
end $$;

-- 2. O ADMIN global NÃO enxerga dados internos de igrejas (garantia no banco) ---------------------
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
do $$
declare tbl text; n int := 0;
begin
  foreach tbl in array array['members','contributions','expenses','payments','payables','payable_occurrences',
      'monthly_balances','attachments','audit_log','tenant_memberships','membership_roles','invitations',
      'contribution_types','payment_methods','expense_categories','member_types','fee_rules','tenant_settings',
      'user_profiles','idempotency_keys','outbox_events']
  loop
    begin
      execute format('select 1 from %I limit 1', tbl);
      raise exception 'ibg_platform conseguiu ler %', tbl;
    exception when insufficient_privilege then n := n + 1; end;
  end loop;
  assert n = 21;
  -- schemas de migração também fora de alcance
  begin perform 1 from legacy.members; assert false; exception when insufficient_privilege then null; end;
  begin perform 1 from etl.config;     assert false; exception when insufficient_privilege then null; end;
  -- o que PODE ler: metadados das igrejas e a trilha da plataforma
  assert (select count(*) from tenants) >= 2;
  assert (select count(*) from platform_audit_log) >= 1;
  -- listagem: só metadados e contadores
  assert (select active_members from v2_platform_list_tenants() where slug = 'igreja-c') = 0;
  assert (select active_members from v2_platform_list_tenants() where slug = 'ibg') = 3;   -- 4 membros, 1 inativo
  assert (select has_active_tenant_admin from v2_platform_list_tenants() where slug = 'igreja-c') = false;
  assert (select pending_admin_invitation_expires_at is not null from v2_platform_list_tenants() where slug = 'igreja-c');
end $$;
rollback;

-- 3. Quem não é ADMIN global é barrado; a API de negócio nem enxerga as funções da plataforma -----------
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000003', true);
do $$
declare m text;
begin
  begin perform v2_platform_list_tenants(); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'PLATFORM_FORBIDDEN%', m; end;
  begin perform v2_platform_create_tenant('x-y', 'X', null, null, 'a@b.com', 'A', 'h', now() + interval '1 day'); assert false;
  exception when sqlstate 'P0001' then null; end;
end $$;
rollback;

begin;
set local role ibg_api;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);   -- mesmo sendo ADMIN global
do $$
begin
  begin perform v2_platform_create_tenant('x-y', 'X', null, null, 'a@b.com', 'A', 'h', now() + interval '1 day'); assert false;
  exception when insufficient_privilege then null; end;
  begin perform v2_platform_list_tenants(); assert false; exception when insufficient_privilege then null; end;
  begin perform v2_seed_tenant_defaults(gen_random_uuid()); assert false; exception when insufficient_privilege then null; end;
end $$;
rollback;

-- 4. Convite por link: pré-visualização, aceite, uso único, e-mail do destinatário ----------------------
begin;
set local role ibg_api;
do $$
declare m text;
begin
  assert (select status from v2_invitation_preview('hash-c-1')) = 'PENDING';
  assert (select tenant_name from v2_invitation_preview('hash-c-1')) = 'Igreja C';
  assert not exists (select 1 from v2_invitation_preview('token-inexistente')), 'token desconhecido: sem linha';
  -- outra pessoa com o link não aceita
  begin perform v2_accept_invitation('hash-c-1', 'e0000000-0000-4000-8000-000000000003');
        assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'INVITATION_EMAIL_MISMATCH%', m; end;
end $$;
rollback;

select tenant_id as acc_t, membership_id as acc_m from v2_accept_invitation('hash-c-1', 'e0000000-0000-4000-8000-000000000002', null) \gset
select set_config('test.acc_t', :'acc_t', false) \gset
select set_config('test.acc_m', :'acc_m', false) \gset

do $$
declare m text; t uuid := current_setting('test.acc_t')::uuid;
begin
  assert (select count(*) from membership_roles where membership_id = current_setting('test.acc_m')::uuid and role = 'TENANT_ADMIN') = 1;
  assert (select display_name from user_profiles where user_id = 'e0000000-0000-4000-8000-000000000002') = 'Pastor C', 'nome vem do convite';
  assert (select status from v2_invitation_preview('hash-c-1')) = 'ACCEPTED';
  assert (select count(*) from audit_log where tenant_id = t and action = 'invitation.accepted') = 1;
  begin perform v2_accept_invitation('hash-c-1', 'e0000000-0000-4000-8000-000000000002'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'INVITATION_ALREADY_USED%', m; end;
end $$;

-- 5. Igreja com TENANT_ADMIN ativo: a plataforma NÃO emite novo convite de admin ---------------------------
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
do $$
declare m text;
begin
  begin perform v2_platform_issue_admin_invitation((select id from tenants where slug = 'igreja-c'),
                'intruso@ex.com', 'Intruso', 'hash-c-2', now() + interval '7 days');
        assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'TENANT_HAS_ADMIN%', m; end;
  assert (select has_active_tenant_admin from v2_platform_list_tenants() where slug = 'igreja-c');
  assert (select active_users from v2_platform_list_tenants() where slug = 'igreja-c') = 1;
end $$;
rollback;

-- 6. Igreja D sem admin: novo link revoga o anterior; suspensa não aceita; recusa convite expirado ---------
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
select v2_platform_create_tenant('igreja-d', 'Igreja D', null, null, 'dono@igrejad.com', 'Dono D', 'hash-d-1', now() + interval '7 days') as did \gset
select v2_platform_issue_admin_invitation(:'did', 'dono@igrejad.com', 'Dono D', 'hash-d-2', now() + interval '7 days');
commit;

do $$
declare m text;
begin
  assert (select status from v2_invitation_preview('hash-d-1')) = 'REVOKED', 'link anterior revogado';
  assert (select status from v2_invitation_preview('hash-d-2')) = 'PENDING';
  begin perform v2_accept_invitation('hash-d-1', 'e0000000-0000-4000-8000-000000000004'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'INVITATION_REVOKED%', m; end;
end $$;

-- expirado
update invitations set expires_at = now() - interval '1 minute' where token_hash = 'hash-d-2';
do $$
declare m text;
begin
  begin perform v2_accept_invitation('hash-d-2', 'e0000000-0000-4000-8000-000000000004'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'INVITATION_EXPIRED%', m; end;
end $$;
update invitations set expires_at = now() + interval '7 days' where token_hash = 'hash-d-2';

-- status: motivo obrigatório; suspensa não aceita convite; cancelada é definitiva
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
do $$
declare m text; d uuid := (select id from tenants where slug = 'igreja-d');
begin
  begin perform v2_platform_set_tenant_status(d, 'SUSPENDED', 'x'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'REASON_REQUIRED%', m; end;
  perform v2_platform_set_tenant_status(d, 'SUSPENDED', 'inadimplência de teste');
end $$;
commit;
do $$
declare m text;
begin
  begin perform v2_accept_invitation('hash-d-2', 'e0000000-0000-4000-8000-000000000004'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'TENANT_UNAVAILABLE%', m; end;
  assert (select count(*) from audit_log where tenant_id = (select id from tenants where slug = 'igreja-d')
            and action = 'platform.tenant.status_changed') = 1;
end $$;
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
do $$
declare m text; d uuid := (select id from tenants where slug = 'igreja-d');
begin
  perform v2_platform_set_tenant_status(d, 'CANCELLED', 'encerramento de teste');
  begin perform v2_platform_set_tenant_status(d, 'ACTIVE', 'tentando reativar'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'TENANT_CANCELLED%', m; end;
end $$;
commit;

-- 7. Convite da plataforma só concede TENANT_ADMIN (CHECK no banco) -----------------------------------------
do $$
begin
  begin
    insert into invitations (tenant_id, email, roles, token_hash, expires_at, created_by_platform)
    values ((select id from tenants where slug = 'igreja-c'), 'x@y.com', array['TREASURER'], 'h-forja', now() + interval '1 day', true);
    assert false;
  exception when check_violation then null; end;
end $$;

-- 8. O TENANT_ADMIN não mexe na camada da plataforma ------------------------------------------------------------
select id as ctid from tenants where slug = 'igreja-c' \gset
begin;
set local role ibg_api;
select set_config('app.tenant_id', :'ctid', true);
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000002', true);
do $$
declare c uuid := (select id from tenants where slug = 'igreja-c');
begin
  -- edita o que é da igreja
  update tenants set name = 'Igreja C (renomeada)' where id = c;
  assert (select name from tenants where id = c) = 'Igreja C (renomeada)';
  -- mas status/slug são da plataforma
  begin update tenants set status = 'ACTIVE' where id = c; assert false; exception when insufficient_privilege then null; end;
  begin update tenants set slug = 'outra' where id = c;    assert false; exception when insufficient_privilege then null; end;
  begin insert into tenants (slug, name) values ('auto-cadastro', 'X'); assert false; exception when insufficient_privilege then null; end;
  begin insert into platform_admins (user_id) values ('e0000000-0000-4000-8000-000000000002'); assert false;
  exception when insufficient_privilege then null; end;
  begin perform 1 from platform_audit_log; assert false; exception when insufficient_privilege then null; end;
  -- convida pessoas da PRÓPRIA igreja, qualquer perfil; não consegue forjar convite "da plataforma"
  insert into invitations (tenant_id, email, roles, token_hash, expires_at, created_by_platform)
  values (c, 'tesoureiro@igrejac.com', array['TREASURER'], 'hash-c-t', now() + interval '7 days', false);
  begin
    insert into invitations (tenant_id, email, roles, token_hash, expires_at, created_by_platform)
    values (c, 'forja@igrejac.com', array['TENANT_ADMIN'], 'hash-c-f', now() + interval '7 days', true);
    assert false;
  exception when insufficient_privilege or check_violation then null; end;
  -- e não enxerga a igreja do ibg (isolamento continua valendo)
  assert (select count(*) from members) = 0;
end $$;
rollback;

-- 9. Gestão dos ADMINs globais: só por função, auditada; nunca fica sem ADMIN global ----------------------------
begin;
set local role ibg_platform;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);
do $$
declare m text;
begin
  -- DML direto na tabela é negado ao console; só as funções escrevem
  begin insert into platform_admins (user_id) values ('e0000000-0000-4000-8000-000000000003'); assert false;
  exception when insufficient_privilege then null; end;
  begin update platform_admins set status = 'SUSPENDED'; assert false; exception when insufficient_privilege then null; end;
  perform v2_platform_add_admin('e0000000-0000-4000-8000-000000000003');
  assert (select count(*) from v2_platform_list_admins()) = 2;
  assert (select email from v2_platform_list_admins() where user_id = 'e0000000-0000-4000-8000-000000000003') = 'intruso@ex.com';
  perform v2_platform_set_admin_status('e0000000-0000-4000-8000-000000000003', 'SUSPENDED');
  begin perform v2_platform_set_admin_status('e0000000-0000-4000-8000-000000000001', 'SUSPENDED'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'LAST_PLATFORM_ADMIN%', m; end;
  begin perform v2_platform_remove_admin('e0000000-0000-4000-8000-000000000001'); assert false;
  exception when sqlstate 'P0001' then get stacked diagnostics m = message_text; assert m like 'LAST_PLATFORM_ADMIN%', m; end;
  perform v2_platform_remove_admin('e0000000-0000-4000-8000-000000000003');
  assert (select count(*) from platform_audit_log where action like 'platform.admin.%') = 3;
end $$;
commit;

-- ADMIN suspenso perde o acesso na hora
do $$
begin
  insert into platform_admins (user_id) values ('e0000000-0000-4000-8000-000000000003');
  update platform_admins set status = 'SUSPENDED' where user_id = 'e0000000-0000-4000-8000-000000000001';
  assert not v2_is_platform_admin('e0000000-0000-4000-8000-000000000001');
  assert v2_is_platform_admin('e0000000-0000-4000-8000-000000000003');
  update platform_admins set status = 'ACTIVE' where user_id = 'e0000000-0000-4000-8000-000000000001';
  delete from platform_admins where user_id = 'e0000000-0000-4000-8000-000000000003';
end $$;

-- 10. ADMIN global NÃO é membro de igreja: sem associação, sem acesso por nenhum caminho de negócio ---------------
begin;
set local role ibg_api;
select set_config('app.user_id', 'e0000000-0000-4000-8000-000000000001', true);   -- é ADMIN global
select set_config('app.tenant_id', :'ctid', true);                                  -- mesmo informando uma igreja
do $$
begin
  -- RLS devolve a igreja informada porque app.tenant_id foi setado; quem barra é o TenantGuard da API
  -- (associação ACTIVE exigida). No banco, o que o ADMIN global NÃO tem é associação nenhuma:
  assert (select count(*) from tenant_memberships where user_id = app_user_id()) = 0;
end $$;
rollback;
\echo '[ok] 35_assert_platform'
