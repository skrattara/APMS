create or replace function private.has_role(requested_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.key = requested_role
      and ur.valid_from <= now()
      and (ur.valid_until is null or ur.valid_until > now())
  );
$$;

revoke all on function private.has_role(text) from public, anon;
grant execute on function private.has_role(text) to authenticated;

drop policy if exists grading_systems_insert on public.grading_systems;
drop policy if exists grading_systems_update on public.grading_systems;
drop policy if exists grading_systems_delete on public.grading_systems;

create policy grading_systems_insert on public.grading_systems for insert to authenticated
  with check (not is_builtin and created_by = (select auth.uid()) and private.has_role('academic_admin'));
create policy grading_systems_update on public.grading_systems for update to authenticated
  using (not is_builtin and created_by = (select auth.uid()) and private.has_role('academic_admin'))
  with check (not is_builtin and created_by = (select auth.uid()) and private.has_role('academic_admin'));
create policy grading_systems_delete on public.grading_systems for delete to authenticated
  using (not is_builtin and created_by = (select auth.uid()) and private.has_role('academic_admin'));

create or replace function private.guard_grading_system_snapshot_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if (new.grading_system_id is not null or new.grading_system_definition is not null)
       and not private.has_role('academic_admin') then
      raise exception 'Only Academic Admins can apply grading systems to classes';
    end if;
  elsif (new.grading_system_id is distinct from old.grading_system_id
      or new.grading_system_definition is distinct from old.grading_system_definition)
      and not private.has_role('academic_admin') then
    raise exception 'Only Academic Admins can edit applied grading systems';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_grading_system_snapshot_edits() from public, anon, authenticated;
drop trigger if exists guard_grading_system_snapshot_edits on public.criteria_sets;
create trigger guard_grading_system_snapshot_edits
  before insert or update on public.criteria_sets
  for each row execute function private.guard_grading_system_snapshot_edits();
