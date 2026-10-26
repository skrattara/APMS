create table public.program_requests (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  code text not null check (length(btrim(code)) between 2 and 30),
  name text not null check (length(btrim(name)) >= 3),
  rationale text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  program_id uuid references public.programs(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'rejected' or length(btrim(coalesce(rejection_reason, ''))) >= 3)
);

create index program_requests_department_created_idx
  on public.program_requests (department_id, created_at desc);
create index program_requests_status_created_idx
  on public.program_requests (status, created_at desc);
create unique index program_requests_pending_code_idx
  on public.program_requests (department_id, upper(code)) where status = 'pending';

alter table public.program_requests enable row level security;
grant select, insert, update on public.program_requests to authenticated;
revoke delete on public.program_requests from authenticated;

create policy program_requests_read_scoped on public.program_requests
  for select to authenticated
  using (
    requested_by = auth.uid()
    or private.can_manage_academic_department(department_id, 'subjects.manage.department')
    or private.has_permission('system.configure')
  );

create policy program_requests_submit_scoped on public.program_requests
  for insert to authenticated
  with check (
    requested_by = auth.uid()
    and private.can_manage_academic_department(department_id, 'subjects.manage.department')
    and status = 'pending'
    and program_id is null
    and reviewed_by is null
    and reviewed_at is null
    and rejection_reason is null
  );

create policy program_requests_system_admin_review on public.program_requests
  for update to authenticated
  using (private.has_permission('system.configure') and status = 'pending')
  with check (private.has_permission('system.configure') and status in ('approved', 'rejected'));

create trigger program_requests_set_updated_at
  before update on public.program_requests
  for each row execute function private.set_updated_at();

create or replace function public.submit_program_request(
  p_department_id uuid,
  p_code text,
  p_name text,
  p_rationale text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  clean_code text := upper(btrim(coalesce(p_code, '')));
  clean_name text := btrim(coalesce(p_name, ''));
  request_id uuid;
begin
  if caller_id is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if not private.can_manage_academic_department(p_department_id, 'subjects.manage.department') then
    raise exception 'You are not authorized to request programs for this department' using errcode = '42501';
  end if;
  if length(clean_code) < 2 or length(clean_code) > 30 or clean_name = '' or length(clean_name) < 3 then
    raise exception 'Enter a program code and name' using errcode = '22023';
  end if;
  if exists (select 1 from public.programs p where p.department_id = p_department_id and upper(p.code) = clean_code) then
    raise exception 'A program with this code already exists in the department' using errcode = '23505';
  end if;
  if exists (select 1 from public.program_requests r where r.department_id = p_department_id and upper(r.code) = clean_code and r.status = 'pending') then
    raise exception 'A pending request for this program code already exists' using errcode = '23505';
  end if;
  insert into public.program_requests (department_id, requested_by, code, name, rationale)
  values (p_department_id, caller_id, clean_code, clean_name, nullif(btrim(coalesce(p_rationale, '')), ''))
  returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.system_admin_review_program_request(
  p_request_id uuid,
  p_decision text,
  p_rejection_reason text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  request_row public.program_requests%rowtype;
  created_program_id uuid;
  clean_reason text := btrim(coalesce(p_rejection_reason, ''));
begin
  if caller_id is null or not private.has_permission('system.configure') then
    raise exception 'Only a System Admin can review program requests' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Choose approve or reject' using errcode = '22023'; end if;
  if p_decision = 'rejected' and length(clean_reason) < 3 then
    raise exception 'A rejection reason is required' using errcode = '22023';
  end if;
  select * into request_row from public.program_requests where id = p_request_id for update;
  if not found then raise exception 'Program request not found' using errcode = 'P0002'; end if;
  if request_row.status <> 'pending' then raise exception 'This program request has already been reviewed' using errcode = '23514'; end if;

  if p_decision = 'approved' then
    if exists (select 1 from public.programs p where p.department_id = request_row.department_id and upper(p.code) = upper(request_row.code)) then
      raise exception 'A program with this code already exists in the department' using errcode = '23505';
    end if;
    insert into public.programs (department_id, code, name, status)
    values (request_row.department_id, request_row.code, request_row.name, 'active')
    returning id into created_program_id;
    update public.program_requests set status = 'approved', program_id = created_program_id,
      reviewed_by = caller_id, reviewed_at = now(), rejection_reason = null where id = request_row.id;
    return created_program_id;
  end if;

  update public.program_requests set status = 'rejected', rejection_reason = clean_reason,
    reviewed_by = caller_id, reviewed_at = now() where id = request_row.id;
  return null;
end;
$$;

revoke all on function public.submit_program_request(uuid, text, text, text) from public, anon;
grant execute on function public.submit_program_request(uuid, text, text, text) to authenticated;
revoke all on function public.system_admin_review_program_request(uuid, text, text) from public, anon;
grant execute on function public.system_admin_review_program_request(uuid, text, text) to authenticated;

create or replace function private.notify_program_request_parties()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_row record;
  department_name text;
  requester_name text;
  reviewer_name text;
begin
  if tg_op = 'INSERT' then
    select d.name into department_name from public.departments d where d.id = new.department_id;
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') into requester_name
      from public.profiles p where p.id = new.requested_by;
    for recipient_row in
      select distinct ur.user_id
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      join public.profiles p on p.id = ur.user_id
      where r.key = 'system_admin' and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now()) and p.status = 'active'
    loop
      insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
      values (recipient_row.user_id, 'program_request_review', 'Program addition requested',
        coalesce(requester_name, 'An Academic Admin') || ' from ' || coalesce(department_name, 'a department') || ' requested the program ' || new.code || ' · ' || new.name || '. Review this request in Academic Setup.',
        'program_request', new.id);
    end loop;
    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') into reviewer_name
      from public.profiles p where p.id = new.reviewed_by;
    insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
    values (new.requested_by, 'program_request_decision', 'Program request ' || new.status,
      case when new.status = 'approved'
        then 'Your request for ' || new.code || ' · ' || new.name || ' was approved by ' || coalesce(reviewer_name, 'a System Admin') || '.'
        else 'Your request for ' || new.code || ' · ' || new.name || ' was rejected by ' || coalesce(reviewer_name, 'a System Admin') || '. Reason: ' || new.rejection_reason
      end,
      'program_request', new.id);
  end if;
  return new;
end;
$$;

revoke all on function private.notify_program_request_parties() from public, anon, authenticated, service_role;
drop trigger if exists program_request_notifications on public.program_requests;
create trigger program_request_notifications
  after insert or update of status on public.program_requests
  for each row execute function private.notify_program_request_parties();
