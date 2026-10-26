-- Faculty deadline changes are reviewed by their department Academic Admin
-- before reaching a System Admin. The affected classes are snapshotted at
-- submission so later assignment changes do not alter the request scope.

create or replace function private.valid_grade_deadline_periods(periods text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(cardinality(periods) between 1 and 20, false)
    and array_position(periods, null) is null
    and not exists (
      select 1 from unnest(periods) as p(period_key)
      where p.period_key <> 'overall' and p.period_key !~ '^p[1-9][0-9]*$'
    );
$$;
revoke all on function private.valid_grade_deadline_periods(text[]) from public, anon;
grant execute on function private.valid_grade_deadline_periods(text[]) to authenticated;

alter table public.grade_encoding_deadline_requests
  add column requested_periods text[] not null default '{}'::text[],
  add column class_record_ids uuid[] not null default '{}'::uuid[],
  add column academic_admin_reason text,
  add column academic_admin_reviewed_by uuid references public.profiles(id) on delete set null,
  add column academic_admin_reviewed_at timestamptz;

alter table public.grade_encoding_deadline_requests
  drop constraint grade_encoding_deadline_requests_status_check,
  add constraint grade_encoding_deadline_requests_status_check
    check (status in ('pending', 'pending_academic_admin', 'pending_system_admin', 'approved', 'rejected')),
  drop constraint grade_encoding_deadline_requests_scope_type_check,
  add constraint grade_encoding_deadline_requests_scope_type_check
    check (scope_type in ('program', 'year_level', 'class', 'faculty')),
  drop constraint grade_encoding_deadline_requests_check,
  add constraint grade_encoding_deadline_requests_check check (
    (scope_type = 'program' and program_id is not null and year_level is null and class_record_id is null)
    or (scope_type = 'year_level' and program_id is null and year_level is not null and class_record_id is null)
    or (scope_type = 'class' and program_id is null and year_level is null and class_record_id is not null)
    or (scope_type = 'faculty' and program_id is null and year_level is null and class_record_id is null
      and cardinality(class_record_ids) > 0 and cardinality(requested_periods) > 0)
  ),
  add constraint grade_encoding_deadline_requests_requested_periods_check check (
    scope_type <> 'faculty' or private.valid_grade_deadline_periods(requested_periods)
  );

create index grade_encoding_deadline_requests_faculty_scope_idx
  on public.grade_encoding_deadline_requests using gin (class_record_ids)
  where scope_type = 'faculty';

grant update (status, review_note, reviewed_by, reviewed_at, updated_at,
  requested_deadlines, academic_admin_reason, academic_admin_reviewed_by,
  academic_admin_reviewed_at)
  on public.grade_encoding_deadline_requests to authenticated;

drop policy grade_encoding_deadline_requests_read on public.grade_encoding_deadline_requests;
create policy grade_encoding_deadline_requests_read
  on public.grade_encoding_deadline_requests for select to authenticated
  using (
    requested_by = (select auth.uid())
    or (private.has_permission('system.configure')
      and (scope_type <> 'faculty' or status <> 'pending_academic_admin'))
    or (scope_type = 'faculty' and private.is_academic_admin_for_department(department_id))
  );

drop policy grade_encoding_deadline_requests_create on public.grade_encoding_deadline_requests;
create policy grade_encoding_deadline_requests_create
  on public.grade_encoding_deadline_requests for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and scope_type in ('program', 'year_level', 'class')
    and status = 'pending'
    and private.has_permission('criteria.manage.department')
    and private.is_academic_admin_for_department(department_id)
    and (
      (scope_type = 'program' and exists (
        select 1 from public.programs p
        where p.id = grade_encoding_deadline_requests.program_id
          and p.department_id = grade_encoding_deadline_requests.department_id
      ))
      or (scope_type = 'year_level' and program_id is null)
      or (scope_type = 'class' and exists (
        select 1 from public.class_records cr
        where cr.id = grade_encoding_deadline_requests.class_record_id
          and cr.department_id = grade_encoding_deadline_requests.department_id
      ))
    )
  );

drop policy grade_encoding_deadline_requests_review on public.grade_encoding_deadline_requests;
create policy grade_encoding_deadline_requests_review
  on public.grade_encoding_deadline_requests for update to authenticated
  using (private.has_permission('system.configure') and status in ('pending', 'pending_system_admin'))
  with check (
    private.has_permission('system.configure')
    and status in ('pending', 'pending_system_admin', 'approved', 'rejected')
    and (status <> 'rejected' or length(trim(coalesce(review_note, ''))) between 1 and 1000)
  );

