alter table public.gradebook_score_versions
  add column if not exists batch_id uuid;

create index if not exists gradebook_score_versions_batch_idx
  on public.gradebook_score_versions (batch_id, created_at desc)
  where batch_id is not null;

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

create or replace view public.gradebook_version_history
with (security_invoker = true)
as
select
  v.id,
  v.class_record_id,
  v.created_at,
  'score'::text as event_type,
  v.assessment_id,
  v.enrollment_id,
  v.actor_id,
  v.actor_name,
  v.action,
  v.before_data,
  v.after_data,
  v.restored_from_version_id,
  v.version_name,
  v.batch_id
from public.gradebook_score_versions v
union all
select
  l.id,
  coalesce(
    nullif(l.after_data ->> 'class_record_id', '')::uuid,
    nullif(l.before_data ->> 'class_record_id', '')::uuid
  ) as class_record_id,
  l.created_at,
  'assessment'::text as event_type,
  l.entity_id as assessment_id,
  null::uuid as enrollment_id,
  l.actor_id,
  l.actor_name,
  l.action,
  l.before_data,
  l.after_data,
  null::uuid as restored_from_version_id,
  null::text as version_name,
  null::uuid as batch_id
from public.audit_logs l
where l.entity_type = 'assessments';

grant select on public.gradebook_version_history to authenticated;

create or replace function public.save_gradebook_score_batch(score_changes jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  batch_id uuid := gen_random_uuid();
  change jsonb;
  v_assessment_id uuid;
  v_enrollment_id uuid;
  v_score_value numeric;
  v_categorical_value text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(score_changes) <> 'array' then
    raise exception 'Score changes must be an array' using errcode = '22023';
  end if;
  if not (
    private.has_permission('assessment_results.manage.assigned')
    or private.has_permission('assessment_results.manage.department')
  ) then
    raise exception 'Not authorized to save assessment scores' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(score_changes) as changes(item)
    left join public.assessments a on a.id = nullif(item ->> 'assessment_id', '')::uuid
    left join public.enrollments e on e.id = nullif(item ->> 'enrollment_id', '')::uuid
    where a.id is null or e.id is null
      or a.class_record_id <> e.class_record_id
      or not private.can_access_class(a.class_record_id)
  ) then
    raise exception 'One or more score rows are outside the classes you can access' using errcode = '42501';
  end if;

  perform set_config('apms.score_change_batch_id', batch_id::text, true);
  for change in select value from jsonb_array_elements(score_changes)
  loop
    v_assessment_id := (change ->> 'assessment_id')::uuid;
    v_enrollment_id := (change ->> 'enrollment_id')::uuid;
    v_score_value := nullif(change ->> 'score', '')::numeric;
    v_categorical_value := nullif(change ->> 'categorical_value', '');

    if v_score_value is null and v_categorical_value is null then
      delete from public.assessment_results
      where assessment_results.assessment_id = v_assessment_id
        and assessment_results.enrollment_id = v_enrollment_id;
    else
      insert into public.assessment_results (
        assessment_id, enrollment_id, score, categorical_value,
        source, approval_status, recorded_by
      ) values (
        v_assessment_id, v_enrollment_id, v_score_value, v_categorical_value,
        'manual', 'approved', auth.uid()
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
  end loop;
  return batch_id;
end;
$$;

revoke all on function public.save_gradebook_score_batch(jsonb) from public, anon;
grant execute on function public.save_gradebook_score_batch(jsonb) to authenticated;

drop function if exists public.restore_assessment_score_version(uuid, boolean);

create or replace function public.restore_assessment_score_version(
  target_version_id uuid,
  restore_before boolean default false,
  restore_batch boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  anchor public.gradebook_score_versions%rowtype;
  target_version public.gradebook_score_versions%rowtype;
  target_data jsonb;
  target_score numeric;
  target_categorical_value text;
  restore_batch_id uuid := gen_random_uuid();
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

  perform set_config('apms.score_change_batch_id', restore_batch_id::text, true);
  for target_version in
    select v.*
    from public.gradebook_score_versions v
    where v.class_record_id = anchor.class_record_id
      and (
        (restore_batch and anchor.batch_id is not null and v.batch_id = anchor.batch_id)
        or (not restore_batch and v.id = anchor.id)
      )
    order by v.id
  loop
    target_data := case when restore_before then target_version.before_data else target_version.after_data end;
    target_score := nullif(target_data ->> 'score', '')::numeric;
    target_categorical_value := nullif(target_data ->> 'categorical_value', '');
    perform set_config('apms.restore_score_version_id', target_version.id::text, true);

    if target_score is null and target_categorical_value is null then
      delete from public.assessment_results
      where assessment_results.assessment_id = target_version.assessment_id
        and assessment_results.enrollment_id = target_version.enrollment_id;
    else
      insert into public.assessment_results (
        assessment_id, enrollment_id, score, categorical_value,
        source, approval_status, version, recorded_by
      ) values (
        target_version.assessment_id, target_version.enrollment_id,
        target_score, target_categorical_value,
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
  end loop;
end;
$$;

revoke all on function public.restore_assessment_score_version(uuid, boolean, boolean) from public, anon;
grant execute on function public.restore_assessment_score_version(uuid, boolean, boolean) to authenticated;

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

  perform set_config('apms.restore_score_version_id', anchor.id::text, true);
  perform set_config('apms.score_change_batch_id', gen_random_uuid()::text, true);

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
