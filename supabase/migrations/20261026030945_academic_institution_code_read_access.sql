-- Academic Admins need the institution code to render context-appropriate
-- section names. Expose only this non-secret setting to authenticated users.
drop policy if exists system_settings_institution_code_read on public.system_settings;
create policy system_settings_institution_code_read
  on public.system_settings for select to authenticated
  using (key = 'academic.institution_code');
