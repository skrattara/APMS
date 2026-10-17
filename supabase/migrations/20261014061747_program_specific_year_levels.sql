-- Convert institution-wide year levels to options owned by each academic program.
alter table public.year_levels
  add column if not exists program_id uuid references public.programs(id) on delete cascade;
alter table public.year_levels drop constraint if exists year_levels_pkey;

insert into public.year_levels(program_id, level, label, sort_order)
select program.id, level.level, coalesce(existing.label, 'Year ' || level.level::text), level.level
from public.programs program
cross join generate_series(1, 4) as level(level)
left join public.year_levels existing
  on existing.program_id is null and existing.level = level.level
on conflict do nothing;

-- Keep options for any higher levels already used by students in that program.
insert into public.year_levels(program_id, level, label, sort_order)
select distinct students.program_id, students.year_level, 'Year ' || students.year_level::text, students.year_level
from public.students
where students.program_id is not null and students.year_level between 1 and 8
on conflict do nothing;

delete from public.year_levels where program_id is null;

alter table public.year_levels alter column program_id set not null;
alter table public.year_levels add constraint year_levels_pkey primary key (program_id, level);

drop policy if exists year_levels_manage_academic_admin on public.year_levels;
drop policy if exists year_levels_read_authenticated on public.year_levels;

create policy year_levels_read_authenticated on public.year_levels
  for select to authenticated using (true);

insert into public.permissions(key, description)
values ('year_levels.manage.department', 'Manage year-level options for programs in the authorized department')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions(role_id, permission_id)
select roles.id, permissions.id
from public.roles
join public.permissions on permissions.key = 'year_levels.manage.department'
where roles.key = 'academic_admin'
on conflict do nothing;

delete from public.role_permissions
using public.roles, public.permissions
where role_permissions.role_id = roles.id
  and role_permissions.permission_id = permissions.id
  and roles.key = 'academic_admin'
  and permissions.key = 'year_levels.manage';

create policy year_levels_manage_academic_admin on public.year_levels
  for all to authenticated
  using (
    exists (
      select 1 from public.programs program
      where program.id = year_levels.program_id
        and private.can_manage_academic_department(program.department_id, 'year_levels.manage.department')
    )
  )
  with check (
    exists (
      select 1 from public.programs program
      where program.id = year_levels.program_id
        and private.can_manage_academic_department(program.department_id, 'year_levels.manage.department')
    )
  );