-- A faculty submission has no deadline values. Period keys and classes are
-- derived and validated inside the database from the caller's active profile.
create or replace function public.submit_faculty_grade_deadline_request(
  p_requested_periods text[],
  p_rationale text
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

  insert into public.grade_encoding_deadline_requests (
    department_id, requested_by, scope_type, requested_periods, class_record_ids,
    requested_deadlines, rationale, status
  ) values (
    faculty_department, requester, 'faculty', normalized_periods, target_classes,
    '{}'::jsonb, trim(p_rationale), 'pending_academic_admin'
  ) returning id into new_request_id;
  return new_request_id;
end;
$$;
revoke all on function public.submit_faculty_grade_deadline_request(text[], text) from public, anon;
grant execute on function public.submit_faculty_grade_deadline_request(text[], text) to authenticated;

-- Academic Admins can only review faculty requests within their own department.
-- Forwarding requires dates for exactly the periods the faculty selected and a
-- separate Academic Admin rationale. Rejection reason is optional.
create or replace function public.review_faculty_grade_deadline_request(
  p_request_id uuid,
  p_action text,
  p_deadlines jsonb default '{}'::jsonb,
  p_academic_admin_reason text default null,
  p_rejection_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.grade_encoding_deadline_requests%rowtype;
  deadline_keys text[];
  requested_deadline_keys text[];
  item record;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  select * into request_row
  from public.grade_encoding_deadline_requests
  where id = p_request_id and scope_type = 'faculty'
  for update;
  if not found then raise exception 'Faculty deadline request not found' using errcode = 'P0002'; end if;
  if request_row.status <> 'pending_academic_admin' then
    raise exception 'This request has already been reviewed' using errcode = '55000';
  end if;
  if not private.is_academic_admin_for_department(request_row.department_id) then
    raise exception 'Only this department Academic Admin can review the request' using errcode = '42501';
  end if;

  if p_action = 'reject' then
    if length(trim(coalesce(p_rejection_reason, ''))) > 1000 then
      raise exception 'Rejection reason must be at most 1000 characters' using errcode = '22023';
    end if;
    update public.grade_encoding_deadline_requests
      set status = 'rejected', review_note = nullif(trim(p_rejection_reason), ''),
          academic_admin_reviewed_by = (select auth.uid()), academic_admin_reviewed_at = now(), updated_at = now()
      where id = p_request_id;
    return;
  end if;

  if p_action <> 'forward' then
    raise exception 'Choose forward or reject' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_academic_admin_reason, ''))) not between 10 and 1000 then
    raise exception 'Add a reason for forwarding (10 to 1000 characters)' using errcode = '22023';
  end if;
  if jsonb_typeof(p_deadlines) <> 'object' then
    raise exception 'Supply deadline values as an object' using errcode = '22023';
  end if;

  select array_agg(p.key order by p.key) into deadline_keys from jsonb_object_keys(p_deadlines) as p(key);
  select array_agg(p.key order by p.key) into requested_deadline_keys from unnest(request_row.requested_periods) as p(key);
  if deadline_keys is distinct from requested_deadline_keys then
    raise exception 'Set a deadline for each selected period, and no other periods' using errcode = '22023';
  end if;
  for item in select key, value from jsonb_each(p_deadlines) loop
    if item.key <> 'overall' and item.key !~ '^p[1-9][0-9]*$' then
      raise exception 'Invalid grading period in deadline request' using errcode = '22023';
    end if;
    if jsonb_typeof(item.value) <> 'string' then
      raise exception 'Each requested deadline must be a date' using errcode = '22023';
    end if;
    perform (item.value #>> '{}')::timestamptz;
  end loop;

  update public.grade_encoding_deadline_requests
    set requested_deadlines = p_deadlines,
        academic_admin_reason = trim(p_academic_admin_reason),
        status = 'pending_system_admin',
        academic_admin_reviewed_by = (select auth.uid()), academic_admin_reviewed_at = now(),
        review_note = null, updated_at = now()
    where id = p_request_id;
end;
$$;
revoke all on function public.review_faculty_grade_deadline_request(uuid, text, jsonb, text, text) from public, anon;
grant execute on function public.review_faculty_grade_deadline_request(uuid, text, jsonb, text, text) to authenticated;

-- Applying a forwarded faculty request writes the selected dates to each class
-- captured when the Faculty submitted it.
create or replace function private.apply_grade_encoding_deadline_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  item record;
  target_class_id uuid;
  normalized_period text;
  parsed_deadline timestamptz;
begin
  if new.status <> 'approved' or old.status = 'approved' then return new; end if;
  if (select auth.uid()) is null or not private.has_permission('system.configure') then
    raise exception 'Not authorized to approve grade deadline requests' using errcode = '42501';
  end if;
  if new.reviewed_by is distinct from (select auth.uid()) then
    raise exception 'The reviewer must match the authenticated user' using errcode = '42501';
  end if;
  if new.scope_type = 'faculty' and old.status <> 'pending_system_admin' then
    raise exception 'Faculty requests must be forwarded by an Academic Admin first' using errcode = '55000';
  end if;

  for item in select key, value from jsonb_each(new.requested_deadlines) loop
    normalized_period := lower(trim(item.key));
    if normalized_period <> 'overall' and normalized_period !~ '^p[1-9][0-9]*$' then
      raise exception 'Invalid grading period in deadline request' using errcode = '22023';
    end if;
    if new.scope_type = 'faculty' then
      if item.value = 'null'::jsonb then raise exception 'Forwarded deadline values cannot be empty' using errcode = '22023'; end if;
      parsed_deadline := (item.value #>> '{}')::timestamptz;
      foreach target_class_id in array new.class_record_ids loop
        insert into public.grade_encoding_deadlines (
          scope_type, department_id, class_record_id, period_key, deadline_at, updated_by, updated_at
        ) values (
          'class', new.department_id, target_class_id, normalized_period, parsed_deadline, new.reviewed_by, now()
        ) on conflict (
          scope_type,
          (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)),
          (coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid)),
          (coalesce(year_level, 0)),
          (coalesce(class_record_id, '00000000-0000-0000-0000-000000000000'::uuid)), period_key
        ) do update set deadline_at = excluded.deadline_at, updated_by = excluded.updated_by, updated_at = now();
      end loop;
    else
      if item.value = 'null'::jsonb then
        delete from public.grade_encoding_deadlines
        where scope_type = new.scope_type and department_id = new.department_id
          and program_id is not distinct from new.program_id and year_level is not distinct from new.year_level
          and class_record_id is not distinct from new.class_record_id and period_key = normalized_period;
      else
        parsed_deadline := (item.value #>> '{}')::timestamptz;
        insert into public.grade_encoding_deadlines (
          scope_type, department_id, program_id, year_level, class_record_id,
          period_key, deadline_at, updated_by, updated_at
        ) values (
          new.scope_type, new.department_id, new.program_id, new.year_level, new.class_record_id,
          normalized_period, parsed_deadline, new.reviewed_by, now()
        ) on conflict (
          scope_type,
          (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)),
          (coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid)),
          (coalesce(year_level, 0)),
          (coalesce(class_record_id, '00000000-0000-0000-0000-000000000000'::uuid)), period_key
        ) do update set deadline_at = excluded.deadline_at, updated_by = excluded.updated_by, updated_at = now();
      end if;
    end if;
  end loop;
  return new;
