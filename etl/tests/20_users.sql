\set ON_ERROR_STOP on
-- antes de existir usuário no Auth
do $$ begin
  assert (select count(*) from etl.user_report) = 4, 'quatro usuários ativos na v1';
  assert (select count(*) from etl.user_report where status = 'NO_EMAIL') = 1, 'Ana sem e-mail';
  assert (select count(*) from etl.user_report where status = 'NO_AUTH_USER') = 3, 'João, Maria e Pedro ainda sem Auth';
end $$;

-- Simula o que etl/tools/migrate-users.mjs faz no Auth e roda a parte SQL (etl.link_users)
insert into auth.users (id, email) values
  ('d0000000-0000-4000-8000-000000000001', 'joao@ex.com'),
  ('d0000000-0000-4000-8000-000000000002', 'maria@ex.com'),
  ('d0000000-0000-4000-8000-000000000003', 'pedro@ex.com');

select * from etl.link_users();

do $$
begin
  assert (select count(*) from tenant_memberships) = 3, 'três associações (Ana sem e-mail fica de fora)';
  assert (select status from tenant_memberships where user_id = 'd0000000-0000-4000-8000-000000000001') = 'ACTIVE';
  assert (select role from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
           where tm.user_id = 'd0000000-0000-4000-8000-000000000001') = 'TENANT_ADMIN', 'ADMIN da v1 vira TENANT_ADMIN';
  assert (select role from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
           where tm.user_id = 'd0000000-0000-4000-8000-000000000002') = 'TREASURER';
  assert (select status from tenant_memberships where user_id = 'd0000000-0000-4000-8000-000000000003') = 'SUSPENDED', 'perfil inválido => SUSPENDED';
  assert not exists (select 1 from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
           where tm.user_id = 'd0000000-0000-4000-8000-000000000003'), 'nenhum perfil inventado';
  assert (select count(*) from etl.user_map) = 3;
  assert (select actor_membership_id is not null from audit_log where legacy_actor_id = 'c0000000-0000-4000-8000-000000000001' limit 1),
         'autoria da auditoria legada resolvida';
  perform * from etl.link_users();
  assert (select count(*) from tenant_memberships) = 3, 'reexecução não duplica';
  assert (select count(*) from user_profiles) = 3;
end $$;
\echo '[ok] 20_users'
