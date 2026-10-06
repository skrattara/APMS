create table if not exists public.grading_systems (
  id text primary key,
  name text not null,
  description text,
  definition jsonb not null,
  is_builtin boolean not null default false,
  created_by uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_builtin and created_by is null) or (not is_builtin and created_by is not null))
);

alter table public.criteria_sets
  add column if not exists grading_system_id text,
  add column if not exists grading_system_definition jsonb;

alter table public.assessments
  add column if not exists grading_type_id text,
  add column if not exists grading_group_id text,
  add column if not exists grading_period_id text,
  add column if not exists grading_instance_weight numeric;

update public.criteria_sets
set grading_system_id = 'grading-system-it-global'
where grading_system_id is null and status = 'active';

alter table public.grading_systems enable row level security;
grant select, insert, update, delete on public.grading_systems to authenticated;
revoke all on public.grading_systems from anon;

create policy grading_systems_read on public.grading_systems for select to authenticated
  using (is_builtin or created_by = (select auth.uid()));
create policy grading_systems_insert on public.grading_systems for insert to authenticated
  with check (not is_builtin and created_by = (select auth.uid()));
create policy grading_systems_update on public.grading_systems for update to authenticated
  using (not is_builtin and created_by = (select auth.uid()))
  with check (not is_builtin and created_by = (select auth.uid()));
create policy grading_systems_delete on public.grading_systems for delete to authenticated
  using (not is_builtin and created_by = (select auth.uid()));

create index if not exists criteria_sets_grading_system_id_idx on public.criteria_sets(grading_system_id);
