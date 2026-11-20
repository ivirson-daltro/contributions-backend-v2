-- =============================================================================
-- IBG v2 · BANCO NOVO 05/10 · Contas a pagar, ocorrências e pagamentos
-- -----------------------------------------------------------------------------
-- A baixa é um registro em `payments` (histórico; estorno não perde rastro). A ocorrência
-- guarda só o previsto e o status.
-- =============================================================================

create table payables (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  description text,
  type        text not null check (type in ('MONTHLY','ONCE')),
  category_id uuid,
  amount      numeric(14,2),
  due_day     int,
  due_date    date,
  start_date  date,
  end_date    date,
  active      boolean not null default true,
  notes       text,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint payables_tenant_id_uk unique (tenant_id, id),
  constraint payables_due_ck check (
    (type = 'MONTHLY' and due_day between 1 and 31) or (type = 'ONCE' and due_date is not null)),
  constraint payables_category_fk foreign key (tenant_id, category_id)
    references expense_categories (tenant_id, id)
);
create index payables_tenant_idx on payables (tenant_id, active);

create table payable_occurrences (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  payable_id       uuid not null,
  competence_year  int  not null,
  competence_month int  not null check (competence_month between 1 and 12),
  due_date         date,
  amount           numeric(14,2),     -- previsto "congelado" na geração
  status           text not null default 'OPEN' check (status in ('OPEN','PAID','CANCELED')),
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint payable_occurrences_tenant_id_uk unique (tenant_id, id),
  constraint payable_occ_period_uk unique (payable_id, competence_year, competence_month),
  constraint payable_occ_payable_fk foreign key (tenant_id, payable_id)
    references payables (tenant_id, id)
);
create index payable_occ_status_idx on payable_occurrences (tenant_id, status, due_date);
create index payable_occ_comp_idx   on payable_occurrences (tenant_id, competence_year, competence_month);

create trigger trg_v2_touch before update on payable_occurrences
  for each row execute function v2_touch_updated_at();

create table payments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  occurrence_id  uuid not null,
  expense_id     uuid,
  paid_at        date not null,
  paid_amount    numeric(14,2) not null check (paid_amount > 0),
  notes          text,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','REVERSED')),
  reversed_at    timestamptz,
  reversed_by    uuid,
  reverse_reason text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  constraint payments_expense_required_ck check (status = 'REVERSED' or expense_id is not null),
  constraint payments_reversed_ck check ((status = 'REVERSED') = (reversed_at is not null)),
  constraint payments_occurrence_fk foreign key (tenant_id, occurrence_id)
    references payable_occurrences (tenant_id, id) on delete restrict,
  constraint payments_expense_fk foreign key (tenant_id, expense_id)
    references expenses (tenant_id, id) on delete restrict
);
-- no máximo um pagamento ativo por ocorrência
create unique index payments_one_active on payments (occurrence_id) where status = 'ACTIVE';
create index payments_tenant_paid_idx on payments (tenant_id, paid_at);
create index payments_expense_idx on payments (expense_id) where expense_id is not null;
