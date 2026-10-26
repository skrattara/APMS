-- Extend the safe APMS JSON restore allowlist as the academic model grows.
-- Ordering preserves the foreign-key dependencies of year-level sections and
-- department program requests.
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
    'roles','permissions','departments','academic_terms','programs','subjects','year_levels','program_sections',
    'profiles','faculty_profiles','students','class_records','class_record_templates','class_record_versions',
    'user_roles','role_permissions','invitations','faculty_assignments','enrollments','criteria_sets','criteria_nodes',
    'grading_systems','evaluation_systems','evaluation_criteria_systems','class_evaluation_criteria',
    'faculty_class_evaluation_systems','academic_admin_class_evaluation_systems','user_evaluation_systems',
    'academic_guidelines','assessments','assessment_results','attendance_sessions','attendance_records',
    'grader_assignments','grader_submissions','grader_reviews','model_versions','prediction_criteria',
    'performance_evaluations','prediction_runs','performance_predictions','feedback_templates','feedback_records',
    'notifications','notification_preferences','delivery_attempts','events','integrations','import_jobs','import_job_rows',
    'grade_encoding_deadlines','grade_encoding_deadline_requests','class_requests','subject_requests','program_requests',
    'audit_logs','access_logs','system_logs','ai_model_usage','gradebook_assessment_version_names','gradebook_score_versions',
    'synthetic_data_batches','system_settings'
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
