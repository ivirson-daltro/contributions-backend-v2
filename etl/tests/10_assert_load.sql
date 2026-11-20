\set ON_ERROR_STOP on
do $$
declare t uuid := 'a1b2c3d4-0000-4000-8000-000000000001';
begin
  assert (select count(*) from members where tenant_id = t) = 4;
  assert (select count(*) from contributions where tenant_id = t) = 7;
  assert (select count(*) from expenses where tenant_id = t) = 5;
  -- dia de negócio: contribuição 00:00 sem fuso mantém o dia (modo LOCAL)
  assert (select occurred_on from contributions where id = '60000000-0000-4000-8000-000000000001') = date '2026-10-04';
  -- despesa 23:30-03 fica no dia 15 (fuso do tenant), não no 16 (UTC)
  assert (select occurred_on from expenses where id = '70000000-0000-4000-8000-000000000002') = date '2026-10-15';
  -- real: 320.45 exato; 200000.37 perde precisão na origem (real) mas é o que a v1 tem => registrado
  assert (select amount from expenses where id = '70000000-0000-4000-8000-000000000001') = 320.45;
  -- exclusão lógica -> VOIDED, com motivo
  assert (select status from expenses where id = '70000000-0000-4000-8000-000000000003') = 'VOIDED';
  assert (select voided_at is not null and void_reason is not null from expenses where id = '70000000-0000-4000-8000-000000000003');
  -- despesa que pagou conta é de origem PAYABLE
  assert (select origin from expenses where id = '70000000-0000-4000-8000-000000000004') = 'PAYABLE';
  -- snapshots do catálogo
  assert (select category_snapshot || '/' || kind_snapshot from contributions where id = '60000000-0000-4000-8000-000000000001') = 'TITHE/PIX';
  assert (select category_snapshot from contributions where id = '60000000-0000-4000-8000-000000000004') = 'CONSTRUCTION_OFFERING';
  assert (select category_snapshot from contributions where id = '60000000-0000-4000-8000-000000000006') = 'OTHER';
  assert (select requires_member from contribution_types where id = '30000000-0000-4000-8000-000000000002') = false, 'Oferta não exige membro';
  assert (select kind from payment_methods where id = '40000000-0000-4000-8000-000000000004') = 'OTHER';
  -- pagamento projetado da ocorrência paga
  assert (select count(*) from payments where tenant_id = t and status = 'ACTIVE') = 1;
  assert (select paid_amount from payments where occurrence_id = 'a0000000-0000-4000-8000-000000000001') = 300.10;
  -- previsto "congelado" na ocorrência
  assert (select amount from payable_occurrences where id = 'a0000000-0000-4000-8000-000000000001') = 300.00;
  -- mês fechado ganhou foto; mês aberto não
  assert (select closing_snapshot is not null from monthly_balances where id = 'b0000000-0000-4000-8000-000000000001');
  assert (select closing_snapshot is null from monthly_balances where id = 'b0000000-0000-4000-8000-000000000002');
  assert (select (closing_snapshot->>'expense')::numeric from monthly_balances where id = 'b0000000-0000-4000-8000-000000000001') = 300.10;
  -- anexos: 3 + attachment_url legado, todos com o caminho novo por tenant, planejados para cópia
  assert (select count(*) from attachments where tenant_id = t) = 3;
  assert not exists (select 1 from attachments where path not like 'tenants/' || t::text || '/%');
  assert (select count(*) from etl.attachment_copy where status = 'PLANNED') = 3;
  assert (select src_path from etl.attachment_copy where entity = 'expenses' and owner_id = '70000000-0000-4000-8000-000000000005')
         = 'expenses/70000000-0000-4000-8000-000000000005/recibo.pdf';
  -- auditoria legada
  assert (select count(*) from audit_log where tenant_id = t and source = 'V1') = 1;
  -- taxas do tenant #1
  assert (select rounding from fee_rules where tenant_id = t and name = 'ASBARE') = 'LEGACY_CENTS_09';
  -- membro excluído na v1 virou INACTIVE com deleted_at
  assert (select status = 'INACTIVE' and deleted_at is not null from members where id = '20000000-0000-4000-8000-000000000003');
  -- revisão de catálogo registrada
  assert (select count(*) from etl.catalog_review) = 10;
  -- nada de tabelas da v1 em public
  assert to_regclass('public.app_users') is null;
end $$;
\echo '[ok] 10_assert_load'
