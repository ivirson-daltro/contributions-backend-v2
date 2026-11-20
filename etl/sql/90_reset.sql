-- =============================================================================
-- ETL v1 -> v2 · 90 · Reset (ensaio) e teardown
-- -----------------------------------------------------------------------------
-- etl.reset(): apaga TUDO do tenant migrado para recarregar do zero (ensaios).
--   Mantém auth.users/user_profiles (idempotentes) e o schema legacy. Recusa se frozen = true.
-- etl.teardown_sql(): não executa nada; devolve os comandos do descarte final (após período de observação).
-- =============================================================================
create or replace function etl.reset() returns void
language plpgsql as $$
declare t uuid := etl.cfg('tenant_id')::uuid;
begin
  if etl.cfg('frozen') = 'true' then
    raise exception 'ETL_FROZEN: o corte já foi feito; reset bloqueado' using errcode = 'P0001';
  end if;
  perform set_config('app.bypass_guards', 'on', true);
  perform set_config('app.audit_maintenance', 'on', true);

  delete from payments            where tenant_id = t;
  delete from attachments         where tenant_id = t;
  delete from payable_occurrences where tenant_id = t;
  delete from payables            where tenant_id = t;
  delete from contributions       where tenant_id = t;
  delete from expenses            where tenant_id = t;
  delete from monthly_balances    where tenant_id = t;
  delete from membership_roles    where tenant_id = t;
  delete from tenant_memberships  where tenant_id = t;
  delete from invitations         where tenant_id = t;
  delete from members             where tenant_id = t;
  delete from contribution_types  where tenant_id = t;
  delete from payment_methods     where tenant_id = t;
  delete from expense_categories  where tenant_id = t;
  delete from member_types        where tenant_id = t;
  delete from fee_rules           where tenant_id = t;
  delete from audit_log           where tenant_id = t;
  delete from idempotency_keys    where tenant_id = t;
  delete from outbox_events       where tenant_id = t;
  delete from tenant_settings     where tenant_id = t;
  delete from tenants             where id = t;

  truncate etl.user_map, etl.attachment_copy, etl.catalog_review, etl.rejects, etl.run_log;
  perform etl.log('reset', 0);
end $$;

create or replace function etl.teardown_sql() returns text
language sql immutable as $$
  select $q$
    -- Só depois do corte + período de observação + backup confirmado:
    select etl.set_cfg('frozen', 'true');
    drop schema legacy cascade;
    drop schema etl cascade;
  $q$
$$;
