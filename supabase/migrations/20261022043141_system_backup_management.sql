alter table public.backups
  add column if not exists storage_path text,
  add column if not exists file_name text,
  add column if not exists encryption text,
  add column if not exists safe_error text;

create table if not exists public.backup_schedules (
  id uuid primary key default gen_random_uuid(),
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  enabled boolean not null default true,
  password_protected boolean not null default true,
  retention_days integer not null default 30 check (retention_days between 1 and 3650),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_backup_id uuid references public.backups(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);
create unique index if not exists backup_schedules_singleton on public.backup_schedules ((true));
alter table public.backups add column if not exists schedule_id uuid references public.backup_schedules(id) on delete set null;
alter table public.backup_restores alter column backup_id drop not null;

alter table public.backup_schedules enable row level security;
create policy backup_schedules_system_admin on public.backup_schedules
  for all to authenticated
  using (private.has_permission('backups.manage'))
  with check (private.has_permission('backups.manage'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('apms-backups', 'apms-backups', false, null, array['application/json', 'application/octet-stream'])
on conflict (id) do update set public = false, allowed_mime_types = excluded.allowed_mime_types;

create policy apms_backups_system_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'apms-backups' and private.has_permission('backups.manage'));
create policy apms_backups_system_admin_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'apms-backups' and private.has_permission('backups.manage'));
create policy apms_backups_system_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'apms-backups' and private.has_permission('backups.manage'))
  with check (bucket_id = 'apms-backups' and private.has_permission('backups.manage'));
create policy apms_backups_system_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'apms-backups' and private.has_permission('backups.manage'));

-- The allowlist intentionally excludes authentication internals and provider
-- credentials. Restores merge backed-up rows by their primary keys so an
-- imported file cannot erase records created after the backup.
create or replace function public.restore_apms_json_backup(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_columns text;
  v_rows jsonb;
  v_primary_key text;
  v_updates text;
  v_conflict text;
  v_count integer;
  v_total integer := 0;
  v_order text[] := array[
    'roles','permissions','departments','academic_terms','programs','subjects','year_levels',
    'profiles','faculty_profiles','students','class_records','class_record_templates','class_record_versions',
    'user_roles','role_permissions','invitations','faculty_assignments','enrollments','criteria_sets','criteria_nodes',
    'grading_systems','evaluation_systems','evaluation_criteria_systems','class_evaluation_criteria',
    'faculty_class_evaluation_systems','academic_admin_class_evaluation_systems','user_evaluation_systems',
    'academic_guidelines','assessments','assessment_results','attendance_sessions','attendance_records',
    'grader_assignments','grader_submissions','grader_reviews','model_versions','prediction_criteria',
    'performance_evaluations','prediction_runs','performance_predictions','feedback_templates','feedback_records',
    'notifications','notification_preferences','delivery_attempts','events','integrations','import_jobs','import_job_rows',
    'grade_encoding_deadlines','grade_encoding_deadline_requests','class_requests','subject_requests',
    'audit_logs','access_logs','system_logs','ai_model_usage','gradebook_assessment_version_names','gradebook_score_versions',
    'synthetic_data_batches','backups','backup_restores','system_settings'
  ];
begin
  if auth.uid() is null or not private.has_permission('backups.manage') then
    raise exception 'System Admin backup permission required' using errcode = '42501';
  end if;
  if p_data->>'format' is distinct from 'apms-json-backup' or jsonb_typeof(p_data->'tables') is distinct from 'object' then
    raise exception 'Unsupported or invalid APMS JSON backup';
  end if;

  foreach v_table in array v_order loop
    v_rows := p_data->'tables'->v_table;
    if v_rows is null then continue; end if;
    if jsonb_typeof(v_rows) <> 'array' then
      raise exception 'Invalid row collection for table %', v_table;
    end if;
    select string_agg(format('%I', a.attname), ', ' order by a.attnum)
      into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = '';
    if v_columns is null then continue; end if;
    select string_agg(format('%I', a.attname), ', ' order by key_col.ordinality)
      into v_primary_key
    from pg_catalog.pg_index i
    cross join lateral unnest(i.indkey) with ordinality as key_col(attnum, ordinality)
    join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = key_col.attnum
    where i.indrelid = format('public.%I', v_table)::regclass and i.indisprimary;
    select string_agg(format('%1$I = EXCLUDED.%1$I', a.attname), ', ' order by a.attnum)
      into v_updates
    from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
      and not exists (
        select 1 from pg_catalog.pg_index i
        cross join lateral unnest(i.indkey) as key_col(attnum)
        where i.indrelid = a.attrelid and i.indisprimary and key_col.attnum = a.attnum
      );
    v_conflict := case
      when v_primary_key is null then ' on conflict do nothing'
      when v_updates is null then format(' on conflict (%s) do nothing', v_primary_key)
      else format(' on conflict (%s) do update set %s', v_primary_key, v_updates)
    end;
    execute format(
      'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s',
      v_table, v_columns, v_conflict
    ) using v_rows;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;
  return jsonb_build_object('restored_rows', v_total);
end
$$;

revoke all on function public.restore_apms_json_backup(jsonb) from public, anon;
grant execute on function public.restore_apms_json_backup(jsonb) to authenticated;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
select cron.schedule(
  'apms-scheduled-backup-dispatch',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := cfg.project_url || '/functions/v1/apms-backups',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', cfg.publishable_key,
        'Authorization', 'Bearer ' || cfg.service_role_key
      ),
      body := '{"action":"scheduled"}'::jsonb
    )
    from (
      select
        max(decrypted_secret) filter (where name = 'apms_project_url') as project_url,
        max(decrypted_secret) filter (where name = 'apms_publishable_key') as publishable_key,
        max(decrypted_secret) filter (where name = 'apms_service_role_key') as service_role_key
      from vault.decrypted_secrets
      where name in ('apms_project_url', 'apms_publishable_key', 'apms_service_role_key')
    ) cfg
    where cfg.project_url is not null and cfg.publishable_key is not null and cfg.service_role_key is not null;
  $$
);
