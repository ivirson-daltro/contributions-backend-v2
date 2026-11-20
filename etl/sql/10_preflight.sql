-- =============================================================================
-- ETL v1 -> v2 · 10 · Preflight (somente leitura sobre `legacy`)
-- -----------------------------------------------------------------------------
-- BLOCKER: a carga recusa. Corrija o dado NA ORIGEM (v1) e recarregue o dump, ou decida e
--          registre a exceção. Nada é descartado em silêncio.
-- WARNING: a carga prossegue; o item aparece em etl.rejects / etl.catalog_review.
-- =============================================================================
create or replace function etl.preflight()
returns table (check_name text, severity text, qty bigint, how_to_fix text)
language plpgsql stable as $$
begin
  -- ----------------------------- BLOCKERS: dados -------------------------------
  return query select 'TENANT_ALREADY_LOADED', 'BLOCKER', 1::bigint,
    'O banco já tem o tenant. Para recarregar use: etl/run.sh reset'
   where exists (select 1 from public.tenants where id = etl.cfg('tenant_id')::uuid);

  return query select 'CONTRIBUTION_AMOUNT_NOT_POSITIVE', 'BLOCKER', count(*),
    'Corrija o valor ou remova o lançamento na v1 (a v2 só aceita valor > 0)'
    from legacy.contributions where amount is null or amount <= 0 having count(*) > 0;

  return query select 'CONTRIBUTION_INCOMPLETE', 'BLOCKER', count(*),
    'Lançamento sem data, tipo ou meio de pagamento: complete na v1'
    from legacy.contributions
   where date is null or contribution_type_id is null or payment_method_id is null having count(*) > 0;

  return query select 'EXPENSE_VALUE_NULL_OR_NO_DATE', 'BLOCKER', count(*),
    'Despesa sem valor ou sem data: complete na v1'
    from legacy.expenses where value is null or date is null having count(*) > 0;

  return query select 'EXPENSE_AMOUNT_NOT_POSITIVE', 'BLOCKER', count(*),
    'Despesa ativa com valor <= 0: corrija ou exclua na v1'
    from legacy.expenses where deleted_at is null and value <= 0 having count(*) > 0;

  return query select 'DUPLICATE_CATALOG_DESCRIPTION', 'BLOCKER', count(*),
    'Mescle/renomeie itens com a mesma descrição (sem acento/caixa) e reaponte os lançamentos'
    from (
      select 1 from legacy.contribution_types group by app_norm(description) having count(*) > 1
      union all select 1 from legacy.payment_methods   group by app_norm(description) having count(*) > 1
      union all select 1 from legacy.expense_categories group by app_norm(description) having count(*) > 1
      union all select 1 from legacy.member_types      group by app_norm(description) having count(*) > 1
    ) d having count(*) > 0;

  return query select 'MONTHLY_BALANCE_INVALID', 'BLOCKER', count(*),
    'Saldo mensal sem ano/mês válidos, ou duplicado para o mesmo (ano, mês): mantenha um por mês'
    from (
      select 1 from legacy.monthly_balances where year is null or month is null or month not between 1 and 12
      union all
      select 1 from legacy.monthly_balances where year is not null and month is not null
       group by year, month having count(*) > 1
    ) d having count(*) > 0;

  return query select 'PAYABLE_INVALID', 'BLOCKER', count(*),
    'Conta a pagar com tipo fora de MONTHLY/ONCE, MONTHLY sem due_day (1..31) ou ONCE sem due_date'
    from legacy.payables
   where type is null or type not in ('MONTHLY','ONCE')
      or (type = 'MONTHLY' and (due_day is null or due_day not between 1 and 31))
      or (type = 'ONCE' and due_date is null) having count(*) > 0;

  return query select 'OCCURRENCE_INVALID', 'BLOCKER', count(*),
    'Ocorrência sem conta/competência, mês fora de 1..12, status fora de OPEN/PAID/CANCELED ou duplicada'
    from (
      select 1 from legacy.payable_occurrences
       where payable_id is null or competence_year is null or competence_month is null
          or competence_month not between 1 and 12 or status is null or status not in ('OPEN','PAID','CANCELED')
      union all
      select 1 from legacy.payable_occurrences
       where payable_id is not null group by payable_id, competence_year, competence_month having count(*) > 1
    ) d having count(*) > 0;

  return query select 'PAID_WITHOUT_VALID_PAYMENT', 'BLOCKER', count(*),
    'Ocorrência PAID sem despesa/valor/data válidos: complete os dados ou reabra a ocorrência na v1'
    from legacy.payable_occurrences o
   where o.status = 'PAID'
     and (o.expense_id is null or coalesce(o.paid_amount, 0) <= 0 or o.paid_at is null)
   having count(*) > 0;

  return query select 'ORPHAN_REFERENCE', 'BLOCKER', count(*),
    'Referência para registro inexistente (a v2 tem FKs): corrija na v1'
    from (
      select 1 from legacy.members m where m.member_type_id is not null
         and not exists (select 1 from legacy.member_types x where x.id = m.member_type_id)
      union all select 1 from legacy.contributions c
       where (c.member_id is not null and not exists (select 1 from legacy.members x where x.id = c.member_id))
          or (c.contribution_type_id is not null and not exists (select 1 from legacy.contribution_types x where x.id = c.contribution_type_id))
          or (c.payment_method_id is not null and not exists (select 1 from legacy.payment_methods x where x.id = c.payment_method_id))
      union all select 1 from legacy.expenses e
       where e.category_id is not null and not exists (select 1 from legacy.expense_categories x where x.id = e.category_id)
      union all select 1 from legacy.payables p
       where p.category_id is not null and not exists (select 1 from legacy.expense_categories x where x.id = p.category_id)
      union all select 1 from legacy.payable_occurrences o
       where (o.payable_id is not null and not exists (select 1 from legacy.payables x where x.id = o.payable_id))
          or (o.expense_id is not null and not exists (select 1 from legacy.expenses x where x.id = o.expense_id))
      union all select 1 from legacy.contribution_attachments a
       where not exists (select 1 from legacy.contributions x where x.id = a.contribution_id)
      union all select 1 from legacy.expense_attachments a
       where not exists (select 1 from legacy.expenses x where x.id = a.expense_id)
      union all select 1 from legacy.payable_attachments a
       where not exists (select 1 from legacy.payables x where x.id = a.payable_id)
    ) d having count(*) > 0;

  return query select 'ATTACHMENT_WITHOUT_PATH', 'BLOCKER', count(*),
    'Anexo sem caminho de arquivo: remova o registro ou informe o caminho na v1'
    from (
      select 1 from legacy.contribution_attachments where nullif(btrim(path), '') is null
      union all select 1 from legacy.expense_attachments where nullif(btrim(path), '') is null
      union all select 1 from legacy.payable_attachments where nullif(btrim(path), '') is null
    ) d having count(*) > 0;

  -- ------------------------------- WARNINGS -----------------------------------
  return query select 'CONTRIBUTION_MEMBER_REQUIRED_VIOLATED', 'WARNING', count(*),
    'Lançamentos antigos sem membro em tipo que exige membro (a v1 não revalidava). Entram assim; a regra vale para novas escritas'
    from legacy.contributions c
    join legacy.contribution_types t on t.id = c.contribution_type_id
    cross join lateral etl.classify_contribution_type(t.description) k
   where k.requires_member and c.member_id is null having count(*) > 0;

  return query select 'MEMBER_WITHOUT_TYPE', 'WARNING', count(*),
    'Membros sem tipo recebem o tipo "Não informado" (criado na carga)'
    from legacy.members where member_type_id is null having count(*) > 0;

  return query select 'MEMBER_EMAIL_INVALID', 'WARNING', count(*),
    'E-mail em formato inválido entra vazio na v2; o valor original fica em etl.rejects'
    from legacy.members where email is not null and btrim(email) <> '' and btrim(email) !~ '^[^@\s]+@[^@\s]+$'
   having count(*) > 0;

  return query select 'AMOUNT_SCALE_OVER_2', 'WARNING', count(*),
    'Valores com mais de 2 casas serão arredondados (HALF_UP); original em etl.rejects'
    from (
      select 1 from legacy.contributions where amount is not null and amount <> round(amount, 2)
      union all select 1 from legacy.payables where amount is not null and amount <> round(amount, 2)
      union all select 1 from legacy.payable_occurrences where paid_amount is not null and paid_amount <> round(paid_amount, 2)
      union all select 1 from legacy.monthly_balances where opening_balance is not null and opening_balance <> round(opening_balance, 2)
    ) d having count(*) > 0;

  return query select 'REAL_PRECISION_RISK', 'WARNING', count(*),
    'Despesas >= 131.072 vindas de "real": confira o centavo com o comprovante'
    from legacy.expenses where abs(coalesce(value, 0)) >= 131072 having count(*) > 0;

  return query select 'MONTH_OPENING_NOT_CHAINED', 'WARNING', count(*),
    'Abertura do mês difere do saldo acumulado do mês anterior (na v1 o saldo é manual): decida manter ou corrigir'
    from legacy.monthly_balances cur
    join legacy.monthly_balances prev on (prev.year * 12 + prev.month) = (cur.year * 12 + cur.month) - 1
   where cur.opening_balance is distinct from (
           coalesce(prev.opening_balance, 0)
         + coalesce((select sum(c.amount) from legacy.contributions c
                      where date_trunc('month', etl.contrib_day(c.date)) = make_date(prev.year, prev.month, 1)), 0)
         - coalesce((select sum(etl.money(e.value)) from legacy.expenses e
                      where e.deleted_at is null and e.date is not null
                        and date_trunc('month', etl.expense_day(e.date)) = make_date(prev.year, prev.month, 1)), 0))
   having count(*) > 0;

  return query select 'CATALOG_CLASSIFICATION_REVIEW', 'WARNING',
    ((select count(*) from legacy.contribution_types) + (select count(*) from legacy.payment_methods))::bigint,
    'Categoria/flags/kind serão derivados do TEXTO da descrição; revise em etl.catalog_review'
   where exists (select 1 from legacy.contribution_types) or exists (select 1 from legacy.payment_methods);

  return query select 'AUDIT_PARTITION_RANGE', 'WARNING',
    (select count(distinct date_trunc('month', created_at)) from legacy.audit_logs),
    'A carga cria uma partição mensal de audit_log por mês com dados na v1'
   where exists (select 1 from legacy.audit_logs where created_at < date_trunc('month', now()));
end $$;

create or replace function etl.preflight_assert() returns void
language plpgsql as $$
declare v_n int; v_list text;
begin
  select count(*), string_agg(check_name || ' (' || qty || ')', ', ')
    into v_n, v_list from etl.preflight() where severity = 'BLOCKER';
  if v_n > 0 then
    raise exception 'PREFLIGHT_BLOCKED: % bloqueio(s): %', v_n, v_list using errcode = 'P0001';
  end if;
end $$;
