-- Ensure all payment_methods have a kind value
-- This migration handles cases where payment_methods were created without the kind column
-- or where existing records have null kind values

-- If kind column doesn't exist, add it
do $$
begin
  if not exists (select 1 from information_schema.columns 
                 where table_name='payment_methods' and column_name='kind') then
    alter table payment_methods add column kind text check (kind in ('CASH','PIX','CARD','TRANSFER','CHECK','OTHER'));
  end if;
end $$;

-- Update any null kind values based on description patterns
update payment_methods
set kind = case
  when app_norm(description) like '%pix%' then 'PIX'
  when app_norm(description) like '%dinheiro%' or app_norm(description) like '%cash%' then 'CASH'
  when app_norm(description) like '%cartão%' or app_norm(description) like '%card%' then 'CARD'
  when app_norm(description) like '%transfer%' then 'TRANSFER'
  when app_norm(description) like '%cheque%' or app_norm(description) like '%check%' then 'CHECK'
  else 'OTHER'
end
where kind is null;

-- Make kind NOT NULL (if it wasn't already)
alter table payment_methods alter column kind set not null;
