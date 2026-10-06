create table if not exists public.evaluation_systems (
  department_id uuid primary key references public.departments(id) on delete cascade,
  definition jsonb not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now()
);

alter table public.evaluation_systems enable row level security;
grant select, insert, update on public.evaluation_systems to authenticated;
revoke all on public.evaluation_systems from anon;

create policy evaluation_systems_read on public.evaluation_systems for select to authenticated
  using (true);

create policy evaluation_systems_insert on public.evaluation_systems for insert to authenticated
  with check (
    updated_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  );

create policy evaluation_systems_update on public.evaluation_systems for update to authenticated
  using (
    exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  )
  with check (
    updated_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  );
