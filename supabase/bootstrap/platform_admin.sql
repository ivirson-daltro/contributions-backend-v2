-- Bootstrap do PRIMEIRO ADMIN global (uma vez, como dono do banco). Os demais são adicionados pelo console.
--   1. Crie/convide o usuário no Supabase Auth (painel ou CLI) com o e-mail desejado.
--   2. psql "$OWNER_DATABASE_URL" -v email=pessoa@exemplo.com -f supabase/bootstrap/platform_admin.sql
-- No primeiro acesso o MFA (TOTP) é obrigatório para entrar no console (aal2).
\set ON_ERROR_STOP on
insert into platform_admins (user_id)
select id from auth.users where lower(email) = lower(:'email')
on conflict (user_id) do update set status = 'ACTIVE';
select user_id, status from platform_admins where user_id = (select id from auth.users where lower(email) = lower(:'email'));
