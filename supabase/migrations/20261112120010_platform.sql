-- =============================================================================
-- IBG v2 · BANCO NOVO 10/10 · Plataforma: ADMIN global x TENANT_ADMIN, convite por link
-- -----------------------------------------------------------------------------
-- Princípios (decisão de 12/11/2026):
--   1. NÃO existe cadastro público. Toda igreja é criada pelo ADMIN global e todo acesso nasce
--      de um convite por link (tabela invitations).
--   2. ADMIN global (platform_admins) gerencia tenants, convites de TENANT_ADMIN, status e limites,
--      mas NÃO enxerga dados internos de nenhuma igreja. Garantia no BANCO: o role `ibg_platform`
--      (usado pelo módulo platform da API) não tem GRANT em nenhuma tabela de negócio; só executa
--      as funções abaixo, que devolvem metadados e contadores de uso.
--   3. TENANT_ADMIN gerencia apenas a própria igreja (RLS por tenant_id, role `ibg_api`).
--   4. O ADMIN global só emite convite de TENANT_ADMIN na abertura da igreja ou quando ela ficou
--      sem TENANT_ADMIN ativo (recuperação) e o ato fica no audit_log DA IGREJA (visível a ela).
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ibg_platform') then
    -- defina a senha fora do repositório: alter role ibg_platform password '<secret>';
    create role ibg_platform login noinherit;
  end if;
end $$;

-- Auditoria da plataforma (ações do ADMIN global). Append-only.
create table platform_audit_log (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  actor_user_id uuid,
  action        text not null,
  tenant_id     uuid,            -- sem FK: o registro sobrevive à exclusão do tenant
  detail        jsonb
);
create index platform_audit_log_time_idx on platform_audit_log (created_at desc);
create trigger trg_platform_audit_append_only
  before update or delete on platform_audit_log
  for each row execute function v2_audit_append_only();

-- ---------------------------------- helpers ----------------------------------
create or replace function v2_is_platform_admin(p_user uuid default app_user_id()) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from platform_admins where user_id = p_user and status = 'ACTIVE') $$;

create or replace function v2_platform_assert() returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not v2_is_platform_admin() then
    raise exception 'PLATFORM_FORBIDDEN: exige ADMIN global ativo' using errcode = 'P0001';
  end if;
end $$;

