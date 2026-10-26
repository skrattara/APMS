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
    if new.scope_type = 'faculty' and old.status = 'pending_system_admin'
      and new.academic_admin_reviewed_by is not null then
      insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
      values (new.academic_admin_reviewed_by, 'grade_deadline_decision',
        'System Admin ' || decision || ' forwarded deadline request',
        coalesce(requester_name, 'The Faculty member') || '''s grade deadline request was ' || decision || ' by the System Admin.'
          || case when new.status = 'rejected' then ' Reason: ' || trim(new.review_note) else '' end,
        'grade_encoding_deadline_request', new.id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.notify_grade_encoding_deadline_request() from public, anon, authenticated, service_role;
