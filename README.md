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

## Contribuicoes

`GET /v1/contributions` lista lancamentos com filtros `q`, `memberId`, `typeId`, `methodId`, `from`, `to`, `status`, paginacao e ordenacao. Sem `from` e `to`, retorna contribuicoes de todos os periodos; ao informar uma ou ambas as datas, usa somente os limites enviados (inclusivos). `meta.totals` considera todas as contribuicoes ativas do filtro, nao apenas a pagina. `POST /v1/contributions` registra uma contribuicao e exige `Idempotency-Key`; o tipo pode exigir membro, e data futura depende da configuracao do tenant. Para preencher o formulario, use `GET /v1/catalogs/contribution-types`, `GET /v1/catalogs/payment-methods` (ambos paginados e somente ativos) e `GET /v1/members/lookup?q=` (ate 20 membros ativos). Essas rotas exigem JWT, `X-Tenant-Id` e as permissoes correspondentes. Anexos ainda nao sao suportados; `attachmentIds`, se enviado, deve ser vazio. Consulte `/docs` para detalhes.

`GET /v1/members/lookup` aceita `page` (padrao 1) e retorna ate 20 membros ativos por pagina, em ordem de nome e ID. Uma pagina com menos de 20 itens indica o fim dos resultados; `q` continua opcional.

`GET /v1/members/all` retorna todos os membros ativos e nao excluidos do tenant, sem paginacao, no mesmo formato e ordenacao do lookup. Exige JWT, `X-Tenant-Id` e a permissao `members:read-list`.

`GET /v1/contributions/report?from=2026-11-01&to=2026-11-30` retorna diretamente um PDF das contribuicoes ativas, agrupadas por meio de pagamento, com totais por classificacao historica. Os nomes de tipos e meios sao os atuais; as classificacoes sao as registradas no lancamento. As duas datas sao obrigatorias e inclusivas; o intervalo maximo e de 366 dias. Exige JWT, `X-Tenant-Id` e a permissao `contributions-report:generate` (sujeita ao MFA configurado para o perfil).

O cabecalho do PDF usa `assets/logo.png`; o build copia a imagem para `dist/assets/logo.png`, que deve acompanhar a aplicacao na implantacao. Ao final, o resumo apresenta entradas por classificacao do meio de pagamento, contribuicoes por categoria e destinacoes para construcao e missoes, seguido de espacos para assinatura do 1º e 2º tesoureiros e de cinco membros do conselho fiscal. Cabecalho, layout, resumo, assinaturas e geracao do PDF sao compartilhados em `src/common/pdf/report-layout.ts` para outros relatorios.

## Membros

`GET /v1/members` lista membros com paginacao e filtros `q`, `memberTypeId` e `status` (padrao `ACTIVE`, ou `ALL`); `sort` aceita `name`, `type` e `createdAt`. `GET /v1/members/:id` retorna os detalhes para quem tem `members:read-detail`. `GET /v1/catalogs/member-types` lista os tipos ativos.

`POST /v1/members` exige `name` e `memberTypeId`. `PUT /v1/members/:id` atualiza apenas os campos informados; `DELETE /v1/members/:id` faz exclusao logica e retorna `409 MEMBER_HAS_ACCESS` se houver acesso ativo vinculado. Secretaria e administrador podem gerenciar todos os campos; tesoureiro pode criar somente com nome e tipo, e alterar nome/tipo ou excluir apenas membros que ele criou. Os registros antigos sem criador nao podem ser alterados nem excluidos por tesoureiro. Usuarios com varios perfis recebem a uniao das permissoes.

Para criacao com dados completos, possiveis duplicatas geram `409 POSSIBLE_DUPLICATE` com candidatos em `errors`; apos confirmacao, `POST /v1/members?force=true` permite prosseguir. Os endpoints exigem JWT, `X-Tenant-Id` e as permissoes correspondentes. A migration `20261124120000_members_created_by.sql` deve ser aplicada antes de usar o CRUD.

## Configuracoes da igreja

