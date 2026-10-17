-- Run with `supabase test db` after the model artifact bucket migration.
-- Fixtures, grants, and permissive policies are rolled back at the end.
begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;

select plan(5);

select ok(
  (select not b.public and b.file_size_limit = 536870912
   from storage.buckets b where b.id = 'apms-ai-artifacts'),
  'the artifact bucket is private and has the 512 MiB default object cap'
);

-- Simulate accidental broad browser policies. The migration's restrictive
-- policies must still deny this dedicated bucket.
create policy ai_artifact_test_broad_objects on storage.objects
  for all to anon, authenticated using (true) with check (true);
create policy ai_artifact_test_broad_buckets on storage.buckets
  for all to anon, authenticated using (true) with check (true);
grant usage on schema storage to anon, authenticated;
grant select on storage.objects, storage.buckets to anon, authenticated;
grant update on storage.buckets to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('ai-artifact-test-other', 'ai-artifact-test-other', false, 536870912)
on conflict (id) do nothing;
insert into storage.objects (bucket_id, name)
values ('apms-ai-artifacts', 'releases/test/weights.pt'),
       ('ai-artifact-test-other', 'unrelated.txt');

set local role anon;
select is(
  (with attempted_change as (
     update storage.buckets set public = true where id = 'apms-ai-artifacts' returning id
   )
   select (select count(*)::integer from storage.objects where bucket_id = 'apms-ai-artifacts')
        + (select count(*)::integer from storage.buckets where id = 'apms-ai-artifacts')
        + (select count(*)::integer from attempted_change)),
  0,
  'anonymous clients cannot read artifacts or bucket metadata, or make the bucket public'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'ai-artifact-test-other'),
  1,
  'the artifact restriction leaves unrelated buckets readable by anonymous clients'
);

reset role;
set local role authenticated;
select is(
  (with attempted_change as (
     update storage.buckets set public = true where id = 'apms-ai-artifacts' returning id
   )
   select (select count(*)::integer from storage.objects where bucket_id = 'apms-ai-artifacts')
        + (select count(*)::integer from storage.buckets where id = 'apms-ai-artifacts')
        + (select count(*)::integer from attempted_change)),
  0,
  'authenticated clients cannot read artifacts or bucket metadata, or make the bucket public'
);
select is(
  (select count(*)::integer from storage.objects where bucket_id = 'ai-artifact-test-other'),
  1,
  'the artifact restriction leaves unrelated buckets readable by authenticated clients'
);

select * from finish();
rollback;
