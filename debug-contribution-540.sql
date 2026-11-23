-- Debug: Check the contribution from Ivirson Mauricio Daltro on 19/11/2026
select 
  c.id,
  c.occurred_on,
  c.member_id,
  m.name as member_name,
  c.contribution_type_id,
  ct.description as type_description,
  c.payment_method_id,
  pm.description as payment_method_desc,
  pm.kind as payment_method_kind,
  c.kind_snapshot,
  c.amount,
  c.status
from contributions c
left join members m on m.id = c.member_id
left join contribution_types ct on ct.id = c.contribution_type_id
left join payment_methods pm on pm.id = c.payment_method_id
where c.amount = 54000  -- R$ 540,00 in cents
  and c.occurred_on = '2026-11-19'
  and m.name like '%Ivirson%'
order by c.occurred_on;