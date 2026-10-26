-- Extend the safe APMS JSON restore allowlist as the academic model grows.
-- Ordering preserves the foreign-key dependencies of year-level sections and
-- department program requests. Auth accounts are recreated by the trusted Edge
-- Function before restore, so profile and role records can retain their IDs.
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
  v_row jsonb;
  v_profile_column record;
  v_profile_id uuid;
  v_skip_row boolean;
  v_sanitized_rows jsonb;
  v_order text[] := array[
    'roles','permissions','departments','academic_terms','programs','subjects','year_levels','profiles',
    'role_permissions','user_roles','faculty_profiles','program_sections','students','class_records','class_record_templates','class_record_versions',
    'invitations','faculty_assignments','enrollments','criteria_sets','criteria_nodes',
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
    -- Invitation tokens are short-lived and should never be revived from backup.
    if v_table = 'invitations' then
      continue;
    end if;

    -- Map missing profile attribution to the authenticated restore operator;
    -- nullable references become NULL, and rows owned by deleted accounts are
    -- skipped instead of being assigned to the operator.
    v_sanitized_rows := '[]'::jsonb;
    for v_row in select value from jsonb_array_elements(v_rows) loop
      v_skip_row := false;
      for v_profile_column in
        select source_attribute.attname as column_name, source_attribute.attnotnull as is_required
        from pg_catalog.pg_constraint fk
        cross join lateral unnest(fk.conkey) with ordinality as source_key(attnum, ordinality)
        join lateral unnest(fk.confkey) with ordinality as target_key(attnum, ordinality)
          on target_key.ordinality = source_key.ordinality
        join pg_catalog.pg_attribute source_attribute
          on source_attribute.attrelid = fk.conrelid and source_attribute.attnum = source_key.attnum
        join pg_catalog.pg_attribute target_attribute
          on target_attribute.attrelid = fk.confrelid and target_attribute.attnum = target_key.attnum
        where fk.contype = 'f'
          and fk.conrelid = format('public.%I', v_table)::regclass
          and fk.confrelid = 'public.profiles'::regclass
          and target_attribute.attname = 'id'
          and pg_catalog.cardinality(fk.conkey) = 1
          and pg_catalog.cardinality(fk.confkey) = 1
      loop
        if v_row->v_profile_column.column_name is null or v_row->v_profile_column.column_name = 'null' then
          continue;
        end if;
        v_profile_id := (v_row->>v_profile_column.column_name)::uuid;
        if exists (select 1 from public.profiles p where p.id = v_profile_id) then
          continue;
        end if;
        if v_profile_column.column_name = any(array[
          'created_by', 'updated_by', 'actor_id', 'granted_by', 'invited_by',
          'requested_by', 'reviewed_by', 'assigned_by', 'recorded_by',
          'calculated_by', 'initiated_by', 'author_id'
        ]) then
          if v_profile_column.is_required then
            v_row := pg_catalog.jsonb_set(v_row, array[v_profile_column.column_name], pg_catalog.to_jsonb(auth.uid()), true);
          else
            v_row := pg_catalog.jsonb_set(v_row, array[v_profile_column.column_name], 'null'::jsonb, true);
          end if;
        elsif v_profile_column.is_required then
          v_skip_row := true;
          exit;
        else
          v_row := pg_catalog.jsonb_set(v_row, array[v_profile_column.column_name], 'null'::jsonb, true);
        end if;
      end loop;
      if not v_skip_row then
        v_sanitized_rows := v_sanitized_rows || pg_catalog.jsonb_build_array(v_row);
      end if;
    end loop;
    v_rows := v_sanitized_rows;
    if pg_catalog.jsonb_array_length(v_rows) = 0 then continue; end if;
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
