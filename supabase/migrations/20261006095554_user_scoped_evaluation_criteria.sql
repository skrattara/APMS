-- Store an Academic Admin's private evaluation draft separately from the active
-- department definition. Availability scope is persisted here, outside the JSON
-- schema, so it cannot alter grading/evaluation semantics.
alter table public.evaluation_systems
  add column if not exists updated_by_name text;

update public.evaluation_systems es
set updated_by_name = nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')
from public.profiles p
where p.id = es.updated_by and es.updated_by_name is null;

create table if not exists public.user_evaluation_systems (
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  definition jsonb not null,
  updated_by uuid not null references public.profiles(id),
  updated_by_name text not null,
  updated_at timestamptz not null default now(),
  primary key (department_id, user_id),
  check (updated_by = user_id)
);

alter table public.user_evaluation_systems enable row level security;
revoke all on public.user_evaluation_systems from anon;
grant select, insert, update on public.user_evaluation_systems to authenticated;

create policy user_evaluation_systems_read on public.user_evaluation_systems
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  );

create policy user_evaluation_systems_insert on public.user_evaluation_systems
  for insert to authenticated
  with check (
    user_id = (select auth.uid()) and updated_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  );

create policy user_evaluation_systems_update on public.user_evaluation_systems
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  )
  with check (
    user_id = (select auth.uid()) and updated_by = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid()) and ur.scope_type = 'department'
        and ur.scope_id = department_id and r.key = 'academic_admin'
        and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
    )
  );
