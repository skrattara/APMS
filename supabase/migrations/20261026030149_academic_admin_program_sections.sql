-- Sections are catalogued by program and year level. Their labels are rendered
-- from the program/year context instead of storing department-specific text.
create table public.program_sections (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null,
  year_level integer not null,
  section_number integer not null check (section_number between 1 and 99),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint program_sections_program_year_fk
    foreign key (program_id, year_level)
    references public.year_levels(program_id, level) on delete cascade,
  constraint program_sections_program_year_number_key
    unique (program_id, year_level, section_number)
);

create index program_sections_program_year_idx
  on public.program_sections(program_id, year_level, section_number);

alter table public.program_sections enable row level security;
grant select, insert, update, delete on public.program_sections to authenticated;

create policy program_sections_read_authenticated
  on public.program_sections for select to authenticated
  using (true);

insert into public.permissions(key, description)
values ('program_sections.manage.department', 'Manage program sections for programs in the authorized department')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions(role_id, permission_id)
select roles.id, permissions.id
from public.roles
join public.permissions on permissions.key = 'program_sections.manage.department'
where roles.key = 'academic_admin'
on conflict do nothing;

create policy program_sections_manage_academic_admin
  on public.program_sections for all to authenticated
  using (
    exists (
      select 1 from public.programs program
      where program.id = program_sections.program_id
        and private.can_manage_academic_department(program.department_id, 'program_sections.manage.department')
    )
  )
  with check (
    exists (
      select 1 from public.programs program
      where program.id = program_sections.program_id
        and private.can_manage_academic_department(program.department_id, 'program_sections.manage.department')
    )
  );