O cadastro pela interface usa `America/Sao_Paulo` como fuso horario padrao, sem solicitar essa informacao. Os fusos ja registrados em igrejas existentes nao sao alterados ao editar seus dados. `GET/PUT /v1/tenant` gerencia nome, documento e fuso horario; `GET/PUT /v1/tenant/settings` gerencia as preferencias. As quatro colecoes de `GET/POST /v1/settings/catalogs/:catalog`, `PUT/DELETE /v1/settings/catalogs/:catalog/:id` usam `member-types`, `contribution-types`, `payment-methods` ou `expense-categories`. Itens usados nao podem ser excluidos; alterar sua classificacao exige `confirm=true`. `GET/PUT /v1/settings/fees` consulta ou substitui a lista de regras de taxas. As escritas sao auditadas e os acessos exigem as permissoes correspondentes.

`PUT /v1/tenant/logo` recebe multipart `file` (PNG, JPEG ou WebP, ate 2 MB); `GET /v1/tenant/logo` retorna a imagem privada ao usuario autenticado da igreja. Ambas aceitam `theme=LIGHT` ou `theme=DARK` (padrao `LIGHT`). Se nao houver logo escura, GET retorna a clara; `fallback=false` desativa esse comportamento para consultar apenas a imagem do tema solicitado. Revise e aplique as migrations `20261124160000_tenant_logos.sql` e `20261124180000_tenant_logo_themes.sql` no banco de destino; a primeira cria o bucket privado `tenant-logos`. `npm run start` executa migrations automaticamente: confira o banco configurado antes de usa-lo.

## Banco de dados

O esquema final esta em `supabase/migrations/`. As dez migrations da especificacao 2.1 foram preservadas porque ja podem estar aplicadas; os deltas 2.2 e de consulta de convites foram adicionados como `20261112150000_monthly_cash_on_hand.sql` e `20261112160000_invitation_account_exists.sql`. Assim, este repositorio tem 12 arquivos de migration e tanto um banco novo quanto o banco remoto atualizado chegam ao mesmo esquema. O projeto Supabase local usa a versao PostgreSQL definida em `supabase/config.toml` e cadastro publico desabilitado. A CLI 3.1.0 rejeita `major_version = 16`; o valor atual e 15, padrao aceito pela CLI e compativel com o requisito PostgreSQL >= 15. Ajuste-o para corresponder ao servidor remoto se a versao do projeto for diferente (`SHOW server_version;`).

`supabase db push` mira o banco local por padrao. Para aplicar ao projeto hospedado, use `corepack pnpm exec supabase login`, `corepack pnpm exec supabase link --project-ref <ref>`, confira com `corepack pnpm exec supabase db push --remote --dry-run` e aplique com `corepack pnpm exec supabase db push --remote`. Credenciais dos roles `ibg_api` e `ibg_platform` devem ser configuradas fora do repositorio.

A API usa `SUPABASE_DB_URL` para conectar como `ibg_api` pelo transaction pooler e `SUPABASE_DB_OWNER_URL` para operacoes administrativas na mesma instancia Supabase. Obtenha as duas URLs em **Connect** no painel e substitua os valores de exemplo; nao aponte a API para `localhost` quando for usar o projeto hospedado. As variaveis `SUPABASE_SERVICE_KEY` e `SUPABASE_BUCKET` seguem a nomenclatura do restante dos servicos. O bucket de anexos deve permanecer privado; por isso a API nao usa `SUPABASE_PUBLIC_URL`.

`supabase/bootstrap/platform_admin.sql` cria o primeiro ADMIN global e deve ser executado manualmente pelo dono do banco, depois de criar a identidade correspondente no Supabase Auth. A pasta `etl/` contem a carga da v1 e seus testes; ela nao faz parte do inicio normal da API e mantem seu contrato de variaveis proprio (`DATABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`). Para testar o ETL, use `etl/tests/run.sh` em Bash com PostgreSQL 16 e `psql` disponiveis.

## Escopo atual

O esquema final do banco e o pacote ETL estao presentes. F02 cobre verificacao JWT, consulta de associacoes por `/me` e aceite de convite. O painel oferece `GET /v1/dashboard/summary` e `GET /v1/dashboard/series?year=AAAA`, protegidos por tenant e pela permissao `dashboard:read`; valores monetarios sao retornados como strings decimais. Meses fechados usam o snapshot, e os indicadores de datas respeitam o fuso e o inicio da semana configurados para o tenant. `npm run start` executa migrations; `start:dev` nao as aplica. A migration `20261112160000_invitation_account_exists.sql` precisa estar aplicada para a previsualizacao distinguir contas existentes. Os demais modulos de negocio, auditoria e idempotencia ainda precisam ser implementados e testados antes do uso com dados reais.
