-- Earlier versions created generated classes with the same TEST - prefix but
-- predated the explicit marker. Backfill those generator-created classes.
update public.class_records
set is_synthetic_test = true
where is_synthetic_test = false
  and section like 'TEST - %';

-- Remove only classes carrying the explicit synthetic-test marker. This is
-- called by the authenticated, System Admin-only Edge Function using service_role.
create or replace function public.delete_synthetic_test_classes()
returns table(classes bigint, students bigint, assessments bigint, results bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_class_ids uuid[];
  v_student_ids uuid[];
  v_assessment_ids uuid[];
begin
  select coalesce(array_agg(cr.id), '{}'::uuid[])
    into v_class_ids
    from public.class_records cr
    where cr.is_synthetic_test = true;

  if cardinality(v_class_ids) = 0 then
    return query select 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  select coalesce(array_agg(distinct s.id), '{}'::uuid[])
    into v_student_ids
    from public.students s
    join public.synthetic_data_batches b on b.id = s.synthetic_batch_id
    where b.class_record_id = any(v_class_ids);

  select coalesce(array_agg(a.id), '{}'::uuid[])
    into v_assessment_ids
    from public.assessments a
    where a.class_record_id = any(v_class_ids);

  delete from public.feedback_records fr
    where fr.student_id = any(v_student_ids)
       or fr.enrollment_id in (
         select e.id from public.enrollments e where e.class_record_id = any(v_class_ids)
       );

  delete from public.performance_evaluations pe
    using public.enrollments e
    where pe.enrollment_id = e.id and e.class_record_id = any(v_class_ids);
  delete from public.performance_evaluations pe
    using public.criteria_sets cs
    where pe.criteria_set_id = cs.id and cs.class_record_id = any(v_class_ids);

  delete from public.prediction_runs pr
    where pr.class_record_id = any(v_class_ids);

  delete from public.assessment_results ar
    where ar.assessment_id = any(v_assessment_ids);
  get diagnostics results = row_count;

  delete from public.assessments a
    where a.class_record_id = any(v_class_ids);
  get diagnostics assessments = row_count;

  delete from public.enrollments e
    where e.class_record_id = any(v_class_ids);

  delete from public.students s
    where s.id = any(v_student_ids);
  get diagnostics students = row_count;

  delete from public.class_records cr
    where cr.id = any(v_class_ids);
  get diagnostics classes = row_count;

  return query select classes, students, assessments, results;
end;
$$;

revoke all on function public.delete_synthetic_test_classes() from public, anon, authenticated;
grant execute on function public.delete_synthetic_test_classes() to service_role;
