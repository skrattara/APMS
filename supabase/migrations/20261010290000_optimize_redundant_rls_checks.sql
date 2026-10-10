-- Avoid repeating class access checks inside policy subqueries. The referenced
-- enrollments/assessments rows remain protected by their own SELECT policies.
drop policy if exists students_scoped_read on public.students;
create policy students_scoped_read
  on public.students
  for select
  to authenticated
  using (
    profile_id = auth.uid()
    or exists (
      select 1
      from public.enrollments e
      where e.student_id = students.id
    )
    or private.has_permission('students.manage.department')
  );

drop policy if exists assessment_results_scoped_read on public.assessment_results;
create policy assessment_results_scoped_read
  on public.assessment_results
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.assessments a
      where a.id = assessment_results.assessment_id
    )
  );

-- Keep read policies focused on class visibility, and apply management
-- permissions only to writes. The predicates are the same as the former
-- FOR ALL policies for their corresponding commands.
drop policy if exists enrollments_scoped_manage on public.enrollments;
create policy enrollments_scoped_insert
  on public.enrollments
  for insert
  to authenticated
  with check (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('class_records.manage.assigned')
      or private.has_permission('class_records.manage.department')
    )
  );
create policy enrollments_scoped_update
  on public.enrollments
  for update
  to authenticated
  using (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('class_records.manage.assigned')
      or private.has_permission('class_records.manage.department')
    )
  )
  with check (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('class_records.manage.assigned')
      or private.has_permission('class_records.manage.department')
    )
  );
create policy enrollments_scoped_delete
  on public.enrollments
  for delete
  to authenticated
  using (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('class_records.manage.assigned')
      or private.has_permission('class_records.manage.department')
    )
  );

drop policy if exists assessments_scoped_manage on public.assessments;
create policy assessments_scoped_insert
  on public.assessments
  for insert
  to authenticated
  with check (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  );
create policy assessments_scoped_update
  on public.assessments
  for update
  to authenticated
  using (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  )
  with check (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  );
create policy assessments_scoped_delete
  on public.assessments
  for delete
  to authenticated
  using (
    private.can_access_class(class_record_id)
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  );

drop policy if exists results_scoped_manage on public.assessment_results;
create policy results_scoped_insert
  on public.assessment_results
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.assessments a
      where a.id = assessment_results.assessment_id
        and private.can_access_class(a.class_record_id)
    )
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  );
create policy results_scoped_update
  on public.assessment_results
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.assessments a
      where a.id = assessment_results.assessment_id
        and private.can_access_class(a.class_record_id)
    )
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  )
  with check (
    exists (
      select 1
      from public.assessments a
      where a.id = assessment_results.assessment_id
        and private.can_access_class(a.class_record_id)
    )
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  );
create policy results_scoped_delete
  on public.assessment_results
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.assessments a
      where a.id = assessment_results.assessment_id
        and private.can_access_class(a.class_record_id)
    )
    and (
      private.has_permission('assessment_results.manage.assigned')
      or private.has_permission('assessment_results.manage.department')
    )
  );
