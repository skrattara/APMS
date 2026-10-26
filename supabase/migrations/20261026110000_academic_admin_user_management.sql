insert into public.system_settings (key, value)
values ('academic_admins.can_invite_academic_admins', 'false'::jsonb)
on conflict (key) do nothing;

insert into public.system_settings (key, value)
values ('academic_admins.can_invite_faculty', 'true'::jsonb)
on conflict (key) do nothing;
