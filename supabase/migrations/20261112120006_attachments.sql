-- =============================================================================
-- IBG v2 · BANCO NOVO 06/10 · Anexos unificados
-- -----------------------------------------------------------------------------
-- Uma tabela para contribuição, despesa e conta. Arquivo no Storage em
-- tenants/{tenant_id}/{entidade}/{id}/{arquivo}. Upload em duas fases:
-- PENDING (arquivo enviado, lançamento ainda não salvo) -> CONFIRMED -> REMOVED.
-- =============================================================================

create table attachments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  contribution_id uuid,
  expense_id      uuid,
  payable_id      uuid,
  path            text not null,
  name            text not null,
  mime_type       text,
  size_bytes      bigint check (size_bytes is null or size_bytes >= 0),
  status          text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','REMOVED')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  removed_at      timestamptz,
  constraint attachments_contribution_fk foreign key (tenant_id, contribution_id)
    references contributions (tenant_id, id) on delete restrict,
  constraint attachments_expense_fk foreign key (tenant_id, expense_id)
    references expenses (tenant_id, id) on delete restrict,
  constraint attachments_payable_fk foreign key (tenant_id, payable_id)
    references payables (tenant_id, id) on delete restrict,
  -- PENDING pode não ter dono ainda; os demais têm exatamente um
  constraint attachments_owner_ck
    check (status = 'PENDING' or num_nonnulls(contribution_id, expense_id, payable_id) = 1),
  constraint attachments_path_ck check (path like 'tenants/' || tenant_id::text || '/%')
);
create index attachments_contribution_idx on attachments (tenant_id, contribution_id) where contribution_id is not null;
create index attachments_expense_idx      on attachments (tenant_id, expense_id)      where expense_id is not null;
create index attachments_payable_idx      on attachments (tenant_id, payable_id)      where payable_id is not null;
create index attachments_pending_idx      on attachments (created_at) where status = 'PENDING';
