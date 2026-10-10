-- Keep this forward migration for databases where the score-version migration
-- had already been applied before audit_logs.id was standardized as a UUID.
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
