-- Clear APMS application data while retaining roles, permissions, settings,
-- and backup history. Departments and academic terms are reset as well.
create or replace function public.reset_apms_application_data(p_actor_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_table text;
  v_deleted bigint;
  v_progress boolean;
  v_remaining bigint;
  v_keep text[] := array[
    'backup_restores', 'backup_schedules', 'backups',
    'permissions', 'role_permissions', 'roles', 'system_settings',
    'user_roles', 'profiles', 'audit_logs'
  ];
begin
  -- Execute privileges are restricted to service_role below. The Edge Function
  -- separately authenticates and verifies the active System Admin caller.
  if p_actor_id is null or not exists (
    select 1
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    join public.roles r on r.id = ur.role_id and r.key = 'system_admin'
    where p.id = p_actor_id and p.status = 'active'
  ) then
    raise exception 'The active System Admin account could not be verified' using errcode = '42501';
  end if;

  -- Preserve backup history and schedule ownership after removing other users.
  update public.backups set created_by = p_actor_id where created_by <> p_actor_id;
  update public.backup_restores set initiated_by = p_actor_id where initiated_by <> p_actor_id;
  update public.backup_schedules set created_by = p_actor_id where created_by <> p_actor_id;
  update public.system_settings set updated_by = p_actor_id where updated_by is distinct from p_actor_id;

  -- Keep only the current admin's System Admin assignment.
  delete from public.user_roles ur
  where ur.user_id <> p_actor_id
     or not exists (
       select 1 from public.roles r
       where r.id = ur.role_id and r.key = 'system_admin'
     );

  -- Delete every other public application table, including tables added by
  -- later migrations. Repeated passes respect foreign keys without disabling
  -- constraints; an unresolvable dependency aborts the transaction safely.
  perform pg_catalog.set_config('apms.force_delete_linked_records', 'on', true);
  loop
    v_progress := false;
    for v_table in
      select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
        and not (c.relname = any(v_keep))
      order by c.relname
    loop
      begin
        execute pg_catalog.format('delete from public.%I where true', v_table);
        get diagnostics v_deleted = row_count;
        if v_deleted > 0 then
          v_progress := true;
        end if;
      exception when foreign_key_violation then
        -- A referenced parent will be retried after its dependent table clears.
        null;
      end;
    end loop;

    if not v_progress then
      v_remaining := 0;
      for v_table in
        select c.relname
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and not exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid)
          and not (c.relname = any(v_keep))
      loop
        execute pg_catalog.format('select count(*) from public.%I', v_table) into v_deleted;
        v_remaining := v_remaining + v_deleted;
      end loop;
      if v_remaining = 0 then exit; end if;
      raise exception 'Application data could not be cleared because a public table has a restrictive foreign-key dependency' using errcode = '23503';
    end if;
  end loop;

  delete from public.profiles where id <> p_actor_id;

  -- Remove trigger-generated operational logs too, then leave one reset event.
  delete from public.audit_logs where true;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, after_data)
  values (
    p_actor_id,
    'application_data.reset',
    'application_data',
    p_actor_id,
    pg_catalog.jsonb_build_object(
      'preserved_user_id', p_actor_id,
      'preserved_tables', array[
        'backup_restores', 'backup_schedules', 'backups',
        'permissions', 'role_permissions', 'roles', 'system_settings'
      ]
    )
  );
  return pg_catalog.jsonb_build_object('reset', true);
end;
$$;

revoke all on function public.reset_apms_application_data(uuid) from public, anon, authenticated;
grant execute on function public.reset_apms_application_data(uuid) to service_role;

