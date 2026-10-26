-- PostgREST does not expose request.jwt.claim.role consistently for this
-- service-role invocation. Function ACLs restrict this wrapper to service_role;
-- the explicit boolean remains mandatory before it sets the cleanup flag.
create or replace function public.admin_purge_profile_restrict_references(
  p_user_id uuid,
  p_force_delete_linked_records boolean
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_force_delete_linked_records is not true then
    raise exception 'Explicit force-delete confirmation is required' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('apms.force_delete_linked_records', 'on', true);
  return private.admin_purge_profile_restrict_references_impl(p_user_id);
end;
$$;

create or replace function private.enforce_grade_encoding_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_assessment_id uuid;
  target_enrollment_id uuid;
  target_program_id uuid;
  target_year_level smallint;
  target_department_id uuid;
  target_class_id uuid;
  period_name text;
  applicable_deadline timestamptz;
  deadline_scope text;
begin
  if tg_op = 'DELETE'
    and pg_catalog.current_setting('apms.force_delete_linked_records', true) = 'on' then
    return old;
  end if;

  if tg_op = 'DELETE' then
    target_assessment_id := old.assessment_id;
    target_enrollment_id := old.enrollment_id;
    if not exists (select 1 from public.assessments a where a.id = target_assessment_id)
      or not exists (select 1 from public.enrollments e where e.id = target_enrollment_id) then
      return old;
    end if;
  else
    target_assessment_id := new.assessment_id;
    target_enrollment_id := new.enrollment_id;
  end if;

  select st.program_id, st.year_level, p.department_id, e.class_record_id,
    coalesce(nullif(lower(trim(a.grading_period)), ''), 'overall')
  into target_program_id, target_year_level, target_department_id, target_class_id, period_name
  from public.assessments a
  join public.enrollments e on e.id = target_enrollment_id
  join public.students st on st.id = e.student_id
  join public.programs p on p.id = st.program_id
  where a.id = target_assessment_id;

  if target_program_id is null then
    raise exception 'Unable to resolve the program and grading period for this score' using errcode = '23503';
  end if;
  if period_name !~ '^p[1-9][0-9]*$' then
    period_name := regexp_replace(period_name, '[^a-z0-9]+', '_', 'g');
  end if;

  foreach deadline_scope in array array['overall', period_name] loop
    select d.deadline_at into applicable_deadline
    from public.grade_encoding_deadlines d
    where d.period_key = deadline_scope and (
      d.scope_type = 'system'
      or (d.department_id = target_department_id and d.scope_type = 'year_level' and d.year_level = target_year_level)
      or (d.department_id = target_department_id and d.scope_type = 'program' and d.program_id = target_program_id)
      or (d.department_id = target_department_id and d.scope_type = 'class' and d.class_record_id = target_class_id)
    )
    order by case d.scope_type when 'class' then 4 when 'program' then 3 when 'year_level' then 2 else 1 end desc,
      d.updated_at desc
    limit 1;

    if applicable_deadline is not null and now() > applicable_deadline then
      raise exception 'Grade encoding is closed for %; the deadline was %', deadline_scope, applicable_deadline using errcode = '55000';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
