-- =============================================================================
-- ETL v1 -> v2 · 00 · Schema de trabalho (`etl`) e configuração
-- -----------------------------------------------------------------------------
-- Premissas:
--   * O banco NOVO já tem o esquema final (supabase/migrations).
--   * Os dados da v1 estão no schema `legacy` do MESMO banco (etl/load-legacy.sh), somente leitura.
--   * Tudo que é temporário da migração mora em `etl` e é descartado no teardown.
-- Idempotente: pode ser reaplicado sem perder configuração.
-- =============================================================================
create schema if not exists etl;
revoke all on schema etl from public;

create table if not exists etl.config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into etl.config (key, value) values
  -- Tenant #1 = a igreja atual. UUID fixo: igual em ensaio e em produção.
  ('tenant_id',              'a1b2c3d4-0000-4000-8000-000000000001'),
  ('tenant_slug',            'ibg'),
  ('tenant_name',            'IBG'),
  -- contributions.date na v1 é "timestamp sem fuso". LOCAL: já é o dia de negócio (date::date).
  -- UTC: foi gravada em UTC; converter para `timezone`. Decida pelo diagnóstico ANTES de carregar.
  ('contribution_date_mode', 'LOCAL'),
  ('timezone',               'America/Sao_Paulo'),
  -- depois do corte: 'true' impede reset/load por engano
  ('frozen',                 'false')
on conflict (key) do nothing;

create or replace function etl.cfg(k text) returns text
language sql stable as $$ select value from etl.config where key = k $$;

create or replace function etl.set_cfg(k text, v text) returns void
language sql as $$
  insert into etl.config (key, value) values (k, v)
  on conflict (key) do update set value = excluded.value, updated_at = now()
$$;

-- Linhas que não cabem nas regras novas ou exigem decisão: NUNCA descartadas em silêncio
create table if not exists etl.rejects (
  id           bigserial primary key,
  step         text not null,
  source_table text not null,
  source_id    text,
  reason       text not null,
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create unique index if not exists etl_rejects_dedupe
  on etl.rejects (step, source_table, coalesce(source_id, ''), reason);

create table if not exists etl.run_log (
  id   bigserial primary key,
  step text not null,
  qty  bigint,
  note text,
  at   timestamptz not null default now()
);

create table if not exists etl.user_map (
  app_user_id   uuid primary key,   -- legacy.app_users.id
  auth_user_id  uuid not null,
  membership_id uuid not null
);

-- Plano de cópia dos arquivos do Storage (executado por etl/tools/copy-attachments.mjs)
create table if not exists etl.attachment_copy (
  attachment_id uuid primary key,   -- public.attachments.id
  entity        text not null check (entity in ('contributions','expenses','payables')),
  owner_id      uuid not null,
  src_path      text not null,      -- caminho (ou URL) na v1
  dst_path      text not null,      -- tenants/{tenant}/{entidade}/{dono}/{id}-{arquivo}
  status        text not null default 'PLANNED' check (status in ('PLANNED','COPIED','MISSING','FAILED')),
  error         text,
  updated_at    timestamptz not null default now()
);

-- Classificação derivada do TEXTO da v1: revisar e marcar reviewed = true
create table if not exists etl.catalog_review (
  catalog     text not null check (catalog in ('contribution_types','payment_methods')),
  item_id     uuid not null,
  description text not null,
  derived     jsonb not null,
  reviewed    boolean not null default false,
  primary key (catalog, item_id)
);

-- ------------------------------ conversões -----------------------------------
create or replace function etl.contrib_day(ts timestamp) returns date
language sql stable as $$
  select case
    when ts is null then null
    when etl.cfg('contribution_date_mode') = 'UTC'
      then ((ts at time zone 'UTC') at time zone etl.cfg('timezone'))::date
    else ts::date
  end
$$;

create or replace function etl.expense_day(ts timestamptz) returns date
language sql stable as $$ select (ts at time zone etl.cfg('timezone'))::date $$;

-- real::numeric mantém só 6 dígitos significativos (12345.67 -> 12345.7).
-- Passar por double precision preserva o valor binário antes de arredondar.
create or replace function etl.money(v double precision) returns numeric
language sql immutable as $$ select round(v::numeric, 2) $$;

-- Regras textuais da v1 -> atributos tipados (spec funcional v1 §6.2, §8.1, §12.2)
create or replace function etl.classify_contribution_type(descr text)
returns table (category text, requires_member boolean, counts_for_fees boolean, counts_as_contributor boolean)
language sql immutable as $$
  with n as (select app_norm(descr) as n)
  select case
           when n like '%dizimo%'                           then 'TITHE'
           when n like '%oferta%' and n like '%construcao%' then 'CONSTRUCTION_OFFERING'
           when n like '%missao%' or n like '%missoes%'     then 'MISSIONS'
           when n like '%oferta%'                           then 'OFFERING'
           when n like '%rendimento%'                       then 'INCOME'
           else 'OTHER' end,
         not (n = 'oferta' or n like '%oferta - construcao%' or n like '%ofertas%'
              or n like '%missoes%' or n like '%missao%' or n like '%rendimentos%'),
         n in ('dizimo','dizimos','oferta','ofertas'),
         n like '%dizimo%'
    from n
$$;

create or replace function etl.classify_payment_kind(descr text, legacy_type text) returns text
language sql immutable as $$
  with x as (select app_norm(descr) as n, lower(btrim(coalesce(legacy_type, ''))) as t)
  select case
           when t = 'pix' or n like '%pix%'                            then 'PIX'
           when n ~ '\mdinheiro\M' or t in ('cash','dinheiro','money') then 'CASH'
           when n like '%cart%' or t in ('card','cartao')              then 'CARD'
           when n like '%transfer%' or n ~ '\m(ted|doc)\M'             then 'TRANSFER'
           when n like '%cheque%' or t = 'check'                       then 'CHECK'
           else 'OTHER' end
    from x
$$;

create or replace function etl.log(p_step text, p_qty bigint, p_note text default null) returns void
language sql as $$ insert into etl.run_log (step, qty, note) values (p_step, p_qty, p_note) $$;