end;
$$;

-- Enforce system-admin rejection notes even for direct API updates.
create or replace function private.enforce_grade_deadline_request_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('pending', 'pending_system_admin') and new.status in ('approved', 'rejected') then
    if (select auth.uid()) is null or not private.has_permission('system.configure')
      or new.reviewed_by is distinct from (select auth.uid()) then
      raise exception 'Only a System Admin can make the final deadline request decision' using errcode = '42501';
    end if;
    if new.status = 'rejected' and length(trim(coalesce(new.review_note, ''))) not between 1 and 1000 then
      raise exception 'A rejection reason is required' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_grade_deadline_request_decision() from public, anon, authenticated;
drop trigger if exists enforce_grade_deadline_request_decision on public.grade_encoding_deadline_requests;
create trigger enforce_grade_deadline_request_decision
before update of status on public.grade_encoding_deadline_requests
for each row execute function private.enforce_grade_deadline_request_decision();

-- Route notices to the role that must take the next action, then tell the
-- Faculty member the result at either review stage.
create or replace function private.notify_grade_encoding_deadline_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_row record;
  requester_name text;
  academic_admin_name text;
  request_scope text;
  decision text;
begin
  select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') into requester_name
  from public.profiles p where p.id = new.requested_by;
  if new.academic_admin_reviewed_by is not null then
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') into academic_admin_name
    from public.profiles p where p.id = new.academic_admin_reviewed_by;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'pending_academic_admin' then
      for recipient_row in
        select ur.user_id from public.user_roles ur
        join public.roles r on r.id = ur.role_id and r.key = 'academic_admin'
        join public.profiles p on p.id = ur.user_id and p.status = 'active'
        where ur.scope_type = 'department' and ur.scope_id = new.department_id
          and ur.valid_from <= now() and (ur.valid_until is null or ur.valid_until > now())
      loop
        insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
        values (recipient_row.user_id, 'grade_deadline_review', 'Faculty deadline change requested',
          coalesce(requester_name, 'A Faculty member') || ' requested a grade encoding deadline change for '
            || cardinality(new.class_record_ids)::text || ' selected class(es). Review the requested periods and reason.',
          'grade_encoding_deadline_request', new.id);
      end loop;
      return new;
    elsif new.status = 'pending' then
      request_scope := case new.scope_type when 'class' then 'class-specific' when 'program' then 'program-level' when 'year_level' then 'year-level' else 'scoped' end;
      for recipient_row in
        select ur.user_id from public.user_roles ur
        join public.roles r on r.id = ur.role_id and r.key = 'system_admin'
        join public.profiles p on p.id = ur.user_id and p.status = 'active'
        where ur.scope_type = 'global' and ur.valid_from <= now()
          and (ur.valid_until is null or ur.valid_until > now())
      loop
        insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
        values (recipient_row.user_id, 'grade_deadline_review', 'Grade deadline change requested',
          coalesce(requester_name, 'An Academic Admin') || ' submitted a ' || request_scope || ' grade deadline change request. Review the requested dates and reason.',
          'grade_encoding_deadline_request', new.id);
      end loop;
    end if;
    return new;
  end if;

  if old.status = 'pending_academic_admin' and new.status = 'pending_system_admin' then
    for recipient_row in
      select ur.user_id from public.user_roles ur
      join public.roles r on r.id = ur.role_id and r.key = 'system_admin'
      join public.profiles p on p.id = ur.user_id and p.status = 'active'
      where ur.scope_type = 'global' and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    loop
      insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
      values (recipient_row.user_id, 'grade_deadline_review', 'Faculty deadline request forwarded',
        coalesce(requester_name, 'A Faculty member') || ' submitted a deadline request forwarded by '
          || coalesce(academic_admin_name, 'the Academic Admin') || ' with proposed deadlines for '
          || cardinality(new.class_record_ids)::text || ' selected class(es). Review both reasons and the proposed dates.',
        'grade_encoding_deadline_request', new.id);
    end loop;
    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (new.requested_by, 'grade_deadline_review', 'Deadline request forwarded to System Admin',
      coalesce(academic_admin_name, 'Your Academic Admin') || ' set the proposed deadline dates and forwarded your request to the System Admin.',
      'grade_encoding_deadline_request', new.id);
    return new;
  end if;

  if new.scope_type = 'faculty' and old.status = 'pending_academic_admin' and new.status = 'rejected' then
    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (new.requested_by, 'grade_deadline_decision', 'Academic Admin declined your deadline request',
      'Your department Academic Admin declined the grade deadline change request.'
        || case when nullif(trim(new.review_note), '') is null then '' else ' Reason: ' || trim(new.review_note) end,
      'grade_encoding_deadline_request', new.id);
    return new;
  end if;

  if old.status in ('pending', 'pending_system_admin') and new.status in ('approved', 'rejected') then
    if (select auth.uid()) is null or not private.has_permission('system.configure')
      or new.reviewed_by is distinct from (select auth.uid()) then
      raise exception 'The reviewer must be an authorized System Admin' using errcode = '42501';
    end if;
    decision := case new.status when 'approved' then 'approved' else 'rejected' end;
    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (new.requested_by, 'grade_deadline_decision', 'Grade deadline request ' || decision,
      case when new.status = 'approved' then 'Your grade deadline change request was approved.'
        else 'Your grade deadline change request was rejected. Reason: ' || trim(new.review_note) end,
      'grade_encoding_deadline_request', new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.notify_grade_encoding_deadline_request() from public, anon, authenticated, service_role;
