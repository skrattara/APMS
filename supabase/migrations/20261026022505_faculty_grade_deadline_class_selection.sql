-- Allow faculty to narrow their request to a subset of their current assigned
-- classes. A NULL class list deliberately means every active assigned class.
create or replace function public.submit_faculty_grade_deadline_request(
  p_requested_periods text[],
  p_rationale text,
  p_class_record_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester uuid := (select auth.uid());
  faculty_department uuid;
  target_classes uuid[];
  requested_classes uuid[];
  normalized_periods text[];
  new_request_id uuid;
begin
  if requester is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_rationale, ''))) not between 10 and 1000 then
    raise exception 'Explain why the grade deadline change is needed (10 to 1000 characters)' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_requested_periods), 0) not between 1 and 20 then
    raise exception 'Select at least one grading period' using errcode = '22023';
  end if;

  select fp.department_id into faculty_department
  from public.faculty_profiles fp
  where fp.profile_id = requester and fp.status = 'active';
  if faculty_department is null then
    raise exception 'An active Faculty profile is required' using errcode = '42501';
  end if;

  select array_agg(distinct lower(trim(p.period_key)) order by lower(trim(p.period_key)))
    into normalized_periods
  from unnest(p_requested_periods) as p(period_key);
  if exists (
    select 1 from unnest(normalized_periods) as p(period_key)
    where p.period_key <> 'overall' and p.period_key !~ '^p[1-9][0-9]*$'
  ) then
    raise exception 'Invalid grading period selected' using errcode = '22023';
  end if;

  select array_agg(distinct cr.id order by cr.id) into target_classes
  from public.faculty_profiles fp
  join public.faculty_assignments fa on fa.faculty_id = fp.id and fa.status = 'active'
  join public.class_records cr on cr.id = fa.class_record_id and cr.status = 'active'
  where fp.profile_id = requester and fp.department_id = faculty_department and fp.status = 'active'
    and cr.department_id = faculty_department;
  if coalesce(cardinality(target_classes), 0) = 0 then
    raise exception 'No active assigned classes are available for a deadline request' using errcode = '22023';
  end if;

  if p_class_record_ids is null then
    requested_classes := target_classes;
  else
    if coalesce(cardinality(p_class_record_ids), 0) = 0 then
      raise exception 'Select at least one assigned class' using errcode = '22023';
    end if;
    select array_agg(distinct p.class_record_id order by p.class_record_id)
      into requested_classes
    from unnest(p_class_record_ids) as p(class_record_id);
    if array_position(requested_classes, null) is not null then
      raise exception 'The selected class list contains an invalid class' using errcode = '22023';
    end if;
    if exists (
      select 1 from unnest(requested_classes) as p(class_record_id)
      where not (p.class_record_id = any(target_classes))
    ) then
      raise exception 'You can only select classes currently assigned to you' using errcode = '42501';
    end if;
  end if;

  insert into public.grade_encoding_deadline_requests (
    department_id, requested_by, scope_type, requested_periods, class_record_ids,
    requested_deadlines, rationale, status
  ) values (
    faculty_department, requester, 'faculty', normalized_periods, requested_classes,
    '{}'::jsonb, trim(p_rationale), 'pending_academic_admin'
  ) returning id into new_request_id;
  return new_request_id;
end;
$$;
revoke all on function public.submit_faculty_grade_deadline_request(text[], text, uuid[]) from public, anon;
grant execute on function public.submit_faculty_grade_deadline_request(text[], text, uuid[]) to authenticated;
