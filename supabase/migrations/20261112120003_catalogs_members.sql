-- =============================================================================
-- IBG v2 · BANCO NOVO 03/10 · Catálogos tipados e membros
-- -----------------------------------------------------------------------------
-- Regras de negócio deixam de depender do texto da descrição: category/kind/flags.
-- Descrição única por tenant ignorando caixa, acento e espaços nas pontas.
-- =============================================================================

create table member_types (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  description text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint member_types_tenant_id_uk unique (tenant_id, id)
);
create unique index member_types_desc_uk on member_types (tenant_id, app_norm(description));

create table expense_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  description text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint expense_categories_tenant_id_uk unique (tenant_id, id)
);
create unique index expense_categories_desc_uk on expense_categories (tenant_id, app_norm(description));

create table contribution_types (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  description text not null,
  category    text not null
              check (category in ('TITHE','OFFERING','CONSTRUCTION_OFFERING','MISSIONS','INCOME','OTHER')),
  requires_member       boolean not null default true,
  counts_for_fees       boolean not null default false,   -- compõe a base das taxas associativas
  counts_as_contributor boolean not null default false,   -- conta no relatório de contribuintes
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint contribution_types_tenant_id_uk unique (tenant_id, id)
);
create unique index contribution_types_desc_uk on contribution_types (tenant_id, app_norm(description));

create table payment_methods (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  description text not null,
  kind        text not null check (kind in ('CASH','PIX','CARD','TRANSFER','CHECK','OTHER')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint payment_methods_tenant_id_uk unique (tenant_id, id)
);
create unique index payment_methods_desc_uk on payment_methods (tenant_id, app_norm(description));

-- --------------------------------- members -----------------------------------
create table members (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  name           text not null,
  member_type_id uuid not null,
  status         text not null default 'ACTIVE'
                 check (status in ('ACTIVE','INACTIVE','TRANSFERRED','DECEASED')),
  phone          text,
  email          text check (email is null or email ~ '^[^@\s]+@[^@\s]+$'),
  gender         text,
  birth_date     date,
  entry_date     date,
  baptism_date   date,
  zip_code       text,
  street         text,
  number         text,
  complement     text,
  neighborhood   text,
  city           text,
  state          text,
  consent_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint members_tenant_id_uk unique (tenant_id, id),
  constraint members_member_type_fk foreign key (tenant_id, member_type_id)
    references member_types (tenant_id, id)
);
create index members_name_idx  on members (tenant_id, app_norm(name)) where deleted_at is null;
create index members_email_idx on members (tenant_id, lower(btrim(email))) where deleted_at is null;
create index members_name_trgm on members using gin (app_norm(name) gin_trgm_ops);
create index members_type_idx  on members (tenant_id, member_type_id);

create trigger trg_v2_touch before update on members
  for each row execute function v2_touch_updated_at();

alter table tenant_memberships
  add constraint tenant_memberships_member_fk foreign key (tenant_id, member_id)
  references members (tenant_id, id);
-- um membro só pode estar vinculado a uma associação por tenant
create unique index tenant_memberships_member_uk
  on tenant_memberships (tenant_id, member_id) where member_id is not null and status <> 'REMOVED';
