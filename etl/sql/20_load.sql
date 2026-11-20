-- =============================================================================
-- ETL v1 -> v2 · 20 · Carga (legacy -> public), uma transação, idempotência por reset
-- -----------------------------------------------------------------------------
-- IDs da v1 são preservados (uuid) em todas as tabelas: reconciliação e rastreio ficam triviais.
-- Guards de negócio ficam desligados SÓ dentro desta função (app.bypass_guards = on, local).
-- =============================================================================
create or replace function etl.load() returns void
language plpgsql as $$
declare
  t   uuid := etl.cfg('tenant_id')::uuid;
  n   bigint;
  v_type_unknown uuid;
  d   date;
  d_min date; d_max date;
begin
  if etl.cfg('frozen') = 'true' then
    raise exception 'ETL_FROZEN: o corte já foi feito; a carga está travada' using errcode = 'P0001';
  end if;
  perform etl.preflight_assert();

  perform set_config('app.bypass_guards', 'on', true);
  perform set_config('app.audit_maintenance', 'on', true);

  -- 1. Tenant, configurações e taxas -------------------------------------------------
  insert into tenants (id, slug, name, status, timezone)
  values (t, etl.cfg('tenant_slug'), etl.cfg('tenant_name'), 'ACTIVE', etl.cfg('timezone'));
  insert into tenant_settings (tenant_id) values (t);
  -- Tenant #1 mantém o comportamento da v1 até a decisão de negócio (ASBARE = 0,09)
  insert into fee_rules (tenant_id, name, percent, rounding, sort_order) values
    (t, 'ASBARE',            2, 'LEGACY_CENTS_09', 1),
    (t, 'Plano Cooperativo', 5, 'HALF_UP_2',       2);

  -- 2. Catálogos ----------------------------------------------------------------------
  insert into member_types (id, tenant_id, description)
  select id, t, btrim(description) from legacy.member_types;
  get diagnostics n = row_count; perform etl.log('member_types', n);

  if exists (select 1 from legacy.members where member_type_id is null) then
    v_type_unknown := md5('member_type:unknown:' || t::text)::uuid;
    insert into member_types (id, tenant_id, description) values (v_type_unknown, t, 'Não informado')
    on conflict do nothing;
    insert into etl.rejects (step, source_table, source_id, reason, detail)
    select 'load', 'members', id::text, 'MEMBER_WITHOUT_TYPE', jsonb_build_object('assigned', 'Não informado')
      from legacy.members where member_type_id is null
    on conflict do nothing;
  end if;

  insert into expense_categories (id, tenant_id, description)
  select id, t, btrim(description) from legacy.expense_categories;
  get diagnostics n = row_count; perform etl.log('expense_categories', n);

  insert into contribution_types (id, tenant_id, description, category, requires_member,
                                  counts_for_fees, counts_as_contributor)
  select ct.id, t, btrim(ct.description), k.category, k.requires_member, k.counts_for_fees, k.counts_as_contributor
    from legacy.contribution_types ct
    cross join lateral etl.classify_contribution_type(ct.description) k;
  get diagnostics n = row_count; perform etl.log('contribution_types', n);

  insert into payment_methods (id, tenant_id, description, kind)
  select pm.id, t, btrim(pm.description), etl.classify_payment_kind(pm.description, pm."type")
    from legacy.payment_methods pm;
  get diagnostics n = row_count; perform etl.log('payment_methods', n);

  insert into etl.catalog_review (catalog, item_id, description, derived)
  select 'contribution_types', id, description,
         jsonb_build_object('category', category, 'requires_member', requires_member,
                            'counts_for_fees', counts_for_fees, 'counts_as_contributor', counts_as_contributor)
    from contribution_types where tenant_id = t
  on conflict do nothing;
  insert into etl.catalog_review (catalog, item_id, description, derived)
  select 'payment_methods', id, description, jsonb_build_object('kind', kind)
    from payment_methods where tenant_id = t
  on conflict do nothing;

  -- 3. Membros ------------------------------------------------------------------------
  insert into etl.rejects (step, source_table, source_id, reason, detail)
  select 'load', 'members', id::text, 'MEMBER_EMAIL_INVALID', jsonb_build_object('email', email)
    from legacy.members
   where email is not null and btrim(email) <> '' and btrim(email) !~ '^[^@\s]+@[^@\s]+$'
  on conflict do nothing;

  insert into members (id, tenant_id, name, member_type_id, status, phone, email, gender, birth_date,
                       entry_date, baptism_date, zip_code, street, number, complement, neighborhood,
                       city, state, created_at, updated_at, deleted_at)
  select m.id, t, btrim(m.name), coalesce(m.member_type_id, v_type_unknown),
         case when m.deleted_at is not null then 'INACTIVE' else 'ACTIVE' end,
         m.phone,
         case when btrim(m.email) ~ '^[^@\s]+@[^@\s]+$' then btrim(m.email) end,
         m.genre, m.birth_date, m.entry_date, m.baptism_date, m.zip_code, m.street, m.number,
         m.complement, m.neighborhood, m.city, m.state,
         coalesce(m.created_at, now()), coalesce(m.deleted_at, m.created_at, now()), m.deleted_at
    from legacy.members m;
  get diagnostics n = row_count; perform etl.log('members', n);

  -- 4. Contribuições ------------------------------------------------------------------
  insert into etl.rejects (step, source_table, source_id, reason, detail)
  select 'load', 'contributions', id::text, 'AMOUNT_ROUNDED', jsonb_build_object('amount', amount, 'rounded', round(amount, 2))
    from legacy.contributions where amount <> round(amount, 2)
  on conflict do nothing;

  insert into contributions (id, tenant_id, member_id, contribution_type_id, payment_method_id, amount,
                             occurred_on, observation, status, category_snapshot, kind_snapshot,
                             created_at, updated_at)
  select c.id, t, c.member_id, c.contribution_type_id, c.payment_method_id, round(c.amount, 2),
         etl.contrib_day(c.date), c.observation, 'ACTIVE', ct.category, pm.kind,
         coalesce(c.created_at, now()), coalesce(c.created_at, now())
    from legacy.contributions c
    join contribution_types ct on ct.tenant_id = t and ct.id = c.contribution_type_id
    join payment_methods pm    on pm.tenant_id = t and pm.id = c.payment_method_id;
  get diagnostics n = row_count; perform etl.log('contributions', n);

  -- 5. Despesas (exclusão lógica da v1 -> VOIDED) --------------------------------------
  insert into expenses (id, tenant_id, description, amount, occurred_on, category_id, notes, status,
                        voided_at, void_reason, origin, created_at, updated_at)
  select e.id, t, e.description, etl.money(e.value), etl.expense_day(e.date), e.category_id, e.notes,
         case when e.deleted_at is null then 'ACTIVE' else 'VOIDED' end,
         e.deleted_at,
         case when e.deleted_at is not null then 'Migrado da v1 (excluída logicamente)' end,
         case when exists (select 1 from legacy.payable_occurrences o where o.expense_id = e.id)
              then 'PAYABLE' else 'MANUAL' end,
         coalesce(e.created_at, now()), coalesce(e.deleted_at, e.created_at, now())
    from legacy.expenses e;
  get diagnostics n = row_count; perform etl.log('expenses', n);

  -- 6. Contas, ocorrências e pagamentos --------------------------------------------------
  insert into payables (id, tenant_id, description, type, category_id, amount, due_day, due_date,
                        start_date, active, notes, created_at, updated_at)
  select p.id, t, p.description, p.type, p.category_id, round(p.amount, 2), p.due_day, p.due_date,
         p.start_date, coalesce(p.active, true), p.notes,
         coalesce(p.created_at, now()), coalesce(p.updated_at, p.created_at, now())
    from legacy.payables p;
  get diagnostics n = row_count; perform etl.log('payables', n);

  insert into payable_occurrences (id, tenant_id, payable_id, competence_year, competence_month, due_date,
                                   amount, status, created_at, updated_at)
  select o.id, t, o.payable_id, o.competence_year, o.competence_month, o.due_date,
         round(p.amount, 2), o.status, coalesce(o.created_at, now()), coalesce(o.updated_at, o.created_at, now())
    from legacy.payable_occurrences o
    join legacy.payables p on p.id = o.payable_id;
  get diagnostics n = row_count; perform etl.log('payable_occurrences', n);

  insert into payments (tenant_id, occurrence_id, expense_id, paid_at, paid_amount, created_at)
  select t, o.id, o.expense_id, o.paid_at, round(o.paid_amount, 2), coalesce(o.updated_at, now())
    from legacy.payable_occurrences o
   where o.status = 'PAID';
  get diagnostics n = row_count; perform etl.log('payments', n);

    -- 7. Saldos mensais; a v1 não tem saldo em mãos, então meses fechados entram com zero.
    insert into monthly_balances (id, tenant_id, year, month, opening_balance, notes, closed_at,
              cash_on_hand, closing_snapshot, created_at, updated_at)
  select b.id, t, b.year, b.month, coalesce(round(b.opening_balance, 2), 0), b.notes, b.closed_at,
      case when b.closed_at is not null then 0 end,
         case when b.closed_at is not null
              then v2_month_snapshot(t, b.year, b.month, coalesce(round(b.opening_balance, 2), 0), 'V1_MIGRATION') end,
         coalesce(b.created_at, now()), coalesce(b.updated_at, b.created_at, now())
    from legacy.monthly_balances b;
  get diagnostics n = row_count; perform etl.log('monthly_balances', n);

  -- 8. Anexos: linhas já com o caminho NOVO; os arquivos são copiados por tools/copy-attachments.mjs
  create temp table _att on commit drop as
  select a.id as id, 'contributions'::text as entity, a.contribution_id as owner_id, a.path as src,
         coalesce(nullif(btrim(a.name), ''), regexp_replace(a.path, '^.*/', '')) as name, a.created_at
    from legacy.contribution_attachments a
  union all
  select a.id, 'expenses', a.expense_id, a.path,
         coalesce(nullif(btrim(a.name), ''), regexp_replace(a.path, '^.*/', '')), a.created_at
    from legacy.expense_attachments a
  union all
  select a.id, 'payables', a.payable_id, a.path,
         coalesce(nullif(btrim(a.name), ''), regexp_replace(a.path, '^.*/', '')), a.created_at
    from legacy.payable_attachments a
  union all   -- coluna legada expenses.attachment_url (anexo único) ainda não representado
  select md5('expense-url:' || e.id::text)::uuid, 'expenses', e.id, e.attachment_url,
         regexp_replace(split_part(e.attachment_url, '?', 1), '^.*/', ''), e.created_at
    from legacy.expenses e
   where nullif(btrim(e.attachment_url), '') is not null
     and not exists (select 1 from legacy.expense_attachments ea
                      where ea.expense_id = e.id and ea.path = e.attachment_url);

  insert into attachments (id, tenant_id, contribution_id, expense_id, payable_id, path, name,
                           status, created_at, confirmed_at)
  select a.id, t,
         case when a.entity = 'contributions' then a.owner_id end,
         case when a.entity = 'expenses'      then a.owner_id end,
         case when a.entity = 'payables'      then a.owner_id end,
         format('tenants/%s/%s/%s/%s-%s', t, a.entity, a.owner_id, a.id,
                right(regexp_replace(unaccent(a.name), '[^A-Za-z0-9._-]+', '_', 'g'), 120)),
         a.name, 'CONFIRMED', coalesce(a.created_at, now()), coalesce(a.created_at, now())
    from _att a;
  get diagnostics n = row_count; perform etl.log('attachments', n);

  insert into etl.attachment_copy (attachment_id, entity, owner_id, src_path, dst_path)
  select a.id, x.entity, x.owner_id, x.src, a.path
    from _att x join attachments a on a.id = x.id and a.tenant_id = t;

  -- 9. Auditoria legada ----------------------------------------------------------------------
  select min(created_at)::date, max(created_at)::date into d_min, d_max from legacy.audit_logs;
  if d_min is not null then
    d := date_trunc('month', d_min)::date;
    while d <= d_max loop
      perform v2_ensure_audit_partition(d);
      d := (d + interval '1 month')::date;
    end loop;
  end if;
  insert into audit_log (id, tenant_id, created_at, legacy_actor_id, action, entity, entity_id,
                         "before", "after", source)
  select l.id, t, coalesce(l.created_at, now()), l.user_id, coalesce(l.action, '?'), coalesce(l.entity, '?'),
         l.entity_id, l."before", l."after", 'V1'
    from legacy.audit_logs l;
  get diagnostics n = row_count; perform etl.log('audit_log', n);
end $$;
