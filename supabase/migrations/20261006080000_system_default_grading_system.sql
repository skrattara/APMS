-- System Admins choose the global default from saved grading definitions.
-- Academic Admin edit permissions remain unchanged.
drop policy if exists grading_systems_system_admin_read on public.grading_systems;
create policy grading_systems_system_admin_read on public.grading_systems
  for select to authenticated
  using (private.has_role('system_admin'));

-- Faculty and Academic Admin clients may read only the configured default
-- definition so grading workflows can use it as a fallback.
drop policy if exists settings_default_grading_definition_read on public.system_settings;
create policy settings_default_grading_definition_read on public.system_settings
  for select to authenticated
  using (key = 'grading.default_system_definition');
