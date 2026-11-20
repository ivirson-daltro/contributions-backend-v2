#!/usr/bin/env bash
# Orquestra a migração v1 -> v2 no BANCO NOVO (esquema final já aplicado; dump da v1 em `legacy`).
#   DATABASE_URL=postgres://... ./etl/run.sh <comando>
#
#   install      instala/atualiza o schema `etl` (idempotente; preserva etl.config)
#   config k v   altera configuração (tenant_id, tenant_slug, tenant_name, contribution_date_mode, timezone)
#   preflight    lista bloqueios e avisos (somente leitura)
#   load         preflight + carga em UMA transação (aborta tudo se algo falhar)
#   users        relatório de usuários        |  link-users  cria associações/perfis (após migrate-users.mjs)
#   reconcile    reconciliação legacy x v2 (sai com erro se algum item divergir)
#   review       classificação de catálogos a revisar e rejeições registradas
#   reset        apaga o tenant migrado para recarregar (ensaios)
#   freeze       trava load/reset (rode logo após o corte)
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
: "${DATABASE_URL:?defina DATABASE_URL}"
P() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
install() { for f in "$D"/sql/[0-9]*.sql; do P -f "$f" 2>/tmp/etl_install.err || { cat /tmp/etl_install.err >&2; echo "ERRO ao aplicar $f" >&2; exit 1; }; done; }

cmd="${1:-}"; shift || true
case "$cmd" in
  install)    install; echo "[ok] schema etl instalado" ;;
  config)     P -c "select etl.set_cfg('$1', '$2')" >/dev/null; echo "[ok] $1 = $2" ;;
  preflight)  install; P -c "select check_name, severity, qty, how_to_fix from etl.preflight() order by severity, check_name" -P pager=off
              n=$(P -At -c "select count(*) from etl.preflight() where severity='BLOCKER'")
              [ "$n" = "0" ] || { echo "ERRO: $n bloqueio(s)"; exit 2; } ;;
  load)       install; P -c "select etl.load()" >/dev/null || { echo "ERRO: carga abortada (nada foi gravado)" >&2; exit 1; }
              echo "[ok] carga concluída"
              P -c "select step, qty from etl.run_log order by id" -P pager=off ;;
  users)      P -c "select status, count(*) from etl.user_report group by 1 order by 1" -P pager=off ;;
  link-users) P -c "select * from etl.link_users()" -P pager=off ;;
  reconcile)  P -c "select * from etl.reconcile()" -P pager=off
              n=$(P -At -c "select count(*) from etl.reconcile() where not ok")
              [ "$n" = "0" ] && echo "[ok] reconciliação completa" || { echo "ERRO: $n divergência(s)"; exit 3; } ;;
  review)     P -c "select * from etl.catalog_review order by catalog, description" -P pager=off
              P -c "select step, source_table, reason, count(*) from etl.rejects group by 1,2,3 order by 1,2,3" -P pager=off ;;
  reset)      P -c "select etl.reset()" >/dev/null || { echo "ERRO: reset recusado" >&2; exit 1; }; echo "[ok] tenant removido; pronto para nova carga" ;;
  freeze)     P -c "select etl.set_cfg('frozen','true')" >/dev/null || exit 1; echo "[ok] etl travado" ;;
  *) sed -n 2,16p "$0"; exit 1 ;;
esac
