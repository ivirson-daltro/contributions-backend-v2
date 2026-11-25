alter table tenant_logos drop constraint tenant_logos_pkey;
alter table tenant_logos add column theme text not null default 'LIGHT'
  check (theme in ('LIGHT', 'DARK'));
alter table tenant_logos add primary key (tenant_id, theme);
