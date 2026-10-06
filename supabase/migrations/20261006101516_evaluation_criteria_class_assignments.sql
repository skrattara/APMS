-- Evaluation definitions are reusable within a department and can be assigned
-- to classes independently, matching the grading-system assignment model.
create table if not exists public.evaluation_criteria_systems (
  id uuid not null,
  department_id uuid not null references public.departments(id) on delete cascade,
  name text not null,
  definition jsonb not null,
  version integer not null default 1 check (version > 0),
  updated_by uuid not null references public.profiles(id),
  updated_by_name text,
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (id, department_id)
);

insert into public.evaluation_criteria_systems (id, department_id, name, definition, version, updated_by, updated_by_name, updated_at)
select (es.definition ->> 'id')::uuid, es.department_id,
       coalesce(nullif(trim(es.definition ->> 'name'), ''), 'Student Performance Evaluation'),
       es.definition, greatest(coalesce((es.definition ->> 'definitionVersion')::integer, 1), 1),
       es.updated_by, es.updated_by_name, es.updated_at
from public.evaluation_systems es
where es.definition ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
on conflict (id) do update set
  department_id = excluded.department_id,
  name = excluded.name,
  definition = excluded.definition,
  version = excluded.version,
  updated_by = excluded.updated_by,
  updated_by_name = excluded.updated_by_name,
  updated_at = excluded.updated_at;

create unique index if not exists evaluation_criteria_systems_name_idx
  on public.evaluation_criteria_systems (department_id, lower(btrim(name)));
create index if not exists evaluation_criteria_systems_updated_idx
  on public.evaluation_criteria_systems (department_id, updated_at desc);

create table if not exists public.class_evaluation_criteria (
  class_record_id uuid primary key references public.class_records(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  evaluation_system_id uuid not null,
  assigned_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  foreign key (evaluation_system_id, department_id)
    references public.evaluation_criteria_systems(id, department_id) on delete cascade
);

create index if not exists class_evaluation_criteria_department_idx
  on public.class_evaluation_criteria (department_id, evaluation_system_id);

alter table public.evaluation_criteria_systems enable row level security;
alter table public.class_evaluation_criteria enable row level security;
revoke all on public.evaluation_criteria_systems, public.class_evaluation_criteria from anon;
grant select, insert, update, delete on public.evaluation_criteria_systems to authenticated;
grant select, insert, update, delete on public.class_evaluation_criteria to authenticated;

create policy evaluation_criteria_systems_read on public.evaluation_criteria_systems
  for select to authenticated using (
    exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
    or exists (
      select 1 from public.faculty_profiles fp
      join public.faculty_assignments fa on fa.faculty_id = fp.id
      join public.class_records cr on cr.id = fa.class_record_id
      where fp.profile_id = (select auth.uid()) and fp.status = 'active'
        and fa.status = 'active' and fa.assignment_role in ('instructor', 'co_instructor')
        and cr.department_id = evaluation_criteria_systems.department_id
    )
  );

create policy evaluation_criteria_systems_insert on public.evaluation_criteria_systems
  for insert to authenticated with check (
    exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    ) and updated_by = (select auth.uid())
  );

create policy evaluation_criteria_systems_update on public.evaluation_criteria_systems
  for update to authenticated
  using (exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
      and ur.scope_id = department_id and r.key = 'academic_admin'
      and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
  ))
  with check (
    exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    ) and updated_by = (select auth.uid())
  );

create policy evaluation_criteria_systems_delete on public.evaluation_criteria_systems
  for delete to authenticated using (exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
      and ur.scope_id = department_id and r.key = 'academic_admin'
      and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
  ));

create policy class_evaluation_criteria_read on public.class_evaluation_criteria
  for select to authenticated using (
    exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
    or exists (
      select 1 from public.faculty_profiles fp join public.faculty_assignments fa on fa.faculty_id = fp.id
      where fp.profile_id = (select auth.uid()) and fp.status = 'active'
        and fa.class_record_id = class_evaluation_criteria.class_record_id
        and fa.status = 'active' and fa.assignment_role in ('instructor', 'co_instructor')
    )
  );

create policy class_evaluation_criteria_insert on public.class_evaluation_criteria
  for insert to authenticated with check (
    assigned_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
    and exists (select 1 from public.class_records cr where cr.id = class_evaluation_criteria.class_record_id and cr.department_id = class_evaluation_criteria.department_id)
  );

create policy class_evaluation_criteria_update on public.class_evaluation_criteria
  for update to authenticated
  using (exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
      and ur.scope_id = department_id and r.key = 'academic_admin'
      and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
  ))
  with check (
    assigned_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
    and exists (select 1 from public.class_records cr where cr.id = class_evaluation_criteria.class_record_id and cr.department_id = class_evaluation_criteria.department_id)
  );

create policy class_evaluation_criteria_delete on public.class_evaluation_criteria
  for delete to authenticated using (exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
      and ur.scope_id = department_id and r.key = 'academic_admin'
      and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
  ));
