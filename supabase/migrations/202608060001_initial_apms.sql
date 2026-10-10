create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public;

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(code) between 2 and 20),
  name text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.programs (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete restrict,
  code text not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, code)
);

create table public.academic_terms (
  id uuid primary key default gen_random_uuid(),
  academic_year text not null,
  semester text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'planned' check (status in ('planned', 'active', 'closed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_on <= ends_on),
  unique (academic_year, semester)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  first_name text not null,
  last_name text not null,
  phone text,
  avatar_path text,
  status text not null default 'invited' check (status in ('invited', 'active', 'inactive', 'suspended')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null,
  system_role boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  scope_type text not null default 'global' check (scope_type in ('global', 'department', 'program', 'class_record')),
  scope_id uuid,
  granted_by uuid references public.profiles(id) on delete set null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  check (valid_until is null or valid_from < valid_until),
  unique (user_id, role_id, scope_type, scope_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role_id uuid not null references public.roles(id) on delete restrict,
  scope_type text not null default 'global',
  scope_id uuid,
  token_digest text not null unique,
  invited_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.faculty_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete restrict,
  employee_id text not null unique,
  position text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles(id) on delete set null,
  program_id uuid not null references public.programs(id) on delete restrict,
  institutional_id text not null unique,
  email text not null,
  first_name text not null,
  last_name text not null,
  year_level smallint not null check (year_level between 1 and 8),
  section text not null,
  remarks text,
  status text not null default 'active' check (status in ('active', 'inactive', 'graduated', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete restrict,
  code text not null,
  title text not null,
  units numeric(4,1) not null default 3 check (units > 0),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, code)
);

create table public.academic_guidelines (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments(id) on delete restrict,
  title text not null,
  content text not null,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  effective_from date,
  effective_until date,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_until is null or effective_from is null or effective_from <= effective_until)
);

create table public.class_record_templates (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete restrict,
  name text not null,
  version integer not null default 1 check (version > 0),
  structure jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, name, version)
);

create table public.class_records (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id) on delete restrict,
  academic_term_id uuid not null references public.academic_terms(id) on delete restrict,
  department_id uuid not null references public.departments(id) on delete restrict,
  template_id uuid references public.class_record_templates(id) on delete restrict,
  section text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'closed', 'archived')),
  version integer not null default 1 check (version > 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_id, academic_term_id, section)
);

create table public.class_record_versions (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  reason text not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (class_record_id, version)
);

create table public.faculty_assignments (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid not null references public.faculty_profiles(id) on delete restrict,
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  assignment_role text not null default 'instructor' check (assignment_role in ('instructor', 'co_instructor', 'reviewer')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  assigned_at timestamptz not null default now(),
  unique (faculty_id, class_record_id, assignment_role)
);

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'dropped', 'withdrawn')),
  enrolled_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, class_record_id)
);

create table public.criteria_sets (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  name text not null,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  total_weight numeric(7,4) not null default 0 check (total_weight between 0 and 100),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_record_id, version),
  check (status <> 'active' or total_weight = 100)
);

create table public.criteria_nodes (
  id uuid primary key default gen_random_uuid(),
  criteria_set_id uuid not null references public.criteria_sets(id) on delete cascade,
  parent_id uuid references public.criteria_nodes(id) on delete cascade,
  type text not null check (type in ('period', 'component', 'assessment_category')),
  label text not null,
  description text,
  weight numeric(7,4) not null check (weight between 0 and 100),
  sort_order integer not null default 0 check (sort_order >= 0),
  formula jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  criteria_node_id uuid references public.criteria_nodes(id) on delete restrict,
  title text not null,
  type text not null,
  maximum_score numeric(10,2) not null check (maximum_score > 0),
  due_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'published', 'closed', 'archived')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.grader_assignments (
  id uuid primary key default gen_random_uuid(),
  grader_id uuid not null references public.profiles(id) on delete restrict,
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  assigned_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'completed', 'revoked')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  unique (grader_id, assessment_id)
);

create table public.grader_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.grader_assignments(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  payload jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, version)
);

create table public.grader_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.grader_submissions(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected')),
  reason text,
  reviewed_at timestamptz not null default now()
);

