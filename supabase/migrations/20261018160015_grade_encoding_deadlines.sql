create table public.grade_encoding_deadlines (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('system', 'program', 'year_level')),
  department_id uuid references public.departments(id) on delete cascade,
  program_id uuid references public.programs(id) on delete cascade,
  year_level smallint check (year_level between 1 and 8),
  period_key text not null check (period_key = 'overall' or period_key ~ '^p[1-9][0-9]*$'),
  deadline_at timestamptz not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'system' and department_id is null and program_id is null and year_level is null)
    or (scope_type = 'program' and department_id is not null and program_id is not null and year_level is null)
    or (scope_type = 'year_level' and department_id is not null and program_id is null and year_level is not null)
  )
);

create unique index grade_encoding_deadlines_scope_period_uidx
  on public.grade_encoding_deadlines (
    scope_type,
    coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(year_level, 0),
    period_key
  );
create index grade_encoding_deadlines_program_period_idx
  on public.grade_encoding_deadlines (program_id, period_key) where program_id is not null;
create index grade_encoding_deadlines_year_period_idx
  on public.grade_encoding_deadlines (department_id, year_level, period_key) where scope_type = 'year_level';

create table public.grade_encoding_deadline_requests (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  scope_type text not null check (scope_type in ('program', 'year_level')),
  program_id uuid references public.programs(id) on delete restrict,
  year_level smallint check (year_level between 1 and 8),
  requested_deadlines jsonb not null check (jsonb_typeof(requested_deadlines) = 'object'),
  rationale text not null check (length(trim(rationale)) between 10 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'program' and program_id is not null and year_level is null)
    or (scope_type = 'year_level' and program_id is null and year_level is not null)
  )
);

create index grade_encoding_deadline_requests_review_idx
  on public.grade_encoding_deadline_requests (status, created_at desc);
create index grade_encoding_deadline_requests_department_idx
  on public.grade_encoding_deadline_requests (department_id, created_at desc);

alter table public.grade_encoding_deadlines enable row level security;
alter table public.grade_encoding_deadline_requests enable row level security;

grant select on public.grade_encoding_deadlines to authenticated;
grant insert, update, delete on public.grade_encoding_deadlines to authenticated;
grant select, insert on public.grade_encoding_deadline_requests to authenticated;
grant update (status, review_note, reviewed_by, reviewed_at, updated_at)
  on public.grade_encoding_deadline_requests to authenticated;

create policy grade_encoding_deadlines_read
  on public.grade_encoding_deadlines for select to authenticated using (true);
create policy grade_encoding_deadlines_system_manage
  on public.grade_encoding_deadlines for all to authenticated
  using (private.has_permission('system.configure'))
  with check (private.has_permission('system.configure'));

create policy grade_encoding_deadline_requests_read
  on public.grade_encoding_deadline_requests for select to authenticated
  using (requested_by = (select auth.uid()) or private.has_permission('system.configure'));
create policy grade_encoding_deadline_requests_create
  on public.grade_encoding_deadline_requests for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and status = 'pending'
    and private.has_permission('criteria.manage.department')
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and r.key = 'academic_admin'
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
    and (
      (scope_type = 'program' and exists (
        select 1 from public.programs p where p.id = grade_encoding_deadline_requests.program_id and p.department_id = grade_encoding_deadline_requests.department_id
      ))
      or scope_type = 'year_level'
    )
  );
create policy grade_encoding_deadline_requests_review
  on public.grade_encoding_deadline_requests for update to authenticated
  using (private.has_permission('system.configure') and status = 'pending')
  with check (private.has_permission('system.configure'));

create or replace function private.apply_grade_encoding_deadline_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  item record;
  normalized_period text;
  parsed_deadline timestamptz;
begin
  if new.status <> 'approved' or old.status = 'approved' then
    return new;
  end if;
  if not private.has_permission('system.configure') then
    raise exception 'Not authorized to approve grade deadline requests' using errcode = '42501';
  end if;
  if new.reviewed_by is distinct from (select auth.uid()) then
    raise exception 'The reviewer must match the authenticated user' using errcode = '42501';
  end if;

  for item in select key, value from jsonb_each(new.requested_deadlines)
  loop
    normalized_period := lower(trim(item.key));
    if normalized_period <> 'overall' and normalized_period !~ '^p[1-9][0-9]*$' then
      raise exception 'Invalid grading period in deadline request' using errcode = '22023';
    end if;
    if item.value = 'null'::jsonb then
      delete from public.grade_encoding_deadlines
      where scope_type = new.scope_type
        and department_id = new.department_id
        and program_id is not distinct from new.program_id
        and year_level is not distinct from new.year_level
        and period_key = normalized_period;
    else
      parsed_deadline := (item.value #>> '{}')::timestamptz;
      insert into public.grade_encoding_deadlines (
        scope_type, department_id, program_id, year_level, period_key, deadline_at, updated_by, updated_at
      ) values (
        new.scope_type, new.department_id, new.program_id, new.year_level,
        normalized_period, parsed_deadline, new.reviewed_by, now()
      )
      on conflict (
        scope_type,
        (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)),
        (coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid)),
        (coalesce(year_level, 0)), period_key
      ) do update set
        deadline_at = excluded.deadline_at,
        updated_by = excluded.updated_by,
        updated_at = now();
    end if;
  end loop;
  return new;
