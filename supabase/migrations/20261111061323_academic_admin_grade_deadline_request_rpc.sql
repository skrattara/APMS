-- Route Academic Admin deadline requests through explicit server-side
-- authorization and scope validation. The former INSERT policy queried
-- class_records, whose System Admin read policy queries this table.
drop policy if exists grade_encoding_deadline_requests_create
  on public.grade_encoding_deadline_requests;

create policy grade_encoding_deadline_requests_create
  on public.grade_encoding_deadline_requests
  for insert to authenticated
  with check (false);

create or replace function public.submit_academic_admin_grade_deadline_request(
  p_department_id uuid,
  p_scope_type text,
  p_program_id uuid,
  p_year_level smallint,
  p_class_record_id uuid,
  p_requested_deadlines jsonb,
  p_rationale text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester uuid := (select auth.uid());
  item record;
  new_request_id uuid;
begin
  if requester is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_department_id is null
    or not private.has_permission('criteria.manage.department')
    or not private.is_academic_admin_for_department(p_department_id) then
    raise exception 'Only an authorized Academic Admin can request a deadline change for this department'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_rationale, ''))) not between 10 and 1000 then
    raise exception 'Explain why the grade deadline change is needed (10 to 1000 characters)'
      using errcode = '22023';
  end if;
  if p_requested_deadlines is null
    or jsonb_typeof(p_requested_deadlines) <> 'object'
    or p_requested_deadlines = '{}'::jsonb then
    raise exception 'Enter at least one deadline to request' using errcode = '22023';
  end if;

  for item in select key, value from jsonb_each(p_requested_deadlines) loop
    if item.key <> 'overall' and item.key !~ '^p[1-9][0-9]*$' then
      raise exception 'Invalid grading period in deadline request' using errcode = '22023';
    end if;
    if jsonb_typeof(item.value) <> 'string' then
      raise exception 'Each requested deadline must be a date' using errcode = '22023';
    end if;
    perform (item.value #>> '{}')::timestamptz;
  end loop;

  if p_scope_type = 'program' then
    if p_program_id is null or p_year_level is not null or p_class_record_id is not null
      or not exists (
        select 1 from public.programs p
        where p.id = p_program_id and p.department_id = p_department_id
      ) then
      raise exception 'Choose a program in your department' using errcode = '22023';
    end if;
  elsif p_scope_type = 'year_level' then
    if p_program_id is not null or p_year_level is null
      or p_year_level not between 1 and 8 or p_class_record_id is not null then
      raise exception 'Choose a valid year level' using errcode = '22023';
    end if;
  elsif p_scope_type = 'class' then
    if p_program_id is not null or p_year_level is not null or p_class_record_id is null
      or not exists (
        select 1 from public.class_records cr
        where cr.id = p_class_record_id and cr.department_id = p_department_id
      ) then
      raise exception 'Choose a class in your department' using errcode = '22023';
    end if;
  else
    raise exception 'Choose a valid deadline request scope' using errcode = '22023';
  end if;

  insert into public.grade_encoding_deadline_requests (
    department_id, requested_by, scope_type, program_id, year_level,
    class_record_id, requested_deadlines, rationale, status
  ) values (
    p_department_id, requester, p_scope_type, p_program_id, p_year_level,
    p_class_record_id, p_requested_deadlines, trim(p_rationale), 'pending'
  ) returning id into new_request_id;

  return new_request_id;
end;
$$;

revoke all on function public.submit_academic_admin_grade_deadline_request(
  uuid, text, uuid, smallint, uuid, jsonb, text
) from public, anon;
grant execute on function public.submit_academic_admin_grade_deadline_request(
  uuid, text, uuid, smallint, uuid, jsonb, text
) to authenticated;
