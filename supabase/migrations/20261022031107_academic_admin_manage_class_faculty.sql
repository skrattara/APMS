create or replace function public.academic_admin_update_class_faculty(
  p_class_record_id uuid,
  p_faculty_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_department_id uuid;
  requested_count integer;
  valid_count integer;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select cr.department_id into target_department_id
  from public.class_records cr
  where cr.id = p_class_record_id and cr.status = 'active'
  for update;

  if target_department_id is null or not private.is_academic_admin_for_department(target_department_id) then
    raise exception 'Only an authorized Academic Admin can manage Faculty for this class' using errcode = '42501';
  end if;

  select count(distinct requested.id) into requested_count
  from unnest(coalesce(p_faculty_user_ids, array[]::uuid[])) as requested(id);
  if requested_count < 1 then
    raise exception 'Assign at least one active Faculty member' using errcode = '22023';
  end if;

  select count(distinct fp.profile_id) into valid_count
  from public.faculty_profiles fp
  where fp.profile_id = any(p_faculty_user_ids)
    and fp.department_id = target_department_id
    and fp.status = 'active';
  if valid_count <> requested_count then
    raise exception 'Every assigned Faculty member must have an active profile in this department' using errcode = '22023';
  end if;

  update public.faculty_assignments fa
  set status = 'inactive'
  from public.faculty_profiles fp
  where fa.class_record_id = p_class_record_id
    and fa.assignment_role = 'instructor'
    and fa.status = 'active'
    and fp.id = fa.faculty_id
    and not (fp.profile_id = any(p_faculty_user_ids));

  insert into public.faculty_assignments (faculty_id, class_record_id, assignment_role, status)
  select fp.id, p_class_record_id, 'instructor', 'active'
  from public.faculty_profiles fp
  where fp.profile_id = any(p_faculty_user_ids)
    and fp.department_id = target_department_id
    and fp.status = 'active'
  on conflict (faculty_id, class_record_id, assignment_role)
  do update set status = 'active';

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after_data)
  values (caller_id, 'class_record.faculty_updated', 'class_records', p_class_record_id,
    jsonb_build_object('department_id', target_department_id, 'faculty_user_ids', p_faculty_user_ids));
end;
$$;

revoke all on function public.academic_admin_update_class_faculty(uuid, uuid[]) from public, anon;
grant execute on function public.academic_admin_update_class_faculty(uuid, uuid[]) to authenticated;

-- Academic Admins may run advisory forecasts only for classes they can access
-- through their department scope; the existing class-access check remains in
-- both the prediction endpoint and its save function.
insert into public.role_permissions (role_id, permission_id)
select academic_admin.id, predictions_run.id
from public.roles academic_admin
cross join public.permissions predictions_run
where academic_admin.key = 'academic_admin'
  and predictions_run.key = 'predictions.run.assigned'
on conflict (role_id, permission_id) do nothing;
