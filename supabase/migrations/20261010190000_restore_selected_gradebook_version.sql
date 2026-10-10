create or replace function public.restore_assessment_score_version(target_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  target_version public.gradebook_score_versions%rowtype;
  selected_score numeric;
  selected_categorical_value text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into target_version
  from public.gradebook_score_versions
  where id = target_version_id;

  if not found or not private.can_access_class(target_version.class_record_id) then
    raise exception 'Score version not found' using errcode = 'P0002';
  end if;
  if not (
    private.has_permission('assessment_results.manage.assigned')
    or private.has_permission('assessment_results.manage.department')
  ) then
    raise exception 'Not authorized to restore scores for this class' using errcode = '42501';
  end if;

  -- Restore the selected version's saved state (after_data), not the state
  -- that preceded that change (before_data). A deleted version has no after
  -- state, so restoring it correctly clears the current score.
  selected_score := nullif(target_version.after_data ->> 'score', '')::numeric;
  selected_categorical_value := target_version.after_data ->> 'categorical_value';
  perform set_config('apms.restore_score_version_id', target_version.id::text, true);

  if selected_score is null and selected_categorical_value is null then
    delete from public.assessment_results
    where assessment_id = target_version.assessment_id
      and enrollment_id = target_version.enrollment_id;
  else
    insert into public.assessment_results (
      assessment_id, enrollment_id, score, categorical_value,
      source, approval_status, version, recorded_by
    ) values (
      target_version.assessment_id, target_version.enrollment_id,
      selected_score, selected_categorical_value,
      'manual', 'approved', 1, auth.uid()
    )
    on conflict (assessment_id, enrollment_id) do update set
      score = excluded.score,
      categorical_value = excluded.categorical_value,
      source = 'manual',
      approval_status = 'approved',
      version = public.assessment_results.version + 1,
      recorded_by = auth.uid(),
      updated_at = now();
  end if;
end;
$$;

revoke all on function public.restore_assessment_score_version(uuid) from public, anon;
grant execute on function public.restore_assessment_score_version(uuid) to authenticated;