create or replace function v2_platform_log(p_action text, p_tenant uuid, p_detail jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into platform_audit_log (actor_user_id, action, tenant_id, detail)
  values (app_user_id(), p_action, p_tenant, p_detail);
  -- ato que afeta uma igreja também fica no audit_log DELA (a igreja vê o que a plataforma fez)
  if p_tenant is not null then
    insert into audit_log (tenant_id, actor_user_id, action, entity, entity_id, "after", source)
    values (p_tenant, app_user_id(), p_action, 'tenant', p_tenant::text, p_detail, 'APP');
  end if;
end $$;

-- ------------------------ criar igreja + convite do TENANT_ADMIN --------------------
-- O link (token) é gerado pela API; aqui entra só o HASH. Devolve o id do tenant.
create or replace function v2_platform_create_tenant(
  p_slug text, p_name text, p_document text, p_timezone text,
  p_admin_email text, p_admin_name text, p_token_hash text, p_expires_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare t uuid := gen_random_uuid();
begin
  perform v2_platform_assert();
  insert into tenants (id, slug, name, document, timezone, status, trial_ends_at)
  values (t, p_slug, btrim(p_name), p_document, coalesce(p_timezone, 'America/Sao_Paulo'), 'TRIAL', now() + interval '30 days');
  perform v2_seed_tenant_defaults(t);
  insert into invitations (tenant_id, email, name, roles, token_hash, expires_at, created_by, created_by_platform)
  values (t, p_admin_email, p_admin_name, array['TENANT_ADMIN'], p_token_hash, p_expires_at, app_user_id(), true);
  perform v2_platform_log('platform.tenant.created', t,
    jsonb_build_object('slug', p_slug, 'name', p_name, 'admin_email', p_admin_email));
  return t;
end $$;

-- Novo link de TENANT_ADMIN: só enquanto a igreja NÃO tem TENANT_ADMIN ativo
create or replace function v2_platform_issue_admin_invitation(
  p_tenant uuid, p_email text, p_name text, p_token_hash text, p_expires_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare inv uuid;
begin
  perform v2_platform_assert();
  if not exists (select 1 from tenants where id = p_tenant and status <> 'CANCELLED') then
    raise exception 'TENANT_NOT_FOUND: igreja inexistente ou cancelada' using errcode = 'P0001';
  end if;
  if exists (select 1 from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
              where mr.tenant_id = p_tenant and mr.role = 'TENANT_ADMIN' and tm.status = 'ACTIVE') then
    raise exception 'TENANT_HAS_ADMIN: a igreja já tem TENANT_ADMIN ativo; ele convida os demais usuários'
      using errcode = 'P0001';
  end if;
  update invitations set revoked_at = now()
   where tenant_id = p_tenant and accepted_at is null and revoked_at is null
     and (created_by_platform or email = p_email);
  insert into invitations (tenant_id, email, name, roles, token_hash, expires_at, created_by, created_by_platform)
  values (p_tenant, p_email, p_name, array['TENANT_ADMIN'], p_token_hash, p_expires_at, app_user_id(), true)
  returning id into inv;
  perform v2_platform_log('platform.admin_invitation.issued', p_tenant,
    jsonb_build_object('email', p_email, 'invitation_id', inv));
  return inv;
end $$;

create or replace function v2_platform_revoke_admin_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare t uuid;
begin
  perform v2_platform_assert();
  update invitations set revoked_at = now()
   where id = p_invitation and created_by_platform and accepted_at is null and revoked_at is null
  returning tenant_id into t;
  if t is null then
    raise exception 'INVITATION_NOT_FOUND: convite da plataforma pendente inexistente' using errcode = 'P0001';
  end if;
  perform v2_platform_log('platform.admin_invitation.revoked', t, jsonb_build_object('invitation_id', p_invitation));
end $$;

create or replace function v2_platform_set_tenant_status(p_tenant uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_old text;
begin
  perform v2_platform_assert();
  if p_status not in ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED') then
    raise exception 'INVALID_STATUS: %', p_status using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'REASON_REQUIRED: informe o motivo (mínimo 5 caracteres)' using errcode = 'P0001';
  end if;
  select status into v_old from tenants where id = p_tenant for update;
  if v_old is null then raise exception 'TENANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_old = 'CANCELLED' then
    raise exception 'TENANT_CANCELLED: igreja cancelada não pode mudar de status' using errcode = 'P0001';
  end if;
  update tenants set status = p_status, updated_at = now() where id = p_tenant;
  perform v2_platform_log('platform.tenant.status_changed', p_tenant,
    jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
end $$;

-- Listagem da plataforma: METADADOS e CONTADORES DE USO (base dos limites do plano).
-- Nenhum nome de membro, usuário, valor financeiro ou anexo.
create or replace function v2_platform_list_tenants()
returns table (
  id uuid, slug text, name text, status text, timezone text, trial_ends_at timestamptz,
  created_at timestamptz, active_users bigint, active_members bigint, storage_bytes bigint,
  has_active_tenant_admin boolean, pending_admin_invitation_expires_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform v2_platform_assert();
  return query
  select t.id, t.slug::text, t.name, t.status, t.timezone, t.trial_ends_at, t.created_at,
         (select count(*) from tenant_memberships tm where tm.tenant_id = t.id and tm.status = 'ACTIVE'),
         (select count(*) from members m where m.tenant_id = t.id and m.deleted_at is null),
         (select coalesce(sum(a.size_bytes), 0)::bigint from attachments a
           where a.tenant_id = t.id and a.status = 'CONFIRMED'),
         exists (select 1 from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
                  where mr.tenant_id = t.id and mr.role = 'TENANT_ADMIN' and tm.status = 'ACTIVE'),
         (select max(i.expires_at) from invitations i
           where i.tenant_id = t.id and i.created_by_platform and i.roles = array['TENANT_ADMIN']
             and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
    from tenants t
   order by t.created_at desc;
end $$;

-- --------------------- página pública do convite e aceite (ibg_api) --------------------
-- Não vaza se o token existe: sem linha => a API responde 404.
create or replace function v2_invitation_preview(p_token_hash text)
returns table (tenant_name text, tenant_slug text, email text, name text, roles text[],
               expires_at timestamptz, status text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select t.name, t.slug::text, i.email::text, i.name, i.roles, i.expires_at,
         case when i.accepted_at is not null then 'ACCEPTED'
              when i.revoked_at  is not null then 'REVOKED'
              when i.expires_at < now()      then 'EXPIRED'
              else 'PENDING' end
    from invitations i join tenants t on t.id = i.tenant_id
   where i.token_hash = p_token_hash and t.status <> 'CANCELLED'
$$;

-- A API cria/identifica o usuário no Auth (e-mail do convite) e chama esta função, que faz TUDO
-- numa transação: perfil, associação, perfis e baixa do convite.
create or replace function v2_accept_invitation(p_token_hash text, p_user_id uuid, p_display_name text default null)
returns table (tenant_id uuid, membership_id uuid, roles text[])
language plpgsql security definer set search_path = public, pg_temp
as $$
declare inv invitations%rowtype; v_email text; v_status text; m uuid;
begin
  select * into inv from invitations where token_hash = p_token_hash for update;
  if not found then raise exception 'INVITATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if inv.accepted_at is not null then raise exception 'INVITATION_ALREADY_USED' using errcode = 'P0001'; end if;
  if inv.revoked_at  is not null then raise exception 'INVITATION_REVOKED'      using errcode = 'P0001'; end if;
  if inv.expires_at < now()      then raise exception 'INVITATION_EXPIRED'      using errcode = 'P0001'; end if;

  select status into v_status from tenants where id = inv.tenant_id;
  if v_status is null or v_status in ('SUSPENDED', 'CANCELLED') then
    raise exception 'TENANT_UNAVAILABLE: igreja suspensa ou cancelada' using errcode = 'P0001';
  end if;

  select au.email into v_email from auth.users au where au.id = p_user_id;
  if v_email is null or lower(v_email) <> lower(inv.email::text) then
    raise exception 'INVITATION_EMAIL_MISMATCH: o usuário não é o destinatário do convite' using errcode = 'P0001';
  end if;

  insert into user_profiles (user_id, display_name)
  values (p_user_id, coalesce(nullif(btrim(p_display_name), ''), inv.name))
  on conflict (user_id) do nothing;

  insert into tenant_memberships as tm (tenant_id, user_id, member_id, status)
  values (inv.tenant_id, p_user_id, inv.member_id, 'ACTIVE')
  on conflict on constraint tenant_memberships_user_uk
    do update set status = 'ACTIVE', member_id = coalesce(excluded.member_id, tm.member_id), updated_at = now()
  returning tm.id into m;

  insert into membership_roles (tenant_id, membership_id, role, granted_by)
  select inv.tenant_id, m, r, inv.created_by from unnest(inv.roles) r
  on conflict do nothing;

  update invitations set accepted_at = now(), accepted_user_id = p_user_id where id = inv.id;

  insert into audit_log (tenant_id, actor_user_id, actor_membership_id, action, entity, entity_id, "after", source)
  values (inv.tenant_id, p_user_id, m, 'invitation.accepted', 'invitation', inv.id::text,
          jsonb_build_object('roles', inv.roles, 'by_platform', inv.created_by_platform), 'APP');

  return query select inv.tenant_id, m, inv.roles;
end $$;

-- --------------------------- gestão dos ADMINs globais (só por função, sempre auditada) ----------------
-- O usuário já deve existir no Auth (a API o cria por convite do Supabase Auth, com MFA obrigatório).
create or replace function v2_platform_add_admin(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform v2_platform_assert();
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into platform_admins (user_id, created_by) values (p_user, app_user_id())
  on conflict (user_id) do update set status = 'ACTIVE';
  perform v2_platform_log('platform.admin.added', null, jsonb_build_object('user_id', p_user));
end $$;

create or replace function v2_platform_set_admin_status(p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform v2_platform_assert();
  if p_status not in ('ACTIVE', 'SUSPENDED') then raise exception 'INVALID_STATUS' using errcode = 'P0001'; end if;
  update platform_admins set status = p_status where user_id = p_user;   -- trigger garante o último ADMIN
  if not found then raise exception 'USER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform v2_platform_log('platform.admin.status_changed', null, jsonb_build_object('user_id', p_user, 'status', p_status));
end $$;

create or replace function v2_platform_remove_admin(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform v2_platform_assert();
  delete from platform_admins where user_id = p_user;                    -- trigger garante o último ADMIN
  if not found then raise exception 'USER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform v2_platform_log('platform.admin.removed', null, jsonb_build_object('user_id', p_user));
end $$;

create or replace function v2_platform_list_admins()
returns table (user_id uuid, email text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform v2_platform_assert();
  return query select pa.user_id, au.email::text, pa.status, pa.created_at
                 from platform_admins pa left join auth.users au on au.id = pa.user_id
                order by pa.created_at;
end $$;

-- ------------------------------------ privilégios -------------------------------------
-- Funções nascem executáveis por PUBLIC: fecha e abre só para quem deve.
revoke all on function
  v2_is_platform_admin(uuid), v2_platform_assert(), v2_platform_log(text, uuid, jsonb),
  v2_platform_create_tenant(text, text, text, text, text, text, text, timestamptz),
  v2_platform_issue_admin_invitation(uuid, text, text, text, timestamptz),
  v2_platform_revoke_admin_invitation(uuid),
  v2_platform_set_tenant_status(uuid, text, text),
  v2_platform_list_tenants(),
  v2_platform_add_admin(uuid), v2_platform_set_admin_status(uuid, text), v2_platform_remove_admin(uuid),
  v2_platform_list_admins(),
  v2_invitation_preview(text), v2_accept_invitation(text, uuid, text)
  from public, anon, authenticated, ibg_api;

grant execute on function
  v2_is_platform_admin(uuid),
  v2_platform_create_tenant(text, text, text, text, text, text, text, timestamptz),
  v2_platform_issue_admin_invitation(uuid, text, text, text, timestamptz),
  v2_platform_revoke_admin_invitation(uuid),
  v2_platform_set_tenant_status(uuid, text, text),
  v2_platform_list_tenants(),
  v2_platform_add_admin(uuid), v2_platform_set_admin_status(uuid, text), v2_platform_remove_admin(uuid),
  v2_platform_list_admins()
  to ibg_platform;

grant execute on function v2_invitation_preview(text), v2_accept_invitation(text, uuid, text) to ibg_api;

-- Rotinas internas: nem a API de negócio nem a plataforma as chamam diretamente
revoke all on function v2_seed_tenant_defaults(uuid), v2_ensure_audit_partition(date)
  from public, anon, authenticated, ibg_api;

-- ibg_platform: SEM acesso a tabelas de negócio. Só o que gerencia a própria camada.
grant usage on schema public to ibg_platform;
grant select on tenants, platform_audit_log to ibg_platform;
grant select on platform_admins to ibg_platform;   -- escrita só pelas funções v2_platform_*_admin

alter table platform_audit_log enable row level security;   -- sem policy para ibg_api => invisível a ele
create policy platform_read_tenants on tenants for select to ibg_platform using (true);
create policy platform_read_admins on platform_admins for select to ibg_platform using (true);
create policy platform_read_audit on platform_audit_log for select to ibg_platform using (true);

revoke all on platform_audit_log from anon, authenticated, ibg_api;

-- ------------- o que o TENANT_ADMIN (role ibg_api) NÃO pode mexer na camada da plataforma -------------
-- Status, slug e plano da igreja são da plataforma: a igreja edita só nome, documento e fuso.
revoke insert, update, delete on tenants from ibg_api;
grant update (name, document, timezone) on tenants to ibg_api;
-- Administradores globais: ibg_api só lê a própria linha (policy de 09); nenhuma escrita.
revoke insert, update, delete on platform_admins from ibg_api;

-- Convite emitido pela igreja nunca se passa por convite da plataforma
drop policy tenant_isolation on invitations;
create policy tenant_isolation on invitations
  using (tenant_id = app_tenant_id())
  with check (tenant_id = app_tenant_id() and not created_by_platform);
