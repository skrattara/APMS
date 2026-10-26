insert into public.system_settings (key, value)
values
  ('security.mfa_required', 'false'::jsonb),
  ('security.mfa_required_roles', '[]'::jsonb),
  ('security.mfa_required_departments', '[]'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
