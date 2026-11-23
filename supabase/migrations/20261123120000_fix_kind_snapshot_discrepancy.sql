-- Correction: Fix contributions that were incorrectly marked as CASH but should be PIX
-- These were migrated with kind_snapshot = NULL and incorrectly filled with CASH

alter table contributions disable trigger trg_v2_z_month_guard;

-- Correct specific contributions that were incorrectly marked as CASH but should be PIX
-- Identified by: amount, member_name, and contribution_type matching v1 data
update contributions c
set kind_snapshot = 'PIX'
where c.kind_snapshot = 'CASH'
  and c.amount in (54000, 5007)  -- R$ 540,00 and R$ 50,07 from Ivirson on 19/11/2026
  and c.occurred_on = '2026-11-19'
  and exists (
    select 1 from members m 
    where m.id = c.member_id 
    and m.tenant_id = c.tenant_id
    and m.name like '%Ivirson%'
  );

alter table contributions enable trigger trg_v2_z_month_guard;
