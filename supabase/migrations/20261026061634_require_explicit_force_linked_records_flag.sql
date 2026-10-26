-- Keep the destructive implementation out of the exposed API schema. The
-- public wrapper requires an explicit force flag and is service-role only.
alter function public.admin_purge_profile_restrict_references_impl(uuid)
  set schema private;

grant usage on schema private to service_role;
revoke all on function private.admin_purge_profile_restrict_references_impl(uuid)
  from public, anon, authenticated;
grant execute on function private.admin_purge_profile_restrict_references_impl(uuid)
  to service_role;

drop function public.admin_purge_profile_restrict_references(uuid);

create function public.admin_purge_profile_restrict_references(
  p_user_id uuid,
  p_force_delete_linked_records boolean
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_force_delete_linked_records is not true then
    raise exception 'Explicit force-delete confirmation is required' using errcode = '42501';
  end if;
  if pg_catalog.current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'Service role is required for forced account cleanup' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('apms.force_delete_linked_records', 'on', true);
  return private.admin_purge_profile_restrict_references_impl(p_user_id);
end;
$$;

revoke all on function public.admin_purge_profile_restrict_references(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_purge_profile_restrict_references(uuid, boolean)
  to service_role;
