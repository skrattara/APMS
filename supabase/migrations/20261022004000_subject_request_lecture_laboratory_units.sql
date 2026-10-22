-- Store and preserve lecture/laboratory unit counts on Faculty subject requests.
alter table public.subject_requests
  add column if not exists lecture_units smallint,
  add column if not exists laboratory_units smallint;

update public.subject_requests
set lecture_units = least(12, greatest(0, floor(units)::integer))::smallint,
    laboratory_units = least(12, greatest(0, ceil(units)::integer - least(12, greatest(0, floor(units)::integer))))::smallint;

update public.subject_requests
set units = lecture_units + laboratory_units;

alter table public.subject_requests
  alter column lecture_units set default 3,
  alter column lecture_units set not null,
  alter column laboratory_units set default 0,
  alter column laboratory_units set not null;

alter table public.subject_requests
  drop constraint if exists subject_requests_lecture_units_range,
  add constraint subject_requests_lecture_units_range check (lecture_units between 0 and 12),
  drop constraint if exists subject_requests_laboratory_units_range,
  add constraint subject_requests_laboratory_units_range check (laboratory_units between 0 and 12),
  drop constraint if exists subject_requests_total_units_positive,
  add constraint subject_requests_total_units_positive check (lecture_units + laboratory_units > 0);

drop function if exists public.faculty_submit_subject_request(text, text, numeric, text);
create function public.faculty_submit_subject_request(
  p_code text,
  p_title text,
  p_lecture_units smallint,
  p_laboratory_units smallint,
  p_rationale text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_dept_id uuid;
  new_request_id uuid;
  clean_code text := upper(trim(coalesce(p_code, '')));
  clean_title text := trim(coalesce(p_title, ''));
  clean_rationale text := trim(coalesce(p_rationale, ''));
  total_units numeric;
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  caller_dept_id := private.get_faculty_department_id();
  if caller_dept_id is null then
    raise exception 'Caller is not an active faculty member with an assigned department' using errcode = '42501';
  end if;
  if length(clean_code) < 2 or length(clean_code) > 30 then
    raise exception 'Subject code must be between 2 and 30 characters' using errcode = '22023';
  end if;
  if length(clean_title) < 3 then
    raise exception 'Subject title must be at least 3 characters' using errcode = '22023';
  end if;
  if p_lecture_units is null or p_lecture_units not between 0 and 12
     or p_laboratory_units is null or p_laboratory_units not between 0 and 12
     or p_lecture_units + p_laboratory_units < 1 then
    raise exception 'Lecture and laboratory units must each be between 0 and 12, with at least 1 total' using errcode = '22023';
  end if;
  total_units := p_lecture_units + p_laboratory_units;
  if length(clean_rationale) < 10 then
    raise exception 'Please provide a clear rationale of at least 10 characters for this subject request' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.subject_requests
    where department_id = caller_dept_id and upper(code) = clean_code and status = 'pending'
  ) then
    raise exception 'A pending subject request for code "%" already exists in your department', clean_code using errcode = '23505';
  end if;
  if exists (
    select 1 from public.subjects
    where department_id = caller_dept_id and upper(code) = clean_code and status = 'active'
  ) then
    raise exception 'An active subject with code "%" already exists in your department', clean_code using errcode = '23505';
  end if;

  insert into public.subject_requests (
    department_id, requested_by, code, title, units, lecture_units, laboratory_units, rationale, status
  ) values (
    caller_dept_id, caller_id, clean_code, clean_title, total_units, p_lecture_units, p_laboratory_units, clean_rationale, 'pending'
  ) returning id into new_request_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after_data)
  values (
    caller_id,
    'subject_request.submitted',
    'subject_requests',
    new_request_id,
    jsonb_build_object(
      'department_id', caller_dept_id,
      'code', clean_code,
      'title', clean_title,
      'units', total_units,
      'lecture_units', p_lecture_units,
      'laboratory_units', p_laboratory_units
    )
  );
  return new_request_id;
end;
$$;

revoke all on function public.faculty_submit_subject_request(text, text, smallint, smallint, text) from public, anon;
grant execute on function public.faculty_submit_subject_request(text, text, smallint, smallint, text) to authenticated;

create or replace function public.academic_admin_review_subject_request(
  p_request_id uuid,
  p_decision text,
  p_review_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  req record;
  clean_decision text := lower(trim(coalesce(p_decision, '')));
  clean_note text := nullif(trim(coalesce(p_review_note, '')), '');
  existing_subject_id uuid;
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if clean_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected' using errcode = '22023';
  end if;
  select * into req from public.subject_requests where id = p_request_id for update;
  if req.id is null then raise exception 'Subject request not found' using errcode = 'P0002'; end if;
  if req.status <> 'pending' then
    raise exception 'Subject request has already been reviewed (status: %)', req.status using errcode = '23514';
  end if;
  if not (
    private.can_manage_academic_department(req.department_id, 'subjects.manage.department')
    or private.has_permission('system.configure')
  ) then
    raise exception 'Not authorized to review subject requests for department %', req.department_id using errcode = '42501';
  end if;

  if clean_decision = 'approved' then
    select id into existing_subject_id
    from public.subjects
    where department_id = req.department_id and upper(code) = upper(req.code);
    if existing_subject_id is not null then
      update public.subjects
      set title = req.title,
          units = req.lecture_units + req.laboratory_units,
          lecture_units = req.lecture_units,
          laboratory_units = req.laboratory_units,
          status = 'active',
          updated_at = now()
      where id = existing_subject_id;
    else
      insert into public.subjects (
        department_id, code, title, units, lecture_units, laboratory_units, status
      ) values (
        req.department_id, upper(req.code), req.title,
        req.lecture_units + req.laboratory_units, req.lecture_units, req.laboratory_units, 'active'
      );
    end if;
  end if;

  update public.subject_requests
  set status = clean_decision,
      reviewed_by = caller_id,
      reviewed_at = now(),
      review_note = clean_note,
      updated_at = now()
  where id = p_request_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
  values (
    caller_id,
    'subject_request.' || clean_decision,
    'subject_requests',
    p_request_id,
    to_jsonb(req),
    jsonb_build_object(
      'id', p_request_id,
      'status', clean_decision,
      'reviewed_by', caller_id,
      'reviewed_at', now(),
      'review_note', clean_note,
      'lecture_units', req.lecture_units,
      'laboratory_units', req.laboratory_units
    )
  );
end;
$$;

revoke all on function public.academic_admin_review_subject_request(uuid, text, text) from public, anon;
grant execute on function public.academic_admin_review_subject_request(uuid, text, text) to authenticated;
