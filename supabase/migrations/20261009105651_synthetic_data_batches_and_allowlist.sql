create table public.synthetic_data_batches (
  id uuid primary key,
  class_record_id uuid not null references public.class_records(id) on delete cascade,
  generation_key text not null,
  seed text not null,
  status text not null default 'writing' check (status in ('writing', 'ready', 'failed', 'replaced')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  grading_system_definition jsonb not null,
  evaluation_system_definition jsonb,
  generation_plan jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_record_id, id)
);

alter table public.students add column synthetic_batch_id uuid references public.synthetic_data_batches(id) on delete restrict;
alter table public.assessments add column synthetic_batch_id uuid references public.synthetic_data_batches(id) on delete restrict;
alter table public.assessments add column optional boolean not null default false;
alter table public.assessment_results add column synthetic_batch_id uuid references public.synthetic_data_batches(id) on delete restrict;
alter table public.class_records add column is_synthetic_test boolean not null default false;

create index synthetic_data_batches_class_created_idx on public.synthetic_data_batches(class_record_id, created_at desc);
create unique index synthetic_data_batches_ready_key_idx on public.synthetic_data_batches(class_record_id, generation_key) where status = 'ready';
create index students_synthetic_batch_idx on public.students(synthetic_batch_id) where synthetic_batch_id is not null;
create index assessments_synthetic_batch_idx on public.assessments(synthetic_batch_id) where synthetic_batch_id is not null;
create index assessment_results_synthetic_batch_idx on public.assessment_results(synthetic_batch_id) where synthetic_batch_id is not null;

alter table public.synthetic_data_batches enable row level security;
revoke all on public.synthetic_data_batches from anon, authenticated;
grant all on public.synthetic_data_batches to service_role;

create or replace function public.promote_synthetic_data_batch(p_batch_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_class_record_id uuid;
  v_generation_key text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select b.class_record_id, b.generation_key
    into v_class_record_id, v_generation_key
    from public.synthetic_data_batches b
    where b.id = p_batch_id and b.status = 'writing'
    for update;
  if not found then raise exception 'Synthetic batch is not in the writing state'; end if;

  update public.synthetic_data_batches
    set status = 'replaced', updated_at = now()
    where class_record_id = v_class_record_id and generation_key = v_generation_key
      and status = 'ready' and id <> p_batch_id;

  update public.assessments a set status = 'archived'
    from public.synthetic_data_batches b
    where b.class_record_id = v_class_record_id and b.generation_key = v_generation_key
      and b.status = 'replaced' and a.synthetic_batch_id = b.id;
  update public.enrollments e set status = 'completed', ended_at = now()
    from public.students s, public.synthetic_data_batches b
    where b.class_record_id = v_class_record_id and b.generation_key = v_generation_key
      and b.status = 'replaced' and s.synthetic_batch_id = b.id
      and e.student_id = s.id and e.class_record_id = v_class_record_id;
  update public.students s set status = 'inactive'
    from public.synthetic_data_batches b
    where b.class_record_id = v_class_record_id and b.generation_key = v_generation_key
      and b.status = 'replaced' and s.synthetic_batch_id = b.id;

  update public.students set status = 'active' where synthetic_batch_id = p_batch_id;
  update public.enrollments e set status = 'active', ended_at = null
    from public.students s where s.synthetic_batch_id = p_batch_id and e.student_id = s.id
      and e.class_record_id = v_class_record_id;
  update public.assessments set status = 'published' where synthetic_batch_id = p_batch_id;
  update public.synthetic_data_batches set status = 'ready', updated_at = now() where id = p_batch_id;
end;
$$;

revoke execute on function public.promote_synthetic_data_batch(uuid) from public, anon, authenticated;
grant execute on function public.promote_synthetic_data_batch(uuid) to service_role;
