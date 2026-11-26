alter table tenant_settings
  add column dashboard_contribution_type_id uuid,
  add constraint tenant_settings_dashboard_contribution_type_fk
    foreign key (tenant_id, dashboard_contribution_type_id)
    references contribution_types (tenant_id, id);
