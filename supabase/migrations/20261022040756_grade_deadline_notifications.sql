-- Send idempotent deadline reminders to faculty assigned to each active class
-- and academic admins scoped to that class's department.
create extension if not exists pg_cron with schema pg_catalog;

create table private.grade_deadline_notification_deliveries (
  deadline_id uuid not null references public.grade_encoding_deadlines(id) on delete cascade,
  deadline_at timestamptz not null,
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  period_key text not null,
  event_key text not null check (event_key in ('approaching', 'passed')),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (deadline_id, deadline_at, class_record_id, period_key, event_key, recipient_id)
);
create index grade_deadline_notification_deliveries_class_idx
  on private.grade_deadline_notification_deliveries (class_record_id);
create index grade_deadline_notification_deliveries_recipient_idx
  on private.grade_deadline_notification_deliveries (recipient_id);

create table private.grade_deadline_notification_config (
  singleton boolean primary key default true check (singleton),
  enabled_at timestamptz not null default now()
);
insert into private.grade_deadline_notification_config (singleton) values (true);

alter table private.grade_deadline_notification_deliveries enable row level security;
alter table private.grade_deadline_notification_config enable row level security;

revoke all on table private.grade_deadline_notification_deliveries from public, anon, authenticated, service_role;
revoke all on table private.grade_deadline_notification_config from public, anon, authenticated, service_role;

create or replace function private.issue_grade_deadline_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deadline_row record;
  recipient_row record;
  inserted_count integer := 0;
begin
  for deadline_row in
    with class_context as (
      select distinct
        cr.id as class_record_id,
        cr.department_id,
        cr.section,
        s.code as subject_code,
        s.title as subject_title,
        term.academic_year || ' S' || term.semester as term_name,
        st.program_id,
        st.year_level
      from public.class_records cr
      join public.subjects s on s.id = cr.subject_id
      join public.academic_terms term on term.id = cr.academic_term_id
      join public.enrollments e on e.class_record_id = cr.id and e.status = 'active'
      join public.students st on st.id = e.student_id and st.status = 'active'
      where cr.status = 'active'
    ), scoped_periods as (
      select c.*, period.period_key
      from class_context c
      cross join lateral (
        select distinct d.period_key
        from public.grade_encoding_deadlines d
        where d.scope_type = 'system'
          or (d.department_id = c.department_id and d.scope_type = 'year_level' and d.year_level = c.year_level)
          or (d.department_id = c.department_id and d.scope_type = 'program' and d.program_id = c.program_id)
          or (d.department_id = c.department_id and d.scope_type = 'class' and d.class_record_id = c.class_record_id)
      ) period
    ), effective_deadlines as (
      select c.*, chosen.id as deadline_id, chosen.deadline_at
      from scoped_periods c
      cross join lateral (
        select d.id, d.deadline_at
        from public.grade_encoding_deadlines d
        where d.period_key = c.period_key
          and (
            d.scope_type = 'system'
            or (d.department_id = c.department_id and d.scope_type = 'year_level' and d.year_level = c.year_level)
            or (d.department_id = c.department_id and d.scope_type = 'program' and d.program_id = c.program_id)
            or (d.department_id = c.department_id and d.scope_type = 'class' and d.class_record_id = c.class_record_id)
          )
        order by case d.scope_type when 'class' then 4 when 'program' then 3 when 'year_level' then 2 else 1 end desc,
          d.updated_at desc
        limit 1
      ) chosen
    )
    select e.*, event.event_key
    from effective_deadlines e
    cross join lateral (
      select 'approaching'::text as event_key
      where (e.deadline_at at time zone 'Asia/Manila')::date =
        (now() at time zone 'Asia/Manila')::date + 3
      union all
      select 'passed'::text as event_key
      where e.deadline_at <= now()
        and e.deadline_at > (select c.enabled_at from private.grade_deadline_notification_config c where c.singleton)
    ) event
  loop
    for recipient_row in
      select distinct targets.recipient_id
      from (
        select fp.profile_id as recipient_id
        from public.faculty_assignments fa
        join public.faculty_profiles fp on fp.id = fa.faculty_id and fp.status = 'active'
        join public.profiles p on p.id = fp.profile_id and p.status = 'active'
        where fa.class_record_id = deadline_row.class_record_id and fa.status = 'active'
        union
        select ur.user_id as recipient_id
        from public.user_roles ur
        join public.roles r on r.id = ur.role_id and r.key = 'academic_admin'
        join public.profiles p on p.id = ur.user_id and p.status = 'active'
        where ur.scope_type = 'department'
          and ur.scope_id = deadline_row.department_id
          and ur.valid_from <= now()
          and (ur.valid_until is null or ur.valid_until > now())
      ) targets
    loop
      insert into private.grade_deadline_notification_deliveries (
        deadline_id, deadline_at, class_record_id, period_key, event_key, recipient_id
      ) values (
        deadline_row.deadline_id, deadline_row.deadline_at, deadline_row.class_record_id,
        deadline_row.period_key, deadline_row.event_key, recipient_row.recipient_id
      ) on conflict do nothing;

      if found then
        insert into public.notifications (recipient_id, type, title, body, entity_type, entity_id)
        values (
          recipient_row.recipient_id,
          case deadline_row.event_key when 'approaching' then 'grade_deadline_approaching' else 'grade_deadline_passed' end,
          case deadline_row.event_key when 'approaching' then 'Grade encoding deadline in 3 days' else 'Grade encoding deadline passed' end,
          case deadline_row.event_key
            when 'approaching' then format(
              '%s · %s (%s, %s): the %s deadline is in 3 days, on %s. Save grades before then.',
              deadline_row.subject_code, deadline_row.subject_title, deadline_row.section, deadline_row.term_name,
              case deadline_row.period_key when 'overall' then 'overall encoding' else upper(deadline_row.period_key) end,
              to_char(deadline_row.deadline_at at time zone 'Asia/Manila', 'Mon FMDD, YYYY')
            )
            else format(
              '%s · %s (%s, %s): the %s encoding deadline passed on %s. Grades in this scope can no longer be added or changed.',
              deadline_row.subject_code, deadline_row.subject_title, deadline_row.section, deadline_row.term_name,
              case deadline_row.period_key when 'overall' then 'overall' else upper(deadline_row.period_key) end,
              to_char(deadline_row.deadline_at at time zone 'Asia/Manila', 'Mon FMDD, YYYY')
            )
          end,
          'grade_encoding_deadline_reminder',
          deadline_row.deadline_id
        );
        inserted_count := inserted_count + 1;
      end if;
    end loop;
  end loop;

  return inserted_count;
end;
$$;

revoke all on function private.issue_grade_deadline_notifications() from public, anon, authenticated, service_role;

select cron.schedule(
  'grade-encoding-deadline-notifications',
  '0 * * * *',
  'select private.issue_grade_deadline_notifications();'
);
