-- =============================================================================
-- IBG v2 · BANCO NOVO 02/10 · Tenants, identidade e múltiplos perfis
-- -----------------------------------------------------------------------------
-- auth.users (Supabase Auth) é a identidade global. O vínculo com a igreja é
-- tenant_memberships; os perfis (vários) ficam em membership_roles.
-- DOIS níveis de administração, que não se misturam:
--   ADMIN (global, plataforma)  = linha em platform_admins. Gerencia tenants, convites de TENANT_ADMIN,
--                                 status e limites. NÃO tem acesso aos dados internos dos tenants.
--   TENANT_ADMIN (da igreja)    = perfil em membership_roles. Gerencia SÓ a sua igreja.
-- =============================================================================

create table tenants (
  id            uuid primary key default gen_random_uuid(),
  slug          citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name          text   not null,
  document      text,
  status        text   not null default 'TRIAL'
                check (status in ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED')),
  timezone      text   not null default 'America/Sao_Paulo',
  trial_ends_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table tenant_settings (
  tenant_id            uuid primary key references tenants(id),
  week_starts_on       smallint not null default 1 check (week_starts_on between 0 and 6),
  allow_future_dates   boolean  not null default false,
  payable_window_days  smallint not null default 10 check (payable_window_days between 0 and 60),
  payable_alert_days   smallint not null default 3,
  attachment_max_mb    smallint not null default 10,
  attachment_max_files smallint not null default 10,
  require_mfa_roles    text[]   not null default '{TENANT_ADMIN,TREASURER}',
  cascade_reopen       boolean  not null default false,
  updated_at           timestamptz not null default now()
);

create table user_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- ADMIN global: operadores da plataforma (nível acima dos tenants). Não são membros de tenant por
-- causa disso; se a mesma pessoa também pertence a uma igreja, entra nela por convite como qualquer outro.
create table platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  status     text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
  created_by uuid,
  created_at timestamptz not null default now()
);

create or replace function v2_guard_last_platform_admin() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.bypass_guards', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and (old.status <> 'ACTIVE' or new.status = 'ACTIVE') then return new; end if;
  if old.status = 'ACTIVE'
     and not exists (select 1 from platform_admins where status = 'ACTIVE' and user_id <> old.user_id) then
    raise exception 'LAST_PLATFORM_ADMIN: a plataforma precisa de ao menos um ADMIN global ativo'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger trg_last_platform_admin before delete or update of status on platform_admins
  for each row execute function v2_guard_last_platform_admin();

create table tenant_memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  user_id    uuid not null references auth.users(id),
  member_id  uuid,   -- FK composta (tenant_id, member_id) -> members: migration 03
  status     text not null default 'ACTIVE'
             check (status in ('INVITED','ACTIVE','SUSPENDED','REMOVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_memberships_tenant_id_uk unique (tenant_id, id),
  constraint tenant_memberships_user_uk      unique (tenant_id, user_id)
);
create index tenant_memberships_user_idx on tenant_memberships (user_id) where status = 'ACTIVE';

-- Vários perfis por associação: a permissão efetiva é a UNIÃO dos perfis.
create table membership_roles (
  tenant_id     uuid not null,
  membership_id uuid not null,
  role          text not null
                check (role in ('TENANT_ADMIN','TREASURER','SECRETARY','FISCAL','PRESIDENT')),
  granted_by    uuid,
  granted_at    timestamptz not null default now(),
  primary key (membership_id, role),
  constraint membership_roles_membership_fk
    foreign key (tenant_id, membership_id)
    references tenant_memberships (tenant_id, id) on delete cascade
);
create index membership_roles_tenant_idx on membership_roles (tenant_id, role);

-- Todo acesso a uma igreja nasce de um CONVITE POR LINK (não existe cadastro público).
--  * created_by_platform = true: emitido pelo ADMIN global; só pode conceder TENANT_ADMIN
--    (abertura da igreja ou recuperação quando ela ficou sem TENANT_ADMIN).
--  * created_by_platform = false: emitido por um TENANT_ADMIN para a própria igreja (qualquer perfil).
-- Só o hash do token é guardado; o link (com o token) é mostrado uma única vez a quem emitiu.
create table invitations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  email                citext not null,
  name                 text,
  member_id            uuid,
  roles                text[] not null check (cardinality(roles) >= 1
                         and roles <@ array['TENANT_ADMIN','TREASURER','SECRETARY','FISCAL','PRESIDENT']::text[]),
  token_hash           text not null unique,
  expires_at           timestamptz not null,
  accepted_at          timestamptz,
  accepted_user_id     uuid references auth.users(id),
  revoked_at           timestamptz,
  created_by           uuid,
  created_by_platform  boolean not null default false,
  created_at           timestamptz not null default now(),
  constraint invitations_platform_only_tenant_admin_ck
    check (not created_by_platform or roles = array['TENANT_ADMIN']::text[])
);
create index invitations_tenant_email_idx on invitations (tenant_id, email);
-- no máximo um convite pendente por e-mail e tenant
create unique index invitations_one_pending
  on invitations (tenant_id, email) where accepted_at is null and revoked_at is null;

-- -----------------------------------------------------------------------------
-- Regra do último TENANT_ADMIN, garantida também no banco
-- -----------------------------------------------------------------------------
create or replace function v2_guard_last_tenant_admin() returns trigger
language plpgsql as $$
declare
  t uuid; m uuid; v_status text; ret record;
begin
  ret := case when tg_op = 'DELETE' then old else new end;
  -- carga/manutenção controlada (etl/): app.bypass_guards = on
  if coalesce(current_setting('app.bypass_guards', true), '') = 'on' then return ret; end if;

  if tg_table_name = 'membership_roles' then
    if old.role <> 'TENANT_ADMIN' then return ret; end if;
    if tg_op = 'UPDATE' and new.role = 'TENANT_ADMIN' then return ret; end if;
    t := old.tenant_id; m := old.membership_id;
  else  -- tenant_memberships
    if tg_op = 'UPDATE' and (old.status <> 'ACTIVE' or new.status = 'ACTIVE') then return ret; end if;
    if not exists (select 1 from membership_roles where membership_id = old.id and role = 'TENANT_ADMIN') then
      return ret;
    end if;
    t := old.tenant_id; m := old.id;
  end if;

  select status into v_status from tenants where id = t;
  if v_status is null or v_status = 'CANCELLED' then return ret; end if;

  if not exists (
    select 1
      from membership_roles mr
      join tenant_memberships tm on tm.id = mr.membership_id
     where mr.tenant_id = t and mr.role = 'TENANT_ADMIN'
       and tm.status = 'ACTIVE' and mr.membership_id <> m
  ) then
    raise exception 'LAST_TENANT_ADMIN: a igreja precisa de ao menos um TENANT_ADMIN ativo'
      using errcode = 'P0001';
  end if;
  return ret;
end $$;

create trigger trg_last_tenant_admin_roles
  before delete or update of role on membership_roles
  for each row execute function v2_guard_last_tenant_admin();

create trigger trg_last_tenant_admin_memberships
  before delete or update of status on tenant_memberships
  for each row execute function v2_guard_last_tenant_admin();
