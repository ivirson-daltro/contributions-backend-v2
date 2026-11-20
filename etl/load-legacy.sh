#!/usr/bin/env bash
# Carrega o dump da v1 (schema public) no schema `legacy` do banco NOVO, sem tocar no `public` dele.
#   ./load-legacy.sh <dump.sql|dump.dump>
#   Requer: psql/pg_dump/pg_restore locais; STAGE_URL = servidor local descartável (scratch);
#           DATABASE_URL = banco novo.
# Por quê passar por um banco de passagem: o dump qualifica tudo como public.*; renomeando o schema
# lá, o pg_dump seguinte já sai como legacy.* e entra no banco novo sem sed.
set -euo pipefail
DUMP="${1:?informe o arquivo do dump}"
: "${STAGE_URL:?STAGE_URL (postgres local de passagem)}" "${DATABASE_URL:?DATABASE_URL (banco novo)}"
STAGE_DB="ibg_v1_stage"
psql -X -q "$STAGE_URL/postgres" -c "drop database if exists $STAGE_DB" -c "create database $STAGE_DB"
case "$DUMP" in
  *.sql) psql -X -q -v ON_ERROR_STOP=0 "$STAGE_URL/$STAGE_DB" -f "$DUMP" >/dev/null ;;
  *)     pg_restore --no-owner --no-acl -d "$STAGE_URL/$STAGE_DB" "$DUMP" ;;
esac
psql -X -q -v ON_ERROR_STOP=1 "$STAGE_URL/$STAGE_DB" -c "alter schema public rename to legacy"
psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "drop schema if exists legacy cascade"
pg_dump --no-owner --no-acl --schema=legacy "$STAGE_URL/$STAGE_DB" | psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" >/dev/null
psql -X -q "$DATABASE_URL" -c "revoke all on schema legacy from public" \
  -c "select 'legacy.' || relname || ': ' || n_live_tup from pg_stat_user_tables where schemaname = 'legacy' order by 1" 
