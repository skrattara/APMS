-- Request reasons remain required at submission. Reviewers may reject subject
-- or class requests without entering an optional review note.
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
  caller_id uuid;
  req record;
  clean_decision text;
  clean_note text;
  existing_subject_id uuid;
begin
  caller_id := auth.uid();
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  clean_decision := lower(trim(p_decision));
  clean_note := nullif(trim(coalesce(p_review_note, '')), '');

  if clean_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected' using errcode = '22023';
  end if;

  select * into req from public.subject_requests where id = p_request_id for update;
  if req.id is null then
    raise exception 'Subject request not found' using errcode = 'P0002';
  end if;
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
      set title = req.title, units = req.units, status = 'active', updated_at = now()
      where id = existing_subject_id;
    else
      insert into public.subjects (department_id, code, title, units, status)
      values (req.department_id, upper(req.code), req.title, req.units, 'active');
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
      'review_note', clean_note
    )
  );
end;
$$;

revoke all on function public.academic_admin_review_subject_request(uuid, text, text) from public, anon;
grant execute on function public.academic_admin_review_subject_request(uuid, text, text) to authenticated;

create or replace function public.academic_admin_reject_class_request(p_request_id uuid, p_review_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  request_row public.class_requests%rowtype;
  clean_note text := nullif(trim(coalesce(p_review_note, '')), '');
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into request_row from public.class_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'Class request not found' using errcode = 'P0002'; end if;
  if request_row.status <> 'pending' then raise exception 'This class request has already been reviewed' using errcode = '23514'; end if;
  if not private.is_academic_admin_for_department(request_row.department_id) then
    raise exception 'Only an authorized Academic Admin can review this request' using errcode = '42501';
  end if;
  update public.class_requests
  set status = 'rejected', reviewed_by = caller_id, reviewed_at = now(), review_note = clean_note
  where id = p_request_id;
end;
$$;

revoke all on function public.academic_admin_reject_class_request(uuid, text) from public, anon;
grant execute on function public.academic_admin_reject_class_request(uuid, text) to authenticated;
