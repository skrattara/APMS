-- Keep the browser origin that initiated OAuth so one Supabase project can
-- serve local development and production without a fixed app-origin secret.
alter table public.google_classroom_oauth_states
  add column if not exists app_origin text;
