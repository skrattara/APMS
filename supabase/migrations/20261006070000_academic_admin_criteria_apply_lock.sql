-- Serialize criteria version creation without taking a row lock on class_records.
-- FOR UPDATE requires class-record management permission, which Academic Admins
-- intentionally do not have; their department-scoped criteria permission is enough.
create or replace function public.save_criteria_version(
  p_class_id uuid,
  p_name text,
  p_passing_threshold numeric,
  p_nodes jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  next_version integer;
  new_set_id uuid;
  total_weight numeric;
begin
  if nullif(btrim(p_name), '') is null then
    raise exception 'Criteria name is required';
  end if;
  if p_passing_threshold < 0 or p_passing_threshold > 100 then
    raise exception 'Passing threshold must be between 0 and 100';
  end if;
  if jsonb_typeof(p_nodes) <> 'array' or jsonb_array_length(p_nodes) = 0 then
    raise exception 'At least one criteria node is required';
  end if;

  select coalesce(sum((node->>'weight')::numeric), 0)
    into total_weight
  from jsonb_array_elements(p_nodes) node;
  if total_weight <> 100 then
    raise exception 'Criteria weights must total exactly 100%%';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_nodes) node
    where nullif(btrim(node->>'label'), '') is null
      or (node->>'weight')::numeric < 0
  ) then
    raise exception 'Criteria nodes require a label and non-negative weight';
  end if;

  -- Use a transaction-scoped lock per class to keep version numbers unique
  -- without requiring UPDATE permission on the class record itself.
  perform pg_advisory_xact_lock(724915, hashtext(p_class_id::text));
  perform 1 from public.class_records where id = p_class_id;
  if not found then raise exception 'Authorized class not found'; end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.criteria_sets where class_record_id = p_class_id;

  insert into public.criteria_sets (
    class_record_id, name, version, status, total_weight,
    passing_threshold, created_by
  ) values (
    p_class_id, btrim(p_name), next_version, 'active', 100,
    p_passing_threshold, auth.uid()
  ) returning id into new_set_id;

  insert into public.criteria_nodes (
    criteria_set_id, type, label, weight, sort_order
  )
  select new_set_id, 'assessment_category', btrim(node->>'label'),
         (node->>'weight')::numeric, ordinal - 1
  from jsonb_array_elements(p_nodes) with ordinality as valueset(node, ordinal);

  update public.criteria_sets
  set status = 'archived'
  where class_record_id = p_class_id
    and id <> new_set_id
    and status = 'active';

  return new_set_id;
end;
$$;

revoke all on function public.save_criteria_version(uuid, text, numeric, jsonb) from public, anon;
grant execute on function public.save_criteria_version(uuid, text, numeric, jsonb) to authenticated;
