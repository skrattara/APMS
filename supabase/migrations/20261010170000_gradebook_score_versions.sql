-- Score history is a user-facing, class-scoped version stream. Keep it
-- separate from the internal, immutable audit log.
-- Upgrade older databases before the history backfill uses audit_logs.id.
do $$
declare
  audit_id_type text;
  source_id_type text;
  primary_key_name text;
begin
  select data_type into audit_id_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'audit_logs' and column_name = 'id';

  if audit_id_type = 'bigint' then
    alter table public.audit_logs add column if not exists id_uuid uuid;
    update public.audit_logs set id_uuid = gen_random_uuid() where id_uuid is null;
    alter table public.audit_logs alter column id_uuid set not null;

    if to_regclass('public.gradebook_score_versions') is not null then
      select data_type into source_id_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'gradebook_score_versions'
        and column_name = 'source_audit_log_id';

      if source_id_type = 'bigint' then
        alter table public.gradebook_score_versions add column if not exists source_audit_log_uuid uuid;
        update public.gradebook_score_versions v
        set source_audit_log_uuid = a.id_uuid
        from public.audit_logs a
        where v.source_audit_log_id = a.id;
        drop index if exists public.gradebook_score_versions_audit_log_idx;
        alter table public.gradebook_score_versions drop column source_audit_log_id;
        alter table public.gradebook_score_versions rename column source_audit_log_uuid to source_audit_log_id;
        create unique index if not exists gradebook_score_versions_audit_log_idx
          on public.gradebook_score_versions (source_audit_log_id)
          where source_audit_log_id is not null;
      end if;
    end if;

    select conname into primary_key_name
    from pg_constraint
    where conrelid = 'public.audit_logs'::regclass and contype = 'p';
    if primary_key_name is not null then
      execute format('alter table public.audit_logs drop constraint %I', primary_key_name);
    end if;
    alter table public.audit_logs drop column id;
    alter table public.audit_logs rename column id_uuid to id;
    alter table public.audit_logs alter column id set default gen_random_uuid();
    alter table public.audit_logs add primary key (id);
  end if;
end;
$$;

