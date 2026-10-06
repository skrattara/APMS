-- Keep Academic Admin-only criteria assignments private to the Academic Admin who applied them.
create table if not exists public.academic_admin_class_evaluation_systems (
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  definition jsonb not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (class_record_id, user_id),
  check (updated_by = user_id)
);

create index if not exists academic_admin_class_evaluation_systems_user_department_idx
  on public.academic_admin_class_evaluation_systems (user_id, department_id);

alter table public.academic_admin_class_evaluation_systems enable row level security;
revoke all on public.academic_admin_class_evaluation_systems from anon;
grant select, insert, update, delete on public.academic_admin_class_evaluation_systems to authenticated;

create policy academic_admin_class_evaluation_systems_read
  on public.academic_admin_class_evaluation_systems
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and r.key = 'academic_admin'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
  );

create policy academic_admin_class_evaluation_systems_insert
  on public.academic_admin_class_evaluation_systems
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and updated_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and r.key = 'academic_admin'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
    and exists (
      select 1 from public.class_records cr
      where cr.id = academic_admin_class_evaluation_systems.class_record_id
        and cr.department_id = academic_admin_class_evaluation_systems.department_id
    )
  );

create policy academic_admin_class_evaluation_systems_update
  on public.academic_admin_class_evaluation_systems
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and r.key = 'academic_admin'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
    and exists (
      select 1 from public.class_records cr
      where cr.id = academic_admin_class_evaluation_systems.class_record_id
        and cr.department_id = academic_admin_class_evaluation_systems.department_id
    )
  )
  with check (
    user_id = (select auth.uid())
    and updated_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and r.key = 'academic_admin'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
    and exists (
      select 1 from public.class_records cr
      where cr.id = academic_admin_class_evaluation_systems.class_record_id
        and cr.department_id = academic_admin_class_evaluation_systems.department_id
    )
  );

create policy academic_admin_class_evaluation_systems_delete
  on public.academic_admin_class_evaluation_systems
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and r.key = 'academic_admin'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
    and exists (
      select 1 from public.class_records cr
      where cr.id = academic_admin_class_evaluation_systems.class_record_id
        and cr.department_id = academic_admin_class_evaluation_systems.department_id
    )
  );
