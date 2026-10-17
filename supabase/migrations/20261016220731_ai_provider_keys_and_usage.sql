-- Department credentials are kept in Supabase Vault. System credentials live
-- in Edge Function Secrets. Public metadata never contains credential material.
create schema if not exists private;

create table if not exists public.ai_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type = 'department'),
  scope_id uuid not null,
  provider text not null check (provider in ('openai', 'gemini')),
  model text,
  vault_secret_id uuid not null,
  monthly_request_limit integer check (monthly_request_limit is null or monthly_request_limit >= 0),
  monthly_token_limit bigint check (monthly_token_limit is null or monthly_token_limit >= 0),
  enabled boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (scope_type, scope_id, provider)
);

alter table public.ai_provider_credentials enable row level security;
revoke all on public.ai_provider_credentials from public, anon, authenticated;
grant all on public.ai_provider_credentials to service_role;

create table if not exists public.ai_model_usage (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  class_record_id uuid references public.class_records(id) on delete set null,
  -- `user` remains valid only to preserve old usage history. New reservations
  -- reject it, and no user credentials can be stored or resolved.
  credential_scope text not null check (credential_scope in ('system', 'department', 'user')),
  credential_scope_id uuid,
  provider text not null,
  model text not null,
  feature text not null,
  request_count integer not null default 1 check (request_count > 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  succeeded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists ai_model_usage_scope_created_idx
  on public.ai_model_usage (credential_scope, credential_scope_id, provider, created_at desc);
create index if not exists ai_model_usage_actor_created_idx
  on public.ai_model_usage (actor_id, created_at desc);
alter table public.ai_model_usage enable row level security;
revoke all on public.ai_model_usage from public, anon, authenticated;
grant all on public.ai_model_usage to service_role;

create or replace function public.ai_provider_reserve_usage(
  p_actor_id uuid, p_class_record_id uuid, p_scope_type text, p_scope_id uuid,
  p_provider text, p_model text, p_feature text, p_monthly_request_limit integer,
  p_monthly_token_limit bigint, p_reserved_tokens integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  month_start timestamptz := date_trunc('month',now());
  used_requests bigint;
  used_tokens bigint;
  reservation_id uuid;
begin
  if p_scope_type not in ('system','department') or p_provider not in ('openai','gemini') or p_reserved_tokens < 0 then
    raise exception 'Invalid AI usage reservation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(concat_ws(':',p_scope_type,coalesce(p_scope_id::text,''),p_provider,month_start::text),0));
  select coalesce(sum(u.request_count),0),coalesce(sum(u.input_tokens+u.output_tokens),0)
    into used_requests,used_tokens from public.ai_model_usage u
    where u.credential_scope=p_scope_type and u.credential_scope_id is not distinct from p_scope_id
      and u.provider=p_provider and u.created_at>=month_start;
  if p_monthly_request_limit is not null and used_requests>=p_monthly_request_limit then return null; end if;
  if p_monthly_token_limit is not null and used_tokens+p_reserved_tokens>p_monthly_token_limit then return null; end if;
  insert into public.ai_model_usage(actor_id,class_record_id,credential_scope,credential_scope_id,provider,model,feature,input_tokens)
    values(p_actor_id,p_class_record_id,p_scope_type,p_scope_id,p_provider,p_model,p_feature,p_reserved_tokens)
    returning id into reservation_id;
  return reservation_id;
end $$;
revoke all on function public.ai_provider_reserve_usage(uuid,uuid,text,uuid,text,text,text,integer,bigint,integer) from public,anon,authenticated;
grant execute on function public.ai_provider_reserve_usage(uuid,uuid,text,uuid,text,text,text,integer,bigint,integer) to service_role;

create or replace function public.ai_provider_usage_summary(p_scope_type text,p_scope_ids uuid[],p_since timestamptz)
returns table(scope_type text,scope_id uuid,provider text,model text,requests bigint,input_tokens bigint,output_tokens bigint)
language sql stable security definer set search_path = '' as $$
  select u.credential_scope,u.credential_scope_id,u.provider,u.model,
    sum(u.request_count)::bigint,sum(u.input_tokens)::bigint,sum(u.output_tokens)::bigint
  from public.ai_model_usage u
  where u.created_at>=p_since
    and (p_scope_type='all' or u.credential_scope=p_scope_type)
    and (p_scope_type='all' or (p_scope_type='system' and u.credential_scope_id is null)
      or (p_scope_type='department' and u.credential_scope_id=any(coalesce(p_scope_ids,'{}'::uuid[]))))
  group by u.credential_scope,u.credential_scope_id,u.provider,u.model
$$;
revoke all on function public.ai_provider_usage_summary(text,uuid[],timestamptz) from public,anon,authenticated;
grant execute on function public.ai_provider_usage_summary(text,uuid[],timestamptz) to service_role;

insert into public.system_settings(key,value)
values ('ai.usage.monthly_request_limit','null'::jsonb), ('ai.usage.monthly_token_limit','null'::jsonb)
on conflict (key) do nothing;

-- The function is intentionally executable only by service_role. Edge Functions
-- perform caller and department-role authorization before invoking these RPCs.
create or replace function public.ai_provider_store_credential(
  p_scope_type text, p_scope_id uuid, p_provider text, p_api_key text,
  p_model text, p_monthly_request_limit integer, p_monthly_token_limit bigint,
  p_updated_by uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  existing_secret uuid;
  secret_id uuid;
  secret_name text;
begin
  if p_scope_type <> 'department' or p_provider not in ('openai','gemini') then
    raise exception 'Unsupported credential scope or provider';
  end if;
  if p_api_key is null or length(btrim(p_api_key)) < 12 or length(p_api_key) > 500 then
    raise exception 'API key is invalid';
  end if;
  if p_monthly_request_limit is not null and p_monthly_request_limit < 0 then raise exception 'Request limit cannot be negative'; end if;
  if p_monthly_token_limit is not null and p_monthly_token_limit < 0 then raise exception 'Token limit cannot be negative'; end if;
  secret_name := 'apms-ai-' || p_scope_type || '-' || p_scope_id::text || '-' || p_provider;
  select c.vault_secret_id into existing_secret from public.ai_provider_credentials c
    where c.scope_type = p_scope_type and c.scope_id = p_scope_id and c.provider = p_provider;
  if existing_secret is null then
    secret_id := vault.create_secret(p_api_key, secret_name, 'APMS AI provider credential');
  else
    perform vault.update_secret(existing_secret, p_api_key, secret_name, 'APMS AI provider credential');
    secret_id := existing_secret;
  end if;
  insert into public.ai_provider_credentials(scope_type,scope_id,provider,model,vault_secret_id,monthly_request_limit,monthly_token_limit,updated_by,updated_at,enabled)
  values (p_scope_type,p_scope_id,p_provider,nullif(btrim(p_model),''),secret_id,p_monthly_request_limit,p_monthly_token_limit,p_updated_by,now(),true)
  on conflict (scope_type,scope_id,provider) do update set model=excluded.model,vault_secret_id=excluded.vault_secret_id,
    monthly_request_limit=excluded.monthly_request_limit,monthly_token_limit=excluded.monthly_token_limit,
    updated_by=excluded.updated_by,updated_at=now(),enabled=true;
end $$;

create or replace function public.ai_provider_delete_credential(p_scope_type text,p_scope_id uuid,p_provider text)
returns void language plpgsql security definer set search_path = '' as $$
declare secret_id uuid;
begin
  if p_scope_type <> 'department' or p_provider not in ('openai','gemini') then
    raise exception 'Unsupported credential scope or provider';
  end if;
  delete from public.ai_provider_credentials where scope_type=p_scope_type and scope_id=p_scope_id and provider=p_provider returning vault_secret_id into secret_id;
  if secret_id is not null then delete from vault.secrets where id=secret_id; end if;
end $$;

create or replace function public.ai_provider_update_credential_limits(
  p_scope_type text,p_scope_id uuid,p_provider text,p_model text,
  p_monthly_request_limit integer,p_monthly_token_limit bigint,p_updated_by uuid
) returns boolean
language sql security definer set search_path = '' as $$
  with changed as (
    update public.ai_provider_credentials set model=nullif(btrim(p_model),''),
      monthly_request_limit=p_monthly_request_limit,monthly_token_limit=p_monthly_token_limit,
      updated_by=p_updated_by,updated_at=now()
    where p_scope_type='department' and p_provider in ('openai','gemini')
      and scope_type='department' and scope_id=p_scope_id and provider=p_provider and enabled
    returning 1
  ) select exists(select 1 from changed)
$$;

create or replace function public.ai_provider_resolve_key(p_class_record_id uuid,p_provider text)
returns table(api_key text, provider text, model text, scope_type text, scope_id uuid, monthly_request_limit integer, monthly_token_limit bigint)
language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret,c.provider,c.model,c.scope_type,c.scope_id,c.monthly_request_limit,c.monthly_token_limit
  from public.class_records cr
  join lateral (
    select c.* from public.ai_provider_credentials c
    where c.provider=p_provider and c.enabled
      and c.scope_type='department' and c.scope_id=cr.department_id
    limit 1
  ) c on true
  join vault.decrypted_secrets ds on ds.id=c.vault_secret_id
  where cr.id=p_class_record_id
  limit 1
$$;

revoke all on function public.ai_provider_store_credential(text,uuid,text,text,text,integer,bigint,uuid) from public,anon,authenticated;
revoke all on function public.ai_provider_delete_credential(text,uuid,text) from public,anon,authenticated;
revoke all on function public.ai_provider_update_credential_limits(text,uuid,text,text,integer,bigint,uuid) from public,anon,authenticated;
revoke all on function public.ai_provider_resolve_key(uuid,text) from public,anon,authenticated;
grant execute on function public.ai_provider_store_credential(text,uuid,text,text,text,integer,bigint,uuid) to service_role;
grant execute on function public.ai_provider_delete_credential(text,uuid,text) to service_role;
grant execute on function public.ai_provider_update_credential_limits(text,uuid,text,text,integer,bigint,uuid) to service_role;
grant execute on function public.ai_provider_resolve_key(uuid,text) to service_role;

-- Earlier prediction runs could retain request input and schema context in
-- input_snapshot. Retain safe provenance metadata but remove prompt context.
update public.prediction_runs
set input_snapshot = input_snapshot - array['inputs','grading_system','evaluation_criteria']
where input_snapshot ?| array['inputs','grading_system','evaluation_criteria'];
