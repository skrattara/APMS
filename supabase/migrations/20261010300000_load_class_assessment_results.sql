-- Load a class's visible assessment results in one Data API round trip.
-- SECURITY INVOKER keeps the caller's table privileges and RLS policies active.
create or replace function public.load_class_assessment_results(p_class_record_id uuid)
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'assessment_id', ar.assessment_id,
        'enrollment_id', ar.enrollment_id,
        'score', ar.score,
        'categorical_value', ar.categorical_value
      )
    ),
    '[]'::json
  )
  from public.assessments as a
  join public.assessment_results as ar
    on ar.assessment_id = a.id
  where a.class_record_id = p_class_record_id
    and a.status <> 'archived';
$$;

revoke all on function public.load_class_assessment_results(uuid) from public;
revoke all on function public.load_class_assessment_results(uuid) from anon;
grant execute on function public.load_class_assessment_results(uuid) to authenticated;
