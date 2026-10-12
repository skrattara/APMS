-- AI data-sharing controls default to off. Only System Admins can change them
-- through the existing system_settings permission and audit workflow.
insert into public.system_settings(key, value)
values
  ('ai.assessment_data.enabled', 'false'::jsonb),
  ('ai.attendance_data.enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- Provider-facing Edge Functions must check both feature permission and class
-- scope before they can send any data outside APMS.
create or replace function public.faculty_assert_ai_access(
  p_class_record_id uuid,
  p_feature text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then raise exception 'Authentication required'; end if;
  if p_feature = 'predictions' then
    if not private.has_permission('predictions.run.assigned') then raise exception 'Permission denied'; end if;
  elsif p_feature = 'feedback_draft' then
    if not private.has_permission('feedback.send.assigned') then raise exception 'Permission denied'; end if;
  else
    raise exception 'Unsupported AI feature';
  end if;
  if not private.can_access_class(p_class_record_id) then raise exception 'Class access denied'; end if;
  return true;
end
$$;

revoke all on function public.faculty_assert_ai_access(uuid, text) from public, anon;
grant execute on function public.faculty_assert_ai_access(uuid, text) to authenticated;
