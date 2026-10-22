-- Notify department Academic Admins when Faculty submit subject/class requests,
-- and notify the Faculty requester when an Academic Admin reviews them.
create or replace function private.notify_subject_request_parties()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_row record;
  requester_name text;
  request_title text;
begin
  if tg_op = 'INSERT' then
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '')
      into requester_name
      from public.profiles p
      where p.id = new.requested_by;

    request_title := new.code || ' · ' || new.title;
    for admin_row in
      select distinct ur.user_id
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      join public.profiles p on p.id = ur.user_id
      where r.key = 'academic_admin'
        and ur.scope_type = 'department'
        and ur.scope_id = new.department_id
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
        and p.status = 'active'
    loop
      insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
      values (
        admin_row.user_id,
        'subject_request_review',
        'Subject addition requested',
        coalesce(requester_name, 'A Faculty member') || ' requested a new subject: ' || request_title || '. Review the request in Subjects.',
        'subject_request',
        new.id
      );
    end loop;
    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (
      new.requested_by,
      'subject_request_decision',
      'Subject request ' || new.status,
      case when new.status = 'approved'
        then 'Your request to add ' || new.code || ' · ' || new.title || ' was approved.'
        else 'Your request to add ' || new.code || ' · ' || new.title || ' was rejected. Reason: ' || coalesce(nullif(btrim(new.review_note), ''), 'No reason was provided.')
      end,
      'subject_request',
      new.id
    );
  end if;
  return new;
end;
$$;

revoke all on function private.notify_subject_request_parties() from public, anon, authenticated, service_role;
drop trigger if exists subject_request_notifications on public.subject_requests;
create trigger subject_request_notifications
after insert or update of status on public.subject_requests
for each row execute function private.notify_subject_request_parties();

create or replace function private.notify_class_request_parties()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_row record;
  requester_name text;
  subject_label text;
  term_label text;
begin
  if tg_op = 'INSERT' then
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '')
      into requester_name
      from public.profiles p
      where p.id = new.requested_by;
    select s.code || ' · ' || s.title
      into subject_label
      from public.subjects s
      where s.id = new.subject_id;
    select t.academic_year || ' · ' || t.semester
      into term_label
      from public.academic_terms t
      where t.id = new.academic_term_id;

    for admin_row in
      select distinct ur.user_id
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      join public.profiles p on p.id = ur.user_id
      where r.key = 'academic_admin'
        and ur.scope_type = 'department'
        and ur.scope_id = new.department_id
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
        and p.status = 'active'
    loop
      insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
      values (
        admin_row.user_id,
        'class_request_review',
        'Class addition requested',
        coalesce(requester_name, 'A Faculty member') || ' requested a class: ' || coalesce(subject_label, 'Subject') || ' · ' || new.section || ' · ' || coalesce(term_label, 'Academic term') || '. Review the request in Classes.',
        'class_request',
        new.id
      );
    end loop;
    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    select s.code || ' · ' || s.title
      into subject_label
      from public.subjects s
      where s.id = new.subject_id;
    select t.academic_year || ' · ' || t.semester
      into term_label
      from public.academic_terms t
      where t.id = new.academic_term_id;

    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (
      new.requested_by,
      'class_request_decision',
      'Class request ' || new.status,
      case when new.status = 'approved'
        then 'Your request for ' || coalesce(subject_label, 'a class') || ' · ' || new.section || ' · ' || coalesce(term_label, 'academic term') || ' was approved.'
        else 'Your request for ' || coalesce(subject_label, 'a class') || ' · ' || new.section || ' · ' || coalesce(term_label, 'academic term') || ' was rejected. Reason: ' || coalesce(nullif(btrim(new.review_note), ''), 'No reason was provided.')
      end,
      'class_request',
      new.id
    );
  end if;
  return new;
end;
$$;

revoke all on function private.notify_class_request_parties() from public, anon, authenticated, service_role;
drop trigger if exists class_request_notifications on public.class_requests;
create trigger class_request_notifications
after insert or update of status on public.class_requests
for each row execute function private.notify_class_request_parties();
