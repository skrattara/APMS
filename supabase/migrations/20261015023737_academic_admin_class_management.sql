-- Class records are created by department Academic Admins; Faculty request a
-- class and gain access only after an Academic Admin assigns them to it.

alter table public.subjects
  add column if not exists lecture_units smallint not null default 3
    check (lecture_units between 0 and 12),
  add column if not exists laboratory_units smallint not null default 0
    check (laboratory_units between 0 and 12);

create or replace function private.is_academic_admin_for_department(target_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = (select auth.uid())
      and r.key = 'academic_admin'
      and ur.scope_type = 'department'
      and ur.scope_id = target_department_id
      and ur.valid_from <= now()
      and (ur.valid_until is null or ur.valid_until > now())
  );
$$;
revoke all on function private.is_academic_admin_for_department(uuid) from public, anon;
grant execute on function private.is_academic_admin_for_department(uuid) to authenticated;

insert into public.permissions (key, description)
values ('class_records.manage.department', 'Create and manage class records in an authorized academic department')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'class_records.manage.department'
where r.key = 'academic_admin'
on conflict do nothing;

create table public.class_requests (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  academic_term_id uuid not null references public.academic_terms(id) on delete restrict,
  section text not null check (length(trim(section)) between 1 and 80),
  rationale text not null check (length(trim(rationale)) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  class_record_id uuid references public.class_records(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.academic_admin_manage_subject_unit_split(
  p_subject_id uuid,
  p_department_id uuid,
  p_code text,
  p_title text,
  p_lecture_units smallint,
  p_laboratory_units smallint,
  p_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  subject_id uuid;
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not private.can_manage_academic_department(p_department_id, 'subjects.manage.department')
     and not private.has_permission('system.configure') then
    raise exception 'Not authorized to manage subjects for this department' using errcode = '42501';
  end if;
  if p_lecture_units is null or p_lecture_units not between 0 and 12
     or p_laboratory_units is null or p_laboratory_units not between 0 and 12 then
    raise exception 'Lecture and laboratory units must each be between 0 and 12' using errcode = '22023';
  end if;
  subject_id := public.academic_admin_manage_subject(
    p_subject_id, p_department_id, p_code, p_title,
    greatest(1, p_lecture_units + p_laboratory_units)::numeric, p_status
  );
  update public.subjects
  set lecture_units = p_lecture_units, laboratory_units = p_laboratory_units
  where id = subject_id and department_id = p_department_id;
  return subject_id;
end;
$$;
revoke all on function public.academic_admin_manage_subject_unit_split(uuid, uuid, text, text, smallint, smallint, text) from public, anon;
grant execute on function public.academic_admin_manage_subject_unit_split(uuid, uuid, text, text, smallint, smallint, text) to authenticated;

create index class_requests_department_status_created_idx
  on public.class_requests (department_id, status, created_at desc);
create index class_requests_requester_created_idx
  on public.class_requests (requested_by, created_at desc);
create unique index class_requests_pending_unique_idx
  on public.class_requests (department_id, subject_id, academic_term_id, upper(section))
  where status = 'pending';

alter table public.class_requests enable row level security;
revoke all on public.class_requests from anon, authenticated;
grant select on public.class_requests to authenticated;
revoke insert, update, delete on public.faculty_assignments from anon, authenticated;

create policy class_requests_read_scoped on public.class_requests
  for select to authenticated
  using (
    requested_by = (select auth.uid())
    or private.is_academic_admin_for_department(department_id)
  );

drop trigger if exists class_requests_set_updated_at on public.class_requests;
create trigger class_requests_set_updated_at
  before update on public.class_requests
  for each row execute function private.set_updated_at();

drop trigger if exists class_requests_audit on public.class_requests;
create trigger class_requests_audit
  after insert or update or delete on public.class_requests
  for each row execute function private.audit_academic_mutation();

-- Prevent Faculty from bypassing the request-and-assignment workflow via either
-- direct table writes or the legacy self-assignment RPC.
drop policy if exists class_records_scoped_manage on public.class_records;
drop policy if exists class_records_scoped_insert on public.class_records;
revoke insert on public.class_records from anon, authenticated;

drop policy if exists class_records_scoped_update on public.class_records;
create policy class_records_scoped_update on public.class_records
  for update to authenticated
  using (
    private.can_access_class(id)
    and (
      private.can_manage_academic_department(department_id, 'class_records.manage.department')
      or private.can_manage_academic_department(department_id, 'class_records.manage.assigned')
    )
  )
  with check (
    private.can_access_class(id)
    and (
      private.can_manage_academic_department(department_id, 'class_records.manage.department')
      or private.can_manage_academic_department(department_id, 'class_records.manage.assigned')
    )
  );

drop policy if exists class_records_scoped_delete on public.class_records;
create policy class_records_scoped_delete on public.class_records
  for delete to authenticated
  using (
    private.can_access_class(id)
    and (
      private.can_manage_academic_department(department_id, 'class_records.manage.department')
      or private.can_manage_academic_department(department_id, 'class_records.manage.assigned')
    )
  );

revoke all on function public.faculty_create_class(uuid, uuid, text) from public, anon, authenticated;
drop function if exists public.faculty_submit_class_request(uuid, uuid, text, smallint, smallint, text);

create or replace function public.faculty_submit_class_request(
  p_subject_id uuid,
  p_academic_term_id uuid,
  p_section text,
  p_rationale text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  faculty_department_id uuid;
  new_request_id uuid;
  clean_section text := trim(coalesce(p_section, ''));
  clean_rationale text := trim(coalesce(p_rationale, ''));
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  faculty_department_id := private.get_faculty_department_id();
  if faculty_department_id is null then raise exception 'An active Faculty profile is required' using errcode = '42501'; end if;
  if clean_section = '' or length(clean_section) > 80 then raise exception 'Section must be between 1 and 80 characters' using errcode = '22023'; end if;
  if length(clean_rationale) < 10 or length(clean_rationale) > 2000 then raise exception 'Please provide a rationale between 10 and 2000 characters' using errcode = '22023'; end if;
  if not exists (select 1 from public.subjects s where s.id = p_subject_id and s.department_id = faculty_department_id and s.status = 'active') then
    raise exception 'Choose an active subject in your department' using errcode = '42501';
  end if;
  if not exists (select 1 from public.academic_terms t where t.id = p_academic_term_id and t.status in ('active', 'planned')) then
    raise exception 'Choose an active or planned academic term' using errcode = '22023';
  end if;

  insert into public.class_requests (department_id, requested_by, subject_id, academic_term_id, section, rationale)
  values (faculty_department_id, caller_id, p_subject_id, p_academic_term_id, clean_section, clean_rationale)
  returning id into new_request_id;
  return new_request_id;
end;
$$;

drop function if exists public.academic_admin_create_class(uuid, uuid, text, smallint, smallint, uuid[], uuid);
create or replace function public.academic_admin_create_class(
  p_subject_id uuid,
  p_academic_term_id uuid,
  p_section text,
  p_faculty_user_ids uuid[],
  p_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  request_row public.class_requests%rowtype;
  target_subject_id uuid := p_subject_id;
  target_term_id uuid := p_academic_term_id;
  target_section text := trim(coalesce(p_section, ''));
  target_department_id uuid;
  new_class_id uuid;
  faculty_count integer;
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  if p_request_id is not null then
    select * into request_row from public.class_requests where id = p_request_id for update;
    if request_row.id is null then raise exception 'Class request not found' using errcode = 'P0002'; end if;
    if request_row.status <> 'pending' then raise exception 'This class request has already been reviewed' using errcode = '23514'; end if;
    target_subject_id := request_row.subject_id;
    target_term_id := request_row.academic_term_id;
    target_section := request_row.section;
    target_department_id := request_row.department_id;
  else
    select s.department_id into target_department_id from public.subjects s where s.id = target_subject_id and s.status = 'active';
  end if;

  if target_department_id is null or not private.is_academic_admin_for_department(target_department_id) then
    raise exception 'Only an authorized Academic Admin can create classes for this department' using errcode = '42501';
  end if;
  if target_section = '' or length(target_section) > 80 then raise exception 'Section must be between 1 and 80 characters' using errcode = '22023'; end if;
  if coalesce(cardinality(p_faculty_user_ids), 0) < 1 then raise exception 'Assign at least one active Faculty member' using errcode = '22023'; end if;
  select count(distinct fp.profile_id) into faculty_count
  from public.faculty_profiles fp
  where fp.profile_id = any(p_faculty_user_ids)
    and fp.department_id = target_department_id
    and fp.status = 'active';
  if faculty_count <> (select count(distinct id) from unnest(p_faculty_user_ids) as requested(id)) then
    raise exception 'Every assigned Faculty member must have an active profile in this department' using errcode = '22023';
  end if;
  if not exists (select 1 from public.subjects s where s.id = target_subject_id and s.department_id = target_department_id and s.status = 'active') then
    raise exception 'Choose an active subject in the class department' using errcode = '22023';
  end if;
  if not exists (select 1 from public.academic_terms t where t.id = target_term_id and t.status in ('active', 'planned')) then
    raise exception 'Choose an active or planned academic term' using errcode = '22023';
  end if;
  if exists (select 1 from public.class_records cr where cr.subject_id = target_subject_id and cr.academic_term_id = target_term_id and upper(cr.section) = upper(target_section)) then
    raise exception 'A class for this subject and section already exists in this term' using errcode = '23505';
  end if;

  insert into public.class_records (subject_id, academic_term_id, department_id, section, status, version, created_by)
  values (target_subject_id, target_term_id, target_department_id, target_section, 'active', 1, caller_id)
  returning id into new_class_id;

  insert into public.faculty_assignments (faculty_id, class_record_id, assignment_role, status)
  select fp.id, new_class_id, 'instructor', 'active'
  from public.faculty_profiles fp
  where fp.profile_id = any(p_faculty_user_ids)
    and fp.department_id = target_department_id
    and fp.status = 'active'
  on conflict (faculty_id, class_record_id, assignment_role) do update set status = 'active';

  if p_request_id is not null then
    update public.class_requests
    set status = 'approved', reviewed_by = caller_id, reviewed_at = now(), class_record_id = new_class_id, review_note = null
    where id = p_request_id;
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after_data)
  values (caller_id, 'class_record.created', 'class_records', new_class_id,
    jsonb_build_object('subject_id', target_subject_id, 'academic_term_id', target_term_id, 'department_id', target_department_id, 'section', target_section, 'faculty_user_ids', p_faculty_user_ids, 'class_request_id', p_request_id));
  return new_class_id;
end;
$$;

create or replace function public.academic_admin_reject_class_request(p_request_id uuid, p_review_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  request_row public.class_requests%rowtype;
begin
  if caller_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into request_row from public.class_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'Class request not found' using errcode = 'P0002'; end if;
  if request_row.status <> 'pending' then raise exception 'This class request has already been reviewed' using errcode = '23514'; end if;
  if not private.is_academic_admin_for_department(request_row.department_id) then raise exception 'Only an authorized Academic Admin can review this request' using errcode = '42501'; end if;
  if length(trim(coalesce(p_review_note, ''))) < 3 then raise exception 'A review note is required when rejecting a class request' using errcode = '22023'; end if;
  update public.class_requests set status = 'rejected', reviewed_by = caller_id, reviewed_at = now(), review_note = trim(p_review_note) where id = p_request_id;
end;
$$;

revoke all on function public.faculty_submit_class_request(uuid, uuid, text, text) from public, anon;
revoke all on function public.academic_admin_create_class(uuid, uuid, text, uuid[], uuid) from public, anon;
revoke all on function public.academic_admin_reject_class_request(uuid, text) from public, anon;
grant execute on function public.faculty_submit_class_request(uuid, uuid, text, text) to authenticated;
grant execute on function public.academic_admin_create_class(uuid, uuid, text, uuid[], uuid) to authenticated;
grant execute on function public.academic_admin_reject_class_request(uuid, text) to authenticated;
