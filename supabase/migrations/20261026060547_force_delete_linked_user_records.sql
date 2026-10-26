create or replace function public.admin_purge_profile_restrict_references(p_user_id uuid)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  foreign_key record;
  join_condition text;
  blocking_conditions text;
  rows_affected bigint;
  total_deleted bigint := 0;
  progress bigint;
begin
  if p_user_id is null then
    raise exception 'A user ID is required';
  end if;

  create temp table apms_user_delete_targets (
    relation_id oid not null,
    row_tid tid not null,
    primary key (relation_id, row_tid)
  ) on commit drop;

  insert into pg_temp.apms_user_delete_targets (relation_id, row_tid)
  select 'public.profiles'::regclass::oid, profile.ctid
  from public.profiles as profile
  where profile.id = p_user_id;

  if not found then
    raise exception 'The user profile does not exist';
  end if;

  -- Find linked rows through CASCADE, RESTRICT, and NO ACTION foreign keys,
  -- following those dependencies so linked data is removed in the same flow.
  loop
    progress := 0;
    for foreign_key in
      select constraint_row.conrelid as child_relation,
             constraint_row.confrelid as parent_relation,
             constraint_row.conkey as child_columns,
             constraint_row.confkey as parent_columns
      from pg_catalog.pg_constraint as constraint_row
      join pg_catalog.pg_class as child_table on child_table.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace as child_schema on child_schema.oid = child_table.relnamespace
      join pg_catalog.pg_class as parent_table on parent_table.oid = constraint_row.confrelid
      join pg_catalog.pg_namespace as parent_schema on parent_schema.oid = parent_table.relnamespace
      where constraint_row.contype = 'f'
        and constraint_row.confdeltype in ('a', 'r', 'c')
        and child_schema.nspname = 'public'
        and parent_schema.nspname = 'public'
        and constraint_row.conrelid <> 'public.profiles'::regclass
    loop
      select pg_catalog.string_agg(
        pg_catalog.format('child.%I = parent.%I', child_column.attname, parent_column.attname),
        ' and ' order by child_key.ordinality
      )
      into join_condition
      from pg_catalog.unnest(foreign_key.child_columns) with ordinality as child_key(attnum, ordinality)
      join pg_catalog.unnest(foreign_key.parent_columns) with ordinality as parent_key(attnum, ordinality)
        on parent_key.ordinality = child_key.ordinality
      join pg_catalog.pg_attribute as child_column
        on child_column.attrelid = foreign_key.child_relation and child_column.attnum = child_key.attnum
      join pg_catalog.pg_attribute as parent_column
        on parent_column.attrelid = foreign_key.parent_relation and parent_column.attnum = parent_key.attnum;

      execute pg_catalog.format(
        'insert into pg_temp.apms_user_delete_targets (relation_id, row_tid) '
        'select %s::oid, child.ctid '
        'from %s as child '
        'join %s as parent on %s '
        'join pg_temp.apms_user_delete_targets as targets '
        'on targets.relation_id = %s::oid and targets.row_tid = parent.ctid '
        'on conflict do nothing',
        foreign_key.child_relation,
        foreign_key.child_relation::regclass,
        foreign_key.parent_relation::regclass,
        join_condition,
        foreign_key.parent_relation
      );
      get diagnostics rows_affected = row_count;
      progress := progress + rows_affected;
    end loop;
    exit when progress = 0;
  end loop;

  -- Remove leaves first so NO ACTION/RESTRICT dependencies are respected.
  loop
    progress := 0;
    for foreign_key in
      select distinct targets.relation_id as target_relation
      from pg_temp.apms_user_delete_targets as targets
      where targets.relation_id <> 'public.profiles'::regclass::oid
    loop
      execute pg_catalog.format(
        'delete from pg_temp.apms_user_delete_targets as target '
        'where target.relation_id = %s::oid '
        'and not exists (select 1 from %s as linked_row where linked_row.ctid = target.row_tid)',
        foreign_key.target_relation,
        foreign_key.target_relation::regclass
      );
      get diagnostics rows_affected = row_count;
      progress := progress + rows_affected;
    end loop;

    for foreign_key in
      select distinct targets.relation_id as parent_relation
      from pg_temp.apms_user_delete_targets as targets
      where targets.relation_id <> 'public.profiles'::regclass::oid
    loop
      select pg_catalog.string_agg(
        pg_catalog.format(
          'not exists (select 1 from %s as child '
          'join pg_temp.apms_user_delete_targets as child_target '
          'on child_target.relation_id = %s::oid and child_target.row_tid = child.ctid '
          'where %s)',
          child_constraint.conrelid::regclass,
          child_constraint.conrelid,
          child_join.condition
        ),
        ' and '
      )
      into blocking_conditions
      from pg_catalog.pg_constraint as child_constraint
      join pg_catalog.pg_class as child_table on child_table.oid = child_constraint.conrelid
      join pg_catalog.pg_namespace as child_schema on child_schema.oid = child_table.relnamespace
      join pg_catalog.pg_class as parent_table on parent_table.oid = child_constraint.confrelid
      join pg_catalog.pg_namespace as parent_schema on parent_schema.oid = parent_table.relnamespace
      cross join lateral (
        select pg_catalog.string_agg(
          pg_catalog.format('child.%I = parent.%I', child_column.attname, parent_column.attname),
          ' and ' order by child_key.ordinality
        ) as condition
        from pg_catalog.unnest(child_constraint.conkey) with ordinality as child_key(attnum, ordinality)
        join pg_catalog.unnest(child_constraint.confkey) with ordinality as parent_key(attnum, ordinality)
          on parent_key.ordinality = child_key.ordinality
        join pg_catalog.pg_attribute as child_column
          on child_column.attrelid = child_constraint.conrelid and child_column.attnum = child_key.attnum
        join pg_catalog.pg_attribute as parent_column
          on parent_column.attrelid = child_constraint.confrelid and parent_column.attnum = parent_key.attnum
      ) as child_join
      where child_constraint.contype = 'f'
        and child_constraint.confdeltype in ('a', 'r', 'c')
        and child_constraint.confrelid = foreign_key.parent_relation
        and child_schema.nspname = 'public'
        and parent_schema.nspname = 'public'
        and child_join.condition is not null;

      execute pg_catalog.format(
        'with deleted_rows as ('
        ' delete from %s as parent using pg_temp.apms_user_delete_targets as target '
        ' where target.relation_id = %s::oid and target.row_tid = parent.ctid and (%s) '
        ' returning parent.ctid'
        ') '
        'delete from pg_temp.apms_user_delete_targets as target using deleted_rows '
        'where target.relation_id = %s::oid and target.row_tid = deleted_rows.ctid',
        foreign_key.parent_relation::regclass,
        foreign_key.parent_relation,
        coalesce(blocking_conditions, 'true'),
        foreign_key.parent_relation
      );
      get diagnostics rows_affected = row_count;
      progress := progress + rows_affected;
    end loop;

    total_deleted := total_deleted + progress;
    exit when progress = 0;
  end loop;

  if exists (
    select 1 from pg_temp.apms_user_delete_targets as target
    where target.relation_id <> 'public.profiles'::regclass::oid
  ) then
    raise exception 'Some linked records could not be safely deleted because of a cyclic or external dependency';
  end if;

  return total_deleted;
end;
$$;

revoke all on function public.admin_purge_profile_restrict_references(uuid) from public, anon, authenticated;
grant execute on function public.admin_purge_profile_restrict_references(uuid) to service_role;
