-- =============================================================================
-- ETL v1 -> v2 · 40 · Reconciliação (legacy x public). Tudo precisa estar ok = true
-- =============================================================================
create or replace function etl.reconcile()
returns table (check_name text, legacy_value text, v2_value text, ok boolean)
language plpgsql stable as $$
declare t uuid := etl.cfg('tenant_id')::uuid;
begin
  return query
  with c(name, l, v) as (values
    ('count.member_types',       (select count(*) from legacy.member_types)::text,
                                  (select count(*) from member_types where tenant_id = t and id <> md5('member_type:unknown:' || t::text)::uuid)::text),
    ('count.members',            (select count(*) from legacy.members)::text,            (select count(*) from members where tenant_id = t)::text),
    ('count.contribution_types', (select count(*) from legacy.contribution_types)::text, (select count(*) from contribution_types where tenant_id = t)::text),
    ('count.payment_methods',    (select count(*) from legacy.payment_methods)::text,     (select count(*) from payment_methods where tenant_id = t)::text),
    ('count.expense_categories', (select count(*) from legacy.expense_categories)::text, (select count(*) from expense_categories where tenant_id = t)::text),
    ('count.contributions',      (select count(*) from legacy.contributions)::text,      (select count(*) from contributions where tenant_id = t)::text),
    ('count.expenses',           (select count(*) from legacy.expenses)::text,            (select count(*) from expenses where tenant_id = t)::text),
    ('count.expenses_voided',    (select count(*) from legacy.expenses where deleted_at is not null)::text,
                                  (select count(*) from expenses where tenant_id = t and status = 'VOIDED')::text),
    ('count.payables',           (select count(*) from legacy.payables)::text,            (select count(*) from payables where tenant_id = t)::text),
    ('count.occurrences',        (select count(*) from legacy.payable_occurrences)::text, (select count(*) from payable_occurrences where tenant_id = t)::text),
    ('count.payments',           (select count(*) from legacy.payable_occurrences where status = 'PAID')::text,
                                  (select count(*) from payments where tenant_id = t and status = 'ACTIVE')::text),
    ('count.monthly_balances',   (select count(*) from legacy.monthly_balances)::text,    (select count(*) from monthly_balances where tenant_id = t)::text),
    ('count.monthly_balances_closed', (select count(*) from legacy.monthly_balances where closed_at is not null)::text,
                                  (select count(*) from monthly_balances where tenant_id = t and closed_at is not null)::text),
    ('count.attachments',        ((select count(*) from legacy.contribution_attachments) + (select count(*) from legacy.expense_attachments)
                                  + (select count(*) from legacy.payable_attachments)
                                  + (select count(*) from legacy.expenses e where nullif(btrim(e.attachment_url), '') is not null
                                       and not exists (select 1 from legacy.expense_attachments ea
                                                        where ea.expense_id = e.id and ea.path = e.attachment_url)))::text,
                                  (select count(*) from attachments where tenant_id = t)::text),
    ('count.audit_log',          (select count(*) from legacy.audit_logs)::text,          (select count(*) from audit_log where tenant_id = t and source = 'V1')::text),
    -- valores
    ('sum.contributions',        (select coalesce(sum(round(amount, 2)), 0) from legacy.contributions)::text,
                                  (select coalesce(sum(amount), 0) from contributions where tenant_id = t)::text),
    ('sum.expenses_active',      (select coalesce(sum(etl.money(value)), 0) from legacy.expenses where deleted_at is null)::text,
                                  (select coalesce(sum(amount), 0) from expenses where tenant_id = t and status = 'ACTIVE')::text),
    ('sum.expenses_voided',      (select coalesce(sum(etl.money(value)), 0) from legacy.expenses where deleted_at is not null)::text,
                                  (select coalesce(sum(amount), 0) from expenses where tenant_id = t and status = 'VOIDED')::text),
    ('sum.payments',             (select coalesce(sum(round(paid_amount, 2)), 0) from legacy.payable_occurrences where status = 'PAID')::text,
                                  (select coalesce(sum(paid_amount), 0) from payments where tenant_id = t and status = 'ACTIVE')::text),
    ('sum.opening_balances',     (select coalesce(sum(round(opening_balance, 2)), 0) from legacy.monthly_balances)::text,
                                  (select coalesce(sum(opening_balance), 0) from monthly_balances where tenant_id = t)::text),
    -- por mês (dia de negócio) e por catálogo: quantidade de grupos divergentes
    ('diff.contributions_by_month', '0',
      (select count(*) from (
         select m, sum(a) from (
           select date_trunc('month', etl.contrib_day(date)) m, round(amount, 2) a from legacy.contributions
           union all
           select date_trunc('month', occurred_on), -amount from contributions where tenant_id = t) x
         group by m having sum(a) <> 0) d)::text),
    ('diff.expenses_by_month', '0',
      (select count(*) from (
         select m, sum(a) from (
           select date_trunc('month', etl.expense_day(date)) m, etl.money(value) a from legacy.expenses where deleted_at is null
           union all
           select date_trunc('month', occurred_on), -amount from expenses where tenant_id = t and status = 'ACTIVE') x
         group by m having sum(a) <> 0) d)::text),
    ('diff.contributions_by_type', '0',
      (select count(*) from (
         select k, sum(a) from (
           select contribution_type_id k, round(amount, 2) a from legacy.contributions
           union all select contribution_type_id, -amount from contributions where tenant_id = t) x
         group by k having sum(a) <> 0) d)::text),
    ('diff.contributions_by_member', '0',
      (select count(*) from (
         select k, sum(a) from (
           select coalesce(member_id::text, '-') k, round(amount, 2) a from legacy.contributions
           union all select coalesce(member_id::text, '-'), -amount from contributions where tenant_id = t) x
         group by k having sum(a) <> 0) d)::text),
    ('diff.expenses_by_category', '0',
      (select count(*) from (
         select k, sum(a) from (
           select coalesce(category_id::text, '-') k, etl.money(value) a from legacy.expenses where deleted_at is null
           union all select coalesce(category_id::text, '-'), -amount from expenses where tenant_id = t and status = 'ACTIVE') x
         group by k having sum(a) <> 0) d)::text),
    -- fotos dos meses fechados batem com os lançamentos
    ('snapshots.closed_months_consistent', '0',
      (select count(*) from monthly_balances mb
        where mb.tenant_id = t and mb.closed_at is not null
          and (mb.closing_snapshot ->> 'income')::numeric <>
              (select coalesce(sum(amount), 0) from contributions c where c.tenant_id = t and c.status = 'ACTIVE'
                  and date_trunc('month', c.occurred_on) = make_date(mb.year, mb.month, 1))
       )::text),
    -- integridade
    ('integrity.payments_without_active_expense', '0',
      (select count(*) from payments p join expenses e on e.tenant_id = p.tenant_id and e.id = p.expense_id
        where p.tenant_id = t and p.status = 'ACTIVE' and e.status <> 'ACTIVE')::text),
    ('integrity.paid_occurrence_has_payment', '0',
      (select count(*) from payable_occurrences o where o.tenant_id = t and o.status = 'PAID'
          and not exists (select 1 from payments p where p.occurrence_id = o.id and p.status = 'ACTIVE'))::text),
    ('files.attachments_copied', (select count(*) from etl.attachment_copy)::text,
                                  (select count(*) from etl.attachment_copy where status = 'COPIED')::text),
    ('users.active_tenant_admin_exists', 'true',
      (exists (select 1 from membership_roles mr join tenant_memberships tm on tm.id = mr.membership_id
                where mr.tenant_id = t and mr.role = 'TENANT_ADMIN' and tm.status = 'ACTIVE'))::text)
  )
  select c.name, c.l, c.v, c.l = c.v from c order by c.name;
end $$;
