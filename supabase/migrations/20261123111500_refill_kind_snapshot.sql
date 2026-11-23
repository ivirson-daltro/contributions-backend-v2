-- Refill kind_snapshot for all contributions that still have NULL value
-- This ensures the report PDF shows the correct payment method names

alter table contributions disable trigger trg_v2_z_month_guard;

update contributions c
set kind_snapshot = pm.kind
from payment_methods pm
where c.payment_method_id = pm.id
  and c.tenant_id = pm.tenant_id
  and c.kind_snapshot is null;

alter table contributions enable trigger trg_v2_z_month_guard;
