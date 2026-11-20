#!/usr/bin/env bash
# Bateria de testes do banco novo + ETL contra um Postgres descartável (>= 15).
#   PGHOST/PGPORT/PGUSER apontam para um servidor onde o usuário pode criar bancos e roles.
#   ./etl/tests/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$ROOT/etl/tests"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
Q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
recreate() { Q -d postgres -c "drop database if exists $1" -c "create database $1" 2>&1 | grep -v NOTICE || true; }
ok() { echo "[ok] $*"; }

DB=ibg_etl_flow
export DATABASE_URL="postgresql://$PGUSER@/$DB?host=$PGHOST&port=$PGPORT"
RUN() { "$ROOT/etl/run.sh" "$@"; }

echo "== 1. banco novo: stubs do Supabase + migrations finais + v1 em legacy"
recreate $DB
Q -d $DB -f "$T/fixtures/00a_supabase_stubs.sql" 2>&1 | grep -v NOTICE || true
for f in "$ROOT"/supabase/migrations/*.sql; do Q -d $DB -f "$f" 2>&1 | grep -v NOTICE || true; done
Q -d $DB -c "create schema legacy"
for f in 00_v1_fixture 01_v1_seed; do PGOPTIONS="-c search_path=legacy,public" Q -d $DB -f "$T/fixtures/$f.sql" 2>&1 | grep -v NOTICE || true; done
[ "$(psql -X -At -d $DB -c 'select count(*) from legacy.contributions')" = 7 ] || { echo "ERRO: v1 não carregou em legacy"; exit 1; }
[ "$(psql -X -At -d $DB -c "select count(*) from information_schema.tables where table_schema='public' and table_name='app_users'")" = 0 ] \
  || { echo "ERRO: tabelas da v1 vazaram para public"; exit 1; }
Q -d $DB -f "$T/10_assert_schema.sql"
ok "esquema final aplicado; v1 isolada em legacy"

echo "== 2. preflight BLOQUEIA com o lançamento de valor zero"
RUN install
if out=$(RUN load 2>&1); then echo "ERRO: a carga deveria ter sido bloqueada"; exit 1; fi
grep -q "PREFLIGHT_BLOCKED" <<<"$out" && grep -q "CONTRIBUTION_AMOUNT_NOT_POSITIVE" <<<"$out" || { echo "$out"; exit 1; }
[ "$(psql -X -At -d $DB -c 'select count(*) from public.tenants')" = 0 ] || { echo "ERRO: carga bloqueada deixou dados"; exit 1; }
ok "bloqueio detectado e nada foi gravado"

echo "== 3. corrige o dado NA ORIGEM e recarrega"
Q -d $DB -c "update legacy.contributions set amount = 25.00 where id = '60000000-0000-4000-8000-000000000007'"
RUN preflight >/dev/null
RUN load
ok "carga concluída"

echo "== 4. asserts da carga"
Q -d $DB -f "$T/10_assert_load.sql"

echo "== 5. usuários: Auth (simulado) + associações"
Q -d $DB -f "$T/20_users.sql"

echo "== 6. reconciliação"
n=$(psql -X -At -d $DB -c "select count(*) from etl.reconcile() where not ok and check_name <> 'files.attachments_copied'")
[ "$n" = 0 ] || { psql -X -d $DB -c "select * from etl.reconcile() where not ok"; echo "ERRO: reconciliação divergente"; exit 1; }
[ "$(psql -X -At -d $DB -c "select ok from etl.reconcile() where check_name = 'files.attachments_copied'")" = f ] \
  || { echo "ERRO: cópia de arquivos deveria estar pendente"; exit 1; }
# precisa estar tudo ok exceto os arquivos ainda não copiados (feito por tools/copy-attachments.mjs)
Q -d $DB -c "update etl.attachment_copy set status = 'COPIED'"
RUN reconcile >/dev/null
ok "reconciliação completa"

echo "== 7. guards, RLS, última-admin e auditoria"
Q -d $DB -f "$T/30_assert_rules.sql"

echo "== 7b. ADMIN global x TENANT_ADMIN, convite por link"
Q -d $DB -f "$T/35_assert_platform.sql"

echo "== 8. reset + nova carga produzem o mesmo resultado"
before=$(psql -X -At -d $DB -c "select md5(string_agg(x, '|' order by x)) from (
   select 'c:'||id||amount||occurred_on||category_snapshot||kind_snapshot x from contributions
   union all select 'e:'||id||amount||occurred_on||status||origin from expenses
   union all select 'p:'||occurrence_id||paid_amount from payments
   union all select 'b:'||id||opening_balance||coalesce(closing_snapshot->>'accumulated','-') from monthly_balances) s")
RUN reset
[ "$(psql -X -At -d $DB -c 'select count(*) from tenants where id = '\''a1b2c3d4-0000-4000-8000-000000000001'\''')" = 0 ] || { echo "ERRO: reset incompleto"; exit 1; }
RUN load >/dev/null
after=$(psql -X -At -d $DB -c "select md5(string_agg(x, '|' order by x)) from (
   select 'c:'||id||amount||occurred_on||category_snapshot||kind_snapshot x from contributions
   union all select 'e:'||id||amount||occurred_on||status||origin from expenses
   union all select 'p:'||occurrence_id||paid_amount from payments
   union all select 'b:'||id||opening_balance||coalesce(closing_snapshot->>'accumulated','-') from monthly_balances) s")
[ "$before" = "$after" ] || { echo "ERRO: recarga divergente ($before != $after)"; exit 1; }
ok "reset + recarga idempotentes"

echo "== 9. freeze trava load/reset"
RUN freeze >/dev/null
if RUN reset >/dev/null 2>&1; then echo "ERRO: reset deveria estar travado"; exit 1; fi
ok "freeze bloqueia reset"

echo "== 10. esquema não tem resquícios da camada de coexistência"
Q -d $DB -f "$T/40_assert_schema.sql"
echo "TODOS OS TESTES PASSARAM"
