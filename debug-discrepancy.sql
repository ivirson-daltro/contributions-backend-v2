-- Find contributions that should be PIX but are marked as CASH
-- Based on the discrepancy between v1 and v2 reports

select 
  c.id,
  c.occurred_on,
  c.amount,
  m.name,
  ct.description as contribution_type,
  pm.description as payment_method,
  pm.kind as payment_method_kind,
  c.kind_snapshot,
  case 
    when c.kind_snapshot = 'CASH' and c.amount in (54000, 5007) and m.name like '%Ivirson%' then 'SHOULD BE PIX'
    else 'OK'
  end as status
from contributions c
left join members m on m.id = c.member_id and m.tenant_id = c.tenant_id
left join contribution_types ct on ct.id = c.contribution_type_id and ct.tenant_id = c.tenant_id
left join payment_methods pm on pm.id = c.payment_method_id and pm.tenant_id = c.tenant_id
where c.occurred_on between '2026-11-19' and '2026-11-19'
  and (c.amount = 54000 or c.amount = 5007)
  and m.name like '%Ivirson%'
order by c.occurred_on, c.amount desc;
