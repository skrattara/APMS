-- Create initial year-level records and the student ID validation setting.
-- The following migration scopes year-level options to individual programs.
create table if not exists public.year_levels (
  level smallint primary key check (level between 1 and 8),
  label text not null check (length(btrim(label)) between 1 and 80),
  sort_order smallint not null default 0
);

alter table public.year_levels enable row level security;
grant select, insert, update, delete on public.year_levels to authenticated;

create policy year_levels_read_authenticated on public.year_levels
  for select to authenticated using (true);

insert into public.permissions(key, description)
values ('year_levels.manage', 'Manage institution-wide student year-level options')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'year_levels.manage'
where r.key = 'academic_admin'
on conflict do nothing;

create policy year_levels_manage_academic_admin on public.year_levels
  for all to authenticated
  using (private.has_permission('year_levels.manage'))
  with check (private.has_permission('year_levels.manage'));

insert into public.year_levels(level, label, sort_order)
select levels.level, 'Year ' || levels.level::text, levels.level
from (
  select distinct year_level::smallint as level
  from public.students
  where year_level between 1 and 8
  union
  select generate_series(1, 4)::smallint
  where not exists (select 1 from public.students)
) as levels
on conflict (level) do nothing;

-- The setting is globally readable only for authenticated app sessions;
-- writes continue to use the existing system.configure policy.
insert into public.system_settings(key, value)
values ('student_id.validation_enabled', 'false'::jsonb)
on conflict (key) do nothing;

create policy student_id_validation_setting_read on public.system_settings
  for select to authenticated using (key = 'student_id.validation_enabled');
