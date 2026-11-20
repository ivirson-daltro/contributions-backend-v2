-- Fixture: reproduz o esquema public da v1 (colunas e tipos informados) + um auth.users mínimo.
-- Só para testes locais. No Supabase real, o schema auth já existe.
-- Nulidade/FKs da v1 real não são conhecidas: aqui assumimos o mais comum (PK + FKs simples).

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz default now()
);

create table member_types (id uuid primary key default gen_random_uuid(), description text not null);
create table members (
  id uuid primary key default gen_random_uuid(), name text not null,
  member_type_id uuid references member_types(id), created_at timestamptz default now(),
  deleted_at timestamptz, phone text, email text, genre text, birth_date date, entry_date date,
  baptism_date date, zip_code text, street text, number text, complement text, city text,
  state text, neighborhood text);
create table contribution_types (id uuid primary key default gen_random_uuid(), description text not null);
create table payment_methods (id uuid primary key default gen_random_uuid(), description text not null, type text);
create table contributions (
  id uuid primary key default gen_random_uuid(), member_id uuid references members(id),
  contribution_type_id uuid references contribution_types(id),
  payment_method_id uuid references payment_methods(id), amount numeric not null,
  observation text, created_at timestamptz default now(), date timestamp);
create table app_users (
  id uuid primary key default gen_random_uuid(), password_hash text, role text,
  created_at timestamptz default now(), deleted_at timestamptz, member_id uuid references members(id));
create table audit_logs (
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  user_id uuid, action text, entity text, entity_id text, before jsonb, after jsonb);
create table expense_categories (id uuid primary key default gen_random_uuid(), description text not null,
  created_at timestamptz default now());
create table expenses (
  id uuid primary key default gen_random_uuid(), description text, value real, notes text,
  attachment_url text, category_id uuid references expense_categories(id),
  created_at timestamptz default now(), deleted_at timestamptz, date timestamptz);
create table expense_attachments (id uuid primary key default gen_random_uuid(),
  expense_id uuid references expenses(id) on delete cascade, path text, name text, created_at timestamptz default now());
create table contribution_attachments (id uuid primary key default gen_random_uuid(),
  contribution_id uuid references contributions(id) on delete cascade, path text, name text, created_at timestamptz default now());
create table payables (
  id uuid primary key default gen_random_uuid(), description text, type text,
  category_id uuid references expense_categories(id), amount numeric, due_day integer, due_date date,
  start_date date, active boolean default true, created_at timestamptz default now(),
  updated_at timestamptz default now(), notes text);
create table payable_occurrences (
  id uuid primary key default gen_random_uuid(), payable_id uuid references payables(id) on delete cascade,
  expense_id uuid references expenses(id) on delete set null, competence_year integer,
  competence_month integer, due_date date, status text default 'OPEN', paid_at date, paid_amount numeric,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table monthly_balances (
  id uuid primary key default gen_random_uuid(), year integer, month integer, opening_balance numeric,
  notes text, closed_at timestamptz, closed_by uuid, created_at timestamptz default now(),
  updated_at timestamptz default now());
create table payable_attachments (id uuid primary key default gen_random_uuid(),
  payable_id uuid references payables(id) on delete cascade, path text, name text, created_at timestamptz default now());
create table password_reset_tokens (id uuid primary key default gen_random_uuid(),
  app_user_id uuid references app_users(id), token_hash varchar, expires_at timestamptz,
  created_at timestamptz default now(), used_at timestamptz);
