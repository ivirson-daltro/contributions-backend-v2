-- Add updated_by column to contributions table for tracking who made edits
alter table contributions add column updated_by uuid;

-- Add index for audit tracking
create index contributions_updated_by_idx on contributions (tenant_id, updated_by);

-- Add foreign key constraint if users table exists in the schema
alter table contributions
  add constraint contributions_updated_by_fk
  foreign key (updated_by) references auth.users(id) on delete set null;
