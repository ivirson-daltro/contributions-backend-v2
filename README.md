# API IBG v2

Fundacao do servico HTTP em NestJS para o Sistema de Gestao IBG v2. O projeto usa Node.js 22 ou superior, pnpm, TypeScript, Zod, Kysely e PostgreSQL.

## Desenvolvimento local

1. Instale Node.js 22+ e habilite o Corepack.
2. Instale as dependencias: `corepack pnpm install`.
3. Crie o arquivo local de ambiente: `Copy-Item .env.example .env` (PowerShell).
4. Preencha as URLs e credenciais de PostgreSQL e Supabase no `.env`.
5. Inicie em modo de desenvolvimento: `corepack pnpm start:dev`.

O processo carrega `.env` automaticamente e valida as variaveis antes de iniciar. A verificacao `/health` testa liveness; `/health/ready` tambem consulta o PostgreSQL. O Swagger fica em `/docs` fora de producao. Rotas da API usam o prefixo `/v1`.

## Autenticacao

O guard global valida `Authorization: Bearer <access-token>` com a JWKS do Supabase, conferindo assinatura, emissor e audiencia `authenticated`. A API oferece `GET /v1/me`, `GET /v1/public/invitations/:token` e `POST /v1/public/invitations/:token/accept`; o aceite aceita JWT opcional para quem ja tem conta e cria conta por convite para novos usuarios. Rotas publicas precisam ser marcadas explicitamente com `@Public()`; `@OptionalAuth()` permite JWT valido ou ausencia de token. `@CurrentUser()` fornece claims validadas; papeis/permissoes sao calculados no servidor. Sem `x-tenant-id`, `/me` retorna o estado MFA de cada associacao; com o header, tambem retorna as permissoes efetivas e os dados do tenant selecionado. Login, refresh, recuperacao de senha e cadastro MFA continuam sendo fluxos do `supabase-js` no front-end. TenantGuard, MfaGuard e PermissionsGuard protegem as rotas de negocio.

## Verificacoes

- `corepack pnpm build`
- `corepack pnpm typecheck`
- `corepack pnpm lint`

## Banco de dados

O esquema final esta em `supabase/migrations/`. As dez migrations da especificacao 2.1 foram preservadas porque ja podem estar aplicadas; os deltas 2.2 e de consulta de convites foram adicionados como `20261112150000_monthly_cash_on_hand.sql` e `20261112160000_invitation_account_exists.sql`. Assim, este repositorio tem 12 arquivos de migration e tanto um banco novo quanto o banco remoto atualizado chegam ao mesmo esquema. O projeto Supabase local usa a versao PostgreSQL definida em `supabase/config.toml` e cadastro publico desabilitado. A CLI 3.1.0 rejeita `major_version = 16`; o valor atual e 15, padrao aceito pela CLI e compativel com o requisito PostgreSQL >= 15. Ajuste-o para corresponder ao servidor remoto se a versao do projeto for diferente (`SHOW server_version;`).

`supabase db push` mira o banco local por padrao. Para aplicar ao projeto hospedado, use `corepack pnpm exec supabase login`, `corepack pnpm exec supabase link --project-ref <ref>`, confira com `corepack pnpm exec supabase db push --remote --dry-run` e aplique com `corepack pnpm exec supabase db push --remote`. Credenciais dos roles `ibg_api` e `ibg_platform` devem ser configuradas fora do repositorio.

A API usa `SUPABASE_DB_URL` para conectar como `ibg_api` pelo transaction pooler e `SUPABASE_DB_OWNER_URL` para operacoes administrativas na mesma instancia Supabase. Obtenha as duas URLs em **Connect** no painel e substitua os valores de exemplo; nao aponte a API para `localhost` quando for usar o projeto hospedado. As variaveis `SUPABASE_SERVICE_KEY` e `SUPABASE_BUCKET` seguem a nomenclatura do restante dos servicos. O bucket de anexos deve permanecer privado; por isso a API nao usa `SUPABASE_PUBLIC_URL`.

`supabase/bootstrap/platform_admin.sql` cria o primeiro ADMIN global e deve ser executado manualmente pelo dono do banco, depois de criar a identidade correspondente no Supabase Auth. A pasta `etl/` contem a carga da v1 e seus testes; ela nao faz parte do inicio normal da API e mantem seu contrato de variaveis proprio (`DATABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`). Para testar o ETL, use `etl/tests/run.sh` em Bash com PostgreSQL 16 e `psql` disponiveis.

## Escopo atual

O esquema final do banco e o pacote ETL estao presentes. F02 cobre verificacao JWT, consulta de associacoes por `/me` e aceite de convite. O painel oferece `GET /v1/dashboard/summary` e `GET /v1/dashboard/series?year=AAAA`, protegidos por tenant e pela permissao `dashboard:read`; valores monetarios sao retornados como strings decimais. Meses fechados usam o snapshot, e os indicadores de datas respeitam o fuso e o inicio da semana configurados para o tenant. A API ainda nao aplica migrations automaticamente; a migration `20261112160000_invitation_account_exists.sql` precisa estar aplicada para a previsualizacao distinguir contas existentes. Os demais modulos de negocio, auditoria e idempotencia ainda precisam ser implementados e testados antes do uso com dados reais.
