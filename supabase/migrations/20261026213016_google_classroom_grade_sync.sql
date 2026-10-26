-- Google Classroom credentials are only accessible to the Edge Function's
-- service-role client. Application users can only see mappings for classes
-- they are assigned to.
create table public.google_classroom_connections (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  google_email text not null,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  granted_scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.google_classroom_oauth_states (
  state text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  app_origin text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index google_classroom_oauth_states_expiry_idx on public.google_classroom_oauth_states (expires_at);

create table public.google_classroom_class_links (
  class_record_id uuid primary key references public.class_records(id) on delete cascade,
  google_course_id text not null unique,
  google_course_name text not null,
  google_account_email text not null,
  -- Removing the owning APMS account removes its external link and all child
  -- mappings. Classroom itself is never modified by this cascade.
  linked_by uuid references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'error', 'paused')),
  last_synced_at timestamptz,
  last_error text,
  push_registration_id text,
  push_registered_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index google_classroom_class_links_due_sync_idx on public.google_classroom_class_links (status, last_synced_at);

create table public.google_classroom_assessment_links (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.google_classroom_class_links(class_record_id) on delete cascade,
  assessment_id uuid not null unique references public.assessments(id) on delete cascade,
  google_course_id text not null,
  google_coursework_id text not null,
  google_coursework_title text not null,
  sync_page_token text,
  source_max_score numeric(10,2) not null check (source_max_score > 0),
  source_min_score numeric(10,2) not null default 0,
  target_min_score numeric(10,2) not null default 0,
  target_max_score numeric(10,2) not null,
  enabled boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (google_course_id, google_coursework_id),
  check (source_max_score > source_min_score),
  check (target_max_score > target_min_score)
);
create index google_classroom_assessment_links_class_idx on public.google_classroom_assessment_links (class_record_id, enabled);

create table public.google_classroom_student_links (
  class_record_id uuid not null references public.google_classroom_class_links(class_record_id) on delete cascade,
  google_user_id text not null,
  google_email text,
  enrollment_id uuid references public.enrollments(id) on delete cascade,
  matched_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (class_record_id, google_user_id),
  unique (class_record_id, enrollment_id)
);
create index google_classroom_student_links_enrollment_idx on public.google_classroom_student_links (enrollment_id);

alter table public.assessment_results drop constraint if exists assessment_results_source_check;
alter table public.assessment_results add constraint assessment_results_source_check
  check (source in ('manual', 'import', 'lms', 'grader', 'google_classroom'));

alter table public.google_classroom_connections enable row level security;
alter table public.google_classroom_oauth_states enable row level security;
alter table public.google_classroom_class_links enable row level security;
alter table public.google_classroom_assessment_links enable row level security;
alter table public.google_classroom_student_links enable row level security;

-- OAuth state and refresh-token ciphertext are not available through the Data API.
revoke all on public.google_classroom_connections, public.google_classroom_oauth_states from public, anon, authenticated;
grant all on public.google_classroom_connections, public.google_classroom_oauth_states to service_role;
revoke all on public.google_classroom_class_links, public.google_classroom_assessment_links, public.google_classroom_student_links from public, anon, authenticated;

create or replace function private.can_manage_google_classroom_class(target_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.faculty_assignments fa
    join public.faculty_profiles fp on fp.id = fa.faculty_id
    where fa.class_record_id = target_class_id
      and fa.status = 'active'
      and fp.status = 'active'
      and fp.profile_id = (select auth.uid())
  );
$$;
revoke all on function private.can_manage_google_classroom_class(uuid) from public, anon;
grant execute on function private.can_manage_google_classroom_class(uuid) to authenticated, service_role;

create policy google_classroom_class_links_assigned_faculty
  on public.google_classroom_class_links for select to authenticated
  using (private.can_manage_google_classroom_class(class_record_id));
create policy google_classroom_assessment_links_assigned_faculty
  on public.google_classroom_assessment_links for select to authenticated
  using (private.can_manage_google_classroom_class(class_record_id));
create policy google_classroom_student_links_assigned_faculty
  on public.google_classroom_student_links for select to authenticated
  using (private.can_manage_google_classroom_class(class_record_id));

grant select on public.google_classroom_class_links,
  public.google_classroom_assessment_links,
  public.google_classroom_student_links to authenticated;
grant all on public.google_classroom_class_links,
  public.google_classroom_assessment_links,
  public.google_classroom_student_links to service_role;

create trigger set_updated_at_google_classroom_connections
  before update on public.google_classroom_connections
  for each row execute function private.set_updated_at();
create trigger set_updated_at_google_classroom_class_links
  before update on public.google_classroom_class_links
  for each row execute function private.set_updated_at();
create trigger set_updated_at_google_classroom_assessment_links
  before update on public.google_classroom_assessment_links
  for each row execute function private.set_updated_at();

-- Push notifications do the normal fast path. This low-frequency runner also
-- renews Google's one-week registrations and reconciles missed webhooks.
select cron.schedule(
  'apms-google-classroom-grade-sync',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := cfg.project_url || '/functions/v1/google-classroom',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', cfg.publishable_key,
        'Authorization', 'Bearer ' || cfg.service_role_key
      ),
      body := '{"action":"scheduled"}'::jsonb
    )
    from (
      select
        max(decrypted_secret) filter (where name = 'apms_project_url') as project_url,
        max(decrypted_secret) filter (where name = 'apms_publishable_key') as publishable_key,
        max(decrypted_secret) filter (where name = 'apms_service_role_key') as service_role_key
      from vault.decrypted_secrets
      where name in ('apms_project_url', 'apms_publishable_key', 'apms_service_role_key')
    ) cfg
    where cfg.project_url is not null and cfg.publishable_key is not null and cfg.service_role_key is not null;
  $$
);
