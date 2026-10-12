-- Preserve schema-validated AI evaluation and assessment forecasts with each
-- advisory prediction so they can be inspected without changing official scores.
create or replace function public.faculty_save_prediction_run(
  p_class_record_id uuid,
  p_model_name text,
  p_model_version text,
  p_input_snapshot jsonb,
  p_predictions jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  resolved_model_version_id uuid;
  resolved_criteria_id uuid;
  resolved_run_id uuid;
begin
  if caller_id is null then raise exception 'Authentication required'; end if;
  if not private.has_permission('predictions.run.assigned') or not private.can_access_class(p_class_record_id) then
    raise exception 'Permission denied';
  end if;
  if jsonb_typeof(p_predictions) <> 'array' or jsonb_array_length(p_predictions) = 0 then
    raise exception 'At least one prediction is required';
  end if;

  insert into public.model_versions(name, version, feature_schema, metrics, status)
  values (
    btrim(coalesce(p_model_name, 'APMS AI Service')),
    btrim(coalesce(p_model_version, 'unversioned')),
    '{"inputs":["current_standing","recent_scores","attendance_rate","missing_assessment_count"]}'::jsonb,
    '{"institutionally_validated":false,"advisory_only":true}'::jsonb,
    'testing'
  )
  on conflict (name, version) do update
    set feature_schema = excluded.feature_schema,
        metrics = excluded.metrics,
        status = case when public.model_versions.status = 'active' then public.model_versions.status else excluded.status end
  returning id into resolved_model_version_id;

  insert into public.prediction_criteria(class_record_id, name, scenario, parameters, status, created_by)
  values (p_class_record_id, 'Faculty live AI prediction', 'stable', '{"source":"apms_ai_service","advisory_only":true}'::jsonb, 'active', caller_id)
  returning id into resolved_criteria_id;

  insert into public.prediction_runs(class_record_id, model_version_id, prediction_criteria_id, input_snapshot, status, initiated_by, started_at, completed_at)
  values (p_class_record_id, resolved_model_version_id, resolved_criteria_id, coalesce(p_input_snapshot, '{}'::jsonb), 'completed', caller_id, now(), now())
  returning id into resolved_run_id;

  insert into public.performance_predictions(prediction_run_id, enrollment_id, predicted_score, trend, risk_level, confidence, explanation)
  select
    resolved_run_id,
    prediction.enrollment_id,
    prediction.predicted_score,
    prediction.trend,
    prediction.risk_level,
    prediction.confidence,
    jsonb_build_object(
      'factors', coalesce(prediction.factors, '[]'::jsonb),
      'evaluation_scores', coalesce(prediction.evaluation_scores, '{}'::jsonb),
      'assessment_predictions', coalesce(prediction.assessment_predictions, '[]'::jsonb),
      'advisory', true,
      'data_basis', prediction.data_basis,
      'institutionally_validated', false
    )
  from jsonb_to_recordset(p_predictions) as prediction(
    enrollment_id uuid,
    predicted_score numeric,
    trend text,
    risk_level text,
    confidence numeric,
    factors jsonb,
    data_basis text,
    evaluation_scores jsonb,
    assessment_predictions jsonb
  )
  where exists (
    select 1 from public.enrollments e
    where e.id = prediction.enrollment_id
      and e.class_record_id = p_class_record_id
      and e.status = 'active'
  );

  return resolved_run_id;
end
$$;

alter table public.performance_predictions
  drop constraint if exists performance_predictions_risk_level_check;
alter table public.performance_predictions
  add constraint performance_predictions_risk_level_check
  check (risk_level in ('low', 'medium', 'high', 'unavailable'));

revoke all on function public.faculty_save_prediction_run(uuid, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.faculty_save_prediction_run(uuid, text, text, jsonb, jsonb) to authenticated;
