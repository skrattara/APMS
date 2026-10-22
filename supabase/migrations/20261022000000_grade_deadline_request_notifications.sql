-- Notify System Admin accounts when Academic Admins submit grade deadline requests,
-- and notify the requester after the request is approved or rejected.
create or replace function private.notify_grade_encoding_deadline_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_row record;
  request_scope text;
  decision text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then return new; end if;
    if new.requested_by is distinct from (select auth.uid()) then
      raise exception 'The requester must match the authenticated user' using errcode = '42501';
    end if;

    request_scope := case new.scope_type
      when 'class' then 'class-specific'
      when 'program' then 'program-level'
      when 'year_level' then 'year-level'
      else 'scoped'
    end;

    for admin_row in
      select ur.user_id
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      join public.profiles p on p.id = ur.user_id
      where r.key = 'system_admin'
        and ur.scope_type = 'global'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
        and p.status = 'active'
    loop
      insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
      values (
        admin_row.user_id,
        'grade_deadline_review',
        'Grade deadline change requested',
        'An Academic Admin submitted a ' || request_scope || ' grade deadline change request. Review the requested dates and reason.',
        'grade_encoding_deadline_request',
        new.id
      );
    end loop;

    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if (select auth.uid()) is null
      or not private.has_permission('system.configure')
      or new.reviewed_by is distinct from (select auth.uid()) then
      raise exception 'The reviewer must be an authorized System Admin' using errcode = '42501';
    end if;

    decision := case new.status when 'approved' then 'approved' else 'rejected' end;
    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (
      new.requested_by,
      'grade_deadline_decision',
      'Grade deadline request ' || decision,
      case when new.status = 'approved'
        then 'Your grade deadline change request was approved.'
        else 'Your grade deadline change request was rejected. Reason: ' || coalesce(nullif(trim(new.review_note), ''), 'No reason was provided.')
      end,
      'grade_encoding_deadline_request',
      new.id
    );
  end if;

  return new;
end;
$$;

revoke all on function private.notify_grade_encoding_deadline_request() from public, anon, authenticated, service_role;

drop trigger if exists grade_encoding_deadline_request_notifications on public.grade_encoding_deadline_requests;
create trigger grade_encoding_deadline_request_notifications
after insert or update of status on public.grade_encoding_deadline_requests
for each row execute function private.notify_grade_encoding_deadline_request();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;
