-- Run with `supabase test db` after the AI provider usage migration.
-- All fixture changes are rolled back when this test finishes.
begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;

select plan(11);

select ok(
  not has_function_privilege('anon', 'public.ai_custom_reserve_usage(uuid,uuid,text,integer)', 'execute'),
  'anonymous callers cannot reserve custom AI usage'
);
select ok(
  not has_function_privilege('authenticated', 'public.ai_custom_reserve_usage(uuid,uuid,text,integer)', 'execute'),
  'authenticated callers cannot reserve custom AI usage directly'
);
select ok(
  has_function_privilege('service_role', 'public.ai_custom_reserve_usage(uuid,uuid,text,integer)', 'execute'),
  'the trusted Edge Function service role can reserve custom AI usage'
);

create or replace function pg_temp.ai_custom_reservation_would_pass(p_request_count integer)
returns boolean
language plpgsql
as $$
declare
  reservation_id uuid;
begin
  reservation_id := public.ai_custom_reserve_usage(
    'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid,
    'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid,
    'pgTAP quota test',
    p_request_count
  );
  if reservation_id is null then
    return false;
  end if;

  -- The fake auth/class references normally make the test insert fail; if this
  -- database happens to contain those UUIDs, remove the reservation instead.
  delete from public.ai_model_usage where id = reservation_id;
  return true;
exception when foreign_key_violation then
  -- Reaching the insert confirms the quota check allowed this reservation.
  return true;
end;
$$;

set local time zone 'Pacific/Honolulu';

update public.system_settings
set value = '0'::jsonb
where key = 'ai.custom.monthly_request_limit';
select is(pg_temp.ai_custom_reservation_would_pass(1), false, 'a zero monthly limit disables reservations');

-- Set a one-record allowance above current usage; the call is allowed to reach
-- the insert (where the intentionally fake references stop it).
update public.system_settings
set value = to_jsonb(coalesce((
  select sum(u.request_count) from public.ai_model_usage u
  where u.credential_scope = 'system' and u.credential_scope_id is null and u.provider = 'custom'
    and u.created_at >= (date_trunc('month', timezone('UTC', now())) at time zone 'UTC')
    and u.created_at < ((date_trunc('month', timezone('UTC', now())) + interval '1 month') at time zone 'UTC')
), 0) + 1)
where key = 'ai.custom.monthly_request_limit';
select is(pg_temp.ai_custom_reservation_would_pass(1), true, 'a request that exactly reaches the cap is allowed');
select is(pg_temp.ai_custom_reservation_would_pass(2), false, 'a batch larger than the remaining allowance is rejected');

update public.system_settings
set value = to_jsonb(coalesce((
  select sum(u.request_count) from public.ai_model_usage u
  where u.credential_scope = 'system' and u.credential_scope_id is null and u.provider = 'custom'
    and u.created_at >= (date_trunc('month', timezone('UTC', now())) at time zone 'UTC')
    and u.created_at < ((date_trunc('month', timezone('UTC', now())) + interval '1 month') at time zone 'UTC')
), 0))
where key = 'ai.custom.monthly_request_limit';
select is(pg_temp.ai_custom_reservation_would_pass(1), false, 'requests beyond the current cap are rejected');

update public.system_settings
set value = 'null'::jsonb
where key = 'ai.custom.monthly_request_limit';
select is(pg_temp.ai_custom_reservation_would_pass(1), true, 'a null monthly limit allows unlimited requests');

update public.system_settings
set value = '-1'::jsonb
where key = 'ai.custom.monthly_request_limit';
create or replace function pg_temp.ai_custom_invalid_limit_is_rejected()
returns boolean
language plpgsql
as $$
begin
  perform public.ai_custom_reserve_usage(
    'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid,
    'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid,
    'pgTAP quota test', 1
  );
  return false;
exception when raise_exception then
  return true;
end;
$$;
select is(pg_temp.ai_custom_invalid_limit_is_rejected(), true, 'negative limits are rejected');

-- A usage row five hours after UTC month-start is still inside the UTC month,
-- even though it precedes month-start in the Honolulu session timezone.
update public.system_settings set value = 'null'::jsonb
where key = 'ai.custom.monthly_request_limit';
insert into public.ai_model_usage (
  credential_scope, credential_scope_id, provider, model, feature, request_count, created_at
) values (
  'system', null, 'custom', 'pgTAP UTC boundary fixture', 'custom_prediction', 100,
  (date_trunc('month', timezone('UTC', now())) + interval '5 hours') at time zone 'UTC'
);
update public.system_settings
set value = to_jsonb((
  select coalesce(sum(u.request_count), 0) from public.ai_model_usage u
  where u.credential_scope = 'system' and u.credential_scope_id is null and u.provider = 'custom'
    and u.created_at >= (date_trunc('month', timezone('UTC', now())) at time zone 'UTC')
    and u.created_at < ((date_trunc('month', timezone('UTC', now())) + interval '1 month') at time zone 'UTC')
))
where key = 'ai.custom.monthly_request_limit';
select is(pg_temp.ai_custom_reservation_would_pass(1), false, 'monthly usage uses stable UTC calendar boundaries');

delete from public.ai_model_usage where model = 'pgTAP UTC boundary fixture';
insert into public.ai_model_usage (
  credential_scope, credential_scope_id, provider, model, feature, request_count, created_at
) values (
  'system', null, 'custom', 'pgTAP next month fixture', 'custom_prediction', 100,
  (date_trunc('month', timezone('UTC', now())) + interval '1 month 5 hours') at time zone 'UTC'
);
update public.system_settings
set value = to_jsonb(coalesce((
  select sum(u.request_count) from public.ai_model_usage u
  where u.credential_scope = 'system' and u.credential_scope_id is null and u.provider = 'custom'
    and u.created_at >= (date_trunc('month', timezone('UTC', now())) at time zone 'UTC')
    and u.created_at < ((date_trunc('month', timezone('UTC', now())) + interval '1 month') at time zone 'UTC')
), 0) + 1)
where key = 'ai.custom.monthly_request_limit';
select is(pg_temp.ai_custom_reservation_would_pass(1), true, 'next month usage does not consume this month’s cap');

select * from finish();
rollback;
