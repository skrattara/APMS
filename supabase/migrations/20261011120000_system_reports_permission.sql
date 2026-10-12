insert into public.permissions (key, description)
values ('reports.export.system', 'Export operational system administration reports')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'reports.export.system'
where r.key = 'system_admin'
on conflict do nothing;
