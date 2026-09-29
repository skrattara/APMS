-- Postgres Changes still applies the existing table RLS policies to each
-- subscriber. Only publish the source tables used by scoped APMS dashboards.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles',
    'students',
    'class_records',
    'enrollments',
    'assessment_results',
    'attendance_records',
    'attendance_sessions',
    'performance_evaluations',
    'performance_predictions',
    'user_roles',
    'audit_logs',
    'backups'
  ] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
