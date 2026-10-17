-- A custom inference service is metered by submitted records rather than
-- provider tokens. Reservations are made atomically before any request leaves
-- the Edge Function; unsuccessful requests remain counted conservatively.
create or replace function public.ai_custom_reserve_usage(
  p_actor_id uuid,
  p_class_record_id uuid,
  p_model text,
  p_request_count integer
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  utc_month_start timestamp := date_trunc('month', timezone('UTC', now()));
  utc_month_end timestamp := utc_month_start + interval '1 month';
  configured_limit integer;
  used_requests bigint;
  reservation_id uuid;
  setting_value jsonb;
begin
  if p_actor_id is null or p_class_record_id is null
     or p_model is null or length(btrim(p_model)) = 0 or length(p_model) > 200
     or p_request_count is null or p_request_count < 1 then
    raise exception 'Invalid custom AI usage reservation';
  end if;

  select s.value into setting_value
  from public.system_settings s
  where s.key = 'ai.custom.monthly_request_limit';

  if not found or setting_value is null or setting_value = 'null'::jsonb then
    configured_limit := null;
  else
    if jsonb_typeof(setting_value) <> 'number'
       or (setting_value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
       or (setting_value #>> '{}')::numeric > 2147483647 then
      raise exception 'Custom AI monthly request limit must be null or a nonnegative whole number';
    end if;
    configured_limit := (setting_value #>> '{}')::integer;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat('system:custom:', to_char(utc_month_start, 'YYYY-MM')), 0
  ));

  select coalesce(sum(u.request_count), 0)
  into used_requests
  from public.ai_model_usage u
  where u.credential_scope = 'system'
    and u.credential_scope_id is null
    and u.provider = 'custom'
    and u.created_at >= (utc_month_start at time zone 'UTC')
    and u.created_at < (utc_month_end at time zone 'UTC');

  if configured_limit is not null
     and used_requests + p_request_count > configured_limit then
    return null;
  end if;

  insert into public.ai_model_usage (
    actor_id, class_record_id, credential_scope, credential_scope_id,
    provider, model, feature, request_count, input_tokens, output_tokens, succeeded
  ) values (
    p_actor_id, p_class_record_id, 'system', null,
    'custom', btrim(p_model), 'custom_prediction', p_request_count, 0, 0, false
  )
  returning id into reservation_id;

  return reservation_id;
end;
$$;

revoke all on function public.ai_custom_reserve_usage(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.ai_custom_reserve_usage(uuid, uuid, text, integer)
  to service_role;

insert into public.system_settings(key, value)
values ('ai.custom.monthly_request_limit', 'null'::jsonb)
on conflict (key) do nothing;
