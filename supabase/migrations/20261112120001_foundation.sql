-- =============================================================================
-- IBG v2 · BANCO NOVO 01/10 · Fundação
-- -----------------------------------------------------------------------------
-- Esquema FINAL da v2 (sem camada de compatibilidade com a v1). Os dados da v1 entram
-- depois, por carga (pasta etl/), a partir de um schema `legacy` neste mesmo banco.
-- Requer PostgreSQL >= 15.
-- =============================================================================

create extension if not exists unaccent;
create extension if not exists citext;
create extension if not exists pg_trgm;

-- unaccent() é apenas STABLE e não pode ser usada direto em índices. Esta função é
-- IMMUTABLE (dicionário qualificado) e serve a unicidade e busca de catálogos e membros.
create or replace function app_norm(txt text) returns text
language sql immutable parallel safe
set search_path = public, extensions, pg_temp
as $$ select lower(unaccent('unaccent'::regdictionary, btrim(txt))) $$;

-- Contexto da requisição (a API faz set_config(..., true) em cada transação)
create or replace function app_tenant_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function app_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function v2_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