end;
$$;

create or replace function public.save_system_grade_encoding_deadlines(p_deadlines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  item record;
  normalized_period text;
  parsed_deadline timestamptz;
begin
  if (select auth.uid()) is null or not private.has_permission('system.configure') then
    raise exception 'Not authorized to manage system grade deadlines' using errcode = '42501';
  end if;
  if jsonb_typeof(p_deadlines) <> 'object' then
    raise exception 'Deadlines must be supplied as an object' using errcode = '22023';
  end if;

  for item in select key, value from jsonb_each(p_deadlines)
  loop
    normalized_period := lower(trim(item.key));
    if normalized_period <> 'overall' and normalized_period !~ '^p[1-9][0-9]*$' then
      raise exception 'Invalid grading period in system deadline settings' using errcode = '22023';
    end if;
    if item.value = 'null'::jsonb then
      delete from public.grade_encoding_deadlines
      where scope_type = 'system' and period_key = normalized_period;
    else
      parsed_deadline := (item.value #>> '{}')::timestamptz;
      insert into public.grade_encoding_deadlines (scope_type, period_key, deadline_at, updated_by, updated_at)
      values ('system', normalized_period, parsed_deadline, (select auth.uid()), now())
      on conflict (
        scope_type,
        (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)),
        (coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid)),
        (coalesce(year_level, 0)), period_key
      ) do update set deadline_at = excluded.deadline_at, updated_by = excluded.updated_by, updated_at = now();
    end if;
  end loop;
end;
$$;
revoke all on function public.save_system_grade_encoding_deadlines(jsonb) from public, anon;
grant execute on function public.save_system_grade_encoding_deadlines(jsonb) to authenticated;

revoke all on function private.apply_grade_encoding_deadline_request() from public, anon, authenticated;
create trigger apply_grade_encoding_deadline_request
  after update of status on public.grade_encoding_deadline_requests
  for each row execute function private.apply_grade_encoding_deadline_request();

create or replace function private.enforce_grade_encoding_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_assessment_id uuid;
  target_enrollment_id uuid;
  target_program_id uuid;
  target_year_level smallint;
  target_department_id uuid;
  period_name text;
  applicable_deadline timestamptz;
  deadline_scope text;
begin
  if tg_op = 'DELETE' then
    target_assessment_id := old.assessment_id;
    target_enrollment_id := old.enrollment_id;
  else
    target_assessment_id := new.assessment_id;
    target_enrollment_id := new.enrollment_id;
  end if;

  select st.program_id, st.year_level, p.department_id,
    coalesce(nullif(lower(trim(a.grading_period)), ''), 'overall')
  into target_program_id, target_year_level, target_department_id, period_name
  from public.assessments a
  join public.enrollments e on e.id = target_enrollment_id
  join public.students st on st.id = e.student_id
  join public.programs p on p.id = st.program_id
  where a.id = target_assessment_id;

  if target_program_id is null then
    raise exception 'Unable to resolve the program and grading period for this score' using errcode = '23503';
  end if;
  if period_name !~ '^p[1-9][0-9]*$' then
    period_name := regexp_replace(period_name, '[^a-z0-9]+', '_', 'g');
  end if;

  foreach deadline_scope in array array['overall', period_name]
  loop
    select d.deadline_at into applicable_deadline
    from public.grade_encoding_deadlines d
    where d.period_key = deadline_scope
      and (
        d.scope_type = 'system'
        or (d.department_id = target_department_id and d.scope_type = 'year_level' and d.year_level = target_year_level)
        or (d.department_id = target_department_id and d.scope_type = 'program' and d.program_id = target_program_id)
      )
    order by case d.scope_type when 'program' then 3 when 'year_level' then 2 else 1 end desc,
      d.updated_at desc
    limit 1;

    if applicable_deadline is not null and now() > applicable_deadline then
      raise exception 'Grade encoding is closed for %; the deadline was %', deadline_scope, applicable_deadline
        using errcode = '55000';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.enforce_grade_encoding_deadline() from public, anon, authenticated;
create trigger enforce_grade_encoding_deadline
  before insert or update or delete on public.assessment_results
  for each row execute function private.enforce_grade_encoding_deadline();
