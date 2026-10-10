create or replace function public.restore_gradebook_to_version(target_version_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  anchor public.gradebook_score_versions%rowtype;
  affected integer := 0;
  changed integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into anchor
  from public.gradebook_score_versions
  where id = target_version_id;

  if not found or not private.can_access_class(anchor.class_record_id) then
    raise exception 'Score version not found' using errcode = 'P0002';
  end if;
  if not (
    private.has_permission('assessment_results.manage.assigned')
    or private.has_permission('assessment_results.manage.department')
  ) then
    raise exception 'Not authorized to restore scores for this class' using errcode = '42501';
  end if;

  drop table if exists pg_temp.gradebook_restore_snapshot;
  create temporary table gradebook_restore_snapshot on commit drop as
  select distinct on (v.assessment_id, v.enrollment_id)
    v.assessment_id,
    v.enrollment_id,
    nullif(v.after_data ->> 'score', '')::numeric as score,
    v.after_data ->> 'categorical_value' as categorical_value
  from public.gradebook_score_versions v
  where v.class_record_id = anchor.class_record_id
    and v.created_at <= anchor.created_at
  order by v.assessment_id, v.enrollment_id, v.created_at desc, v.id desc;

  -- Trigger-created versions are marked as restores and point back to the
  -- selected class-history event. The trigger preserves each affected row's
  -- before/after values, so the bulk operation itself remains reversible.
  perform set_config('apms.restore_score_version_id', anchor.id::text, true);

  delete from public.assessment_results r
  using public.assessments a
  where a.id = r.assessment_id
    and a.class_record_id = anchor.class_record_id
    and not exists (
      select 1
      from pg_temp.gradebook_restore_snapshot s
      where s.assessment_id = r.assessment_id
        and s.enrollment_id = r.enrollment_id
        and (s.score is not null or s.categorical_value is not null)
    );
  get diagnostics changed = row_count;
  affected := affected + changed;

  insert into public.assessment_results (
    assessment_id, enrollment_id, score, categorical_value,
    source, approval_status, version, recorded_by
  )
  select s.assessment_id, s.enrollment_id, s.score, s.categorical_value,
    'manual', 'approved', 1, auth.uid()
  from pg_temp.gradebook_restore_snapshot s
  where s.score is not null or s.categorical_value is not null
  on conflict (assessment_id, enrollment_id) do update set
    score = excluded.score,
    categorical_value = excluded.categorical_value,
    source = 'manual',
    approval_status = 'approved',
    version = public.assessment_results.version + 1,
    recorded_by = auth.uid(),
    updated_at = now()
  where public.assessment_results.score is distinct from excluded.score
    or public.assessment_results.categorical_value is distinct from excluded.categorical_value;
  get diagnostics changed = row_count;
  affected := affected + changed;

  return affected;
end;
$$;

revoke all on function public.restore_gradebook_to_version(uuid) from public, anon;
grant execute on function public.restore_gradebook_to_version(uuid) to authenticated;
