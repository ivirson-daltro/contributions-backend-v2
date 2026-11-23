-- Populate kind_snapshot for existing contributions that have NULL values
-- This handles contributions created before kind_snapshot was properly captured

update contributions c
set kind_snapshot = pm.kind
from payment_methods pm
where c.tenant_id = pm.tenant_id
  and c.payment_method_id = pm.id
  and c.kind_snapshot is null;

-- Ensure kind_snapshot is NOT NULL (if there are still nulls after the update, set them to 'OTHER')
update contributions
set kind_snapshot = 'OTHER'
where kind_snapshot is null;

-- Add a constraint to prevent NULL kind_snapshot in the future
alter table contributions alter column kind_snapshot set not null;
