-- Keep names as editable version-history metadata without mutating immutable audit logs.
create table if not exists public.gradebook_assessment_version_names (
  audit_log_id uuid primary key references public.audit_logs(id) on delete cascade,
  version_name text check (version_name is null or char_length(version_name) <= 120),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.gradebook_assessment_version_names enable row level security;
revoke all on public.gradebook_assessment_version_names from anon, authenticated;
grant select, insert, update on public.gradebook_assessment_version_names to authenticated;

drop policy if exists gradebook_assessment_version_names_read on public.gradebook_assessment_version_names;
create policy gradebook_assessment_version_names_read
on public.gradebook_assessment_version_names
for select to authenticated
using (
  exists (
    select 1
    from public.audit_logs l
    where l.id = audit_log_id
      and l.entity_type = 'assessments'
      and private.can_access_class(coalesce(
        nullif(l.after_data ->> 'class_record_id', '')::uuid,
        nullif(l.before_data ->> 'class_record_id', '')::uuid
      ))
  )
);

drop policy if exists gradebook_assessment_version_names_manage on public.gradebook_assessment_version_names;
create policy gradebook_assessment_version_names_manage
on public.gradebook_assessment_version_names
for all to authenticated
using (
  exists (
    select 1
    from public.audit_logs l
    where l.id = audit_log_id
      and l.entity_type = 'assessments'
      and private.can_access_class(coalesce(
        nullif(l.after_data ->> 'class_record_id', '')::uuid,
        nullif(l.before_data ->> 'class_record_id', '')::uuid
      ))
      and (private.has_permission('assessment_results.manage.assigned') or private.has_permission('assessment_results.manage.department'))
  )
)
with check (
  exists (
    select 1
    from public.audit_logs l
    where l.id = audit_log_id
      and l.entity_type = 'assessments'
      and private.can_access_class(coalesce(
        nullif(l.after_data ->> 'class_record_id', '')::uuid,
        nullif(l.before_data ->> 'class_record_id', '')::uuid
      ))
      and (private.has_permission('assessment_results.manage.assigned') or private.has_permission('assessment_results.manage.department'))
  )
);

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
  n.version_name,
  null::uuid as batch_id
from public.audit_logs l
left join public.gradebook_assessment_version_names n on n.audit_log_id = l.id
where l.entity_type = 'assessments';

grant select on public.gradebook_version_history to authenticated;

-- Let the existing “restore all to this point” action use assessment history
-- timestamps as anchors as well as individual score-version IDs.
create or replace function public.restore_gradebook_to_version(target_version_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  anchor public.gradebook_score_versions%rowtype;
  anchor_class_id uuid;
  anchor_created_at timestamptz;
  restore_source_version_id uuid;
  affected integer := 0;
  changed integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into anchor
  from public.gradebook_score_versions
  where id = target_version_id;
  if found then
    anchor_class_id := anchor.class_record_id;
    anchor_created_at := anchor.created_at;
    restore_source_version_id := anchor.id;
  else
    select
      coalesce(nullif(l.after_data ->> 'class_record_id', '')::uuid, nullif(l.before_data ->> 'class_record_id', '')::uuid),
      l.created_at
    into anchor_class_id, anchor_created_at
    from public.audit_logs l
    where l.id = target_version_id and l.entity_type = 'assessments';
    if anchor_class_id is null then
      raise exception 'Version not found' using errcode = 'P0002';
    end if;
    select v.id into restore_source_version_id
    from public.gradebook_score_versions v
    where v.class_record_id = anchor_class_id and v.created_at <= anchor_created_at
    order by v.created_at desc, v.id desc
    limit 1;
  end if;

  if not private.can_access_class(anchor_class_id) then
    raise exception 'Version not found' using errcode = 'P0002';
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
  where v.class_record_id = anchor_class_id
    and v.created_at <= anchor_created_at
  order by v.assessment_id, v.enrollment_id, v.created_at desc, v.id desc;

  if restore_source_version_id is not null then
    perform set_config('apms.restore_score_version_id', restore_source_version_id::text, true);
  end if;
  perform set_config('apms.score_change_batch_id', gen_random_uuid()::text, true);

  delete from public.assessment_results r
  using public.assessments a
  where a.id = r.assessment_id
    and a.class_record_id = anchor_class_id
    and not exists (
      select 1 from pg_temp.gradebook_restore_snapshot s
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
