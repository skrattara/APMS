-- Allow Academic Admins to add students to active classes in their own
-- department, while keeping Faculty limited to classes they can access.
create or replace function public.faculty_upsert_student_enrollment(
  p_class_record_id uuid,
  p_program_id uuid,
  p_institutional_id text,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_year_level smallint,
  p_section text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  class_department_id uuid;
  resolved_student_id uuid;
begin
  if caller_id is null then raise exception 'Authentication required'; end if;

  select cr.department_id into class_department_id
  from public.class_records cr
  where cr.id = p_class_record_id and cr.status = 'active';
  if class_department_id is null then raise exception 'Active class record required'; end if;

  if not (
    (
      private.has_permission('students.manage.assigned')
      and private.can_access_class(p_class_record_id)
    )
    or (
      private.has_permission('class_records.manage.department')
      and private.is_academic_admin_for_department(class_department_id)
    )
  ) then
    raise exception 'Permission denied';
  end if;

  if btrim(coalesce(p_institutional_id, '')) = '' or btrim(coalesce(p_first_name, '')) = '' or btrim(coalesce(p_last_name, '')) = '' then
    raise exception 'Student ID and name are required';
  end if;
  if p_year_level not between 1 and 8 then raise exception 'Year level must be between 1 and 8'; end if;
  if not exists (
    select 1 from public.programs pr
    where pr.id = p_program_id and pr.department_id = class_department_id and pr.status = 'active'
  ) then
    raise exception 'Program is outside the class department or inactive';
  end if;

  select s.id into resolved_student_id
  from public.students s
  where lower(s.institutional_id) = lower(btrim(p_institutional_id));
  if resolved_student_id is null then
    insert into public.students(program_id, institutional_id, email, first_name, last_name, year_level, section, status)
    values (p_program_id, btrim(p_institutional_id), lower(btrim(p_email)), btrim(p_first_name), btrim(p_last_name), p_year_level, btrim(p_section), 'active')
    returning id into resolved_student_id;
  end if;

  insert into public.enrollments(student_id, class_record_id, status)
  values (resolved_student_id, p_class_record_id, 'active')
  on conflict (student_id, class_record_id) do update
    set status = 'active', ended_at = null, updated_at = now();

  return resolved_student_id;
end
$$;

revoke all on function public.faculty_upsert_student_enrollment(uuid, uuid, text, text, text, text, smallint, text) from public, anon;
grant execute on function public.faculty_upsert_student_enrollment(uuid, uuid, text, text, text, text, smallint, text) to authenticated;

-- Keep roster import records owned by the initiating user. Academic Admins
-- may create import jobs only for class records in their authorized department.
drop policy if exists imports_scoped on public.import_jobs;
create policy imports_scoped on public.import_jobs
for all to authenticated
using (
  initiated_by = (select auth.uid())
  or (select private.has_permission('integrations.manage'))
)
with check (
  initiated_by = (select auth.uid())
  and (
    (select private.has_permission('imports.manage.assigned'))
    or (select private.has_permission('integrations.manage'))
    or (
      scope_type = 'class_record'
      and (select private.has_permission('class_records.manage.department'))
      and exists (
        select 1
        from public.class_records cr
        where cr.id = scope_id
          and private.is_academic_admin_for_department(cr.department_id)
      )
    )
  )
);
