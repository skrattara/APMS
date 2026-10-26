-- Score-version entries reference their enrollment and assessment. When either
-- parent is deleted, cascade cleanup must not try to create a new version row.
-- Direct score deletes continue to be recorded in gradebook history.
create or replace function private.record_gradebook_score_version()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_assessment_id uuid;
  v_enrollment_id uuid;
  v_class_record_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_actor_id uuid;
  v_restore_version_id uuid;
  v_batch_id uuid;
  v_action text;
begin
  if tg_op = 'UPDATE'
    and old.score is not distinct from new.score
    and old.categorical_value is not distinct from new.categorical_value then
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_assessment_id := old.assessment_id;
    v_enrollment_id := old.enrollment_id;
    if not exists (select 1 from public.assessments a where a.id = v_assessment_id)
      or not exists (select 1 from public.enrollments e where e.id = v_enrollment_id) then
      return old;
    end if;
    v_before := jsonb_build_object('assessment_id', old.assessment_id, 'enrollment_id', old.enrollment_id, 'score', old.score, 'categorical_value', old.categorical_value);
    v_actor_id := coalesce(auth.uid(), old.recorded_by);
  else
    v_assessment_id := new.assessment_id;
    v_enrollment_id := new.enrollment_id;
    if tg_op = 'UPDATE' then
      v_before := jsonb_build_object('assessment_id', old.assessment_id, 'enrollment_id', old.enrollment_id, 'score', old.score, 'categorical_value', old.categorical_value);
    end if;
    v_after := jsonb_build_object('assessment_id', new.assessment_id, 'enrollment_id', new.enrollment_id, 'score', new.score, 'categorical_value', new.categorical_value);
    v_actor_id := coalesce(auth.uid(), new.recorded_by);
  end if;

  select a.class_record_id into v_class_record_id
  from public.assessments a
  where a.id = v_assessment_id;
  if v_class_record_id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_restore_version_id := nullif(current_setting('apms.restore_score_version_id', true), '')::uuid;
  v_batch_id := nullif(current_setting('apms.score_change_batch_id', true), '')::uuid;
  v_action := case
    when v_restore_version_id is not null then 'restored'
    when tg_op = 'INSERT' then 'created'
    when tg_op = 'UPDATE' then 'updated'
    else 'deleted'
  end;
  insert into public.gradebook_score_versions (
    class_record_id, assessment_id, enrollment_id, action,
    before_data, after_data, actor_id, restored_from_version_id, batch_id
  ) values (
    v_class_record_id, v_assessment_id, v_enrollment_id, v_action,
    v_before, v_after, v_actor_id, v_restore_version_id, v_batch_id
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
