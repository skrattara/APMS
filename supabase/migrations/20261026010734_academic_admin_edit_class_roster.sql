-- Allow Academic Admins to edit student details only for students enrolled
-- in classes within their authorized department.
drop policy if exists students_academic_admin_class_roster_update on public.students;
create policy students_academic_admin_class_roster_update
  on public.students
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.enrollments e
      join public.class_records cr on cr.id = e.class_record_id
      where e.student_id = students.id
        and private.can_access_class(cr.id)
        and private.can_manage_academic_department(cr.department_id, 'class_records.manage.department')
    )
  )
  with check (
    exists (
      select 1
      from public.programs pr
      join public.enrollments e on e.student_id = students.id
      join public.class_records cr on cr.id = e.class_record_id
        and cr.department_id = pr.department_id
      where pr.id = students.program_id
        and private.can_access_class(cr.id)
        and private.can_manage_academic_department(cr.department_id, 'class_records.manage.department')
    )
  );
