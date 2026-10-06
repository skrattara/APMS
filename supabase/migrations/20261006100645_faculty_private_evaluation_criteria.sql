-- Faculty evaluation overrides are private to their author and scoped to classes
-- where that author has an active instructor or co-instructor assignment.
create table if not exists public.faculty_class_evaluation_systems (
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  faculty_user_id uuid not null references public.profiles(id) on delete cascade,
  definition jsonb not null,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (class_record_id, faculty_user_id),
  check (updated_by = faculty_user_id)
);

create index if not exists faculty_class_evaluation_systems_user_idx
  on public.faculty_class_evaluation_systems (faculty_user_id, updated_at desc);

alter table public.faculty_class_evaluation_systems enable row level security;
revoke all on public.faculty_class_evaluation_systems from anon;
grant select, insert, update, delete on public.faculty_class_evaluation_systems to authenticated;

create policy faculty_class_evaluation_systems_read on public.faculty_class_evaluation_systems
  for select to authenticated
  using (
    faculty_user_id = (select auth.uid())
    and exists (
      select 1 from public.faculty_assignments fa
      join public.faculty_profiles fp on fp.id = fa.faculty_id
      where fa.class_record_id = faculty_class_evaluation_systems.class_record_id
        and fp.profile_id = (select auth.uid())
        and fp.status = 'active'
        and fa.status = 'active'
        and fa.assignment_role in ('instructor', 'co_instructor')
    )
  );

create policy faculty_class_evaluation_systems_insert on public.faculty_class_evaluation_systems
  for insert to authenticated
  with check (
    faculty_user_id = (select auth.uid()) and updated_by = (select auth.uid())
    and exists (
      select 1 from public.faculty_assignments fa
      join public.faculty_profiles fp on fp.id = fa.faculty_id
      where fa.class_record_id = faculty_class_evaluation_systems.class_record_id
        and fp.profile_id = (select auth.uid())
        and fp.status = 'active'
        and fa.status = 'active'
        and fa.assignment_role in ('instructor', 'co_instructor')
    )
  );

create policy faculty_class_evaluation_systems_update on public.faculty_class_evaluation_systems
  for update to authenticated
  using (
    faculty_user_id = (select auth.uid())
    and exists (
      select 1 from public.faculty_assignments fa
      join public.faculty_profiles fp on fp.id = fa.faculty_id
      where fa.class_record_id = faculty_class_evaluation_systems.class_record_id
        and fp.profile_id = (select auth.uid())
        and fp.status = 'active'
        and fa.status = 'active'
        and fa.assignment_role in ('instructor', 'co_instructor')
    )
  )
  with check (
    faculty_user_id = (select auth.uid()) and updated_by = (select auth.uid())
    and exists (
      select 1 from public.faculty_assignments fa
      join public.faculty_profiles fp on fp.id = fa.faculty_id
      where fa.class_record_id = faculty_class_evaluation_systems.class_record_id
        and fp.profile_id = (select auth.uid())
        and fp.status = 'active'
        and fa.status = 'active'
        and fa.assignment_role in ('instructor', 'co_instructor')
    )
  );

create policy faculty_class_evaluation_systems_delete on public.faculty_class_evaluation_systems
  for delete to authenticated
  using (
    faculty_user_id = (select auth.uid())
    and exists (
      select 1 from public.faculty_assignments fa
      join public.faculty_profiles fp on fp.id = fa.faculty_id
      where fa.class_record_id = faculty_class_evaluation_systems.class_record_id
        and fp.profile_id = (select auth.uid())
        and fp.status = 'active'
        and fa.status = 'active'
        and fa.assignment_role in ('instructor', 'co_instructor')
    )
  );
