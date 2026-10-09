alter table public.feedback_records
  drop constraint if exists feedback_records_status_check;

update public.feedback_records set status = 'published' where status = 'sent';

alter table public.feedback_records
  add constraint feedback_records_status_check
  check (status in ('draft', 'ready', 'published', 'failed', 'archived'));

alter table public.performance_predictions
  drop constraint if exists performance_predictions_risk_level_check;
alter table public.performance_predictions
  add constraint performance_predictions_risk_level_check
  check (risk_level in ('low', 'medium', 'high', 'unavailable'));

drop policy if exists feedback_scoped_read on public.feedback_records;
create policy feedback_scoped_read on public.feedback_records for select to authenticated using (
  author_id = (select auth.uid())
  or (
    feedback_records.status = 'published'
    and exists (
      select 1 from public.students s
      where s.id = student_id and s.profile_id = (select auth.uid())
    )
  )
);

create or replace function public.faculty_upsert_feedback(
  p_feedback_id uuid,
  p_enrollment_id uuid,
  p_body text,
  p_category text,
  p_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  resolved_student_id uuid;
  resolved_class_id uuid;
  resolved_evaluation_id uuid;
  resolved_prediction_id uuid;
  resolved_feedback_id uuid;
  clean_status text := coalesce(nullif(btrim(p_status), ''), 'draft');
begin
  if caller_id is null then raise exception 'Authentication required'; end if;
  if not private.has_permission('feedback.send.assigned') then raise exception 'Permission denied'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'Feedback body is required'; end if;
  if clean_status not in ('draft', 'published') then raise exception 'Feedback must be saved as draft or published'; end if;

  select e.student_id, e.class_record_id
    into resolved_student_id, resolved_class_id
  from public.enrollments e
  where e.id = p_enrollment_id and e.status = 'active';

  if resolved_student_id is null or not private.can_access_class(resolved_class_id) then
    raise exception 'Enrollment is outside the Faculty scope';
  end if;

  if p_feedback_id is not null then
    update public.feedback_records
      set body = btrim(p_body),
          category = coalesce(nullif(btrim(p_category), ''), 'custom'),
          status = clean_status,
          sent_at = case when clean_status = 'published' then now() else null end,
          updated_at = now()
    where id = p_feedback_id
      and enrollment_id = p_enrollment_id
      and author_id = caller_id
      and status in ('draft', 'ready')
    returning id into resolved_feedback_id;
    if resolved_feedback_id is null then raise exception 'Only your own unpublished feedback can be edited or published'; end if;
    return resolved_feedback_id;
  end if;

  select pe.id into resolved_evaluation_id
  from public.performance_evaluations pe
  where pe.enrollment_id = p_enrollment_id
  order by pe.calculated_at desc limit 1;

  select pp.id into resolved_prediction_id
  from public.performance_predictions pp
  where pp.enrollment_id = p_enrollment_id
  order by pp.created_at desc limit 1;

  insert into public.feedback_records(
    student_id, enrollment_id, evaluation_id, prediction_id, author_id, body, category, status, sent_at
  ) values (
    resolved_student_id, p_enrollment_id, resolved_evaluation_id, resolved_prediction_id, caller_id,
    btrim(p_body), coalesce(nullif(btrim(p_category), ''), 'custom'), clean_status,
    case when clean_status = 'published' then now() else null end
  ) returning id into resolved_feedback_id;

  return resolved_feedback_id;
end
$$;

revoke all on function public.faculty_upsert_feedback(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.faculty_upsert_feedback(uuid, uuid, text, text, text) to authenticated;
