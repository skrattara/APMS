grant delete on public.user_evaluation_systems to authenticated;

create policy user_evaluation_systems_delete on public.user_evaluation_systems
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = (select auth.uid())
        and ur.scope_type = 'department'
        and ur.scope_id = department_id
        and r.key = 'academic_admin'
        and ur.valid_from <= now()
        and (ur.valid_until is null or ur.valid_until > now())
    )
  );
