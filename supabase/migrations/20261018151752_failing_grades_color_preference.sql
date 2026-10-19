alter table public.profiles
  add column if not exists failing_grades_red boolean not null default true;