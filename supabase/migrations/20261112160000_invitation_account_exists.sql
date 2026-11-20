-- Permite ao ibg_api verificar se o destinatário já tem conta sem acesso direto a auth.users.
create or replace function v2_invitation_account_exists(p_token_hash text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from invitations i
      join auth.users u on lower(u.email) = lower(i.email::text)
     where i.token_hash = p_token_hash
  )
$$;

revoke all on function v2_invitation_account_exists(text) from public, anon, authenticated;
grant execute on function v2_invitation_account_exists(text) to ibg_api;