create table public.assessment_results (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  grader_submission_id uuid references public.grader_submissions(id) on delete set null,
  score numeric(10,2) not null check (score >= 0),
  source text not null default 'manual' check (source in ('manual', 'import', 'lms', 'grader')),
  approval_status text not null default 'approved' check (approval_status in ('draft', 'submitted', 'approved', 'rejected')),
  version integer not null default 1 check (version > 0),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assessment_id, enrollment_id)
);

create table public.model_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version text not null,
  artifact_reference text,
  feature_schema jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'unavailable' check (status in ('unavailable', 'testing', 'active', 'retired')),
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table public.performance_evaluations (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  criteria_set_id uuid not null references public.criteria_sets(id) on delete restrict,
  score numeric(7,2) not null check (score between 0 and 100),
  classification text not null check (classification in ('excellent', 'passing', 'at_risk')),
  risk_level text not null check (risk_level in ('low', 'medium', 'high')),
  explanation jsonb not null default '{}'::jsonb,
  calculated_by uuid references public.profiles(id) on delete set null,
  calculated_at timestamptz not null default now(),
  unique (enrollment_id, criteria_set_id)
);

create table public.prediction_criteria (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  name text not null,
  scenario text not null check (scenario in ('minimum', 'maximum', 'minimum_pass', 'stable', 'custom')),
  parameters jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.prediction_runs (
  id uuid primary key default gen_random_uuid(),
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  model_version_id uuid references public.model_versions(id) on delete restrict,
  prediction_criteria_id uuid not null references public.prediction_criteria(id) on delete restrict,
  input_snapshot jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'unavailable')),
  error_code text,
  error_message text,
  initiated_by uuid not null references public.profiles(id) on delete restrict,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.performance_predictions (
  id uuid primary key default gen_random_uuid(),
  prediction_run_id uuid not null references public.prediction_runs(id) on delete cascade,
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  predicted_score numeric(7,2) not null check (predicted_score between 0 and 100),
  trend text not null check (trend in ('improving', 'stable', 'declining')),
  risk_level text not null check (risk_level in ('low', 'medium', 'high')),
  confidence numeric(6,5) check (confidence between 0 and 1),
  explanation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (prediction_run_id, enrollment_id)
);

create table public.feedback_templates (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments(id) on delete cascade,
  title text not null,
  category text not null check (category in ('excellent', 'at_risk', 'attendance', 'improvement', 'custom')),
  body text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.feedback_records (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  enrollment_id uuid references public.enrollments(id) on delete set null,
  evaluation_id uuid references public.performance_evaluations(id) on delete set null,
  prediction_id uuid references public.performance_predictions(id) on delete set null,
  template_id uuid references public.feedback_templates(id) on delete set null,
  author_id uuid not null references public.profiles(id) on delete restrict,
  body text not null,
  category text not null,
  status text not null default 'draft' check (status in ('draft', 'ready', 'sent', 'failed', 'archived')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.notification_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  in_app boolean not null default true,
  email boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, event_type)
);

create table public.delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid references public.feedback_records(id) on delete cascade,
  notification_id uuid references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email')),
  provider_reference text,
  status text not null check (status in ('queued', 'sent', 'failed')),
  safe_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (feedback_id is not null or notification_id is not null)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  title text not null,
  description text not null default '',
  category text not null check (category in ('assessment', 'meeting', 'training', 'seminar', 'event')),
  priority text not null check (priority in ('low', 'medium', 'high', 'urgent')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  audience jsonb not null default '{}'::jsonb,
  status text not null default 'scheduled' check (status in ('draft', 'scheduled', 'completed', 'cancelled')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at <= ends_at)
);

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments(id) on delete cascade,
  provider text not null,
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'error', 'disabled')),
  configuration jsonb not null default '{}'::jsonb,
  secret_reference text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid references public.integrations(id) on delete set null,
  type text not null,
  scope_type text not null,
  scope_id uuid,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  total_count integer not null default 0,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  safe_error text,
  initiated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (total_count >= 0 and success_count >= 0 and failure_count >= 0)
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create table public.access_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  route text not null,
  action text not null,
  outcome text not null check (outcome in ('allowed', 'denied', 'failed')),
  ip_hash text,
  user_agent text,
  request_id text,
  created_at timestamptz not null default now()
);

