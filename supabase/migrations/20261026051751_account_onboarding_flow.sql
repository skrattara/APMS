-- Existing accounts are already onboarded; invited accounts explicitly set this to null.
alter table public.profiles
  add column if not exists takeover_email text,
  add column if not exists onboarding_completed_at timestamptz;

update public.profiles
set onboarding_completed_at = case when status = 'invited' then null else now() end
where onboarding_completed_at is null;

alter table public.profiles
  alter column onboarding_completed_at set default now();

-- Users may configure their own future department takeover contact. Completion is
-- written only by the protected onboarding Edge Function after MFA is verified.
revoke update (onboarding_completed_at) on public.profiles from authenticated;
grant update (takeover_email) on public.profiles to authenticated;
