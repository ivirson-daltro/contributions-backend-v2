# Sistema de Gestão IBG v2 — Especificação de construção

**Versão:** 2.2 — **documento definitivo e autossuficiente** · **Data:** 12 de novembro de 2026 (estratégia de migração: **banco novo + carga**)
**Stack:** NestJS + Supabase (Postgres, Auth, Storage) + Angular · **Modelo:** multi-tenant (uma igreja = um tenant)
**Escopo deste documento:** visão e princípios, arquitetura, planejamento de escala, o que construir feature por feature no back-end e no front-end, banco e migração dos dados da v1. **Não depende de nenhum documento anterior**: o que era útil neles foi incorporado (Apêndices C a H).

---

## 0. Como ler e o que vale em caso de conflito

| Fonte | Papel |
|---|---|
| `supabase/migrations/*.sql` (10 arquivos) | **Fonte da verdade do esquema final do banco novo.** Nomes de tabelas, colunas, funções e erros abaixo foram conferidos contra elas. |
| `etl/` (`run.sh`, `sql/`, `tools/`, `tests/`) | **Fonte da verdade da carga v1 → v2** (preflight, carga, usuários, anexos, reconciliação). |
| `archive/inplace-expand/` | Fluxo anterior (migrar *in-place* o banco da v1: expand/coexistência/corte/contract). **Arquivado e não usado**: serve só de referência histórica e de comparação de esquema. Não aplicar. |
| Este documento | Fonte da verdade do **comportamento** (regras, endpoints, telas, aceite). |
| Documentos anteriores (funcional da v1, arquitetura v2, modelo de dados e migração) | **Substituídos por este documento.** Não são necessários para construir nem para migrar. O conteúdo aproveitado está nos Apêndices C a H (ver mapa abaixo); o DDL e o SQL de migração antigos estão **descartados** (§0.1). |

**Mapa do que foi absorvido:** visão, princípios e decisões de arquitetura → Apêndice C · ciclo de vida do tenant, LGPD, auditoria, segurança e continuidade → Apêndice D · planejamento de escala e riscos → Apêndice E · divergências da v1 e cenários de homologação → Apêndice F · achados do esquema da v1 e queries de diagnóstico → Apêndice G · decisões de negócio pendentes → Apêndice H.

Convenções: **RN-x** = regra de negócio · **[DB]** = garantida também pelo banco · **[D-xx]** = decisão assumida (§1) · `MONTH_CLOSED` etc. = código de erro (§9).

### 0.1 Correções em relação ao documento de modelo de dados anterior

As migrations do repositório já refletem as correções; o documento antigo não deve ser usado como DDL.

| Documento anterior | Problema | Vale agora |
|---|---|---|
| Índice `lower(unaccent(description))` | `unaccent()` é STABLE; o Postgres recusa (`functions in index expression must be marked IMMUTABLE`) — **verificado** | Função `app_norm(text)` IMMUTABLE com dicionário qualificado |
| `round(value::numeric, 2)` em coluna `real` | `real::numeric` mantém 6 dígitos: `12345.67 → 12345.7` — **verificado** | `v2_money(double precision)`: passa por `double precision` antes de arredondar |
| Coluna `date` nova em contribuições/despesas | Tipo e semântica diferentes da v1 (`timestamp`/`timestamptz`) | **`occurred_on`** (`date`, dia de negócio no fuso do tenant); a conversão é feita na carga (`etl.contrib_day`, `etl.expense_day`) |
| `monthly_balances.closed_by` com semântica nova | Na v1 guarda `app_users.id` | Nova coluna **`closed_by_membership_id`** |
| `attachments.path_scheme` | — | Não existe: todo anexo nasce em `tenants/{tenant_id}/…` (`CHECK` [DB]); a cópia dos arquivos antigos é planejada em `etl.attachment_copy` |
| Funções em schema `app_private`, role `ibg_worker` | — | Funções em `public` (`app_tenant_id()`, `app_user_id()`, `app_norm()`, `v2_*`); um role de aplicação, **`ibg_api`**; jobs entre tenants usam a conexão do dono (§4.3) |
| `gender` renomeado direto | — | `members.gender` (a v1 chama `genre`; copiado na carga) |
| Migrar *in-place* o banco da v1 (expand → coexistência → contract) | Exigia triggers bidirecionais, colunas duplicadas e um corte sem volta sobre o banco de produção | **Banco novo** com o esquema final + carga a partir de um dump da v1 (§3); o banco de produção da v1 nunca é alterado |

---

## 1. Decisões assumidas (revisar com o negócio)

O negócio ainda não respondeu às decisões pendentes (consolidadas no Apêndice H). Para não bloquear a construção, cada ponto abaixo tem um **padrão assumido**; os que viram configuração estão marcados.

| ID | Tema | Padrão assumido | Configurável? |
|---|---|---|---|
| D-01 | Reabrir mês | Só em ordem decrescente; reabertura em cascata apenas por TENANT_ADMIN e se `tenant_settings.cascade_reopen = true` | Sim |
| D-02 | Data futura em lançamentos | Proibida | Sim (`allow_future_dates`) |
| D-03 | Arredondamento das taxas | Tenant #1 mantém `LEGACY_CENTS_09` na ASBARE até confirmação; tenants novos usam `HALF_UP_2`. **Base zero → 0,00 em `HALF_UP_2`** (em `LEGACY` continua 0,09) | Sim (`fee_rules.rounding`) |
| D-04 | Pagamento de conta | Valor pago ≠ previsto é permitido e sinalizado; valor zero não (`paid_amount > 0` [DB]) | Não |
| D-05 | Retenção | Anexos e auditoria: 5 anos; tenant cancelado: dados retidos 90 dias | Parâmetro de job |
| D-06 | Relatório por meio de pagamento | Detalhado por `kind`, mais a linha “Pix × demais” para paridade com a v1 | Não |
| D-07 | MFA | Obrigatório para TENANT_ADMIN e TREASURER (`require_mfa_roles`) e **sempre** para o ADMIN global (`aal2` no console) | Parcial |
| D-08 | Como a v1 gravou `contributions.date` | `LOCAL` (data de negócio). **Confirmar com a query G.2 (Apêndice G) antes da carga** | Sim (`etl.config`: `contribution_date_mode`, `timezone`) |
| D-09 | Senhas no corte | Usuários criados no Auth sem senha + convite no dia do corte; importar hash bcrypt só se testado em staging | Flag do script |
| D-10 | Menus | Derivados da matriz de permissões (Secretário vê Contribuições; Fiscal vê Membros) | — |
| D-11 | Janela de migração | Banco novo: **a v1 é a única que escreve até o congelamento**; a v2 só recebe escritas reais depois da carga final. Ensaios (cargas repetidas com dump novo) podem acontecer quantas vezes forem necessárias (§3.3) | — |
| D-12 | Taxas | ASBARE = associação (2%); Plano Cooperativo = convenção (5%) | Sim (`fee_rules`) |
| D-13 | Acesso a banco | Kysely (SQL tipado) sobre `pg`, via pooler em *transaction mode* | — |
| D-14 | Validação/contrato | Zod (`nestjs-zod`) → OpenAPI → cliente Angular gerado | — |
| D-15 | Relatórios PDF | `pdfmake` (sem Chromium) | — |
| D-16 | UI | Angular Material + CDK | — |
| D-17 | Autenticação no front | `supabase-js` só para fluxos de auth; API valida o JWT | — |
| D-18 | Quem é “contribuinte” | Contribuição ativa cujo **tipo atual** tem `counts_as_contributor = true` (reclassificar o tipo muda o histórico do relatório) | Limitação conhecida |
| D-19 | Entrada no sistema | **Não existe autocadastro.** Todo acesso nasce de **convite por link** (token de uso único; só o hash é guardado). Igreja nova = link de `TENANT_ADMIN` gerado no console do ADMIN global; demais usuários = link gerado pelo `TENANT_ADMIN` da igreja. O Supabase Auth fica com `enable_signup = false` | Não |
| D-20 | Dois níveis de administração | **ADMIN (global)** gerencia a plataforma: igrejas, convites de `TENANT_ADMIN`, status, outros ADMINs globais; **não lê dados internos** de nenhuma igreja (garantido por privilégios do banco, não só pela API). **TENANT_ADMIN** gerencia **somente a própria igreja** e não vê nem altera nada da plataforma | Não |
| D-21 | O que o ADMIN global enxerga de uma igreja | Metadados e **contadores de uso** (usuários ativos, membros ativos, bytes de anexos, status, existência de TENANT_ADMIN). Nenhum nome de membro, valor financeiro ou anexo. **Sem “visualizar como”** (impersonação removida) | Não (assumido; confirmar) |
| D-22 | Igreja sem TENANT_ADMIN | O ADMIN global pode emitir novo convite de `TENANT_ADMIN` **somente** na criação da igreja ou quando ela não tem TENANT_ADMIN ativo; toda emissão é auditada na plataforma e no `audit_log` da igreja | Não |

---

## 2. Arquitetura e convenções

### 2.1 Stack e estrutura do repositório

Node 22 LTS · NestJS (última major estável) · Angular (LTS vigente, mínimo 19), *standalone components*, *signals*, `OnPush` · PostgreSQL ≥ 15 (Supabase) · pnpm workspaces.

```
ibg-v2/
  apps/
    api/                    # NestJS
      src/
        main.ts, app.module.ts, worker.ts
        config/             # env validada (zod)
        common/
          database/         # pools, withTenantTx, PlatformDb (ibg_platform), MaintenanceDb (worker), Kysely types (codegen)
          auth/             # JwtAuthGuard (JWKS), MfaGuard
          tenant/           # TenantGuard, TenantContext (AsyncLocalStorage)
          authorization/    # permissions.ts, PermissionsGuard, @RequirePermissions
          http/             # ExceptionFilter (RFC 7807), pagination, idempotency, db-error mapper
          audit/            # AuditService (dentro da transação)
          files/            # StorageService (URL assinada, magic bytes)
          jobs/             # pg-boss
          notifications/    # outbox + e-mail
          pdf/              # pdfmake
          money/            # decimal (decimal.js), datas por fuso
        modules/
          tenants/ platform/ billing/
          auth/ memberships/ users/
          catalogs/ members/ contributors/
          contributions/ contributions-report/
          expenses/ expenses-report/ attachments/
          monthly-balances/
          payables/ payments/
          dashboard/ fees/ audit-query/
      test/                 # integração (DB real) + isolamento entre tenants
    web/                    # Angular
  packages/
    api-client/             # cliente TypeScript gerado de openapi.json
  supabase/migrations/      # esquema final da v2 (10 arquivos) — banco NOVO
  etl/                      # carga v1 → v2 (run.sh, sql/, tools/, tests/)
  archive/inplace-expand/   # fluxo in-place anterior (arquivado; não aplicar)
```

Módulo Nest = **controller → application service (caso de uso, 1 transação) → domínio (funções puras) → repositório (Kysely, sempre dentro de `withTenantTx`)**. Módulos só conversam por serviços exportados; nenhum módulo lê tabela de outro.

### 2.2 Pipeline de requisição

```
RequestId → Helmet/CORS → Throttler (IP + usuário + tenant)
 → JwtAuthGuard (JWKS Supabase; extrai sub, aal)
 → TenantGuard (X-Tenant-Id: associação ACTIVE + status do tenant)
 → MfaGuard (aal2 exigido se perfil ∈ require_mfa_roles)
 → PermissionsGuard (@RequirePermissions)
 → ZodValidationPipe → IdempotencyInterceptor (POST financeiros)
 → Controller → UseCase (withTenantTx) → AuditService (mesma tx)
 → ExceptionFilter (RFC 7807 + mapeamento de erros do banco)
```

### 2.3 Contexto de tenant e transação (obrigatório em toda consulta)

A API conecta como **`ibg_api`** (não dono, sem `BYPASSRLS`). Toda operação roda dentro de `withTenantTx`:

