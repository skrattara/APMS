-- Model artifacts are readable only through short-lived signed URLs minted by
-- the service-role Edge Function. No browser role receives a Storage policy.
begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('apms-ai-artifacts', 'apms-ai-artifacts', false, 536870912)
on conflict (id) do nothing;

do $$
declare
  bucket_is_public boolean;
begin
  select b.public into bucket_is_public
  from storage.buckets b
  where b.id = 'apms-ai-artifacts';

  if not found then
    raise exception 'Required model artifact bucket could not be created';
  end if;
  if bucket_is_public then
    raise exception 'The existing apms-ai-artifacts bucket must be private before this migration can continue';
  end if;
end;
$$;

update storage.buckets
set file_size_limit = 536870912
where id = 'apms-ai-artifacts';

alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
drop policy if exists ai_artifacts_deny_browser_access on storage.objects;
create policy ai_artifacts_deny_browser_access
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'apms-ai-artifacts')
  with check (bucket_id <> 'apms-ai-artifacts');

-- Protect the bucket's public flag and metadata even if another permissive
-- browser policy is added to storage.buckets later.
drop policy if exists ai_artifacts_deny_browser_bucket_access on storage.buckets;
create policy ai_artifacts_deny_browser_bucket_access
  on storage.buckets
  as restrictive
  for all
  to anon, authenticated
  using (id <> 'apms-ai-artifacts')
  with check (id <> 'apms-ai-artifacts');

commit;
