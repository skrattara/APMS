alter table public.gradebook_score_versions
  add column if not exists actor_name text;

update public.gradebook_score_versions v
set actor_name = nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '')
from public.profiles p
where p.id = v.actor_id
  and v.actor_name is null;

create or replace function private.snapshot_gradebook_version_actor_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '')
  into new.actor_name
  from public.profiles p
  where p.id = new.actor_id;
  return new;
end;
$$;

revoke all on function private.snapshot_gradebook_version_actor_name() from public, anon, authenticated;

drop trigger if exists snapshot_gradebook_version_actor_name on public.gradebook_score_versions;
create trigger snapshot_gradebook_version_actor_name
before insert on public.gradebook_score_versions
for each row execute function private.snapshot_gradebook_version_actor_name();