```ts
async withTenantTx<T>(ctx: {tenantId: string; userId: string}, fn: (trx: Kysely<DB>) => Promise<T>) {
  return this.db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${ctx.tenantId}, true),
                     set_config('app.user_id',   ${ctx.userId},   true)`.execute(trx);
    return fn(trx);
  });
}
```

- `set_config(..., true)` vale só na transação (compatível com *transaction mode* do pooler).
- Antes de saber o tenant (ex.: `GET /v1/me`), usar `withUserTx` (só `app.user_id`): a policy `memberships_visible` deixa o usuário ler as próprias associações.
- Proibido: consulta fora de `withTenantTx`; `service_role` na API; SQL sem `tenant_id` em repositórios (a RLS é a segunda camada, não a primeira).

### 2.4 Convenções de API

| Tema | Regra |
|---|---|
| Prefixo/versão | `/v1/...`; OpenAPI em `/docs` (só fora de produção ou autenticado) |
| Headers | `Authorization: Bearer`, `X-Tenant-Id`, `X-Request-Id` (gerado se ausente e devolvido), `Idempotency-Key` (**obrigatório** em `POST` de contribuição, despesa e baixa) |
| Paginação | `?page=1&pageSize=20&sort=…&order=asc|desc` (`pageSize` ≤ 100) → `{ data, meta: { page, pageSize, total, totals? } }` |
| Totais | Sempre sobre **todo o filtro**, nunca só a página (corrige v1). Vêm em `meta.totals` |
| Dinheiro | JSON como **string decimal** (`"1234.50"`), nunca `number`; banco `numeric(14,2)`; cálculo com `decimal.js` |
| Datas | Datas de negócio = `YYYY-MM-DD` (coluna `date`); instantes = ISO 8601 UTC. “Hoje” e limites de semana/mês usam o **fuso do tenant** (`tenants.timezone`) |
| Erros | RFC 7807: `{ type, title, status, code, detail, errors?: [{field, code, message}], requestId }` |
| Exclusão | Financeiro: **cancelamento lógico** (`status = VOIDED/REVERSED`, motivo obrigatório). Cadastros: `deleted_at` (membros) ou `active = false` (catálogos) |
| Concorrência | Edições enviam `version`; `update … where id = $1 and version = $2`; 0 linhas → `409 STALE_VERSION`. O banco incrementa `version` [DB] |
| Idempotência | `Idempotency-Key` + hash do corpo em `idempotency_keys`; mesma chave e corpo → devolve a resposta gravada; mesma chave e corpo diferente → `422 IDEMPOTENCY_KEY_REUSED`; retenção 48 h |

### 2.5 Configuração (variáveis de ambiente)

`DATABASE_URL` (pooler, role `ibg_api`) · `DATABASE_OWNER_URL` (conexão direta, só módulos `platform`/jobs de manutenção) · `SUPABASE_URL` · `SUPABASE_JWKS_URL` · `SUPABASE_SERVICE_ROLE_KEY` (somente criação de usuário/Storage admin) · `STORAGE_BUCKET=attachments` · `EMAIL_PROVIDER_*` · `APP_BASE_DOMAIN` · `SENTRY_DSN` · `WORKER=true|false`. Validadas por Zod na subida; processo não inicia se faltar.

### 2.6 Observabilidade

Logs JSON com `requestId`, `tenantId`, `userId`, rota, status, latência (nunca corpo com dados pessoais/financeiros); métricas p50/p95/p99 por rota, fila (tamanho e idade), pool de conexões; Sentry no back e no front; `GET /health` (liveness) e `GET /health/ready` (consulta simples ao banco).

---

## 3. Banco de dados e migrations

**Estratégia (decidida em 11/11/2026): banco novo + carga.** O banco de produção da v1 não é alterado. Cria-se um projeto Supabase novo, aplica-se o **esquema final** da v2 e carrega-se o dump da v1 por scripts reexecutáveis. A mesma carga é ensaiada quantas vezes for preciso com dumps reais antes do dia do corte.

### 3.1 O que o repositório contém

**Esquema final (`supabase/migrations/`)** — sem colunas legadas, sem triggers de coexistência:

| Arquivo | Conteúdo |
|---|---|
| `20261112120001_foundation` | Extensões (`unaccent`, `citext`, `pg_trgm`); `app_norm()` (IMMUTABLE), `app_tenant_id()`, `app_user_id()`, `v2_touch_updated_at()` |
| `…0002_tenancy_access` | `tenants`, `tenant_settings`, `user_profiles`, `platform_admins`, `tenant_memberships`, `membership_roles` (**vários perfis por associação**), `invitations` (**só por link**, `token_hash`, `created_by_platform`); triggers `v2_guard_last_tenant_admin` e `v2_guard_last_platform_admin` |
| `…0003_catalogs_members` | `member_types`, `expense_categories`, `contribution_types` (`category`, `requires_member`, `counts_for_fees`, `counts_as_contributor`), `payment_methods` (`kind`), `members`; descrição única por tenant via `app_norm()` |
| `…0004_financial` | `contributions`, `expenses` (`occurred_on`, `amount numeric(14,2)`, `status`, `voided_*`, `category_snapshot`/`kind_snapshot`, `origin`, `version`), `monthly_balances` (`cash_on_hand` **saldo em mãos**, `cash_on_hand_notes/_by/_at`, `closing_snapshot`, `opening_source`, `closed_by_membership_id`, `reopened_*`), `v2_month_snapshot()` |
| `…0005_payables_payments` | `payables`, `payable_occurrences` (previsto congelado), `payments` (um ativo por ocorrência; `RESTRICT`) |
| `…0006_attachments` | `attachments` unificada (`PENDING/CONFIRMED/REMOVED`; caminho obrigatoriamente `tenants/{tenant_id}/…`) |
| `…0007_audit_infra` | `audit_log` (particionada por mês, append-only), `v2_ensure_audit_partition()`, `fee_rules`, `idempotency_keys`, `outbox_events`, `v2_seed_tenant_defaults()` |
| `…0008_guards` | Travas permanentes: `MONTH_CLOSED`, `DELETE_FORBIDDEN`, `MEMBER_REQUIRED`, `version` otimista; bypass controlado (`app.bypass_guards`) |
| `…0009_rls_roles` | Role `ibg_api`, RLS e policies, privilégios, `REVOKE` para `anon/authenticated` |
| `…0010_platform` | Role `ibg_platform` (**sem acesso às tabelas de negócio**; só executa funções `v2_platform_*`), `platform_audit_log` (append-only), criação de igreja + convite de TENANT_ADMIN, status da igreja, gestão de ADMINs globais, `v2_invitation_preview` e `v2_accept_invitation`; limita o `ibg_api` (só atualiza `name, document, timezone` em `tenants`) |

**Carga (`etl/`)**:

| Arquivo | Conteúdo |
|---|---|
| `etl/load-legacy.sh` | Restaura o dump da v1 no schema **`legacy`** do banco novo (via banco de passagem local; `public` do banco novo não é tocado) |
| `etl/sql/00_schema` | Schema `etl`: `config` (tenant #1, modo de data, fuso, `frozen`), `rejects`, `run_log`, `user_map`, `attachment_copy`, `catalog_review`; conversões `etl.contrib_day`, `etl.expense_day`, `etl.money` (via `double precision`), classificação de catálogos |
| `etl/sql/10_preflight` | `etl.preflight()` / `etl.preflight_assert()`: **BLOCKER** recusa a carga; **WARNING** carrega e registra |
| `etl/sql/20_load` | `etl.load()`: uma transação; preserva os UUIDs da v1; guards desligados só dentro dela |
| `etl/sql/30_users` | `etl.user_report` e `etl.link_users()` (associações, perfis, autoria legada) |
| `etl/sql/40_reconcile` | `etl.reconcile()`: contagens, somas, diferenças por mês/tipo/membro/categoria, integridade |
| `etl/sql/90_reset` | `etl.reset()` (ensaios), `etl.teardown_sql()` (descarte final, **não** executado automaticamente) |
| `etl/tools/migrate-users.mjs` | Cria os usuários no Supabase Auth do projeto novo e chama `etl.link_users()` |
| `etl/tools/copy-attachments.mjs` | Copia os arquivos do Storage antigo para `tenants/{tenant}/…` conforme `etl.attachment_copy` |
| `etl/run.sh` | Orquestra: `install`, `config`, `preflight`, `load`, `users`, `link-users`, `reconcile`, `review`, `reset`, `freeze` |

### 3.2 Fases

| Fase | O que acontece | Quem escreve no banco novo |
|---|---|---|
| ENSAIO (repetível) | `supabase db push` → `load-legacy.sh <dump>` → `run.sh preflight` → `load` → `users` → `reconcile`. Se algo falhar: corrigir **na v1**, novo dump, `run.sh reset`, repetir | ninguém (só testes/QA) |
| CORTE | v1 congelada (somente leitura) → dump final → carga → `migrate-users.mjs` → `link-users` → `copy-attachments.mjs` → `reconcile` sem divergência → `run.sh freeze` → apontar o front/API v2 → convites | v2 |
| OBSERVAÇÃO | v1 em leitura por ≥ 14 dias; schema `legacy` mantido para consulta | v2 |
| DESCARTE | `etl.teardown_sql()` (apaga `legacy` e `etl`) após backup/PITR confirmado | v2 |

### 3.3 Janela de migração (decisão D-11)

Não há coexistência: **a v1 escreve até o congelamento e a v2 só passa a gravar dados reais depois da carga final**. O custo é uma janela de indisponibilidade de escrita (estimada em minutos para a carga + o tempo da cópia de anexos, que pode ser **pré-executada**: `copy-attachments.mjs` é reexecutável e copia o delta no dia). Em troca, o banco de produção da v1 permanece intacto como plano de volta até o fim da observação: voltar atrás é reapontar a v1.

### 3.4 Runbook de migração

1. **Diagnóstico** na v1 (queries do Apêndice G; principalmente G.2 para `contribution_date_mode`) e comparação do esquema real com `etl/tests/fixtures/00_v1_fixture.sql` (risco R-01).
2. Criar o projeto Supabase novo; `supabase db push` (10 migrations). Definir **fora do repositório** as senhas dos roles `ibg_api` e `ibg_platform`; desligar o cadastro público no Auth (`enable_signup = false`, D-19); criar o **primeiro ADMIN global** (pessoa criada no Auth + `supabase/bootstrap/platform_admin.sql` como dono do banco; os demais ADMINs são adicionados pelo console).
3. Dump da v1 (`pg_dump` do schema `public`) → `etl/load-legacy.sh dump.sql`.
4. `etl/run.sh config contribution_date_mode LOCAL|UTC` (e `timezone`, `tenant_slug`, `tenant_name`, se diferentes do padrão).
5. `etl/run.sh preflight`. **BLOCKERs** (valor ≤ 0, lançamento sem tipo/meio/data, catálogo duplicado, mês duplicado, referência órfã, conta/ocorrência inválida, `PAID` sem baixa válida, anexo sem caminho) são corrigidos **na v1**; novo dump; repetir. **WARNINGs** são lidos e aceitos conscientemente.
6. `etl/run.sh load` (uma transação: ou entra tudo, ou nada). Conferir `etl/run.sh review` (`etl.catalog_review`: classificação derivada do **texto** das descrições; revisar e corrigir os catálogos pela própria v2 — risco R-02; `etl.rejects`).
7. `node etl/tools/migrate-users.mjs --mode=create` (`--dry-run` antes) → `etl/run.sh link-users` → `etl/run.sh users` (esperado: só `NO_EMAIL`/`INVALID_ROLE` pendentes, que viram decisão do TENANT_ADMIN da igreja).
8. `node etl/tools/copy-attachments.mjs` até zerar `PLANNED/FAILED/MISSING`.
9. `etl/run.sh reconcile` → **zero divergência** (inclui cópia de arquivos e existência de um TENANT_ADMIN ativo). Os usuários v1 com perfil `ADMIN` viram **TENANT_ADMIN** da igreja; ninguém da v1 vira ADMIN global.
10. Dia do corte: congelar a v1 → repetir 3–9 com o dump final → `etl/run.sh freeze` → e-mails de definição de senha (`--mode=invite`, via API admin do Auth, que continua funcionando com `enable_signup = false`). Os usuários migrados já têm associação e perfis (`link-users`); os convites por link do F04 valem para quem entrar **depois** do corte.
11. Observação ≥ 14 dias → `etl.teardown_sql()`.

**O que a carga garante:** UUIDs preservados; valores `real` convertidos por `double precision` (`etl.money`); `deleted_at` → `status = VOIDED` com `voided_at` e motivo; despesa que quitou conta → `origin = PAYABLE`; baixa da ocorrência → registro em `payments`; mês fechado ganha `closing_snapshot` (`source = V1_MIGRATION`); anexos (3 tabelas + `expenses.attachment_url`) ganham o caminho novo; auditoria da v1 → `audit_log` (`source = V1`, partições mensais criadas na carga); autoria resolvida para a associação em `link-users`; nada é descartado em silêncio (`etl.rejects`).

**Teste automatizado do fluxo completo:** `PGHOST=… PGUSER=… ./etl/tests/run.sh` (esquema final → v1 em `legacy` → preflight **bloqueia** o lançamento de valor zero → correção na origem → carga → asserts → usuários → reconciliação → regras de negócio/RLS/última-admin/auditoria → reset + recarga idempotentes → `freeze` → ausência de resquícios de coexistência). Rodou com sucesso em PostgreSQL 16.

### 3.5 Erros do banco que a API deve traduzir

| Origem | Código HTTP/API |
|---|---|
| `P0001` + prefixo `MONTH_CLOSED:` | 409 `MONTH_CLOSED` |
| `P0001` + prefixo `MEMBER_REQUIRED:` | 422 `MEMBER_REQUIRED` |
| `P0001` + prefixo `CASH_ON_HAND_REQUIRED:` | 422 `CASH_ON_HAND_REQUIRED` |
| `P0001` + prefixo `LAST_TENANT_ADMIN:` | 409 `LAST_TENANT_ADMIN` |
| `P0001` + prefixo `LAST_PLATFORM_ADMIN:` | 409 `LAST_PLATFORM_ADMIN` |
| `P0001` + prefixo `PLATFORM_FORBIDDEN:` | 403 `FORBIDDEN` (a API já barra antes; aparecer aqui indica bug) |
| `P0001` + prefixo `TENANT_HAS_ADMIN:` | 409 `TENANT_HAS_ADMIN` |
| `P0001` + prefixo `REASON_REQUIRED:` | 422 `REASON_REQUIRED` |
| `P0001` + prefixo `TENANT_CANCELLED:` | 409 `TENANT_CANCELLED_IRREVERSIBLE` |
| `P0001` + prefixo `INVITATION_NOT_FOUND` | 404 `NOT_FOUND` |
| `P0001` + prefixo `INVITATION_ALREADY_USED` / `INVITATION_REVOKED` / `INVITATION_EXPIRED` | 410 `INVITATION_EXPIRED` (mensagem distinta pelo `status` do preview) |
| `P0001` + prefixo `INVITATION_EMAIL_MISMATCH` | 403 `INVITATION_EMAIL_MISMATCH` |
| `P0001` + prefixo `TENANT_UNAVAILABLE:` | 423 `TENANT_SUSPENDED` / `TENANT_CANCELLED` |
| `P0001` + prefixo `DELETE_FORBIDDEN:` / `AUDIT_IMMUTABLE:` | 500 (indica bug: a API nunca apaga financeiro nem altera auditoria) |
| `23505` em `*_desc_uk` | 409 `DUPLICATE_DESCRIPTION` |
| `23505` em `monthly_balances_period_uk` / `payments_one_active` | 409 `DUPLICATE_PERIOD` / `ALREADY_PAID` |
| `23503` (FK) | 422 `INVALID_REFERENCE` (ou 409 `IN_USE` em exclusão) |
| `UPDATE … version` sem linha afetada | 409 `STALE_VERSION` |

### 3.6 Riscos conhecidos do banco e da carga

| ID | Risco | Tratamento |
|---|---|---|
| R-01 | O esquema da v1 usado nos testes foi **reconstruído** a partir da listagem de colunas; constraints, defaults e triggers reais da v1 são desconhecidos | Rodar o diagnóstico (Apêndice G, G.1) na v1 e comparar com `etl/tests/fixtures/00_v1_fixture.sql`; qualquer coluna extra da v1 precisa de decisão (carregar ou descartar) antes do ensaio |
| R-02 | `category`, `requires_member`, flags de taxa/contribuinte e `kind` dos catálogos são **derivados do texto** das descrições da v1 (mesmas regras textuais da v1) | Revisar `etl.catalog_review` logo após a carga; a v2 não depende mais do texto depois disso |
| R-03 | `etl.preflight()` só enxerga o que os dados mostram; regras implícitas da v1 não documentadas podem existir | O ensaio com dumps reais e a reconciliação por mês/tipo/membro/categoria são o instrumento de descoberta |
| R-04 | Criação do role `ibg_api` e uso do pooler em hospedagem Supabase não foram testados aqui (testes em PostgreSQL 16 local, com *stubs* do `auth`) | Ensaiar em um projeto Supabase de staging |
| R-05 | `etl/tools/migrate-users.mjs`, `copy-attachments.mjs` e `etl/load-legacy.sh` dependem de Supabase/Storage/`pg_dump` reais e **não foram executados** | Ensaiar em staging (`--dry-run` primeiro) |
| R-06 | Senhas: a v1 tem hash próprio (`app_users.password_hash`); o padrão é criar usuários sem senha e convidar (D-09) | Importar hash só se testado em staging |
| R-07 | O diagnóstico de fuso (D-08) errado desloca lançamentos de dia (e de mês) | A reconciliação por mês compara contra a mesma regra; conferir amostras de fim de mês com a tesouraria |

---

## 4. Multi-tenancy e segurança

### 4.1 Isolamento em camadas

1. **Aplicação:** `TenantGuard` valida `X-Tenant-Id` contra `tenant_memberships` (status `ACTIVE`); repositórios filtram por `tenant_id`.
2. **Banco:** RLS com `tenant_id = app_tenant_id()` em toda tabela de negócio [DB]; FKs compostas `(tenant_id, id)` impedem referência entre tenants [DB].
3. **Storage:** caminho `tenants/{tenantId}/…` e `CHECK` de prefixo em `attachments.path` [DB]; bucket privado; URLs assinadas curtas.
4. **Privilégios:** `ibg_api` não tem `UPDATE/DELETE/TRUNCATE` em `audit_log`; sem acesso aos schemas `etl` e `legacy` (existem só durante a migração); `anon/authenticated` sem acesso às tabelas v2.
5. **Plataforma:** o ADMIN global usa o role `ibg_platform`, que **não tem GRANT em nenhuma tabela de negócio** (nem RLS que o admita): só executa funções `SECURITY DEFINER` `v2_platform_*` que devolvem metadados e contadores. O `ibg_api` (TENANT_ADMIN e demais) não executa essas funções e só altera `name, document, timezone` da própria igreja (`status`, `slug`, `trial_ends_at` ficam fora do alcance dele).

### 4.2 Status do tenant

| `tenants.status` | Leitura | Escrita | Resposta |
|---|---|---|---|
| `TRIAL`, `ACTIVE` | sim | sim | — |
| `PAST_DUE` | sim | sim | Cabeçalho `X-Tenant-Warning: PAST_DUE` (banner no front) |
| `SUSPENDED` | sim | não | `423 TENANT_SUSPENDED` em escrita; exportação liberada |
| `CANCELLED` | só exportação (90 dias) | não | `423 TENANT_CANCELLED` |

### 4.3 Três acessos ao banco

- **`TenantDb`** (role `ibg_api`, RLS): todo o código de negócio, inclusive aceite de convite (`v2_accept_invitation`/`v2_invitation_preview`, únicas funções de plataforma liberadas a ele).
- **`PlatformDb`** (role `ibg_platform`): **somente** o módulo `platform` (F21). A API faz `set_config('app.user_id', …, true)` e chama as funções `v2_platform_*`; **não há SQL livre** nesse acesso e ele não consegue ler tabela de negócio.
- **`MaintenanceDb`** (conexão de manutenção, não exposta a rotas HTTP): **somente o worker**, para jobs entre tenants (partições de auditoria, listar tenants para jobs por tenant, varredura de retenção). Jobs que processam dados de um tenant entram nele com `withTenantTx`. Classe separada, injetável apenas nos módulos de job.

O console do ADMIN global nunca recebe `X-Tenant-Id`: `/platform/*` ignora o cabeçalho de tenant e **`TenantGuard` rejeita** (`403 FORBIDDEN`) o ADMIN global que tente usar rotas de igreja sem ter associação ativa nela.

### 4.4 Suíte de isolamento (obrigatória na CI)

- **SQL:** para cada tabela com `tenant_id`, como `ibg_api` com `app.tenant_id = A`: `select` de linhas do tenant B retorna 0; `insert`/`update` com `tenant_id = B` falha.
- **HTTP:** para cada rota com `:id`, usuário do tenant A acessa ID do tenant B → `404` (nunca `403`, para não vazar existência).
- **Referência cruzada:** criar contribuição do tenant A apontando para membro do tenant B → `422 INVALID_REFERENCE`.

---

## 5. Perfis múltiplos e permissões

### 5.1 Regras

- **RN-5.1** Uma associação tem **um ou mais** perfis (`membership_roles`). Permissão efetiva = **união**; não existe “negar”.
- **RN-5.2** Associação `ACTIVE` exige ≥ 1 perfil.
- **RN-5.3** Cada tenant mantém ≥ 1 TENANT_ADMIN ativo **[DB]** (`LAST_TENANT_ADMIN`). A plataforma mantém ≥ 1 ADMIN global ativo **[DB]** (`LAST_PLATFORM_ADMIN`).
- **RN-5.7** **ADMIN (global) e TENANT_ADMIN são níveis distintos e não se herdam.** O ADMIN global **não é perfil de igreja**: não consta em `membership_roles` e não tem nenhuma permissão da matriz abaixo. Se a mesma pessoa precisa operar uma igreja, entra nela por convite como qualquer outra e passa a ter ali os perfis convidados (a plataforma não concede esse acesso).
- **RN-5.4** Ninguém altera os próprios perfis nem o próprio status.
- **RN-5.5** O JWT não carrega perfis. A API resolve perfis a cada requisição (cache em memória de 30 s por `membershipId`, invalidado na alteração).
- **RN-5.6** Toda mudança de perfil é auditada (antes/depois, autor, motivo).

### 5.2 Matriz da igreja (A = TENANT_ADMIN, T = TREASURER, S = SECRETARY, F = FISCAL, P = PRESIDENT)

O código autoriza por **permissão** (`@RequirePermissions('expenses:write')`), nunca por perfil. A tabela é a única fonte e fica em `common/authorization/permissions.ts`; o front a recebe de `GET /v1/me`.

| Permissão | A | T | S | F | P |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `fees:calculate` | ✔ | ✔ | | | |
| `members:read-list` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `members:read-detail` | ✔ | ✔ | ✔ | | ✔ |
| `members:write` | ✔ | ✔ | ✔ | | |
| `contributors-report:read` | ✔ | | | | ✔ |
| `users:manage` | ✔ | | | | |
| `catalogs:read` | ✔ | ✔ | ✔¹ | ✔ | ✔ |
| `catalogs:write` | ✔ | ✔ | | | |
| `contributions:read` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `contributions:write` | ✔ | ✔ | | | |
| `contributions-report:generate` | ✔ | ✔ | | | |
| `expenses:read` | ✔ | ✔ | | ✔ | ✔ |
| `expenses:write` | ✔ | ✔ | | | |
| `expenses-report:generate` | ✔ | ✔ | | | |
| `month:set-opening-balance` | ✔ | ✔ | | | |
| `month:set-cash-on-hand` | ✔ | ✔ | | | |
| `month:close` | ✔ | ✔ | | | |
| `month:reopen` | ✔ | ✔ | | | ✔ |
| `payables:read` | ✔ | ✔ | | ✔ | ✔ |
| `payables:write` (cadastro, baixa, estorno, cancelar) | ✔ | ✔ | | | |
| `audit:read` | ✔ | | | ✔ | ✔ |
| `tenant-settings:write` (inclui taxas) | ✔ | | | | |
| `data:export` | ✔ | | | | |

¹ Secretário lê apenas tipos de membro (necessário ao cadastro de membros). `members:read-list` devolve `{id, name, memberType, status}`; o detalhe completo exige `members:read-detail`.
Permissões de plataforma (`/v1/platform/*`) **não fazem parte da matriz** e nenhuma coluna dela as concede: usam `PlatformAdminGuard` (§F21). Por sua vez, o TENANT_ADMIN não tem nenhuma permissão em `/v1/platform/*`.

---

## 6. Features — fundação, acesso e cadastros

Formato de cada feature: **Objetivo · Regras · Back-end (endpoints, dados, transação/auditoria) · Front-end (rotas, telas, estados) · Aceite**. Endpoints omitem o prefixo `/v1`. Todos exigem JWT e `X-Tenant-Id`, exceto os marcados *(público)*.

### F00 — Fundação técnica

**Objetivo:** esqueleto que as demais features reutilizam, com o isolamento entre tenants provado desde o primeiro dia.

**Back-end**
- Bootstrap Nest (`main.ts`, `worker.ts`), configuração validada (§2.5), `DatabaseModule` (`TenantDb`, `PlatformDb`, `MaintenanceDb`, `withTenantTx`, `withUserTx`), tipos Kysely gerados do banco (`kysely-codegen` a partir do banco **pós-corte**).
- Guards: `JwtAuthGuard` (JWKS), `TenantGuard`, `MfaGuard`, `PermissionsGuard`, `PlatformAdminGuard` (F21); `permissions.ts` com a matriz (§5.2).
- `ExceptionFilter` RFC 7807 + mapeador de erros do banco (§3.5); `IdempotencyInterceptor`; utilitário de paginação com `meta.totals`; `AuditService` (§F19).
- Script `pnpm openapi` gera `packages/api-client` (falha a CI se o cliente gerado divergir do commitado).
- `GET /health`, `GET /health/ready`.

**Front-end**
- Workspace Angular com `core/` (`SessionStore`, `TenantStore`, `PermissionsStore`, interceptors `auth`, `tenant`, `idempotency`, `error`), `shared/ui` (tabela paginada, diálogo, confirmação, `money-input`, `date-input`, `file-uploader`, estado vazio, skeleton), `layout/` (shell, menu lateral gerado por `{label, route, permission}`, cabeçalho com seletor de igreja), tema claro/escuro, locale `pt-BR`.
- `permissionGuard` único (avalia a rota **completa**, não o primeiro segmento) e diretiva `*hasPermission`.
- Tradução central de `code` de erro → mensagem (§9).

**Aceite**
- Dado dois tenants com um usuário cada, quando o usuário A chama qualquer rota com ID do tenant B, então recebe `404`.
- Dado um `POST` financeiro sem `Idempotency-Key`, então `400 IDEMPOTENCY_KEY_REQUIRED`.
- A CI executa `etl/tests/run.sh` (esquema + carga + regras no banco), a suíte de isolamento e gera o cliente OpenAPI.

---

### F01 — Abertura da igreja (pelo ADMIN global) e configurações da igreja

**Objetivo:** não existe autocadastro. Uma igreja nasce quando o **ADMIN global** a cria no console (F21) e entrega um **link de convite** ao futuro TENANT_ADMIN; depois disso a igreja se configura e pode exportar seus dados sozinha. Substitui o autocadastro quebrado da v1.

**Regras**
- **RN-1.1** `slug`: `^[a-z0-9][a-z0-9-]{1,40}$` [DB], único (sem diferenciar caixa), fora da lista reservada (`www, api, app, admin, platform, auth, static`).
- **RN-1.2** Tenant novo nasce `TRIAL` (30 dias, `trial_ends_at`) e é semeado por `v2_seed_tenant_defaults()`: tipos de membro, de contribuição (com flags), meios de pagamento, categorias de despesa, `tenant_settings` e `fee_rules` (ASBARE 2% e Plano Cooperativo 5%, `HALF_UP_2`). A criação ocorre **só** por `v2_platform_create_tenant` (F21); não há rota pública nem caminho no banco para outro papel criar igreja.
- **RN-1.3** A igreja nasce **sem usuários**; o único meio de ter o primeiro TENANT_ADMIN é o convite emitido na criação (link com validade padrão de 7 dias, uso único). Os demais usuários entram por convite do TENANT_ADMIN (F04).
- **RN-1.4** `timezone` deve ser um identificador IANA válido.
- **RN-1.5** Exportação gera ZIP de CSVs (todas as tabelas de negócio do tenant + anexos opcionais) por job; link assinado de 24 h enviado por e-mail ao solicitante.
- **RN-1.6** Cancelamento **pela igreja** foi retirado do escopo do TENANT_ADMIN: o `status` da igreja só muda pelo ADMIN global (F21), que pode cancelá-la a pedido (motivo obrigatório, irreversível, dados retidos 90 dias — D-05 — e depois anonimizados por job). O TENANT_ADMIN **solicita** o cancelamento por `POST /tenant/cancel-request`, que apenas registra o pedido e avisa a plataforma.
- **RN-1.7** O TENANT_ADMIN edita **apenas** `name`, `document` e `timezone` da igreja e as configurações em `tenant_settings`; `slug`, `status` e `trial_ends_at` são da plataforma [DB: `GRANT UPDATE (name, document, timezone)`].

**Back-end**
| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/public/tenants/by-slug/:slug` *(público)* | — | `{ id, name, slug }` apenas (o front resolve a igreja pelo subdomínio) |
| GET / PUT | `/tenant` | `tenant-settings:write` (PUT) | `{ name, document, timezone }` |
| GET / PUT | `/tenant/settings` | `tenant-settings:write` (PUT) | `{ weekStartsOn, allowFutureDates, payableWindowDays (0–60), payableAlertDays, attachmentMaxMb (≤25), attachmentMaxFiles (≤20), requireMfaRoles[], cascadeReopen }` |
| POST | `/tenant/export` | `data:export` | `202 { jobId }` |
| GET | `/tenant/export/:jobId` | `data:export` | `{ status, downloadUrl? }` |
| POST | `/tenant/cancel-request` | `tenant-settings:write` | `{ reason }` → registra o pedido (auditado) e notifica a plataforma; **não** altera o status |

- Removidos em relação à v2.0: `POST /public/signup` e a tela `/signup`. Ficam proibidos no Supabase Auth: cadastro público (`enable_signup = false`) e login por *magic link* de e-mail desconhecido.
- A criação da igreja e a emissão do primeiro convite acontecem numa única transação no banco (F21, `v2_platform_create_tenant`): `tenants` → `v2_seed_tenant_defaults` → `invitations (created_by_platform, roles = {TENANT_ADMIN})` → `platform_audit_log` e `audit_log` da igreja.
- Auditoria: `TENANT_UPDATED`, `TENANT_SETTINGS_UPDATED`, `TENANT_EXPORT_REQUESTED`, `TENANT_CANCEL_REQUESTED` (na igreja); `PLATFORM_TENANT_CREATED` (F21).

**Front-end**
- `/onboarding`: checklist persistente para o TENANT_ADMIN recém-chegado (importar membros, revisar catálogos, definir saldo de abertura, convidar usuários), cada item com link e marcação automática.
- `/settings/church` e `/settings/preferences` (formulários reativos; alterações de `requireMfaRoles` com aviso); diálogo de exportação com *polling* do job; diálogo “Solicitar cancelamento”. Sem campos de `slug`/`status`.
- Subdomínio `{slug}.app…` resolve o tenant (`by-slug`); sem subdomínio, vai ao seletor de igreja (F02). Quem chega sem convite e sem conta vê apenas a tela de login (“acesso somente por convite”).

**Aceite**
- Dado `slug` já usado na criação pelo ADMIN global, então `409 SLUG_TAKEN` e nada é criado.
- Dado tenant criado, então existem 1 tenant `TRIAL`, catálogos semeados, **0 associações** e 1 convite pendente de `TENANT_ADMIN`; `by-slug` devolve só `id`, `name`, `slug`.
- Dado TENANT_ADMIN, quando tenta alterar `status`/`slug` (por API ou SQL como `ibg_api`), então é negado.
- Dado tenant `SUSPENDED`, então escritas retornam `423` e a exportação continua funcionando.

---

### F02 — Autenticação e sessão

**Objetivo:** login seguro, **aceite de convite por link**, recuperação e MFA, com permissões resolvidas no servidor. Não há cadastro público: sem convite não se cria conta.

**Regras**
- **RN-2.1** Identidade = `auth.users` (e-mail de **login**). Diferença da v1: o login não usa mais `members.email`; os dois e-mails são independentes.
- **RN-2.2** Senha ≥ 8 caracteres com letra e número (configurado no Supabase Auth); recuperação por e-mail com resposta genérica; limite de tentativas no Auth + `Throttler` da API.
- **RN-2.3** MFA TOTP **obrigatório** se algum perfil do usuário no tenant ∈ `require_mfa_roles` (D-07): sem `aal2` no JWT → `403 MFA_REQUIRED`.
- **RN-2.4** Usuário com várias associações escolhe a igreja; a última escolha é lembrada. Uma só associação ativa entra direto.
- **RN-2.5** Associação `SUSPENDED/REMOVED/INVITED` → `403 MEMBERSHIP_INACTIVE`.
- **RN-2.6** Sessão: *access token* de 1 h, *refresh* rotativo.
- **RN-2.7** **Aceite de convite** (único caminho de entrada): o link `https://{slug}.app…/accept-invite?token=…` leva à tela de aceite, que consulta o convite (`PENDING`, `ACCEPTED`, `REVOKED` ou `EXPIRED`) e mostra igreja, e-mail e perfis. (a) E-mail **sem conta**: a pessoa define nome e senha e a API cria o usuário no Auth (API admin, e-mail já confirmado por ter recebido o link) e aceita. (b) E-mail **com conta**: precisa entrar (login) e confirmar; o e-mail do usuário deve ser **igual** ao do convite (`INVITATION_EMAIL_MISMATCH`). Falha após criar o usuário → o usuário recém-criado é removido (compensação). O token só vale uma vez e nunca é gravado em claro (só o hash).
- **RN-2.8** ADMIN global: o console exige `aal2`; no primeiro acesso o MFA TOTP é cadastrado antes de qualquer tela.

**Back-end**
| Método | Rota | Descrição |
|---|---|---|
| GET | `/me` | Sem `X-Tenant-Id`: `{ user:{id,email,displayName}, memberships:[{tenantId, slug, name, status, roles[], mfa:{required, satisfied}}] }`. Com `X-Tenant-Id`: acrescenta `permissions[]` efetivas, `tenant:{status, timezone, settings}` e `mfa:{required, satisfied}` da associação selecionada |
| GET | `/public/invitations/:token` *(público, limite de taxa)* | Prévia: `{ tenant:{name, slug}, email, name?, roles[], status, expiresAt, accountExists }`; token desconhecido → `404` (não revela se existiu) |
| POST | `/public/invitations/:token/accept` *(público, limite de taxa)* | Sem conta: `{ displayName, password }` → cria o usuário no Auth e aceita. Com conta: exige JWT do mesmo e-mail e corpo `{}`. Cria a associação `ACTIVE` + perfis do convite (`v2_accept_invitation`), marca `accepted_at`/`accepted_user_id`. `201 { tenantId, membershipId }` |

Login, logout, refresh, esqueci/redefinir senha e MFA são chamadas diretas do front ao Supabase Auth (D-17); a API só valida o JWT.

**Front-end** — rotas: `/login`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/mfa/enroll` (QR code + código de verificação), `/mfa/verify`, `/select-church`. Guards: `authGuard` → `tenantGuard` (resolve `/me`) → `mfaGuard` → `permissionGuard`. Interceptor renova a sessão em `401` uma única vez; em `403 MFA_REQUIRED` redireciona ao fluxo de MFA. Estados: carregando, credenciais inválidas (mensagem genérica), conta sem igreja (“acesso somente por convite: peça ao administrador da sua igreja”).

**Aceite**
- Dado TENANT_ADMIN sem MFA verificado, quando chama qualquer rota de negócio, então `403 MFA_REQUIRED`.
- Dado token já usado, revogado ou vencido, então a prévia informa o estado e o aceite devolve `410 INVITATION_EXPIRED`; dado e-mail de outra conta, `403 INVITATION_EMAIL_MISMATCH`.
- Dado visitante sem convite, quando tenta criar conta pelo Supabase Auth diretamente, então é recusado (`enable_signup = false`).
- Dado usuário com TENANT_ADMIN + TREASURER, então `/me` lista os dois perfis e a união das permissões.
- Dado perfil alterado há menos de 30 s no mesmo servidor, então a próxima requisição já usa o novo conjunto (cache invalidado).

---

### F03 — Perfil do usuário (autoatendimento)

**Regras**
- **RN-3.1** O usuário edita o próprio `displayName` e, no cadastro de membro vinculado, apenas campos de contato e endereço (telefone, e-mail de contato, CEP, logradouro, número, complemento, bairro, cidade, UF). Tipo de membro, status e datas da igreja continuam exclusivos de `members:write` (corrige a limitação da v1 em que o perfil abria uma edição que a API negava).
- **RN-3.2** Troca de e-mail de login passa pela confirmação do Supabase Auth; troca de senha exige senha atual.

**Back-end:** `GET/PUT /me/profile` `{ displayName }`; `GET/PUT /me/member` (somente campos acima; `404` se não há membro vinculado). Auditoria `PROFILE_UPDATED`.
**Front-end:** `/profile` com abas Dados pessoais, Segurança (senha, MFA), Minhas igrejas.
**Aceite:** secretário edita o próprio telefone; tentativa de alterar `memberTypeId` pelo `/me/member` retorna `422` (campo não aceito).

---

### F04 — Usuários, convites e perfis múltiplos

**Objetivo:** o TENANT_ADMIN controla quem acessa **a própria igreja** e com quais perfis, sempre por convite com link.

**Regras**
- **RN-4.1** Convite: e-mail + ≥ 1 perfil + membro opcional; **gera um link de uso único** (token com hash no banco), válido por 7 dias; no máximo 1 convite pendente por e-mail e tenant. O link é exibido **uma única vez** para quem emitiu (copiar) e pode ser enviado por e-mail pelo sistema (evento no outbox cujo conteúdo com o token é descartado após o envio). Perdeu o link: reenviar gera token novo e invalida o anterior.
- **RN-4.2** Aceitar o convite cria a associação; perfis do convite viram `membership_roles`.
- **RN-4.3** Alterar perfis substitui o conjunto (a API calcula a diferença, grava e audita antes/depois). Aplicam-se RN-5.2 a RN-5.4.
- **RN-4.4** Conceder TENANT_ADMIN ou TREASURER a quem não tem MFA ativo é permitido; o usuário será levado a configurar MFA no próximo acesso (RN-2.3).
- **RN-4.5** Remover (`REMOVED`) ou suspender não apaga histórico; a auditoria mantém o autor.
- **RN-4.6** Um membro só pode estar vinculado a uma associação ativa.

- **RN-4.7** O TENANT_ADMIN só convida para a **própria** igreja; convites `created_by_platform` (emitidos pelo ADMIN global, sempre com perfil único TENANT_ADMIN) aparecem na lista mas **não podem ser criados nem alterados** por ele [DB: policy com `not created_by_platform`], apenas visualizados e, se preciso, revogados pelo ADMIN global.

**Back-end** (`users:manage`)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/users` | Filtros `status`, `role`, `q`; itens `{ membershipId, userId, email, displayName, member?, status, roles[], lastSeenAt }` |
| POST | `/users/invitations` | `{ email, name?, roles[≥1], memberId? }` → `201 { id, link, expiresAt }` (`link` só nesta resposta); grava `invitations` (token com hash) e, opcionalmente, e-mail via outbox |
| GET | `/users/invitations` | Pendentes/expirados |
| POST | `/users/invitations/:id/resend` · DELETE `/users/invitations/:id` | Reenviar (novo token e novo `link`) / revogar (`revoked_at`) |
| PUT | `/users/:membershipId/roles` | `{ roles[], reason? }` |
| PATCH | `/users/:membershipId/status` | `{ status: ACTIVE|SUSPENDED|REMOVED, reason }` |
| PUT | `/users/:membershipId/member` | `{ memberId|null }` |

Auditoria: `INVITATION_CREATED/RESENT/REVOKED/ACCEPTED`, `MEMBERSHIP_ROLES_CHANGED`, `MEMBERSHIP_STATUS_CHANGED`. Erros: `LAST_TENANT_ADMIN`, `SELF_CHANGE_FORBIDDEN`, `INVITATION_EXPIRED`, `INVITATION_EMAIL_MISMATCH`.

**Front-end** — `/users`: tabela com *chips* de perfis, abas Ativos / Convites; diálogo **Convidar** (e-mail, grupo de caixas de seleção de perfis com descrição, busca de membro) que termina na tela “**Link do convite**” (botão copiar, aviso de que não será mostrado de novo, validade); diálogo **Editar perfis** (caixas de seleção + pré-visualização das permissões resultantes); ações suspender/remover com motivo; desabilita ações sobre si mesmo. Estado vazio com chamada para convidar.

**Aceite**
- Dado usuário com TREASURER, quando o TENANT_ADMIN adiciona TENANT_ADMIN, então ele passa a ter `users:manage` e continua com `expenses:write`.
- Dado único TENANT_ADMIN ativo, quando se tenta removê-lo ou retirar o perfil, então `409 LAST_TENANT_ADMIN`.
- Dado TENANT_ADMIN editando os próprios perfis, então `403 SELF_CHANGE_FORBIDDEN`.
- Dado TENANT_ADMIN da igreja A, quando tenta emitir convite para a igreja B ou um convite `created_by_platform`, então é negado (`404`/RLS).

---

### F05 — Catálogos (parâmetros)

**Objetivo:** quatro cadastros por igreja, com atributos tipados que substituem as regras por texto da v1.

**Regras**
- **RN-5.1c** Tipo de contribuição tem `category` (`TITHE, OFFERING, CONSTRUCTION_OFFERING, MISSIONS, INCOME, OTHER`), `requiresMember`, `countsForFees`, `countsAsContributor`. Meio de pagamento tem `kind` (`CASH, PIX, CARD, TRANSFER, CHECK, OTHER`). **Nenhuma regra depende do texto da descrição.**
- **RN-5.2c** Descrição única por tenant ignorando caixa, acento e espaços nas pontas [DB] → `409 DUPLICATE_DESCRIPTION` (a v1 devolvia o registro existente em silêncio).
- **RN-5.3c** Item referenciado por lançamento **não é excluído**: só inativado (`active = false`); some dos formulários e permanece no histórico. Exclusão física apenas de item nunca usado (`409 IN_USE` caso contrário).
- **RN-5.4c** Alterar `category`/flags/`kind` de item já usado exige `confirm=true` e é auditado; lançamentos já feitos mantêm `category_snapshot`/`kind_snapshot` [DB].
- **RN-5.5c** Tipos de membro e categorias de despesa: somente `description` e `active`.

**Back-end** — grupos `/catalogs/member-types`, `/catalogs/contribution-types`, `/catalogs/payment-methods`, `/catalogs/expense-categories`, cada um com `GET` (filtros `q`, `active`, paginação), `GET /:id`, `POST`, `PUT /:id`, `PATCH /:id/active`, `DELETE /:id`. Leitura: `catalogs:read`; escrita: `catalogs:write`. Auditoria `CATALOG_CREATED/UPDATED/DEACTIVATED/DELETED` (com `entity` = nome do catálogo).

**Front-end** — `/settings/catalogs` com abas. Tabela com coluna Ativo (alternador) e contagem de uso; diálogo de edição; no tipo de contribuição, campos de categoria e três opções com texto de ajuda (“Dízimo: entra na base das taxas e no relatório de contribuintes”); confirmação ao alterar item em uso; inativos ocultos por padrão (filtro “mostrar inativos”).

**Aceite**
- Renomear “Dízimo” para “Dízimos e Primícias” **não** muda cálculo de taxas, contribuintes nem obrigatoriedade de membro.
- Excluir tipo com lançamentos → `409 IN_USE` com sugestão de inativar.
- Criar “dizimo ” (com espaço e sem acento) quando “Dízimo” existe → `409 DUPLICATE_DESCRIPTION`.

---

### F06 — Membros

**Regras**
- **RN-6.1** Obrigatórios: `name`, `memberTypeId` (do mesmo tenant [DB]). `email` opcional e válido.
- **RN-6.2** **Duplicidade:** na criação, se existir membro ativo com mesmo nome normalizado (`app_norm`) **e** (mesma data de nascimento, ou e-mail igual, ou telefone igual só com dígitos), responde `409 POSSIBLE_DUPLICATE` com até 5 candidatos; `force=true` cria mesmo assim. Substitui o retorno silencioso por nome exato da v1.
- **RN-6.3** Exclusão é **lógica** (`deleted_at`). Não exclui membro vinculado a associação `ACTIVE` (`409 MEMBER_HAS_ACCESS`). Contribuições antigas continuam exibindo o nome.
- **RN-6.4** `status`: `ACTIVE, INACTIVE, TRANSFERRED, DECEASED`; só `ACTIVE` aparece em seletores de novos lançamentos.
- **RN-6.5** Dados sensíveis (nascimento, batismo, endereço) só com `members:read-detail`; `consent_at` registra o consentimento (LGPD).
- **RN-6.6** Importação CSV: validação linha a linha, prévia com erros/duplicatas, confirmação explícita; processada por job.

**Back-end**
| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/members` | `members:read-list` | `q` (busca parcial por trigrama em `app_norm(name)`), `memberTypeId`, `status`, `page`, `sort=name|type|createdAt` |
| GET | `/members/lookup?q=` | `members:read-list` | Autocomplete leve (≤ 20): `{id, name, memberType}` |
| GET | `/members/:id` | `members:read-detail` | Todos os campos |
| POST | `/members` | `members:write` | Campos: `name, memberTypeId, status?, phone, email, gender, birthDate, entryDate, baptismDate, zipCode, street, number, complement, neighborhood, city, state, consent?` |
| PUT / DELETE | `/members/:id` | `members:write` | — |
| POST | `/members/import` | `members:write` | `multipart` CSV → `202 { jobId }` |
| GET / POST | `/members/import/:jobId` · `/members/import/:jobId/confirm` | `members:write` | Progresso/erros; confirmação |

Observação de dados: a API usa `gender`; o campo `genre` da v1 é copiado para `gender` na carga. Auditoria `MEMBER_CREATED/UPDATED/DELETED/IMPORTED`.

**Front-end** — `/members`: busca com *debounce* de 300 ms, filtros, paginação no servidor; `/members/new` e `/members/:id/edit` em **página** (seções Dados, Endereço, Igreja); CEP com preenchimento via ViaCEP tolerante a falha (campos continuam editáveis); máscaras de telefone/CEP; diálogo de possível duplicidade (“usar existente” / “criar mesmo assim”); `/members/import` (enviar → prévia → confirmar). Componente de **criação rápida** reutilizado no formulário de contribuição.

**Aceite**
- Fiscal vê a lista (nome e tipo) mas recebe `403` em `GET /members/:id`; Secretário e Presidente acessam o detalhe (matriz §5.2).
- Dado “João Silva” já cadastrado com mesma data de nascimento, quando se cria outro igual, então `409 POSSIBLE_DUPLICATE`; com `force=true` cria.
- Membro com contribuições é excluído → some das listas; contribuições continuam mostrando o nome.

---

### F07 — Contribuintes (relatórios)

**Regras**
- **RN-7.1** Contribuinte = membro **não excluído** com ≥ 1 contribuição **ativa** no período cujo tipo tenha `counts_as_contributor = true` (D-18). Contribuições sem membro são ignoradas. Cada membro aparece uma vez por período; cada mês, uma vez.
- **RN-7.2** Mensal: lista de membros do mês. Anual: matriz membro × 12 meses.

**Back-end** (`contributors-report:read`)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/members/contributors/month?year&month&q&page&sort=name|type` | `{ id, name, memberType }` |
| GET | `/members/contributors/year?year&q&page&sort` | `{ id, name, memberType, months: boolean[12] }` |
| GET | `/members/contributors/year/report?year&q` | PDF (síncrono até 2 000 membros; acima, job) |

**Front-end** — `/members/contributors`: abas Mensal/Anual, seletor de mês/ano, busca, ordenação, tabela anual com 12 colunas (marcação ✔), botão PDF, estados vazios (“Nenhum contribuinte no período”).

**Aceite:** dízimo repetido no mesmo mês conta 1 mês; oferta sem membro não gera contribuinte; membro excluído não aparece; PDF anual traz os mesmos membros e meses da tela.

---

### F08 — Contribuições

**Objetivo:** registrar e consultar entradas financeiras.

**Regras**
- **RN-8.1** Campos: `contributionTypeId`, `paymentMethodId`, `amount` (> 0, 2 casas), `occurredOn` (data), `memberId?`, `observation?`, `attachmentIds[]`.
- **RN-8.2** **Membro obrigatório** se `contribution_types.requires_member = true`; revalidado em **criação e edição** [DB `MEMBER_REQUIRED`] (corrige a v1). Se informado, o membro deve existir, estar ativo e ser do mesmo tenant.
- **RN-8.3** **Edição pode trocar o membro**, com auditoria antes/depois; trocar o tipo revalida a regra anterior.
- **RN-8.4** `occurredOn` ≤ hoje no fuso do tenant, salvo `allow_future_dates` (D-02).
- **RN-8.5** Mês fechado bloqueia criar, editar e cancelar lançamento com data naquele mês (`409 MONTH_CLOSED`) [DB] — vale a data antiga **e** a nova numa edição.
- **RN-8.6** Tipo e meio devem estar `active`.
- **RN-8.7** **Cancelar** (não excluir): `status = VOIDED`, `void_reason` ≥ 5 caracteres, preserva registro e anexos; sai de totais e relatórios. `DELETE` físico é proibido [DB `DELETE_FORBIDDEN`].
- **RN-8.8** Snapshots `category_snapshot`/`kind_snapshot` são preenchidos pelo banco no lançamento e alterados só quando o tipo/meio do lançamento muda.
- **RN-8.9** Idempotência e `version` (§2.4).
- **RN-8.10** Edição só em lançamento `ACTIVE`.

**Back-end**
| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/contributions` | `contributions:read` | Filtros `memberId, typeId, methodId, from, to, status=ACTIVE|VOIDED|ALL`, `page`, `sort=date|amount|member`. Item: `{ id, occurredOn, amount, member?:{id,name}, type:{id,description,category}, method:{id,description,kind}, observation, status, attachmentsCount, version }`. `meta.totals = { amount, count }` calculado sobre **todo o filtro**, apenas `ACTIVE` |
| GET | `/contributions/:id` | `contributions:read` | Com anexos |
| POST | `/contributions` | `contributions:write` | `Idempotency-Key` obrigatório → `201` |
| PUT | `/contributions/:id` | `contributions:write` | Corpo + `version` |
| POST | `/contributions/:id/void` | `contributions:write` | `{ reason, version }` |

Transação do `POST`: validar → pré-checar mês fechado (mensagem amigável) → inserir → confirmar anexos (`PENDING → CONFIRMED`) → auditar `CONTRIBUTION_CREATED`. Demais: `CONTRIBUTION_UPDATED`, `CONTRIBUTION_VOIDED`.

**Front-end** — `/contributions`: barra de filtros (membro com busca assíncrona, tipo, meio, período com atalhos Semana atual/anterior e Mês), tabela paginada no servidor, **faixa de totais do filtro** (soma e quantidade), linhas canceladas em cinza quando `status=ALL`; ações por permissão (`*hasPermission`). **Formulário** (diálogo): o campo Membro é **obrigatório ou opcional conforme `requiresMember` do tipo escolhido**, vindo da API (sem lista de textos no front); data com máximo = hoje; `money-input` em reais; `file-uploader`; criação rápida de membro. Chave de idempotência gerada uma vez por abertura do formulário e reutilizada em reenvios. `MONTH_CLOSED` mostra mensagem com atalho para “Reabrir mês” se o usuário tiver `month:reopen`. Diálogo de cancelamento exige motivo.

**Aceite**
- Dado tipo com `requiresMember = true`, quando se envia sem membro, então `422 MEMBER_REQUIRED`; após editar um lançamento sem membro mudando para tipo que exige membro, idem.
- Dado mês fechado, quando se cria lançamento nele ou se muda a data de outro **para** ele, então `409 MONTH_CLOSED`.
- Dado 45 lançamentos no filtro com página de 20, então `meta.totals.count = 45` e a soma cobre os 45.
- Dado duplo clique em “Salvar”, então existe 1 lançamento.

---

### F09 — Relatório de contribuições (PDF)

**Regras**
- **RN-9.1** Intervalo livre (`from`, `to`, inclusivos, em data de negócio), máx. 366 dias; `from ≤ to`.
- **RN-9.2** Conteúdo: cabeçalho (nome e documento da igreja, período, emissor, gerado em no fuso do tenant); tabela (data, membro, tipo, meio, valor); **total geral**; totais **por `kind`** do meio (`PIX, CASH, CARD, TRANSFER, CHECK, OTHER`) mais a linha “Pix × demais” (D-06); totais **por `category`** do tipo (dízimos, ofertas, oferta de construção, missões, rendimentos, outros) lidos de `category_snapshot`/`kind_snapshot`; só lançamentos `ACTIVE`.
- **RN-9.3** Sem dados: PDF com “Sem contribuições no período”.
- **RN-9.4** Até 2 000 linhas: resposta direta; acima: job (`202 { jobId }`).

**Back-end:** `GET /contributions/report?from&to` (`contributions-report:generate`) → `application/pdf` ou `202`. **Front-end:** diálogo “Gerar relatório” com período, atalhos (semana atual e anterior respeitando `weekStartsOn`, mês atual), pré-visualização/baixar; progresso quando assíncrono.
**Aceite:** lançamentos nos dias inicial e final entram; soma por `kind` e por `category` iguala o total geral; cancelados não aparecem.

---

### F10 — Despesas

**Regras**
- **RN-10.1** Campos: `amount` (> 0), `description`, `categoryId` (ativa), `occurredOn`, `notes?`, `attachmentIds[]`. **Validação no backend também na criação** (corrige a v1).
- **RN-10.2** Mesmas regras de F08 para data futura, mês fechado, cancelamento lógico com motivo, idempotência e `version`.
- **RN-10.3** Despesa com `origin = PAYABLE` **não** é editada nem cancelada por esta feature (`409 EXPENSE_FROM_PAYABLE`): estorna-se a baixa (F16).
- **RN-10.4** Totais do filtro em `meta.totals`.

**Back-end**
| Método | Rota | Permissão |
|---|---|---|
| GET | `/expenses` (`categoryId, from, to, status, q, page, sort`) | `expenses:read` |
| GET | `/expenses/:id` | `expenses:read` |
| POST | `/expenses` | `expenses:write` (`Idempotency-Key`) |
| PUT | `/expenses/:id` | `expenses:write` |
| POST | `/expenses/:id/void` | `expenses:write` (`{ reason, version }`) |

Auditoria `EXPENSE_CREATED/UPDATED/VOIDED`.
**Front-end:** `/expenses` com a mesma estrutura de F08; selo “Conta a pagar” nas despesas `PAYABLE` com atalho para a ocorrência; ações de edição/cancelamento desabilitadas nelas, com dica explicando o motivo.
**Aceite:** `amount = 0` na criação → `422`; despesa gerada por baixa → editar retorna `409 EXPENSE_FROM_PAYABLE`; mês fechado → `409 MONTH_CLOSED`.

---

### F11 — Anexos

**Objetivo:** upload seguro e atômico, eliminando lançamentos criados “sem anexo por falha”.

**Regras**
- **RN-11.1** **Duas fases:** (a) pedir URL assinada de envio (cria linha `PENDING`); (b) o front envia direto ao Storage; (c) ao salvar o lançamento, a API vincula (`CONFIRMED`, preenche o dono e `confirmed_at`) **na mesma transação** da entidade. Falha de envio aparece antes de salvar.
- **RN-11.2** Tipos: `pdf, png, jpg, jpeg, heic, webp`; tamanho ≤ `attachment_max_mb` (padrão 10); ≤ `attachment_max_files` por entidade (padrão 10). Na confirmação a API lê os primeiros bytes do objeto e confere a **assinatura do arquivo** (não só a extensão): divergência → `422 ATTACHMENT_INVALID`.
- **RN-11.3** Caminho `tenants/{tenantId}/…` [DB `CHECK` de prefixo em `attachments.path`]; anexos novos usam `tenants/{tenantId}/{ano}/{attachmentId}-{nomeSeguro}` e os migrados da v1 usam `tenants/{tenantId}/{entidade}/{donoId}/{attachmentId}-{nomeSeguro}` (a verificação do banco é só o prefixo). Bucket privado.
- **RN-11.4** Leitura por **URL assinada de 15 min**, gerada sob demanda e autorizada pela permissão de leitura da entidade dona. Todo anexo já está no caminho `tenants/{tenantId}/…`; anexos migrados da v1 só ficam disponíveis depois da cópia dos arquivos (`etl/tools/copy-attachments.mjs`), e o corte exige `etl.reconcile()` sem pendência de cópia.
- **RN-11.5** Remover = `status = REMOVED` (+ `removed_at`); proibido se o dono está em mês fechado ou é baixa de conta.
- **RN-11.6** Job horário remove `PENDING` com mais de 24 h (objeto e linha).

**Back-end**
| Método | Rota | Descrição |
|---|---|---|
| POST | `/attachments/uploads` | `{ fileName, mimeType, sizeBytes }` → `201 { attachmentId, uploadUrl, expiresIn }` |
| GET | `/attachments/:id/url` | `{ url, expiresIn }` |
| DELETE | `/attachments/:id` | `204` |

A permissão de criar upload é a de escrita da entidade onde será usado (`contributions:write`, `expenses:write` ou `payables:write`), informada em `purpose` (`CONTRIBUTION|EXPENSE|PAYABLE|PAYMENT`) no corpo.

**Front-end:** componente reutilizável `FileUploader` (arrastar/selecionar, validação local de tipo e tamanho, barra de progresso, miniatura de imagem/PDF, remover, tentar novamente), emitindo `attachmentIds[]` ao formulário pai; visualizador que busca a URL assinada ao clicar (nunca guarda a URL por mais de 10 min).
**Aceite:** arquivo `.pdf` que na verdade é executável → `422 ATTACHMENT_INVALID` e nenhum lançamento é criado; lançamento salvo com 2 anexos tem os 2 `CONFIRMED`; envio abandonado some em até 25 h.

---

## 7. Features — financeiro, contas a pagar, painel e plataforma

### F12 — Saldo de abertura e fechamento mensal

**Objetivo:** fechar o mês de verdade (bloqueio + foto imutável) e encadear os saldos, corrigindo o saldo manual e o “zero silencioso” da v1.

**Modelo:** `monthly_balances` por `(tenant, year, month)` com `opening_balance`, `opening_source` (`MANUAL | CARRIED_OVER | ADJUSTED`), `adjustment_reason`, `notes`, `closing_snapshot` (jsonb gerado por `v2_month_snapshot()`), `closed_at`, `closed_by_membership_id`, `reopened_at/by`, `reopen_reason`. `CHECK`: `closed_at` e `closing_snapshot` nulos ou preenchidos juntos [DB].

**Regras**
- **RN-12.1** **Abertura encadeada:** se o mês anterior está fechado, a abertura é o `accumulated` do snapshot dele (`CARRIED_OVER`). Só o **primeiro mês de uso** (nenhum período anterior em `monthly_balances`) exige abertura `MANUAL`.
- **RN-12.2** **Ajuste manual** de abertura encadeada é permitido a `month:set-opening-balance`, exige `reason` e vira `ADJUSTED` (relatórios exibem “saldo ajustado manualmente”).
- **RN-12.3** **Fechar:** o mês anterior precisa estar fechado (ou não existir período anterior) → senão `409 PREVIOUS_MONTH_OPEN`; a abertura precisa estar definida → senão `422 OPENING_NOT_DEFINED`; o **saldo em mãos precisa ter sido informado** (0 vale; vazio não) → senão `422 CASH_ON_HAND_REQUIRED` [DB]. Em uma única transação, com `select … for update` na linha do mês: calcula o snapshot, grava `closed_at`, `closed_by_membership_id`, `closing_snapshot` e, se o mês seguinte existe, está aberto e é `CARRIED_OVER`, atualiza a abertura dele.
- **RN-12.4** **Mês fechado bloqueia** [DB]: criar/editar/cancelar contribuições e despesas com data no mês; criar/estornar pagamentos com `paid_at` no mês; alterar abertura. Erro `MONTH_CLOSED`.
- **RN-12.5** **Reabrir:** exige `reason`; permitido em ordem decrescente (`409 LATER_MONTH_CLOSED` se um mês posterior está fechado). Com `cascade=true`, apenas TENANT_ADMIN e somente se `tenant_settings.cascade_reopen`, reabre os posteriores do mais recente ao escolhido (D-01). Reabrir grava `reopened_*` e **zera `closed_at` e `closing_snapshot` juntos**.
- **RN-12.6** Nenhum relatório ou indicador usa zero quando a abertura é desconhecida: devolve `openingDefined: false` e o PDF imprime o aviso. Erros de consulta nunca viram zero.
- **RN-12.7** Indicadores com nomes e fórmulas únicos: **Saldo do mês = entradas − saídas**; **Saldo em mãos** = dinheiro físico informado (RN-12.9); **Saldo final do mês = saldo do mês + saldo em mãos**; **Saldo acumulado = abertura + saldo final do mês** (= abertura + entradas − saídas + saldo em mãos), que vira a abertura do mês seguinte (RN-12.1).
- **RN-12.9** **Saldo em mãos (dinheiro físico):** valor ≥ 0 com observação opcional, informado **antes do fechamento**, uma vez por mês (`monthly_balances.cash_on_hand`; vazio = “não informado”, 0 = informado como zero). Fica gravado com quem informou e quando, é **editável enquanto o mês está aberto** (auditado com valor anterior e novo) e **trava junto com o mês** [DB: `MONTH_CLOSED`]; reabrir o mês libera a edição. Entra no snapshot do fechamento (`cash_on_hand`, `final_balance`, `accumulated`). **Atenção ao conceito:** como o acumulado alimenta a abertura seguinte, o valor informado é o que **se soma** naquele mês (não o total do caixa físico); se o usuário informar o total do caixa todo mês, o valor se repete nos acumulados — a tela explica isso e mostra o efeito antes de gravar.
- **RN-12.8** O banco impõe as travas; a API pré-checa para devolver mensagem amigável e **traduz** o erro do banco se a pré-checagem for ultrapassada por concorrência.

**Back-end**
| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/months?year` | `expenses:read` | 12 meses: `{ year, month, status OPEN|CLOSED, openingBalance, openingSource, openingDefined, income, expense, balance, cashOnHand (null = não informado), finalBalance, accumulated, closedAt, closedBy? }` (fechados: do snapshot; abertos: calculados) |
| GET | `/months/:year/:month` | `expenses:read` | Detalhe + checagens de fechamento (`previousClosed`, `openingDefined`, `cashOnHandInformed`, `overduePayables`) |
| PUT | `/months/:year/:month/opening-balance` | `month:set-opening-balance` | `{ openingBalance, notes?, reason? }` |
| PUT | `/months/:year/:month/cash-on-hand` | `month:set-cash-on-hand` | `{ amount (≥ 0, string decimal), notes? }` → `{ cashOnHand, finalBalance, accumulated }` pré-calculados; `409 MONTH_CLOSED` se fechado |
| POST | `/months/:year/:month/close` | `month:close` | `204`; devolve `warnings[]` (ex.: contas vencidas sem baixa — não bloqueia) |
| POST | `/months/:year/:month/reopen` | `month:reopen` | `{ reason, cascade? }` |

Auditoria: `MONTH_OPENING_SET`, `MONTH_CASH_ON_HAND_SET`, `MONTH_CLOSED`, `MONTH_REOPENED` (todas com `reason` quando aplicável).

**Front-end** — `/monthly-closing`: seletor de mês/ano; cartões (Abertura, Entradas, Saídas, Saldo do mês, **Saldo em mãos** (campo editável com valor e observação, enquanto aberto), **Saldo final do mês**, Saldo acumulado) com ajuda de fórmula; *chip* de situação; **painel de checagens** (mês anterior fechado ✔/✖, abertura definida ✔/✖, **saldo em mãos informado ✔/✖**, contas vencidas ⚠); botões *Fechar* e *Reabrir* com diálogo de motivo/confirmação; diálogo de ajuste de abertura com motivo; histórico de fechamentos/reaberturas (a partir da auditoria).

**Aceite**
- Dado janeiro fechado, quando fecha fevereiro, então a abertura de fevereiro = acumulado de janeiro.
- Dado fevereiro fechado, quando se tenta reabrir janeiro sem cascata, então `409 LATER_MONTH_CLOSED`.
- Dado mês fechado, quando alguém edita via API ou SQL direto uma despesa dele, então é recusado (`MONTH_CLOSED`).
- Dado fechar sem abertura definida, então `422 OPENING_NOT_DEFINED` (nunca assume zero).
- Dado mês aberto sem saldo em mãos informado, quando fecha, então `422 CASH_ON_HAND_REQUIRED`; com 0 informado, fecha.
- Dado janeiro com abertura 100, entradas 500, saídas 400 e saldo em mãos 25,50, então saldo do mês 100,00, saldo final 125,50, acumulado 225,50 e abertura de fevereiro 225,50.
- Dado mês fechado, quando se altera o saldo em mãos (API ou SQL), então `MONTH_CLOSED`; reaberto, volta a ser editável.

---

### F13 — Relatório mensal (PDF)

**Regras:** `year`/`month` obrigatórios. Conteúdo: cabeçalho; **Entradas**, **Saídas**, **Saldo do mês**, **Saldo em mãos**, **Saldo final do mês**, **Saldo acumulado** e **Saldo de abertura** (com a marca “ajustado manualmente” ou o aviso “abertura não definida”); entradas por categoria e por meio (snapshot em mês fechado, consulta em mês aberto); despesas agrupadas por categoria com data, descrição, observação e valor e subtotal por categoria. Limites por `date` (primeiro ao último dia do mês, inclusivos). Somente `ACTIVE`.
**Back-end:** `GET /expenses/monthly-report?year&month` (`expenses-report:generate`) → PDF (direto) ou `202` conforme volume. **Front-end:** diálogo de mês/ano com baixar/pré-visualizar.
**Aceite:** as fórmulas (saldo do mês, final e acumulado) conferem com a tela de F12; mês sem despesas gera PDF com seção vazia e totais zerados **sem** esconder a abertura.

---

### F14 — Contas a pagar (cadastro)

**Regras**
- **RN-14.1** Campos: `description`, `categoryId` (**obrigatória**), `amount` (≥ 0, opcional), `type` (`MONTHLY | ONCE`), `dueDay` 1–31 (MONTHLY) ou `dueDate` (ONCE) [DB], `startDate` (padrão hoje), `endDate?`, `notes`, `active`, anexos (contrato/boleto-base).
- **RN-14.2** Editar valor/vencimento/categoria afeta **apenas ocorrências `OPEN` futuras**; pagas permanecem como estão. Cada edição incrementa `version`.
- **RN-14.3** **Tipo não muda** depois que existem ocorrências (`409 PAYABLE_TYPE_LOCKED`): cria-se outra conta (resolve a ambiguidade de “mudança de tipo” da v1).
- **RN-14.4** **Excluir** só se nenhuma ocorrência da conta tem pagamento; senão `409 HAS_PAYMENTS` e a tela oferece **inativar**. Inativar cancela (`CANCELED`, motivo “Conta inativada”) as ocorrências `OPEN` com vencimento futuro; reativar regenera pelo job/serviço.
- **RN-14.5** Vencimento mensal: dia limitado ao último dia do mês (31 → 28/29/30, ano bissexto incluso).

**Back-end** (`payables:read` para leitura, `payables:write` para escrita)
| Método | Rota |
|---|---|
| GET | `/payables` (`q, active, categoryId, page`) |
| GET | `/payables/:id` |
| POST | `/payables` |
| PUT | `/payables/:id` (com `version`) |
| PATCH | `/payables/:id/active` |
| DELETE | `/payables/:id` |

Ao criar/editar/reativar, o serviço gera as ocorrências do horizonte (F15) na mesma transação. Auditoria `PAYABLE_CREATED/UPDATED/DEACTIVATED/DELETED`.
**Front-end:** `/payables/registry` (lista de contas, alternador de ativo) e diálogo de cadastro com **pré-visualização das próximas 3 competências** e seus vencimentos (mostra o ajuste 31 → 28/29/30).
**Aceite:** conta mensal dia 31 em fevereiro de 2028 gera vencimento 29/02; excluir conta com pagamento → `409 HAS_PAYMENTS`; alterar valor não muda ocorrência paga.

---

### F15 — Ocorrências e listagem

**Modelo:** uma ocorrência por conta e competência (`unique (payable_id, competence_year, competence_month)` após o corte); `amount` previsto “congelado” na geração; status persistido `OPEN | PAID | CANCELED`.

**Regras**
- **RN-15.1** **Geração por job diário** (e ao cadastrar/editar), para o horizonte de 3 meses à frente; idempotente (`on conflict do nothing`); respeita `startDate/endDate`. **A listagem é somente leitura** (a v1 gerava durante a leitura).
- **RN-15.2** **Situação exibida:** `PAID` se paga; senão `OVERDUE` se `due_date` < hoje no fuso do tenant; senão `OPEN`; `CANCELED` à parte. O dia do vencimento é `OPEN`.
- **RN-15.3** **Listagem padrão** (sem competência): por conta, a mais antiga `OVERDUE`; senão a do mês atual; senão a do próximo mês se vence em até `payable_window_days` (padrão 10). Com `year`+`month`: competência exata.
- **RN-15.4** **Cartões** calculados sobre **todo o filtro**: *Previsto* = soma de `amount` das ocorrências; *Pago* = soma de `paid_amount` dos pagamentos `ACTIVE` (o efetivamente pago, não o cadastrado); *Em atraso*; *Em aberto*; contagens.

**Back-end** (`payables:read`)
`GET /payables/occurrences?year&month&payableId&categoryId&status=OPEN|OVERDUE|PAID|CANCELED&page&sort=dueDate|description` → item `{ id, payable:{id,description}, category, competence:{year,month}, dueDate, expectedAmount, status, payment?:{id, paidAt, paidAmount, differenceFromExpected, expenseId}, attachmentsCount }`; `meta.totals = { expected, paid, overdue, open, counts }`.

**Front-end:** `/payables` — seletor de competência (padrão mês atual), abas Todas/Abertas/Atrasadas/Pagas, **cartões de totais do filtro**, tabela com *chips* de situação, ações *Baixar* / *Desfazer* conforme situação e permissão, link para o cadastro.
**Aceite:** com 25 ocorrências no filtro e página de 10, os cartões somam as 25; ocorrência paga com valor diferente mostra “pago com diferença de R$ X”; no dia do vencimento a situação é *Aberta*.

---

### F16 — Baixa e estorno de pagamento

**Regras**
- **RN-16.1** **Baixar** (`POST …/payment`, `Idempotency-Key`): campos `paidAt` (≤ hoje, mês aberto), `paidAmount` (> 0; padrão = previsto; ausente os dois → `422`), `notes?`, `categoryId?` (padrão da conta), `attachmentIds[≥1]` (comprovante obrigatório). Numa **única transação**: bloquear a ocorrência (`for update`, deve estar `OPEN`) → criar despesa (`origin = PAYABLE`, descrição da conta + competência, valor pago, `occurred_on = paidAt`, categoria) → confirmar anexos na despesa → inserir `payments (ACTIVE)` → marcar a ocorrência `PAID`. Sem compensação manual: ou tudo, ou nada.
- **RN-16.2** Repetir a baixa de ocorrência já paga → `409 ALREADY_PAID` (índice `payments_one_active` [DB]); com a mesma `Idempotency-Key` devolve a resposta original.
- **RN-16.3** **Valor diferente do previsto** é aceito e registrado (D-04); resposta traz `differenceFromExpected`.
- **RN-16.4** **Estornar** (`POST …/payment/reverse`, `reason`): permitido enquanto o **mês da data de pagamento** está aberto (não “mês corrente da competência”, como na v1). Numa transação: `payments → REVERSED` (`reversed_at/by`, `reverse_reason`), despesa vinculada `VOIDED` (“Baixa estornada”), ocorrência `OPEN`. Histórico e anexos são **preservados**.
- **RN-16.5** **Cancelar ocorrência** (`POST …/cancel`, `reason`): só `OPEN`; para isentar uma conta sem pagar (pagamento zero não existe).
- **RN-16.6** A fonte da verdade do pagamento é **`payments`**. A ocorrência não tem `paid_at/paid_amount/expense_id` (campos da v1, convertidos em `payments` na carga); a coerência `status = PAID` ⇔ pagamento `ACTIVE` é garantida pela transação da baixa/estorno e verificada na carga e na reconciliação (`PAID_WITHOUT_VALID_PAYMENT`, `integrity.paid_occurrence_has_payment`).

**Back-end** (`payables:write`)
| Método | Rota |
|---|---|
| POST | `/payables/occurrences/:id/payment` |
| POST | `/payables/occurrences/:id/payment/reverse` |
| POST | `/payables/occurrences/:id/cancel` |

Auditoria `PAYMENT_CREATED`, `PAYMENT_REVERSED`, `OCCURRENCE_CANCELED` (inclui IDs da despesa e do pagamento).
**Front-end:** `PaymentDialog` — data (padrão hoje), **valor pago** (padrão previsto, com dica de diferença), observação, categoria pré-selecionada, `FileUploader` com mínimo de 1 comprovante (botão desabilitado sem ele); `ReverseDialog` — resumo do pagamento, aviso “a despesa gerada será cancelada”, motivo obrigatório; mensagens específicas para `MONTH_CLOSED`, `ALREADY_PAID`, `ATTACHMENT_REQUIRED`.
**Aceite**
- Baixar com 1 comprovante → existem 1 despesa `PAYABLE`, 1 pagamento `ACTIVE`, ocorrência `PAID`, comprovante `CONFIRMED` na despesa.
- Falha ao confirmar anexo → **nada** é criado (sem despesa órfã).
- Estornar pagamento de mês fechado → `409 MONTH_CLOSED`; estornar de mês aberto, mesmo de competência anterior → permitido; despesa fica `VOIDED` e o pagamento permanece no histórico.

---

### F17 — Painel

**Regras**
- **RN-17.1** Indicadores da v1 mantidos, com **definições únicas** (ícone de ajuda por cartão): entradas e saídas do período, **saldo do mês**, **saldo em mãos**, **saldo final do mês**, **saldo acumulado**.
- **RN-17.2** Meses **fechados** leem `closing_snapshot`; apenas o mês corrente é agregado ao vivo. Resultado em cache de 60 s por tenant.
- **RN-17.3** Semana começa em `tenant_settings.week_starts_on` (padrão segunda), tudo no fuso do tenant.
- **RN-17.4** Séries mensais do ano atual **e do anterior**, tanto de entradas (por `kind`, com “Pix × demais”) quanto de **saídas** (a v1 mostrava zero para as saídas do ano anterior).
- **RN-17.5** “Contribuintes do mês” usa a regra de F07; o antigo “contribuintes distintos no histórico” é removido ou rotulado `histórico`.
- **RN-17.6** Oferta de construção: total e quantidade por `category_snapshot = CONSTRUCTION_OFFERING` (não mais pela descrição exata).
- **RN-17.7** Contas: quantidade em atraso e a vencer em 7 dias (valor previsto).

**Back-end** (`dashboard:read`): `GET /dashboard/summary` → `{ period, income:{week, previousWeek, month, count…}, expense:{week, month, year}, balance:{month, cashOnHand, final, accumulated, openingDefined}, byKind:{week, previousWeek, month}, members:{active, contributorsMonth}, constructionOffering:{total, count}, payables:{overdueCount, next7DaysCount, next7DaysAmount, overdue, next7Days} }`; `overdue` e `next7Days` contêm ocorrências abertas com `{id, payableId, description, dueDate, expectedAmount}` ordenadas por vencimento, ou `null` sem `payables:read`. O vencimento de hoje até hoje + 7 dias é incluído em `next7Days`; valores não informados são `null`. `GET /dashboard/series?year` → `{ income:{current[12], previous[12], byKind}, expense:{current[12], previous[12]} }`.
**Front-end:** `/dashboard` — cartões, gráficos de barras/linhas carregados com `@defer`, *skeletons*, botão Atualizar + atualização automática a cada 5 min, atalho “Calcular taxas” (F18), estado de erro por cartão (um cartão que falha não derruba a página).
**Aceite:** saldo do painel = saldo do mês do PDF; mês fechado não varia ao editar lançamento (travado) e é lido do snapshot; série de saídas do ano anterior não é zero quando há despesas.

---

### F18 — Taxas associativas

**Regras**
- **RN-18.1** **Base** = soma dos lançamentos `ACTIVE` do mês cujo tipo tem `counts_for_fees = true` (padrão migrado da v1: dízimo e ofertas gerais; construção, missões e rendimentos ficam de fora). Resposta discrimina total e contagem **por tipo**.
- **RN-18.2** `fee_rules` por tenant: `name`, `percent` (≥ 0), `rounding`, `active`, `sortOrder`. Padrão do tenant #1: ASBARE 2% (`LEGACY_CENTS_09`) e Plano Cooperativo 5% (`HALF_UP_2`) (D-03, D-12).
- **RN-18.3** `HALF_UP_2`: `round(base × percent / 100, 2)` meio para cima; **base zero → 0,00**. `LEGACY_CENTS_09` (somente compatibilidade): arredonda a 2 casas, descarta os centavos e fixa `,09` (20,86 → 20,09; base zero → 0,09).
- **RN-18.4** Total combinado = soma dos valores finais das regras ativas. Cálculo com aritmética decimal (nunca `float`).
- **RN-18.5** É uma **consulta**: não gera despesa nem conta a pagar (botão “gerar conta” fica para a fase 2).
- **RN-18.6** O cálculo usa os lançamentos ativos do mês; como mês fechado trava os lançamentos, o valor não muda depois do fechamento. Reclassificar um tipo (`counts_for_fees`) altera o histórico calculado; por isso F05 exige confirmação e audita.

**Back-end**
| Método | Rota | Permissão |
|---|---|---|
| GET | `/fees/calculate?year&month` | `fees:calculate` → `{ period, base:{ total, byType:[{typeId, description, total, count}] }, rules:[{ruleId, name, percent, rounding, gross, final}], total }` |
| GET / PUT | `/fees/rules` | leitura `fees:calculate`; escrita `tenant-settings:write` (PUT substitui a lista) |

**Front-end:** diálogo “Taxas associativas” (a partir do painel): mês/ano, tabela de base por tipo, cartão por regra com botão **copiar** (área de transferência), total combinado; `/settings/fees` (TENANT_ADMIN) para editar regras, com aviso ao escolher `LEGACY_CENTS_09`.
**Aceite:** base zero em `HALF_UP_2` → 0,00; em `LEGACY_CENTS_09` → 0,09; oferta de construção não entra na base; construção e missões aparecem em linhas separadas, sem somar.

---

### F19 — Auditoria

**Regras**
- **RN-19.1** `audit_log` é **append-only** [DB: trigger `AUDIT_IMMUTABLE`; `ibg_api` sem `UPDATE/DELETE/TRUNCATE`], particionada por mês, gravada **na mesma transação** da operação (não existe mais “audita depois e pode falhar”).
- **RN-19.2** Campos: `actor_user_id`, `actor_membership_id`, `action`, `entity`, `entity_id`, `before`, `after`, `reason`, `request_id`, `ip`, `user_agent`, `source` (`APP | V1 | SYSTEM`). Registros da v1 têm `source = V1` e `legacy_actor_id` (resolvido para a associação por `etl.link_users()` quando o usuário foi migrado; `actor_membership_id` fica nulo para usuários não migrados).
- **RN-19.3** `reason` é obrigatório em cancelamentos, estornos, reaberturas, ajuste de abertura e mudança de perfis/status.
- **RN-19.4** Nunca gravar senha, token ou segredo; `before/after` mascaram documento e e-mail quando o tenant ativar a opção. Registros migrados da v1 podem conter dados pessoais: revisar antes de abrir a tela a outros perfis.
- **RN-19.5** Retenção ≥ 5 anos (D-05); job garante partições dos próximos 3 meses.

**Back-end** (`audit:read`): `GET /audit` (filtros `from, to, actorMembershipId, entity, action, entityId`, paginação **por cursor** `(created_at, id)`), `GET /audit/:id`, `GET /audit/export` (CSV, assíncrono acima de 10 000 linhas). `AuditService.record({ action, entity, entityId, before, after, reason })` recebe a transação corrente.
**Front-end:** `/audit` — filtros, tabela com rolagem por cursor, *drawer* com diferença antes/depois (chaves alteradas em destaque), exportar.
**Aceite:** reabrir mês gera registro com o motivo; tentativa de `UPDATE audit_log` com `ibg_api` falha; operação que falha na transação não deixa registro de auditoria.

---

### F20 — Notificações e jobs

**Regras**
- **RN-20.1** **Outbox transacional:** eventos (`outbox_events`) são gravados na transação de negócio e entregues por job, **pelo menos uma vez**; o handler é idempotente pelo `id` do evento; até 5 tentativas com recuo exponencial; `last_error` registrado; esgotadas → fila de falhas (*dead-letter*) com alerta.
- **RN-20.2** Eventos/e-mails: convite, reenvio de convite, conta a vencer (`payable_alert_days`, padrão 3) e resumo de atrasadas, exportação pronta, mudança de status do tenant. E-mails de autenticação (confirmação, recuperação) saem pelo Supabase Auth configurado com o mesmo provedor SMTP. Destinatários de alertas de contas: usuários com `payables:write`.
- **RN-20.3** Falha de e-mail nunca deixa usuário “criado pela metade” (v1): convite é reenviável.

**Jobs** (pg-boss; worker no mesmo processo no início, separável com `WORKER=true`)
| Job | Frequência | Observação |
|---|---|---|
| `notifications.dispatch-outbox` | a cada 10 s | entrega e retentativas |
| `payables.generate-occurrences` | diário | por tenant, horizonte de 3 meses, idempotente |
| `payables.notify-due` | de hora em hora | envia só para tenants em que são 08:00 locais |
| `attachments.cleanup-pending` | de hora em hora | `PENDING` > 24 h (objeto + linha) |
| `idempotency.cleanup` | diário | chaves > 48 h |
| `audit.ensure-partitions` | diário | `v2_ensure_audit_partition` para os próximos 3 meses |
| `reports.generate-pdf` | sob demanda | resultado no Storage com URL assinada |
| `members.import` / `tenant.export` | sob demanda | progresso consultável por `jobId` |
| `tenants.retention-sweep` | diário | anonimiza tenants `CANCELLED` > 90 dias (`MaintenanceDb`) |

Jobs por tenant usam `withTenantTx`; manutenção entre tenants usa `MaintenanceDb` (§4.3).

---

### F21 — Console do ADMIN global (plataforma)

**Objetivo:** o ADMIN global administra o **sistema** — igrejas, acessos de TENANT_ADMIN, status e outros ADMINs globais — **sem enxergar dados internos das igrejas**.

**Regras**
- **RN-21.1** `/platform/*` usa `PlatformAdminGuard`: usuário com linha **ACTIVE** em `platform_admins` **e** `aal2` (MFA); IP permitido opcional. Módulo Angular isolado (`/platform`, lazy, shell próprio), fora do menu das igrejas. Todas as chamadas passam por `PlatformDb` (role `ibg_platform`, §4.3).
- **RN-21.2** **O ADMIN global não vê dados internos.** Vê: slug, nome, status, fuso, datas, **contadores de uso** (usuários ativos, membros ativos, bytes de anexos) e se a igreja tem TENANT_ADMIN ativo/convite pendente. **Não vê**: membros, contribuições, despesas, contas, saldos, anexos, auditoria da igreja, e-mails dos usuários da igreja. Garantia no banco (o role não tem GRANT nas tabelas), verificada por teste. **Não existe “visualizar como” nem impersonação.**
- **RN-21.3** **Criar igreja** informa `slug`, `name`, `document?`, `timezone?` e o futuro TENANT_ADMIN (`email`, `name`). Resultado: tenant `TRIAL` semeado + **link de convite** (perfil único TENANT_ADMIN, 7 dias) mostrado **uma única vez**.
- **RN-21.4** **Recuperação:** novo convite de TENANT_ADMIN só é aceito pelo banco se a igreja **não tem** TENANT_ADMIN ativo (`TENANT_HAS_ADMIN` caso contrário); o convite pendente anterior é revogado; ação auditada na plataforma e no `audit_log` da igreja. Esse é o único ponto em que a plataforma toca o acesso de uma igreja.
- **RN-21.5** **Status da igreja** (`TRIAL/ACTIVE/PAST_DUE/SUSPENDED/CANCELLED`, §4.2) muda com **motivo obrigatório** (≥ 5 caracteres, `REASON_REQUIRED`), auditado; `CANCELLED` é irreversível (`TENANT_CANCELLED`). Suspender/reativar avisa o TENANT_ADMIN por e-mail (via outbox, sem expor o console).
- **RN-21.6** **ADMINs globais** são adicionados, suspensos e removidos **apenas por funções** (a tabela é somente leitura para o console), sempre auditados; a plataforma nunca fica sem ADMIN ativo (`LAST_PLATFORM_ADMIN`). O primeiro ADMIN é criado manualmente (runbook §3.4); uma pessoa nova entra por convite do Auth (e-mail com definição de senha) e tem de cadastrar MFA.
- **RN-21.7** ADMIN global **não é membro de igreja** (RN-5.7) e não pode usar rotas de igreja só por ser ADMIN.

**Back-end** (todas exigem `PlatformAdminGuard`; sem `X-Tenant-Id`)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/platform/tenants` | `status, q, page`; itens com os contadores da RN-21.2 (`v2_platform_list_tenants`) |
| POST | `/platform/tenants` | `{ slug, name, document?, timezone?, admin:{ name, email } }` → `201 { tenantId, invitation:{ id, link, expiresAt } }` (`link` só nesta resposta). `SLUG_TAKEN` |
| GET | `/platform/tenants/:id` | Metadados + contadores + convite de TENANT_ADMIN pendente (id, e-mail, validade) |
| POST | `/platform/tenants/:id/admin-invitations` | `{ email, name }` → novo link (RN-21.4); `409 TENANT_HAS_ADMIN` |
| DELETE | `/platform/admin-invitations/:invitationId` | Revoga o convite pendente de TENANT_ADMIN |
| POST | `/platform/tenants/:id/status` | `{ status, reason }` |
| GET | `/platform/admins` | Lista (`userId, email, status, createdAt`) |
| POST | `/platform/admins` | `{ email, name }`: cria o usuário no Auth (convite com definição de senha) e chama `v2_platform_add_admin`; falha → compensação |
| PATCH | `/platform/admins/:userId/status` | `{ status: ACTIVE|SUSPENDED }` |
| DELETE | `/platform/admins/:userId` | Remove da plataforma (não apaga o usuário do Auth) |
| GET | `/platform/audit` | `platform_audit_log` (ação, autor, igreja, detalhe), paginado, somente leitura |

**Front-end** (`/platform`): painel com tabela de igrejas (filtro por status, contadores, selo “sem TENANT_ADMIN”); assistente **Nova igreja** (dados → administrador → tela “Link do convite” com botão copiar e aviso de exibição única); detalhe da igreja (metadados, uso, convite pendente com reemitir/revogar, histórico de status); diálogos de status com motivo obrigatório; aba **Administradores** (lista, convidar, suspender, remover; desabilita ações sobre si mesmo e sobre o último ativo); aba **Auditoria**. Nenhuma tela mostra dado de negócio da igreja.

**Aceite**
- Usuário comum (inclusive TENANT_ADMIN) chamando `/platform/*` → `403`; ADMIN global chamando rota de igreja sem associação → `403`.
- Como `ibg_platform`, `select` em qualquer tabela de negócio → `permission denied` (teste `35_assert_platform`, 21 tabelas).
- Convite de TENANT_ADMIN só é emitido na criação ou com a igreja sem TENANT_ADMIN ativo; emissão aparece no `audit_log` da igreja e no `platform_audit_log`.
- Suspender o único ADMIN global ativo ou removê-lo → `409 LAST_PLATFORM_ADMIN`.

---

### F22 — Cobrança e planos (fase posterior)

**Fora das migrations atuais** — exige nova migration (`plans`, `subscriptions`, `usage_counters`) antes da implementação.
**Escopo mínimo:** planos com limites (membros, usuários, armazenamento); assinatura por tenant; *webhook* do provedor (`POST /billing/webhooks/:provider`, assinatura verificada, idempotente por `event_id`); mapeamento `trial → TRIAL`, pago → `ACTIVE`, atraso → `PAST_DUE` (carência) → `SUSPENDED`; aplicação de limites com `402 PLAN_LIMIT_REACHED`; tela de plano e faturas na igreja; job `tenants.trial-expiry`. Provedor a definir (Asaas, Pagar.me ou Stripe).

---

## 8. Mapa v1 → v2 das rotas (para a migração do front e de integrações)

| v1 | v2 |
|---|---|
| `POST /auth/login`, `/auth/password/*` | Supabase Auth (front) + `GET /me` |
| `/users` (CRUD) | `/users`, `/users/invitations`, `/users/:membershipId/roles|status` |
| `/members`, `/members/paginated`, `/members/search` | `GET /members` (+ `/members/lookup`) |
| `/members/contributors/*` | igual (`/members/contributors/month|year|year/report`) |
| `/domain/{payment-methods,contribution-types,member-types,expense-categories}` | `/catalogs/…` |
| `/contributions/paginated`, `/weekly/report` | `GET /contributions`, `GET /contributions/report` |
| `DELETE /contributions/:id` | `POST /contributions/:id/void` |
| `/expenses/paginated`, `/monthly/report` | `GET /expenses`, `GET /expenses/monthly-report` |
| `/expenses/monthly/opening-balance[/close|/reopen]` | `/months/:year/:month/{opening-balance,close,reopen}` |
| `/payables/paginated`, `POST /payables/:id/payments`, `DELETE /payables/:id/payments` | `GET /payables/occurrences`, `POST …/payment`, `POST …/payment/reverse` |
| `/dashboard/summary`, `/payment-methods`, `/collection-percentage` | `/dashboard/summary`, `/dashboard/series`, `/fees/calculate` |

---

## 9. Catálogo de erros

| Código | HTTP | Quando |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Corpo/parâmetros inválidos (Zod), com `errors[]` por campo |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | `POST` financeiro sem chave |
| `UNAUTHENTICATED` | 401 | JWT ausente/inválido/expirado |
| `FORBIDDEN` | 403 | Sem a permissão da rota |
| `MFA_REQUIRED` | 403 | Perfil exige MFA e o JWT não é `aal2` |
| `MEMBERSHIP_INACTIVE` | 403 | Associação não `ACTIVE` |
| `SELF_CHANGE_FORBIDDEN` | 403 | Alterar os próprios perfis/status |
| `INVITATION_EMAIL_MISMATCH` | 403 | E-mail do convite ≠ e-mail do usuário |
| `PLATFORM_FORBIDDEN` | 403 | Quem chama `/platform/*` não é ADMIN global ativo (a API responde `FORBIDDEN`) |
| `NOT_FOUND` | 404 | Inclui recurso de outro tenant |
| `INVITATION_EXPIRED` | 410 | Convite vencido, revogado ou já usado (o `status` da prévia detalha) |
| `SLUG_TAKEN`, `DUPLICATE_DESCRIPTION`, `DUPLICATE_PERIOD` | 409 | Unicidade |
| `POSSIBLE_DUPLICATE` | 409 | Membro parecido existe (`candidates[]`) |
| `IN_USE`, `HAS_PAYMENTS`, `MEMBER_HAS_ACCESS` | 409 | Exclusão bloqueada por vínculo |
| `LAST_TENANT_ADMIN` | 409 | A igreja ficaria sem TENANT_ADMIN ativo |
| `LAST_PLATFORM_ADMIN` | 409 | A plataforma ficaria sem ADMIN global ativo |
| `TENANT_HAS_ADMIN` | 409 | Convite de TENANT_ADMIN pela plataforma, mas a igreja já tem um ativo |
| `TENANT_CANCELLED_IRREVERSIBLE` | 409 | Tentativa de mudar o status de igreja cancelada |
| `REASON_REQUIRED` | 422 | Motivo ausente/curto (mudança de status) |
| `MONTH_CLOSED` | 409 | Operação em mês fechado |
| `PREVIOUS_MONTH_OPEN`, `LATER_MONTH_CLOSED` | 409 | Ordem de fechamento/reabertura |
| `STALE_VERSION` | 409 | Edição sobre versão antiga |
| `EXPENSE_FROM_PAYABLE` | 409 | Alterar despesa gerada por baixa |
| `ALREADY_PAID`, `OCCURRENCE_NOT_OPEN`, `NOT_PAID` | 409 | Estado inválido da ocorrência |
| `PAYABLE_TYPE_LOCKED` | 409 | Mudar tipo de conta com ocorrências |
| `MEMBER_REQUIRED`, `INVALID_REFERENCE`, `FUTURE_DATE_NOT_ALLOWED` | 422 | Regra de negócio |
| `OPENING_NOT_DEFINED`, `ADJUSTMENT_REASON_REQUIRED`, `CASH_ON_HAND_REQUIRED` | 422 | Fechamento/abertura/saldo em mãos |
| `ATTACHMENT_INVALID`, `ATTACHMENT_LIMIT`, `ATTACHMENT_REQUIRED` | 422 | Anexos |
| `IDEMPOTENCY_KEY_REUSED`, `REPORT_RANGE_TOO_LARGE` | 422 | — |
| `TENANT_SUSPENDED`, `TENANT_CANCELLED` | 423 | Status do tenant (§4.2) |
| `RATE_LIMITED` | 429 | Limite de taxa |
| `PLAN_LIMIT_REACHED` | 402 | Fase de cobrança |
| `INTERNAL` | 500 | Inesperado (sem detalhes ao cliente; `requestId` para suporte) |

---

## 10. Eventos de auditoria (`audit_log.action`)

`TENANT_CREATED (gravado pela plataforma na criação), TENANT_UPDATED, TENANT_SETTINGS_UPDATED, TENANT_EXPORT_REQUESTED, TENANT_CANCEL_REQUESTED` · `PROFILE_UPDATED` · `INVITATION_CREATED, INVITATION_RESENT, INVITATION_REVOKED, INVITATION_ACCEPTED, MEMBERSHIP_ROLES_CHANGED, MEMBERSHIP_STATUS_CHANGED` · `CATALOG_CREATED, CATALOG_UPDATED, CATALOG_DEACTIVATED, CATALOG_DELETED` · `MEMBER_CREATED, MEMBER_UPDATED, MEMBER_DELETED, MEMBER_IMPORTED` · `CONTRIBUTION_CREATED, CONTRIBUTION_UPDATED, CONTRIBUTION_VOIDED` · `EXPENSE_CREATED, EXPENSE_UPDATED, EXPENSE_VOIDED` · `ATTACHMENT_REMOVED` · `MONTH_OPENING_SET, MONTH_CASH_ON_HAND_SET, MONTH_CLOSED, MONTH_REOPENED` · `PAYABLE_CREATED, PAYABLE_UPDATED, PAYABLE_DEACTIVATED, PAYABLE_DELETED` · `PAYMENT_CREATED, PAYMENT_REVERSED, OCCURRENCE_CANCELED` · `FEE_RULES_UPDATED` · `TENANT_CANCEL_REQUESTED` · **`platform_audit_log.action`** (log próprio e append-only da plataforma; os eventos que tocam uma igreja também vão ao `audit_log` dela): `platform.tenant.created, platform.tenant.admin_invitation_issued, platform.tenant.admin_invitation_revoked, platform.tenant.status_changed, platform.admin.added, platform.admin.status_changed, platform.admin.removed`.

---

## 11. Estratégia de testes

| Camada | O que cobre | Ferramentas |
|---|---|---|
| Banco e carga | Esquema final; preflight que **bloqueia** dado inválido; carga; usuários; reconciliação; guards, RLS, último TENANT_ADMIN/ADMIN global, separação ADMIN global × TENANT_ADMIN (`ibg_platform` sem acesso a dados de negócio), convite por link, auditoria imutável; reset + recarga idempotentes; ausência de resquícios de coexistência | `etl/tests/run.sh` (já existente; 10 etapas) |
| Domínio (unitário) | Mês fechado, obrigatoriedade de membro, arredondamento (`HALF_UP_2`, `LEGACY_CENTS_09`, base zero), vencimento 31 → fevereiro/bissexto, situação de ocorrência, permissões por união de perfis | Vitest/Jest, ≥ 90% nas regras financeiras |
| Integração (API + banco real) | Cada caso de uso numa transação, RLS ativa, traduções de erro do banco | Banco com as migrations finais (`supabase/migrations/`), sem camada de coexistência; `pnpm test:db` aplica as 10 migrations num Postgres descartável |
| Isolamento entre tenants | §4.4 | Obrigatória; bloqueia o merge |
| Contrato | OpenAPI gerado = cliente commitado | CI |
| E2E (Playwright) | Login → contribuição → despesa → fechar mês → baixar conta → estornar → relatório; um fluxo por perfil | Playwright |
| Homologação | Os 12 cenários do Apêndice F, ajustados às decisões do §1, executados em staging com dados migrados | Roteiro manual + automação parcial |
| Carga | 50 usuários simultâneos no painel e listagens com 1 M de linhas financeiras | k6 |

**Pipeline de CI:** lint → testes de domínio → `etl/tests/run.sh` → integração → isolamento → geração/verificação do OpenAPI → build back/front → E2E em staging.

---

## 12. Definição de pronto (por feature)

1. Regras RN-x implementadas e cobertas por teste unitário; travas [DB] cobertas por teste de integração.
2. Endpoints no OpenAPI com exemplos e códigos de erro; cliente regenerado.
3. Permissões declaradas em `permissions.ts` e conferidas por teste (cada perfil × rota).
4. Escrita auditada na mesma transação; `reason` onde exigido.
5. Totais e paginação sobre todo o filtro; dinheiro como string decimal; datas no fuso do tenant.
6. Front: estados de carregando, vazio, erro e sem permissão; teclado e leitor de tela (WCAG AA); *responsivo* até 360 px.
7. Teste de isolamento entre tenants para as rotas novas; E2E do fluxo principal.
8. Sem consulta fora de `withTenantTx`; sem `service_role` na API.

---

## 13. Ordem de construção

| Etapa | Entregas | Depende de |
|---|---|---|
| **0 — Fundação** | Repositório, CI (`etl/tests/run.sh`), F00, banco de staging com as migrations aplicadas, suíte de isolamento esqueleto | — |
| **1 — Acesso** | F02 (login, aceite de convite, MFA), F04, F01 (configurações da igreja), F03; mínimo de F21 para **criar a primeira igreja e o convite** (sem ele ninguém entra) | 0 |
| **2 — Cadastros** | F05, F06, F07, F11 (anexos) | 1 |
| **3 — Financeiro** | F08, F10, F12, F13, F09 | 2 |
| **4 — Contas** | F14, F15, F16 | 3 |
| **5 — Visão e controle** | F17, F18, F19, F20 | 3–4 |
| **6 — Migração e piloto** | Ensaios repetidos da carga em staging com dumps reais (runbook §3.4, `etl.reconcile()` sem divergência), homologação, piloto com 1–2 igrejas, corte (`etl/run.sh freeze`) | 1–5 |
| **7 — Plataforma** | F21 completo (administradores, auditoria, painel de uso), F22 (nova migration), limites por plano, exportação/LGPD completas | 6 |

**Reconciliação (critério de aceite do corte):** `etl.reconcile()` já automatiza contagens, somas e diferenças por mês/tipo/membro/categoria; o que ela não cobre é conferido à mão. Diferença zero, ou explicada e documentada, em: contagem por tabela; soma de contribuições por mês × tipo × meio; soma de despesas por mês × categoria (tolerância R$ 0,01 por linha pelo tipo `real`); saldo do mês de todos os meses; contribuintes por mês e ano; base de taxas por mês; ocorrências por situação em data fixa; anexos (contagem, tamanho e amostra de download); usuários ativos × associações com perfis. Dois PDFs históricos comparados lado a lado.

---

## 14. Pendências abertas

| # | Pendência | Quem decide | Bloqueia |
|---|---|---|---|
| 1 | Como a v1 gravou `contributions.date` (query G.2) → `etl.config.contribution_date_mode` | Negócio + dados | Carga (`etl.load()`) |
| 2 | Origem do arredondamento “,09” da ASBARE | Tesouraria | Corte (D-03) |
| 3 | Mapeamento ASBARE = 2% / Plano Cooperativo = 5% (D-12) | Tesouraria | F18 |
| 4 | Definir como o Supabase novo expõe o role `ibg_api` (senha, pooler) e apontar `DATABASE_URL` da API | Dev/Infra | Etapa 0 |
| 5 | Constraints/triggers/colunas reais da v1 (R-01): comparar com a fixture e ajustar `etl/` | Dev | Primeiro ensaio com dump real |
| 6 | Revisão dos catálogos derivados do texto (`etl.catalog_review`, R-02) | Tesouraria | Corte |
| 7 | Revisar aberturas de saldo ≠ fechamento anterior (`MONTH_OPENING_NOT_CHAINED`) | Tesouraria | Corte (aviso) |
| 8 | Despesas ≥ R$ 131.072 vindas de `real` (`REAL_PRECISION_RISK`) | Tesouraria | Corte (aviso) |
| 9 | Provedor de e-mail transacional; provedor de cobrança; hospedagem da API/worker | Produto/Infra | F20, F22 |
| 10 | Perfis customizáveis por tenant (hoje 5 perfis fixos) | Produto | Fase futura |
| 11 | Plano para os avisos da carga que o preflight só sinaliza (e-mail inválido, valor com mais de 2 casas, membro sem tipo, lançamento sem membro em tipo que exige) | Tesouraria/Secretaria | Corte (aviso) |
| 12 | Política de retenção/anonimização por tenant cancelado (prazo e escopo) e termos LGPD | Jurídico | F01, F21 |
| 13 | Confirmar que o ADMIN global vê só metadados e contadores de uso (D-21) e a regra de recuperação de igreja sem TENANT_ADMIN (D-22) | Produto | F21 |
| 14 | Envio do link de convite: só cópia manual ou também e-mail transacional (o token não pode ficar gravado em claro no outbox) | Produto/Dev | F02, F04, F21 |

---

## Apêndice A — Exemplo de contrato (contribuição)

`POST /v1/contributions` · headers: `Authorization`, `X-Tenant-Id`, `Idempotency-Key: 6f1c…`

```json
{
  "contributionTypeId": "c0f9…",
  "paymentMethodId": "a3d1…",
  "amount": "250.00",
  "occurredOn": "2026-11-08",
  "memberId": "9b52…",
  "observation": "Dízimo de novembro",
  "attachmentIds": ["e7a4…"]
}
```

`201`
```json
{
  "id": "5d2b…", "occurredOn": "2026-11-08", "amount": "250.00",
  "member": { "id": "9b52…", "name": "Maria Souza" },
  "type": { "id": "c0f9…", "description": "Dízimo", "category": "TITHE" },
  "method": { "id": "a3d1…", "description": "Pix", "kind": "PIX" },
  "observation": "Dízimo de novembro", "status": "ACTIVE", "attachmentsCount": 1, "version": 1
}
```

Erro (mês fechado):
```json
{ "type": "https://api.ibg/errors/month-closed", "title": "Mês fechado", "status": 409,
  "code": "MONTH_CLOSED", "detail": "O mês 11/2026 está fechado.", "requestId": "01J…" }
```

## Apêndice B — Estado da validação deste pacote

| Item | Situação |
|---|---|
| 10 migrations finais aplicadas em banco vazio | **Executadas** em PostgreSQL 16 (com *stubs* de `auth.users` e dos roles do Supabase) |
| Equivalência com o esquema pós-contract do fluxo arquivado | **Comparada** (colunas, funções, triggers): só diferem o que é intencional (colunas legadas e funções de coexistência removidas; `NOT NULL` mais estritos; `created_at` nos catálogos) |
| Carga completa (`etl/tests/run.sh`, 10 etapas) | **Executada com sucesso**: preflight bloqueia valor zero e nada é gravado; carga; asserts de conversão (fuso, `real`, VOIDED, snapshots, pagamentos, anexos, auditoria); usuários; reconciliação sem divergência; guards (`MONTH_CLOSED`, `DELETE_FORBIDDEN`, `MEMBER_REQUIRED`, `LAST_TENANT_ADMIN`, `AUDIT_IMMUTABLE`); RLS entre dois tenants com o role `ibg_api`; **saldo em mãos** (obrigatório para fechar, não negativo, soma no saldo final e no acumulado, trava com o mês); **etapa 7b (`35_assert_platform`)**: criação de igreja só pelo ADMIN global, `ibg_platform` negado em 21 tabelas de negócio e nos schemas `legacy`/`etl`, `ibg_api` sem acesso às funções de plataforma, convite por link (prévia, aceite, uso único, e-mail diferente, revogado, vencido, igreja suspensa/cancelada), `TENANT_HAS_ADMIN`, convite da plataforma limitado a TENANT_ADMIN, TENANT_ADMIN sem poder alterar `status`/`slug`/criar igreja/ler `platform_audit_log`/forjar convite da plataforma, gestão de ADMINs globais só por função, `LAST_PLATFORM_ADMIN`; reset + recarga idempotentes; `freeze` |
| Erros de unaccent em índice e precisão de `real::numeric` | **Verificados** em PostgreSQL 16 |
| Fluxo in-place anterior (`archive/inplace-expand/`) | Passou na bateria própria antes de ser arquivado; **não faz parte da estratégia atual** |
| `etl/tools/migrate-users.mjs`, `copy-attachments.mjs`, `etl/load-legacy.sh` | Revisados, **não executados** (exigem Supabase/Storage e dump reais) |
| Esquema real da v1 | **Não visto**: os testes usam um esquema reconstruído da listagem de colunas (R-01) |
| Roles `ibg_api` e `ibg_platform` (senhas, pooler), `enable_signup = false` e criação de usuário pela API admin do Auth em Supabase hospedado | **Não testados** (ensaiar em staging) |
| Endpoints, telas e regras das features | Especificação; **não há código de back/front** neste pacote |


## Apêndice C — Visão, princípios e decisões de arquitetura

A v2 deixa de ser “o sistema de uma igreja” e passa a ser uma **plataforma SaaS**: cada igreja (tenant) tem dados, usuários, parâmetros e regras isolados.

**Princípios**

1. **Isolamento primeiro.** Nenhum dado de uma igreja pode ser lido ou alterado por outra; garantido em duas camadas (aplicação + RLS no banco).
2. **Regras explícitas, não textuais.** Nada de descobrir “dízimo” ou “Pix” pelo texto da descrição: catálogos têm atributos tipados.
3. **Histórico financeiro imutável.** Lançamentos não são apagados; são cancelados/estornados, com auditoria.
4. **Servidor é a fonte da verdade.** Validações, totais e permissões vivem no back-end; o front reflete.
5. **Monólito modular.** Um deploy NestJS com módulos delimitados; microserviços só com necessidade comprovada.
6. **Escala por desenho, não por reescrita.** Toda tabela de negócio nasce com `tenant_id` e índices compostos; tarefas pesadas vão para fila.
7. **LGPD desde o início.** Dados de membros de igreja revelam convicção religiosa, dado pessoal sensível (art. 5º, II, LGPD).

**Decisões de arquitetura (complementam D-13 a D-17 do §1)**

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| A-01 | Estilo | Monólito modular NestJS | Equipe pequena, deploy simples, fronteiras claras para extrair depois |
| A-02 | Multi-tenancy | Banco único, schema único, `tenant_id` em todas as tabelas + RLS | Menor custo operacional; escala para milhares de igrejas pequenas |
| A-03 | Acesso ao Postgres | Conexão direta via pooler (Supavisor, *transaction mode*) com `set_config('app.tenant_id', …, true)` por transação | O `supabase-js` com *service role* **ignora RLS**; a conexão direta permite RLS real como defesa em profundidade |
| A-04 | Identidade | Supabase Auth (e-mail/senha, convite, recuperação, MFA) | Remove código próprio de senha/hash/token; convite substitui “senha temporária por e-mail” |
| A-05 | Autorização | Perfis → permissões `recurso:ação`, resolvidas **no servidor a cada requisição** (cache curto) | Corrige o perfil desatualizado no JWT da v1 e permite vários perfis |
| A-06 | Seleção de tenant | Header `X-Tenant-Id` validado contra as associações; subdomínio `igreja.app.com` escolhe o tenant no front | Um usuário pode pertencer a várias igrejas |
| A-07 | Jobs | `pg-boss` (fila sobre Postgres) | Sem Redis no início; migrável para BullMQ |
| A-08 | Arquivos | Upload direto ao Storage por URL assinada, caminho prefixado por tenant | Tira tráfego pesado do back-end; isolamento por prefixo |
| A-09 | Contrato | OpenAPI gerado pelo Nest; cliente Angular gerado | Evita divergência front/back (problema recorrente na v1) |
| A-10 | Dinheiro | `numeric(14,2)` no banco, string decimal na API; nunca `float` | Precisão financeira |
| A-11 | Datas | `date` para datas de negócio; fuso por tenant (padrão `America/Sao_Paulo`) | Elimina a mistura UTC/local da v1 |

**Modelo de tenant.** Tenant = igreja/organização (slug único, nome, CNPJ opcional, fuso, status). Usuário é global (identidade única por e-mail); o vínculo é a **associação** (`tenant_memberships`) com os perfis. Membro pertence a um único tenant (a mesma pessoa em duas igrejas são dois membros). Acima dos tenants existe o **ADMIN global** (`platform_admins`), com console próprio (F21), que administra a plataforma **sem acesso aos dados internos** das igrejas; dentro de cada igreja o nível máximo é o **TENANT_ADMIN** (D-20). Não há autocadastro: todo acesso vem de convite por link (D-19).

**Resolução do tenant em cada requisição.** (1) O front resolve o slug pelo subdomínio (`GET /v1/public/tenants/by-slug/{slug}`: só nome e logo). (2) Toda chamada autenticada envia `X-Tenant-Id`. (3) O `TenantGuard` confirma associação ativa e status do tenant que permita a operação. (4) O contexto (`tenantId`, `userId`, `membershipId`, perfis, permissões) vive em `AsyncLocalStorage`. (5) A camada de dados abre a transação e executa `set_config('app.tenant_id', …, true)`; a RLS passa a valer (§2.3).

## Apêndice D — Ciclo de vida, LGPD, auditoria, segurança e continuidade

**Ciclo de vida do tenant** (comportamento por status no §4.2). `TRIAL` (uso completo por N dias, padrão 30) → `ACTIVE` → `PAST_DUE` (aviso e carência) → `SUSPENDED` (leitura e exportação) → `CANCELLED` (dados retidos 90 dias, depois anonimização/exclusão — D-05). **Onboarding:** **não há cadastro público**. O ADMIN global cria a igreja no console (semeia catálogos, configurações e taxas) e entrega o **link de convite** do primeiro TENANT_ADMIN; os demais usuários entram **só por convite** do TENANT_ADMIN (F01, F04, F21). **Exportação:** o TENANT_ADMIN exporta todos os dados da igreja (CSV/ZIP) a qualquer momento.

**LGPD.** O tenant é o controlador; a plataforma é operadora. Registro de tratamento e base legal por finalidade; **consentimento** para dados sensíveis (`members.consent_at`); direito de acesso, correção e eliminação (rotina de **anonimização de membro** preservando os totais financeiros); mapeamento dos operadores (Supabase, provedor de e-mail, hospedagem); política de privacidade e termos por tenant; comunicação à ANPD e aos titulares em incidente. Exclusão de membro com histórico é **sempre lógica**; a anonimização ocorre por pedido.

**Auditoria** (F19, §10). Append-only, na mesma transação da operação, retenção mínima de 5 anos (D-05), particionada por mês; arquivamento a frio (Storage/Parquet) após 24 meses; `reason` obrigatório em cancelamentos, reaberturas, ajustes de saldo e mudança de perfis; redação de dados sensíveis (senhas nunca existem ali).

**Notificações.** Outbox transacional (F20): e-mail de convite, recuperação, conta vencendo e exportação pronta; falha de e-mail nunca deixa usuário “criado pela metade” (convite reenviável).

**Segurança.** Meta OWASP ASVS nível 2; RLS ativa; segredos em gerenciador (nunca no repositório); CORS restrito ao domínio e subdomínios de tenants; `helmet` e CSP; *rate limiting*; dependências auditadas (Dependabot/Renovate); log de acesso a dados sensíveis; **pentest antes de abrir para terceiros**; política de resposta a incidentes.

**Continuidade.** PITR do Supabase; teste de restauração trimestral; **RPO ≤ 15 min, RTO ≤ 4 h**; backup lógico semanal em armazenamento independente; exportação por tenant como camada extra. **Ambientes:** local (Supabase CLI), `dev`, `staging` (dados sintéticos ou dump anonimizado), `prod`; dados reais de produção nunca em ambientes inferiores, **exceto no ensaio da carga (§3.4), que usa dump real em ambiente restrito e descartável**.

## Apêndice E — Planejamento de escala

**Volume de referência.** Igreja média: ~300 membros ativos, ~1.500 contribuições/mês, ~150 despesas/mês, ~10 anexos/semana → ~20 mil linhas financeiras/ano e ~50 MB de anexos/ano por tenant.

| Tenants | Linhas financeiras/ano | Anexos/ano | Usuários simultâneos (pico) |
|---|---|---|---|
| 100 | 2 M | 5 GB | ~30–60 |
| 1.000 | 20 M | 50 GB | ~300–600 |
| 10.000 | 200 M | 500 GB | ~3.000–6.000 |

O tráfego é **concentrado** (pós-culto, fechamento de mês, vencimentos): planejar para pico de 5 a 10 vezes a média.

| Estágio | Tenants | Infraestrutura | Gatilho para avançar |
|---|---|---|---|
| **0 — Lançamento** | 1–50 | Supabase Pro (compute small/medium); Nest em 2 instâncias (container); CDN para o Angular; worker no mesmo processo | p95 > 500 ms ou CPU do banco > 60% sustentada |
| **1 — Crescimento** | 50–500 | Compute maior; pooler em *transaction mode*; Nest com autoscaling horizontal (stateless); **worker separado**; cache (Redis/Upstash) para painel e `/me`; PITR | Relatórios lentos; > 70% das conexões do pool |
| **2 — Escala** | 500–5.000 | **Réplica de leitura** para relatórios/painel/PDF; agregados incrementais além de `monthly_balances`; partição de `audit_log` e, se necessário, de `contributions`/`expenses` por hash de `tenant_id` ou por data; cotas por tenant; filas dedicadas por tipo de job | Tabelas > 100–200 M de linhas; contenção em tenants grandes |
| **3 — Hiperescala** | 5.000+ | **Células** (várias instâncias do banco, `tenant_directory` mapeia tenant → célula); tenants grandes em banco dedicado; roteamento por célula na API | Limite de um cluster Postgres ou requisito contratual de isolamento |

| Gargalo | Mitigação |
|---|---|
| Conexões ao Postgres | Pooler em *transaction mode*; pool pequeno por instância; `set_config(…, true)` dentro da transação (compatível) |
| Agregações do painel/relatórios | `closing_snapshot` dos meses fechados; só o mês corrente ao vivo; índices `(tenant_id, occurred_on)`; cache de 60 s por tenant; réplica de leitura |
| PDF (CPU/memória) | Worker dedicado, limite de concorrência, resultado no Storage com link assinado; `pdfmake` (sem Chromium) |
| Vizinho barulhento | `ThrottlerGuard` por tenant, cotas por plano, `statement_timeout`, filas com limites por tenant |
| Crescimento de auditoria | Partição mensal; arquivamento a frio após 24 meses |
| Anexos | Lifecycle no Storage; compressão de imagens no upload (job); cota por plano |
| Picos de segunda-feira/fechamento | Autoscaling por CPU/latência (mínimo 2 instâncias); jobs pesados fora do horário comercial |
| Migrações em tabelas grandes | Expand/contract, `CREATE INDEX CONCURRENTLY`, lotes |
| RLS e desempenho | Policies simples (`tenant_id = app_tenant_id()`), índices começando por `tenant_id`, conferir planos de execução |
| Consistência | Transações curtas, idempotência, outbox, bloqueio otimista (`version`) |

**Observabilidade.** Logs JSON com `request_id`, `tenant_id`, `user_id`, rota e latência, **sem** dados pessoais/financeiros no corpo. Métricas (OpenTelemetry/Prometheus): latência p50/p95/p99 por rota, taxa de erro, filas (tamanho e idade do job mais antigo), conexões, uso por tenant. Sentry no back e no front. **SLOs:** disponibilidade 99,9% mensal; p95 < 400 ms (leituras) e < 800 ms (escritas); PDF < 30 s (assíncrono). **Alertas:** 5xx > 1%, fila atrasada > 5 min, conexões > 80%, falha de backup, job diário não executado. **CI/CD:** lint + testes + isolamento + banco efêmero + build; staging automático, produção aprovada; *feature flags* por tenant.

**Custos.** O estágio 0 cabe em dezenas a poucas centenas de dólares por mês (Supabase Pro, 2 containers, e-mail, monitoramento); cresce sobretudo com compute do banco, armazenamento e *egress* de anexos — cotas por plano e compressão de imagens protegem a margem.

**Riscos principais do produto**

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Vazamento entre tenants | Baixa | Crítico | RLS + FKs compostas + suíte de isolamento (§4.4) + revisão de segurança |
| Divergência de valores na migração | Média | Alto | `etl.reconcile()`, ensaios repetidos, conferência manual por mês (§3.4, §13) |
| Regras de negócio não homologadas | Alta | Médio | Resolver o Apêndice H antes da etapa 2; registrar em ADRs |
| Complexidade multi-tenant atrasando o MVP | Média | Médio | Escopo enxuto nas etapas 0–3; cobrança e perfis customizáveis depois |
| Dependência do Supabase | Baixa | Médio | Postgres padrão + SQL puro + Storage atrás de uma interface |
| Sobrecarga operacional de equipe pequena | Média | Médio | Serviços gerenciados, IaC, observabilidade desde o início |

## Apêndice F — Comportamento da v1, divergências e homologação

Esta tabela substitui a leitura da especificação funcional da v1: lista o que a v1 fazia de **diferente do desejável** e **onde a v2 resolve**. O restante do comportamento da v1 está reproduzido nas features F02–F20.

| Ponto | Na v1 | Na v2 |
|---|---|---|
| Fechamento de mês | Só bloqueava o saldo de abertura | Bloqueia criar/editar/cancelar lançamentos e baixas com data no mês [DB `MONTH_CLOSED`]; reabertura com motivo, em ordem decrescente (RN-12.4, RN-12.5, D-01) |
| Permissões de interface | Menu divergia da API (Secretário/Fiscal) | Matriz única (§5.2); menus derivados dela (D-10) |
| Guarda de navegação | Avaliava só o primeiro segmento da URL | `permissionGuard` avalia a rota completa (F00) |
| Autocadastro | Tela chamava rota inexistente | **Removido**: igreja criada pelo ADMIN global; acesso só por convite por link (D-19, F01, F02, F04, F21) |
| Administração | Um perfil `ADMIN` por usuário, sem separar plataforma e igreja | ADMIN **global** (plataforma, sem dados das igrejas) × **TENANT_ADMIN** (só a própria igreja) (D-20, RN-5.7) |
| Identificação de tipos | Dependia do texto da descrição | `category`, `kind` e flags tipados (RN-5.1c); na carga, derivados do texto e revisáveis (R-02) |
| Alterar contribuição | Não trocava membro nem revalidava | Troca de membro permitida e regra revalidada [DB `MEMBER_REQUIRED`] (RN-8.2, RN-8.3) |
| Totais em listas | Calculados sobre a página | Totais sobre **todo o filtro** (DoD item 5) |
| Arredondamento de associação | Centavos viravam `,09`, inclusive em base zero | `fee_rules.rounding`; tenant #1 mantém `LEGACY_CENTS_09` até confirmação; base zero → 0,00 em `HALF_UP_2` (D-03, RN-18.3) |
| Saldo e relatório | Manual; zero quando ausente ou em erro de consulta | Abertura encadeada; ausência vira `openingDefined: false`; erro nunca vira zero (RN-12.1, RN-12.6) |
| Saldo no painel | Entradas − saídas, sem abertura | Nomes e fórmulas fixos: **Saldo do mês**, **Saldo em mãos**, **Saldo final** e **Saldo acumulado** (RN-12.7, RN-12.9, RN-17.1) |
| Datas | Mistura de local e UTC; data futura só no front | `date` + fuso do tenant; futuro proibido por padrão (D-02, A-11) |
| Exclusão e histórico | Física em contribuições, despesas, parâmetros, contas | Cancelamento lógico e `RESTRICT` nas FKs financeiras; itens de catálogo só inativados (RN-8.7, RN-5.3c) |
| Pagamentos | Aceitava diferente e zero; desfazer só na competência corrente | Diferente aceito e registrado; zero recusado; estorno enquanto o mês do pagamento está aberto; histórico em `payments` (D-04, RN-16.1 a RN-16.4) |
| Anexos e falhas parciais | Lançamento criado sem anexos após falha; baixa sem transação | Duas fases, vínculo na mesma transação do lançamento (RN-11.1) |
| Cadastro duplicado | Devolvia o existente em silêncio | `409 DUPLICATE_DESCRIPTION` (RN-5.2c) |
| Auditoria | Campos perdidos; sem consulta | Estruturada, na transação, com tela de consulta (F19) |
| Restrições de banco | Desconhecidas | Esquema final com constraints, FKs compostas e travas (§3); esquema real da v1 verificado no ensaio (R-01) |

**Cenários de homologação** (executar em staging com dados migrados; os ligados à tabela acima seguem a decisão da v2, não o comportamento da v1)

1. Criar membro, convidar o usuário associado, aceitar convite, autenticar, trocar senha e bloquear o acesso após suspensão.
2. Testar cada perfil — inclusive combinações como TENANT_ADMIN + TREASURER — contra a matriz (§5.2), pela interface e **diretamente pela API**.
3. Registrar dízimo com membro e oferta sem membro; conferir filtros, anexos, edição e totais do filtro.
4. Consultar contribuintes por mês e ano com dízimos repetidos, contribuição sem membro e membro inativo; conferir o PDF anual.
5. Gerar o relatório de contribuições com entradas nas datas inicial e final; verificar a classificação por `kind` e `category` (Pix, dinheiro, dízimo, ofertas, construção, missões).
6. Registrar despesas e contribuições, definir a abertura e informar o saldo em mãos e conferir as fórmulas do relatório mensal (Saldo do mês, Saldo final e Saldo acumulado).
7. Fechar o mês, tentar editar saldo e lançamentos, reabrir e editar de novo; conferir a cascata e `LATER_MONTH_CLOSED`.
8. Criar conta mensal com vencimento dia 31 e verificar fevereiro (e bissexto); janela de dez dias, atrasos e filtro de competência.
9. Baixar conta com comprovante; conferir despesa e anexo gerados; repetir a baixa (`ALREADY_PAID`); estornar com o mês aberto e tentar com o mês fechado.
10. Calcular taxas com base zero, tipos elegíveis e excluídos, e resultado com centavos diferentes de 09; conferir valores separados e combinado.
11. Simular falhas de e-mail, upload, Storage e auditoria e conferir que nada fica pela metade.
12. Verificar limites de data e fuso na virada de dia, semana, mês e ano, inclusive em ano bissexto.

## Apêndice G — Achados do esquema da v1 e diagnóstico

**G.0 Achados que mudam a migração** (esquema `public` da v1 informado pelo cliente: 16 tabelas) e onde cada um é tratado:

| # | Achado | Tratamento |
|---|---|---|
| 1 | `expenses.value` é **`real`** (~7 dígitos): valores grandes já podem estar imprecisos | Conversão por `double precision` (`etl.money`); aviso `REAL_PRECISION_RISK` (≥ 131.072) |
| 2 | `contributions.date` é `timestamp` sem fuso; `expenses.date` é `timestamptz` | `etl.contrib_day` (`contribution_date_mode`) e `etl.expense_day` (fuso do tenant); D-08 |
| 3 | `expenses.deleted_at` existe, apesar de a spec v1 dizer exclusão física | Migram como `VOIDED` com motivo “Migrado da v1” |
| 4 | `expenses.attachment_url` coexiste com `expense_attachments` | Vira linha em `attachments`, sem duplicar quando o caminho já existe na tabela |
| 5 | Existe `payable_attachments`, não descrita antes | Vira anexo da conta |
| 6 | `contributions` não tem `deleted_at`, `updated_at`, `created_by` | v2 acrescenta `status`, `version`, `updated_at`, `created_by`; autor histórico só pela auditoria |
| 7 | `app_users` não tem e-mail/nome/status (vêm de `members`) | `etl.user_report`: `NO_EMAIL`, `DUPLICATE_EMAIL`, `NO_AUTH_USER`, `INVALID_ROLE`, `READY`, `DONE` |
| 8 | `app_users.role` é texto livre (um valor) | Perfil válido vira `membership_roles`; inválido → associação `SUSPENDED`, sem perfil inventado |
| 9 | `monthly_balances` sem unicidade conhecida em (ano, mês) | Preflight `MONTHLY_BALANCE_INVALID` (BLOCKER) |
| 10 | `payable_occurrences` sem unicidade em (conta, ano, mês) | Preflight `OCCURRENCE_INVALID` (BLOCKER) |
| 11 | Pagamento é atributo da ocorrência (`paid_*`, `expense_id`) | Uma linha em `payments` por ocorrência `PAID`; `PAID_WITHOUT_VALID_PAYMENT` (BLOCKER) |
| 12 | `audit_logs` pouco estruturada | Migra com `source = V1` e `legacy_actor_id` |
| 13 | Catálogos só têm descrição (e `type` no pagamento) | Classificação derivada do texto + `etl.catalog_review` |
| 14 | `members.genre`, endereço solto, sem status/consentimento | `gender`; `status` (`INACTIVE` se `deleted_at`); `consent_at` nulo |
| 15 | `password_reset_tokens` é auth própria | Não migra (Supabase Auth) |
| 16 | Nenhuma tabela tem `tenant_id` | Tudo recebe o tenant #1 (`etl.config.tenant_id`) |

**G.1 Metadados que faltam** (rodar na v1, somente leitura; comparar com `etl/tests/fixtures/00_v1_fixture.sql` — R-01):

```sql
select conrelid::regclass as tabela, conname, contype, pg_get_constraintdef(oid) as definicao
  from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2;
select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2;
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns where table_schema = 'public' order by 1, ordinal_position;
select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
  from information_schema.triggers where trigger_schema = 'public';
select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';
select * from pg_policies where schemaname = 'public';
select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc;
```

**G.2 Datas — como foram gravadas** (decide `contribution_date_mode`, D-08):

```sql
select extract(hour from date) as hora, count(*) from contributions group by 1 order by 1;
select count(*) filter (where (date at time zone 'UTC')::date
                             <> (date at time zone 'America/Sao_Paulo')::date) as divergentes,
       count(*) as total
  from expenses;
```
Se a maioria das contribuições está em `00:00:00`, o dia gravado é o dia de negócio (`LOCAL`). Se há horas variadas, descobrir como o front enviou (local ou UTC) e usar `UTC` só se foi UTC. Despesas “divergentes” são registros de fim de dia que cairiam no dia seguinte em UTC (a carga usa o fuso do tenant).

**G.3 Precisão de `expenses.value (real)`** — atenção: `real::numeric` já descarta dígitos (12345.67 → 12345.7); a medição correta passa por `double precision`:

```sql
select count(*) filter (where value::double precision::numeric <> round(value::double precision::numeric, 2)) as com_ruido,
       max(abs(value::double precision::numeric - round(value::double precision::numeric, 2))) as maior_diferenca,
       sum(value::double precision::numeric) as soma_real,
       sum(round(value::double precision::numeric, 2)) as soma_arredondada
  from expenses where deleted_at is null;
```

**G.4 Usuários e perfis:**

```sql
select u.id, u.role, m.id as member_id, m.email
  from app_users u left join members m on m.id = u.member_id
 where u.deleted_at is null and (m.id is null or m.email is null or btrim(m.email) = '');
select lower(btrim(m.email)) as email, count(*) from app_users u join members m on m.id = u.member_id
 where u.deleted_at is null group by 1 having count(*) > 1;
select role, count(*) from app_users where deleted_at is null group by 1;
```

**G.5 Duplicatas e integridade** (o `etl.preflight()` repete estes controles; rodar antes poupa um ciclo de ensaio):

```sql
select year, month, count(*) from monthly_balances group by 1, 2 having count(*) > 1;
select payable_id, competence_year, competence_month, count(*)
  from payable_occurrences group by 1, 2, 3 having count(*) > 1;
select count(*) from contributions c left join members m on m.id = c.member_id
 where c.member_id is not null and m.id is null;
select count(*) from contributions c join members m on m.id = c.member_id where m.deleted_at is not null;
select count(*) from payable_occurrences where status = 'PAID' and expense_id is null;
select count(*) from payable_occurrences o left join expenses e on e.id = o.expense_id
 where o.expense_id is not null and (e.id is null or e.deleted_at is not null);
select count(*) from expenses where deleted_at is not null;
select count(*) from expenses where attachment_url is not null;
select count(*) from payable_attachments;
select count(*) from contributions where amount <= 0;
select count(*) from expenses where value <= 0;
select 'contribution_types', lower(btrim(description)), count(*) from contribution_types group by 2 having count(*) > 1
union all select 'payment_methods', lower(btrim(description)), count(*) from payment_methods group by 2 having count(*) > 1
union all select 'expense_categories', lower(btrim(description)), count(*) from expense_categories group by 2 having count(*) > 1
union all select 'member_types', lower(btrim(description)), count(*) from member_types group by 2 having count(*) > 1;
```
(O preflight compara descrições sem acento e sem caixa; esta versão simplificada só acha duplicatas exatas ignorando caixa.)

**G.6 Catálogos a classificar** (insumo da revisão em `etl.catalog_review`):

```sql
select t.id, t.description, count(c.id) as usos, coalesce(sum(c.amount), 0) as total
  from contribution_types t left join contributions c on c.contribution_type_id = t.id
 group by 1, 2 order by usos desc;
select p.id, p.description, p.type, count(c.id) as usos
  from payment_methods p left join contributions c on c.payment_method_id = p.id group by 1, 2, 3;
```

## Apêndice H — Decisões de negócio pendentes (consolidado)

Todas têm **padrão assumido** (§1) e seguem valendo até resposta contrária; as que são configuração mudam sem nova versão.

| # | Tema | Padrão assumido | Referência |
|---|---|---|---|
| 1 | Escopo do bloqueio de mês fechado | Bloquear tudo com data no mês | RN-12.4 |
| 2 | Reabertura em cascata | Ordem decrescente; cascata só TENANT_ADMIN e se habilitada | D-01 |
| 3 | Perfis customizáveis por tenant | Fase posterior (hoje 5 perfis fixos) | §14 item 10 |
| 4 | Visibilidade de menus (Secretário/Fiscal) | Menu derivado da matriz de permissões | D-10 |
| 5 | Datas futuras em lançamentos | Proibidas, configurável | D-02 |
| 6 | Arredondamento “,09” da ASBARE | Mantido só no tenant #1 até confirmação | D-03 |
| 7 | Pagamento diferente/zero em contas | Diferença permitida e sinalizada; zero não | D-04 |
| 8 | Retenção de anexos e auditoria | 5 anos | D-05 |
| 9 | Resumo “Pix × demais” | Detalhar por `kind` e manter a linha de paridade | D-06 |
| 10 | Exclusão de membros com histórico | Sempre lógica; anonimização por pedido LGPD | Apêndice D |
| 11 | Snapshot das flags no lançamento | Sim | RN-8.8 |
| 12 | MFA para TENANT_ADMIN/TREASURER (e ADMIN global) | Obrigatório | D-07 |
| 13 | Modelo de preço e planos | Definir antes da fase de cobrança | F22 |
| 14 | Como a v1 gravou `contributions.date` | `LOCAL` até confirmar pela query G.2 | D-08 |
| 15 | Quem é “contribuinte” | Pelo tipo **atual** do lançamento (limitação conhecida) | D-18 |
| 16 | O que o ADMIN global vê das igrejas | Só metadados e contadores de uso (sem dados financeiros/membros); **sem impersonação** | D-21 |
| 17 | Recuperação de igreja sem TENANT_ADMIN | Novo convite só se não houver TENANT_ADMIN ativo; auditado | D-22 |
| 18 | ADMIN global que também atua numa igreja | Entra nela por convite comum; os papéis não se herdam | RN-5.7 |
| 20 | Saldo em mãos | Valor único por mês, obrigatório para fechar (0 vale), soma ao saldo final e ao acumulado; é o valor **somado**, não o total do caixa | RN-12.9 |
| 19 | Cancelamento de igreja | Só o ADMIN global altera status; a igreja apenas solicita | RN-1.6 |
