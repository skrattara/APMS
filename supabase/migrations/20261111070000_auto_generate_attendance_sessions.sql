alter table public.attendance_sessions
  add column schedule_component text,
  add column schedule_start_minute smallint,
  add constraint attendance_sessions_schedule_component_check
    check (schedule_component is null or schedule_component in ('lecture', 'laboratory')),
  add constraint attendance_sessions_schedule_start_minute_check
    check (schedule_start_minute is null or (schedule_start_minute between 0 and 1410 and schedule_start_minute % 30 = 0)),
  add constraint attendance_sessions_schedule_fields_check
    check ((schedule_component is null) = (schedule_start_minute is null));

create unique index attendance_sessions_scheduled_occurrence_idx
  on public.attendance_sessions (class_record_id, session_date, schedule_component, schedule_start_minute)
  where schedule_start_minute is not null;

create or replace function public.ensure_class_schedule_attendance_sessions(p_class_record_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  requester uuid := (select auth.uid());
  inserted_count integer := 0;
begin
  if requester is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.class_records cr
    join public.academic_terms term on term.id = cr.academic_term_id
    where cr.id = p_class_record_id
      and (select private.can_access_class(cr.id))
      and (select private.has_permission('attendance.manage.assigned'))
  ) then
    raise exception 'You cannot generate attendance sessions for this class' using errcode = '42501';
  end if;

  with term_dates as (
    select cr.id as class_record_id, generated.session_day::date as session_date
    from public.class_records cr
    join public.academic_terms term on term.id = cr.academic_term_id
    cross join lateral generate_series(term.starts_on::timestamp, term.ends_on::timestamp, interval '1 day') as generated(session_day)
    where cr.id = p_class_record_id
  ), meeting_starts as (
    select schedule.class_record_id, schedule.component_type, schedule.day_of_week, schedule.start_minute
    from public.class_schedule_slots schedule
    where schedule.class_record_id = p_class_record_id
      and not exists (
        select 1
        from public.class_schedule_slots previous_slot
        where previous_slot.class_record_id = schedule.class_record_id
          and previous_slot.component_type = schedule.component_type
          and previous_slot.day_of_week = schedule.day_of_week
          and previous_slot.start_minute = schedule.start_minute - 30
      )
  ), inserted as (
    insert into public.attendance_sessions (
      class_record_id, session_date, label, created_by, schedule_component, schedule_start_minute
    )
    select
      dates.class_record_id,
      dates.session_date,
      case starts.component_type when 'lecture' then 'Lecture' else 'Laboratory' end
        || ' · '
        || ((starts.start_minute / 60 + 11) % 12 + 1)::text
        || ':' || lpad((starts.start_minute % 60)::text, 2, '0')
        || case when starts.start_minute < 720 then ' AM' else ' PM' end,
      requester,
      starts.component_type,
      starts.start_minute
    from term_dates dates
    join meeting_starts starts
      on (extract(isodow from dates.session_date)::smallint - 1) = starts.day_of_week
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into inserted_count from inserted;

  return inserted_count;
end;
$$;

revoke all on function public.ensure_class_schedule_attendance_sessions(uuid) from public, anon;
grant execute on function public.ensure_class_schedule_attendance_sessions(uuid) to authenticated;
