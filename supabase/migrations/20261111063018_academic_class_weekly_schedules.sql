create table public.class_schedule_slots (
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  component_type text not null check (component_type in ('lecture', 'laboratory')),
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_minute smallint not null check (start_minute between 0 and 1410 and start_minute % 30 = 0),
  created_at timestamptz not null default now(),
  primary key (class_record_id, component_type, day_of_week, start_minute)
);

create index class_schedule_slots_class_week_idx
  on public.class_schedule_slots (class_record_id, day_of_week, start_minute);
create unique index class_schedule_slots_no_component_overlap_idx
  on public.class_schedule_slots (class_record_id, day_of_week, start_minute);

alter table public.class_schedule_slots enable row level security;
grant select on public.class_schedule_slots to authenticated;

create policy class_schedule_slots_read
  on public.class_schedule_slots for select to authenticated
  using (private.can_access_class(class_record_id));

create or replace function private.valid_class_schedule_slots(p_slots jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  slot jsonb;
  day_value text;
  minute_value text;
  occupied_period text;
  occupied_periods text[] := '{}'::text[];
begin
  if p_slots is null then return false; end if;
  if jsonb_typeof(p_slots) <> 'array' then return false; end if;
  if jsonb_array_length(p_slots) > 672 then return false; end if;
  for slot in select value from jsonb_array_elements(p_slots) as entry(value) loop
    if jsonb_typeof(slot) <> 'object'
      or jsonb_typeof(slot -> 'component_type') is distinct from 'string'
      or slot ->> 'component_type' not in ('lecture', 'laboratory') then
      return false;
    end if;
    day_value := slot ->> 'day_of_week';
    minute_value := slot ->> 'start_minute';
    if day_value is null or minute_value is null
      or jsonb_typeof(slot -> 'day_of_week') is distinct from 'number'
      or day_value !~ '^[0-6]$'
      or jsonb_typeof(slot -> 'start_minute') is distinct from 'number'
      or minute_value !~ '^(0|[1-9][0-9]*)$'
      or length(minute_value) > 4 then
      return false;
    end if;
    if minute_value::integer > 1410 or minute_value::integer % 30 <> 0 then
      return false;
    end if;
    occupied_period := day_value || ':' || minute_value;
    if occupied_period = any(occupied_periods) then return false; end if;
    occupied_periods := array_append(occupied_periods, occupied_period);
  end loop;
  return true;
end;
$$;
revoke all on function private.valid_class_schedule_slots(jsonb) from public, anon, authenticated;

create or replace function public.academic_admin_create_class_with_schedule(
  p_subject_id uuid,
  p_academic_term_id uuid,
  p_section text,
  p_faculty_user_ids uuid[],
  p_request_id uuid,
  p_weekly_schedule jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester uuid := (select auth.uid());
  new_class_id uuid;
  lecture_units smallint;
  laboratory_units smallint;
  slot jsonb;
begin
  if requester is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.valid_class_schedule_slots(p_weekly_schedule) then
    raise exception 'The weekly schedule contains an invalid time slot' using errcode = '22023';
  end if;

  new_class_id := public.academic_admin_create_class(
    p_subject_id, p_academic_term_id, p_section, p_faculty_user_ids, p_request_id
  );
  select s.lecture_units, s.laboratory_units
  into lecture_units, laboratory_units
  from public.class_records cr
  join public.subjects s on s.id = cr.subject_id
  where cr.id = new_class_id;
  if (lecture_units = 0 and exists (
      select 1 from jsonb_array_elements(p_weekly_schedule) entry(value)
      where value ->> 'component_type' = 'lecture'
    ))
    or (laboratory_units = 0 and exists (
      select 1 from jsonb_array_elements(p_weekly_schedule) entry(value)
      where value ->> 'component_type' = 'laboratory'
    )) then
    raise exception 'This subject does not have units for the selected schedule component'
      using errcode = '22023';
  end if;
  for slot in select value from jsonb_array_elements(p_weekly_schedule) as entry(value) loop
    insert into public.class_schedule_slots (class_record_id, component_type, day_of_week, start_minute)
    values (
      new_class_id,
      slot ->> 'component_type',
      (slot ->> 'day_of_week')::smallint,
      (slot ->> 'start_minute')::smallint
    );
  end loop;
  return new_class_id;
end;
$$;
revoke all on function public.academic_admin_create_class_with_schedule(uuid, uuid, text, uuid[], uuid, jsonb) from public, anon;
grant execute on function public.academic_admin_create_class_with_schedule(uuid, uuid, text, uuid[], uuid, jsonb) to authenticated;

create or replace function public.academic_admin_save_class_schedule(
  p_class_record_id uuid,
  p_weekly_schedule jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester uuid := (select auth.uid());
  target_department_id uuid;
  lecture_units smallint;
  laboratory_units smallint;
  slot jsonb;
begin
  if requester is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.valid_class_schedule_slots(p_weekly_schedule) then
    raise exception 'The weekly schedule contains an invalid time slot' using errcode = '22023';
  end if;
  select cr.department_id, s.lecture_units, s.laboratory_units
  into target_department_id, lecture_units, laboratory_units
  from public.class_records cr
  join public.subjects s on s.id = cr.subject_id
  where cr.id = p_class_record_id for update of cr;
  if target_department_id is null
    or not private.is_academic_admin_for_department(target_department_id) then
    raise exception 'Only this department Academic Admin can edit the class schedule'
      using errcode = '42501';
  end if;
  if (lecture_units = 0 and exists (
      select 1 from jsonb_array_elements(p_weekly_schedule) entry(value)
      where value ->> 'component_type' = 'lecture'
    ))
    or (laboratory_units = 0 and exists (
      select 1 from jsonb_array_elements(p_weekly_schedule) entry(value)
      where value ->> 'component_type' = 'laboratory'
    )) then
    raise exception 'This subject does not have units for the selected schedule component'
      using errcode = '22023';
  end if;

  delete from public.class_schedule_slots where class_record_id = p_class_record_id;
  for slot in select value from jsonb_array_elements(p_weekly_schedule) as entry(value) loop
    insert into public.class_schedule_slots (class_record_id, component_type, day_of_week, start_minute)
    values (
      p_class_record_id,
      slot ->> 'component_type',
      (slot ->> 'day_of_week')::smallint,
      (slot ->> 'start_minute')::smallint
    );
  end loop;
end;
$$;
revoke all on function public.academic_admin_save_class_schedule(uuid, jsonb) from public, anon;
grant execute on function public.academic_admin_save_class_schedule(uuid, jsonb) to authenticated;

-- Restore schedule rows through the same permission-gated backup workflow.
create or replace function public.restore_apms_class_schedule_slots(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb;
  target_class_id uuid;
  component text;
  day_value text;
  minute_value text;
  restored_count integer := 0;
  inserted_count integer;
  normalized_slot jsonb;
begin
  if (select auth.uid()) is null or not private.has_permission('backups.manage') then
    raise exception 'System Admin backup permission required' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Invalid schedule backup rows' using errcode = '22023';
  end if;

  for row_data in select value from jsonb_array_elements(p_rows) as entry(value) loop
    target_class_id := (row_data ->> 'class_record_id')::uuid;
    component := row_data ->> 'component_type';
    day_value := row_data ->> 'day_of_week';
    minute_value := row_data ->> 'start_minute';
    normalized_slot := jsonb_build_array(jsonb_build_object(
      'component_type', row_data -> 'component_type',
      'day_of_week', row_data -> 'day_of_week',
      'start_minute', row_data -> 'start_minute'
    ));
    if target_class_id is null or not private.valid_class_schedule_slots(normalized_slot) then
      raise exception 'Invalid schedule backup row' using errcode = '22023';
    end if;
    insert into public.class_schedule_slots (class_record_id, component_type, day_of_week, start_minute)
    values (target_class_id, component, day_value::smallint, minute_value::smallint)
    on conflict (class_record_id, component_type, day_of_week, start_minute) do nothing;
    get diagnostics inserted_count = row_count;
    restored_count := restored_count + inserted_count;
  end loop;

  return jsonb_build_object('restored_rows', restored_count);
end;
$$;
revoke all on function public.restore_apms_class_schedule_slots(jsonb) from public, anon;
grant execute on function public.restore_apms_class_schedule_slots(jsonb) to authenticated;