create table public.system_logs (
  id bigint generated always as identity primary key,
  severity text not null check (severity in ('debug', 'info', 'warning', 'error', 'critical')),
  subsystem text not null,
  event_code text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.backups (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('full', 'database', 'files')),
  provider_reference text,
  checksum text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'deleted')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.backup_restores (
  id uuid primary key default gen_random_uuid(),
  backup_id uuid not null references public.backups(id) on delete restrict,
  initiated_by uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  safe_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.system_settings (
  key text primary key,
  value jsonb not null,
  is_secret_reference boolean not null default false,
  version integer not null default 1,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index idx_programs_department on public.programs(department_id, status);
create index idx_user_roles_user_active on public.user_roles(user_id, valid_until);
create index idx_students_program_status on public.students(program_id, status);
create index idx_students_search on public.students(last_name, first_name, institutional_id);
create index idx_class_records_department_term on public.class_records(department_id, academic_term_id, status);
create index idx_faculty_assignments_class on public.faculty_assignments(class_record_id, status);
create index idx_enrollments_class_status on public.enrollments(class_record_id, status);
create index idx_assessments_class_status on public.assessments(class_record_id, status);
create index idx_results_enrollment on public.assessment_results(enrollment_id, approval_status);
create index idx_grader_assignments_grader on public.grader_assignments(grader_id, status);
create index idx_evaluations_enrollment_risk on public.performance_evaluations(enrollment_id, risk_level);
create index idx_prediction_runs_class_status on public.prediction_runs(class_record_id, status, created_at desc);
create index idx_predictions_enrollment_risk on public.performance_predictions(enrollment_id, risk_level);
create index idx_feedback_student_status on public.feedback_records(student_id, status, created_at desc);
create index idx_notifications_recipient on public.notifications(recipient_id, read_at, created_at desc);
create index idx_events_department_date on public.events(department_id, starts_at, status);
create index idx_audit_entity on public.audit_logs(entity_type, entity_id, created_at desc);
create index idx_audit_actor on public.audit_logs(actor_id, created_at desc);
create index idx_access_actor on public.access_logs(actor_id, created_at desc);
create index idx_system_logs_time on public.system_logs(severity, created_at desc);
create index idx_backups_status on public.backups(status, created_at desc);

create or replace function private.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'departments','programs','academic_terms','profiles','faculty_profiles','students','subjects',
    'academic_guidelines','class_record_templates','class_records','enrollments','criteria_sets',
    'criteria_nodes','assessments','grader_submissions','assessment_results','prediction_criteria',
    'feedback_templates','feedback_records','notification_preferences','events','integrations'
  ] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', table_name);
  end loop;
end $$;

create or replace function private.has_permission(requested_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = auth.uid()
      and p.key = requested_permission
      and ur.valid_from <= now()
      and (ur.valid_until is null or ur.valid_until > now())
  );
$$;

create or replace function private.can_access_class(target_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.class_records cr
    where cr.id = target_class_id and (
      exists (
        select 1 from public.faculty_assignments fa
        join public.faculty_profiles fp on fp.id = fa.faculty_id
        where fa.class_record_id = cr.id and fp.profile_id = auth.uid() and fa.status = 'active'
      )
      or exists (
        select 1 from public.enrollments e
        join public.students s on s.id = e.student_id
        where e.class_record_id = cr.id and s.profile_id = auth.uid()
      )
      or exists (
        select 1 from public.user_roles ur
        join public.roles r on r.id = ur.role_id
        where ur.user_id = auth.uid() and r.key = 'academic_admin'
          and ur.scope_type = 'department' and ur.scope_id = cr.department_id
      )
    )
  );
$$;

create or replace function public.review_grader_submission(
  target_submission_id uuid,
  review_decision text,
  review_reason text default null
)
returns public.grader_submissions
language plpgsql
security definer
set search_path = public
as $$
declare submission public.grader_submissions;
declare assessment_class_id uuid;
begin
  if review_decision not in ('approved', 'rejected') then
    raise exception 'Invalid review decision' using errcode = '22023';
  end if;
  select gs into submission
  from public.grader_submissions gs
  where gs.id = target_submission_id
  for update;
  if submission.id is null then raise exception 'Submission not found' using errcode = 'P0002'; end if;
  select a.class_record_id into assessment_class_id
  from public.grader_assignments ga
  join public.assessments a on a.id = ga.assessment_id
  where ga.id = submission.assignment_id;
  if not private.has_permission('grader_submissions.review.assigned') or not private.can_access_class(assessment_class_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if submission.status <> 'submitted' then raise exception 'Submission is not awaiting review' using errcode = '23514'; end if;
  insert into public.grader_reviews(submission_id, reviewer_id, decision, reason)
  values (submission.id, auth.uid(), review_decision, nullif(trim(review_reason), ''));
  update public.grader_submissions set status = review_decision, updated_at = now() where id = submission.id returning * into submission;
  update public.assessment_results set approval_status = review_decision, updated_at = now()
  where grader_submission_id = submission.id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, after_data)
  values (auth.uid(), 'grader_submission.' || review_decision, 'grader_submission', submission.id, jsonb_build_object('reason', review_reason));
  return submission;
end;
$$;

revoke all on function public.review_grader_submission(uuid, text, text) from public;
grant execute on function public.review_grader_submission(uuid, text, text) to authenticated;

do $$
declare protected_table regclass;
begin
  for protected_table in
    select format('%I.%I', schemaname, tablename)::regclass
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('alter table %s enable row level security', protected_table);
  end loop;
end;
$$;

create policy reference_departments_read on public.departments for select to authenticated using (true);
create policy reference_programs_read on public.programs for select to authenticated using (true);
create policy reference_terms_read on public.academic_terms for select to authenticated using (true);
create policy reference_subjects_read on public.subjects for select to authenticated using (true);
create policy reference_roles_read on public.roles for select to authenticated using (true);
create policy reference_permissions_read on public.permissions for select to authenticated using (true);
create policy reference_role_permissions_read on public.role_permissions for select to authenticated using (true);
create policy reference_model_versions_read on public.model_versions for select to authenticated using (true);
create policy references_operator_manage_departments on public.departments for all to authenticated using (private.has_permission('system.configure')) with check (private.has_permission('system.configure'));
create policy references_operator_manage_programs on public.programs for all to authenticated using (private.has_permission('system.configure')) with check (private.has_permission('system.configure'));
create policy references_operator_manage_terms on public.academic_terms for all to authenticated using (private.has_permission('system.configure')) with check (private.has_permission('system.configure'));
create policy references_operator_manage_subjects on public.subjects for all to authenticated using (private.has_permission('system.configure')) with check (private.has_permission('system.configure'));
create policy roles_operator_manage on public.roles for all to authenticated using (private.has_permission('roles.manage')) with check (private.has_permission('roles.manage'));
create policy permissions_operator_manage on public.permissions for all to authenticated using (private.has_permission('roles.manage')) with check (private.has_permission('roles.manage'));
create policy role_permissions_operator_manage on public.role_permissions for all to authenticated using (private.has_permission('roles.manage')) with check (private.has_permission('roles.manage'));
create policy invitations_operator_manage on public.invitations for all to authenticated using (private.has_permission('users.manage') or private.has_permission('admin_accounts.manage')) with check (private.has_permission('users.manage') or private.has_permission('admin_accounts.manage'));

create policy profiles_self_read on public.profiles for select to authenticated using (id = auth.uid() or private.has_permission('users.manage') or private.has_permission('admin_accounts.manage'));
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy user_roles_technical_read on public.user_roles for select to authenticated using (user_id = auth.uid() or private.has_permission('users.manage') or private.has_permission('admin_accounts.manage'));
create policy students_scoped_read on public.students for select to authenticated using (
  profile_id = auth.uid()
  or exists (select 1 from public.enrollments e where e.student_id = students.id and private.can_access_class(e.class_record_id))
  or private.has_permission('students.manage.department')
);
create policy students_department_manage on public.students for all to authenticated using (private.has_permission('students.manage.department')) with check (private.has_permission('students.manage.department'));
create policy faculty_scoped_read on public.faculty_profiles for select to authenticated using (profile_id = auth.uid() or private.has_permission('faculty.read.department') or private.has_permission('users.manage'));
create policy class_records_scoped_read on public.class_records for select to authenticated using (private.can_access_class(id));
create policy class_records_scoped_manage on public.class_records for all to authenticated using (
  private.can_access_class(id) and (private.has_permission('class_records.manage.assigned') or private.has_permission('class_records.manage.department'))
) with check (private.has_permission('class_records.manage.assigned') or private.has_permission('class_records.manage.department'));
create policy enrollments_scoped_read on public.enrollments for select to authenticated using (private.can_access_class(class_record_id));
create policy assessments_scoped on public.assessments for select to authenticated using (private.can_access_class(class_record_id));
create policy assessment_results_scoped_read on public.assessment_results for select to authenticated using (
  exists (select 1 from public.assessments a where a.id = assessment_id and private.can_access_class(a.class_record_id))
);
create policy grader_assignments_self on public.grader_assignments for select to authenticated using (grader_id = auth.uid() or private.can_access_class((select a.class_record_id from public.assessments a where a.id = assessment_id)));
create policy grader_submissions_self_read on public.grader_submissions for select to authenticated using (
  exists (select 1 from public.grader_assignments ga where ga.id = assignment_id and (ga.grader_id = auth.uid() or private.can_access_class((select a.class_record_id from public.assessments a where a.id = ga.assessment_id))))
);
create policy evaluations_scoped_read on public.performance_evaluations for select to authenticated using (
  exists (select 1 from public.enrollments e where e.id = enrollment_id and private.can_access_class(e.class_record_id))
);
create policy predictions_scoped_read on public.performance_predictions for select to authenticated using (
  exists (select 1 from public.enrollments e where e.id = enrollment_id and private.can_access_class(e.class_record_id))
);
create policy feedback_scoped_read on public.feedback_records for select to authenticated using (
  author_id = auth.uid() or exists (select 1 from public.students s where s.id = student_id and s.profile_id = auth.uid())
);
create policy notifications_self on public.notifications for select to authenticated using (recipient_id = auth.uid());
create policy notifications_self_update on public.notifications for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
create policy events_authenticated_read on public.events for select to authenticated using (true);
create policy events_department_manage on public.events for all to authenticated using (private.has_permission('events.manage.department')) with check (private.has_permission('events.manage.department'));
create policy audit_logs_technical on public.audit_logs for select to authenticated using (private.has_permission('logs.read'));
create policy access_logs_technical on public.access_logs for select to authenticated using (private.has_permission('logs.read'));
create policy system_logs_technical on public.system_logs for select to authenticated using (private.has_permission('logs.read'));
create policy backups_super_admin on public.backups for all to authenticated using (private.has_permission('backups.manage')) with check (private.has_permission('backups.manage'));
create policy settings_technical on public.system_settings for select to authenticated using (private.has_permission('system.configure') or private.has_permission('backups.manage'));

create policy guidelines_authenticated_read on public.academic_guidelines for select to authenticated using (true);
create policy guidelines_scoped_manage on public.academic_guidelines for all to authenticated using (
  private.has_permission('guidelines.manage.assigned') or private.has_permission('guidelines.manage.department')
) with check (private.has_permission('guidelines.manage.assigned') or private.has_permission('guidelines.manage.department'));
create policy templates_authenticated_read on public.class_record_templates for select to authenticated using (true);
create policy templates_scoped_manage on public.class_record_templates for all to authenticated using (
  private.has_permission('templates.manage.assigned') or private.has_permission('templates.manage.department')
) with check (private.has_permission('templates.manage.assigned') or private.has_permission('templates.manage.department'));
create policy class_versions_scoped_read on public.class_record_versions for select to authenticated using (private.can_access_class(class_record_id));
create policy class_versions_scoped_manage on public.class_record_versions for all to authenticated using (
  private.can_access_class(class_record_id) and (private.has_permission('class_records.manage.assigned') or private.has_permission('class_records.manage.department'))
) with check (private.can_access_class(class_record_id) and (private.has_permission('class_records.manage.assigned') or private.has_permission('class_records.manage.department')));
create policy faculty_assignments_scoped_read on public.faculty_assignments for select to authenticated using (private.can_access_class(class_record_id));
create policy faculty_assignments_scoped_manage on public.faculty_assignments for all to authenticated using (
  private.has_permission('class_records.manage.department')
) with check (private.has_permission('class_records.manage.department'));
create policy enrollments_scoped_manage on public.enrollments for all to authenticated using (
  private.can_access_class(class_record_id) and (private.has_permission('class_records.manage.assigned') or private.has_permission('class_records.manage.department'))
) with check (private.can_access_class(class_record_id) and (private.has_permission('class_records.manage.assigned') or private.has_permission('class_records.manage.department')));
create policy criteria_sets_scoped_read on public.criteria_sets for select to authenticated using (private.can_access_class(class_record_id));
create policy criteria_sets_scoped_manage on public.criteria_sets for all to authenticated using (
  private.can_access_class(class_record_id) and (private.has_permission('criteria.manage.assigned') or private.has_permission('criteria.manage.department'))
) with check (private.can_access_class(class_record_id) and (private.has_permission('criteria.manage.assigned') or private.has_permission('criteria.manage.department')));
create policy criteria_nodes_scoped_read on public.criteria_nodes for select to authenticated using (
  exists (select 1 from public.criteria_sets cs where cs.id = criteria_set_id and private.can_access_class(cs.class_record_id))
);
create policy criteria_nodes_scoped_manage on public.criteria_nodes for all to authenticated using (
  exists (select 1 from public.criteria_sets cs where cs.id = criteria_set_id and private.can_access_class(cs.class_record_id))
  and (private.has_permission('criteria.manage.assigned') or private.has_permission('criteria.manage.department'))
) with check (
  exists (select 1 from public.criteria_sets cs where cs.id = criteria_set_id and private.can_access_class(cs.class_record_id))
  and (private.has_permission('criteria.manage.assigned') or private.has_permission('criteria.manage.department'))
);
create policy assessments_scoped_manage on public.assessments for all to authenticated using (
  private.can_access_class(class_record_id) and (private.has_permission('assessment_results.manage.assigned') or private.has_permission('assessment_results.manage.department'))
) with check (private.can_access_class(class_record_id) and (private.has_permission('assessment_results.manage.assigned') or private.has_permission('assessment_results.manage.department')));
create policy grader_assignments_scoped_manage on public.grader_assignments for all to authenticated using (
  private.can_access_class((select a.class_record_id from public.assessments a where a.id = assessment_id))
  and private.has_permission('assessment_results.manage.assigned')
) with check (
  private.can_access_class((select a.class_record_id from public.assessments a where a.id = assessment_id))
  and private.has_permission('assessment_results.manage.assigned')
);
create policy grader_submissions_grader_write on public.grader_submissions for insert to authenticated with check (
  exists (select 1 from public.grader_assignments ga where ga.id = assignment_id and ga.grader_id = auth.uid())
  and private.has_permission('assessment_results.submit.assigned')
);
create policy grader_reviews_scoped_read on public.grader_reviews for select to authenticated using (
  reviewer_id = auth.uid() or exists (
    select 1 from public.grader_submissions gs
    join public.grader_assignments ga on ga.id = gs.assignment_id
    join public.assessments a on a.id = ga.assessment_id
    where gs.id = submission_id and private.can_access_class(a.class_record_id)
  )
);
create policy results_scoped_manage on public.assessment_results for all to authenticated using (
  exists (select 1 from public.assessments a where a.id = assessment_id and private.can_access_class(a.class_record_id))
  and (private.has_permission('assessment_results.manage.assigned') or private.has_permission('assessment_results.manage.department'))
) with check (
  exists (select 1 from public.assessments a where a.id = assessment_id and private.can_access_class(a.class_record_id))
  and (private.has_permission('assessment_results.manage.assigned') or private.has_permission('assessment_results.manage.department'))
);
create policy evaluation_inputs_scoped_read on public.prediction_criteria for select to authenticated using (
  private.can_access_class(class_record_id)
);
create policy prediction_runs_scoped_read on public.prediction_runs for select to authenticated using (
  private.can_access_class(class_record_id)
);
create policy feedback_templates_authenticated_read on public.feedback_templates for select to authenticated using (true);
create policy feedback_templates_scoped_manage on public.feedback_templates for all to authenticated using (
  private.has_permission('feedback.send.assigned') or private.has_permission('predictions.run.department')
) with check (private.has_permission('feedback.send.assigned') or private.has_permission('predictions.run.department'));
create policy notification_preferences_self on public.notification_preferences for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy delivery_attempts_technical on public.delivery_attempts for select to authenticated using (private.has_permission('logs.read'));
create policy integrations_operator on public.integrations for all to authenticated using (private.has_permission('integrations.manage')) with check (private.has_permission('integrations.manage'));
create policy imports_operator on public.import_jobs for all to authenticated using (private.has_permission('integrations.manage')) with check (private.has_permission('integrations.manage'));
create policy backup_restores_super_admin on public.backup_restores for all to authenticated using (private.has_permission('backups.manage')) with check (private.has_permission('backups.manage'));
create policy settings_operator_manage on public.system_settings for all to authenticated using (private.has_permission('system.configure')) with check (private.has_permission('system.configure'));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
