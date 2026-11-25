create table tenant_logos (
  tenant_id uuid primary key references tenants(id),
  object_key text not null,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp'))
);

alter table tenant_logos enable row level security;
create policy tenant_logos_isolation on tenant_logos
  using (tenant_id = app_tenant_id())
  with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on tenant_logos to ibg_api;
revoke all on tenant_logos from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-logos', 'tenant-logos', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'tenant-logos' and public) then
    raise exception 'O bucket tenant-logos deve ser privado';
  end if;
end $$;