create table if not exists public.gradebook_score_versions (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  source_audit_log_id uuid,
  action text not null check (action in ('created', 'updated', 'deleted', 'restored')),
  before_data jsonb,
  after_data jsonb,
  actor_id uuid references public.profiles(id) on delete set null,
  restored_from_version_id uuid references public.gradebook_score_versions(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Supports rerunning this script if an SQL editor committed the earlier DDL
-- before stopping at a later statement error.
alter table public.gradebook_score_versions
  add column if not exists source_audit_log_id uuid;
create unique index if not exists gradebook_score_versions_audit_log_idx
  on public.gradebook_score_versions (source_audit_log_id)
  where source_audit_log_id is not null;

create index if not exists gradebook_score_versions_lookup_idx
  on public.gradebook_score_versions (class_record_id, assessment_id, enrollment_id, created_at desc);
create index if not exists gradebook_score_versions_class_history_idx
  on public.gradebook_score_versions (class_record_id, created_at desc, id desc);

alter table public.gradebook_score_versions enable row level security;
revoke all on public.gradebook_score_versions from anon, authenticated;
grant select on public.gradebook_score_versions to authenticated;

drop policy if exists gradebook_score_versions_class_read on public.gradebook_score_versions;
create policy gradebook_score_versions_class_read
on public.gradebook_score_versions
for select
to authenticated
using (
  private.can_access_class(class_record_id)
  and exists (
    select 1 from public.assessments a
    where a.id = gradebook_score_versions.assessment_id
      and a.class_record_id = gradebook_score_versions.class_record_id
  )
  and exists (
    select 1 from public.enrollments e
    where e.id = gradebook_score_versions.enrollment_id
      and e.class_record_id = gradebook_score_versions.class_record_id
  )
);

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
  v_action := case
    when v_restore_version_id is not null then 'restored'
    when tg_op = 'INSERT' then 'created'
    when tg_op = 'UPDATE' then 'updated'
    else 'deleted'
  end;
  insert into public.gradebook_score_versions (
    class_record_id, assessment_id, enrollment_id, action,
    before_data, after_data, actor_id, restored_from_version_id
  ) values (
    v_class_record_id, v_assessment_id, v_enrollment_id, v_action,
    v_before, v_after, v_actor_id, v_restore_version_id
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.record_gradebook_score_version() from public;
drop trigger if exists record_gradebook_score_version on public.assessment_results;
create trigger record_gradebook_score_version
after insert or update or delete on public.assessment_results
for each row execute function private.record_gradebook_score_version();

-- Preserve the score history already captured by audit logs, but copy only the
-- score fields needed by the gradebook. Audit logs remain the internal source.
insert into public.gradebook_score_versions (
  id, class_record_id, assessment_id, enrollment_id, source_audit_log_id, action,
  before_data, after_data, actor_id, created_at
)
select
  gen_random_uuid(),
  a.class_record_id,
  coalesce(l.after_data ->> 'assessment_id', l.before_data ->> 'assessment_id')::uuid,
  coalesce(l.after_data ->> 'enrollment_id', l.before_data ->> 'enrollment_id')::uuid,
  l.id,
  case
    when l.action = 'assessment_results.insert' then 'created'
    when l.action = 'assessment_results.delete' then 'deleted'
    else 'updated'
  end,
  case when l.before_data is null then null else jsonb_build_object(
    'assessment_id', l.before_data -> 'assessment_id',
    'enrollment_id', l.before_data -> 'enrollment_id',
    'score', l.before_data -> 'score',
    'categorical_value', l.before_data -> 'categorical_value'
  ) end,
  case when l.after_data is null then null else jsonb_build_object(
    'assessment_id', l.after_data -> 'assessment_id',
    'enrollment_id', l.after_data -> 'enrollment_id',
    'score', l.after_data -> 'score',
    'categorical_value', l.after_data -> 'categorical_value'
  ) end,
  l.actor_id,
  l.created_at
from public.audit_logs l
join public.assessments a on a.id::text = coalesce(l.after_data ->> 'assessment_id', l.before_data ->> 'assessment_id')
join public.enrollments e on e.id::text = coalesce(l.after_data ->> 'enrollment_id', l.before_data ->> 'enrollment_id')
where l.entity_type = 'assessment_results'
  and a.class_record_id = e.class_record_id
on conflict do nothing;

-- Seed a current-state baseline for results that predate audit capture.
insert into public.gradebook_score_versions (
  class_record_id, assessment_id, enrollment_id, action,
  before_data, after_data, actor_id, created_at
)
select
  a.class_record_id,
  r.assessment_id,
  r.enrollment_id,
  'created',
  null,
  jsonb_build_object('assessment_id', r.assessment_id, 'enrollment_id', r.enrollment_id, 'score', r.score, 'categorical_value', r.categorical_value),
  r.recorded_by,
  r.created_at
from public.assessment_results r
join public.assessments a on a.id = r.assessment_id
join public.enrollments e on e.id = r.enrollment_id and e.class_record_id = a.class_record_id
where not exists (
  select 1 from public.gradebook_score_versions v
  where v.assessment_id = r.assessment_id and v.enrollment_id = r.enrollment_id
);

create or replace function public.restore_assessment_score_version(target_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  target_version public.gradebook_score_versions%rowtype;
  prior_score numeric;
  prior_categorical_value text;
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

  prior_score := nullif(target_version.after_data ->> 'score', '')::numeric;
  prior_categorical_value := target_version.after_data ->> 'categorical_value';
  perform set_config('apms.restore_score_version_id', target_version.id::text, true);

  if prior_score is null and prior_categorical_value is null then
    delete from public.assessment_results
    where assessment_id = target_version.assessment_id
      and enrollment_id = target_version.enrollment_id;
  else
    insert into public.assessment_results (
      assessment_id, enrollment_id, score, categorical_value,
      source, approval_status, version, recorded_by
    ) values (
      target_version.assessment_id, target_version.enrollment_id,
      prior_score, prior_categorical_value,
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

-- Version history is the class-scoped user-facing feature. Keep score audit
-- records available through the internal technical-log permission only.
drop policy if exists assessment_result_audit_history_scoped_read on public.audit_logs;
drop policy if exists audit_logs_technical on public.audit_logs;
create policy audit_logs_technical
on public.audit_logs
for select
to authenticated
using (private.has_permission('logs.read'));
