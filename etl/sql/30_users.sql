-- =============================================================================
-- ETL v1 -> v2 · 30 · Usuários: v1 (app_users) -> Supabase Auth + associações + perfis
-- -----------------------------------------------------------------------------
-- auth.users é criado por tools/migrate-users.mjs (API admin). Depois: select * from etl.link_users();
-- Regras: perfil da v1 ADMIN => TENANT_ADMIN; ninguém vira ADMIN global (isso é criado à mão, ver
--         runbook: bootstrap do primeiro ADMIN global);
--         perfil inválido/ausente => associação SUSPENDED (nunca se inventa perfil);
--         sem e-mail => não migra ativo (aparece no relatório).
-- =============================================================================
create or replace view etl.user_report as
select u.id                  as app_user_id,
       m.id                  as member_id,
       m.name,
       lower(btrim(m.email)) as email,
       -- no v1 não havia ADMIN global: o ADMIN da igreja vira TENANT_ADMIN
       case upper(btrim(u.role)) when 'ADMIN' then 'TENANT_ADMIN' else upper(btrim(u.role)) end as role,
       case
         when mp.app_user_id is not null                                    then 'DONE'
         when m.id is null or nullif(btrim(m.email), '') is null            then 'NO_EMAIL'
         when count(*) over (partition by lower(btrim(m.email))) > 1        then 'DUPLICATE_EMAIL'
         when not exists (select 1 from auth.users au
                           where lower(au.email) = lower(btrim(m.email)))   then 'NO_AUTH_USER'
         when upper(btrim(u.role)) is null
           or upper(btrim(u.role)) not in ('ADMIN','TREASURER','SECRETARY','FISCAL','PRESIDENT')   -- valores válidos da v1
                                                                            then 'INVALID_ROLE'
         else 'READY'
       end                   as status
  from legacy.app_users u
  left join legacy.members m on m.id = u.member_id
  left join etl.user_map mp on mp.app_user_id = u.id
 where u.deleted_at is null;

create or replace function etl.link_users()
returns table (report_status text, qty bigint)
language plpgsql as $$
declare
  t uuid := etl.cfg('tenant_id')::uuid;
  r record; v_mem uuid;
begin
  perform set_config('app.audit_maintenance', 'on', true);

  for r in
    select rep.app_user_id, rep.member_id, rep.name, rep.role, rep.status as st, au.id as auth_id
      from etl.user_report rep
      join auth.users au on lower(au.email) = rep.email
     where rep.status in ('READY', 'INVALID_ROLE')
  loop
    insert into user_profiles (user_id, display_name) values (r.auth_id, r.name)
    on conflict (user_id) do nothing;

    insert into tenant_memberships (tenant_id, user_id, member_id, status)
    values (t, r.auth_id, r.member_id, case when r.st = 'READY' then 'ACTIVE' else 'SUSPENDED' end)
    on conflict (tenant_id, user_id) do update set member_id = excluded.member_id
    returning id into v_mem;

    if r.st = 'READY' then
      insert into membership_roles (tenant_id, membership_id, role) values (t, v_mem, r.role)
      on conflict do nothing;
    end if;

    insert into etl.user_map (app_user_id, auth_user_id, membership_id)
    values (r.app_user_id, r.auth_id, v_mem) on conflict (app_user_id) do nothing;
  end loop;

  -- autoria legada passa a apontar para a associação / usuário do Auth
  update monthly_balances mb
     set closed_by_membership_id = um.membership_id
    from legacy.monthly_balances lb
    join etl.user_map um on um.app_user_id = lb.closed_by
   where mb.id = lb.id and mb.tenant_id = t and mb.closed_by_membership_id is null;

  update audit_log al
     set actor_user_id = um.auth_user_id, actor_membership_id = um.membership_id
    from etl.user_map um
   where al.tenant_id = t and al.legacy_actor_id = um.app_user_id and al.actor_membership_id is null;

  return query select rep.status::text, count(*) from etl.user_report rep group by rep.status order by rep.status;
end $$;
