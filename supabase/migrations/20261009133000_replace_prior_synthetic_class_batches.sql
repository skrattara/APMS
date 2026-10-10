-- A test class should have exactly one active generated assessment set.
-- Replacing only batches with the same seed leaves duplicate assessment
-- instances behind when a seed changes, which can violate grading count rules.
with ranked_ready_batches as (
  select id,
         row_number() over (partition by class_record_id order by created_at desc, id desc) as batch_rank
  from public.synthetic_data_batches
  where status = 'ready'
)
update public.synthetic_data_batches b
set status = 'replaced', updated_at = now()
from ranked_ready_batches r
where r.id = b.id and r.batch_rank > 1;

update public.assessments a set status = 'archived'
from public.synthetic_data_batches b
where b.status = 'replaced' and a.synthetic_batch_id = b.id and a.status <> 'archived';
update public.enrollments e set status = 'completed', ended_at = now()
from public.students s, public.synthetic_data_batches b
where b.status = 'replaced' and s.synthetic_batch_id = b.id
  and e.student_id = s.id and e.class_record_id = b.class_record_id and e.status = 'active';
update public.students s set status = 'inactive'
from public.synthetic_data_batches b
where b.status = 'replaced' and s.synthetic_batch_id = b.id and s.status = 'active';

drop index if exists public.synthetic_data_batches_ready_key_idx;
create unique index synthetic_data_batches_one_ready_per_class_idx
  on public.synthetic_data_batches(class_record_id)
  where status = 'ready';

create or replace function public.promote_synthetic_data_batch(p_batch_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_class_record_id uuid;
begin
  if current_user <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select b.class_record_id
    into v_class_record_id
    from public.synthetic_data_batches b
    where b.id = p_batch_id and b.status = 'writing'
    for update;
  if not found then raise exception 'Synthetic batch is not in the writing state'; end if;

  -- Serialize promotions for the class so concurrent writes cannot leave two
  -- ready generated batches active at the same time.
  perform 1 from public.class_records where id = v_class_record_id for update;

  update public.synthetic_data_batches
    set status = 'replaced', updated_at = now()
    where class_record_id = v_class_record_id
      and status = 'ready'
      and id <> p_batch_id;

  update public.assessments a set status = 'archived'
    from public.synthetic_data_batches b
    where b.class_record_id = v_class_record_id
      and b.status = 'replaced'
      and a.synthetic_batch_id = b.id
      and a.status <> 'archived';
  update public.enrollments e set status = 'completed', ended_at = now()
    from public.students s, public.synthetic_data_batches b
    where b.class_record_id = v_class_record_id
      and b.status = 'replaced'
      and s.synthetic_batch_id = b.id
      and e.student_id = s.id
      and e.class_record_id = v_class_record_id
      and e.status = 'active';
  update public.students s set status = 'inactive'
    from public.synthetic_data_batches b
    where b.class_record_id = v_class_record_id
      and b.status = 'replaced'
      and s.synthetic_batch_id = b.id
      and s.status = 'active';

  update public.students set status = 'active' where synthetic_batch_id = p_batch_id;
  update public.enrollments e set status = 'active', ended_at = null
    from public.students s
    where s.synthetic_batch_id = p_batch_id
      and e.student_id = s.id
      and e.class_record_id = v_class_record_id;
  update public.assessments set status = 'published' where synthetic_batch_id = p_batch_id;
  update public.synthetic_data_batches set status = 'ready', updated_at = now() where id = p_batch_id;
end;
$$;

revoke execute on function public.promote_synthetic_data_batch(uuid) from public, anon, authenticated;
grant execute on function public.promote_synthetic_data_batch(uuid) to service_role;
