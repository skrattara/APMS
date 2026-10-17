-- Disable the former user-key path even if the earlier AI provider migration
-- has already been applied. Department credentials stay in Vault; system keys
-- stay in Edge Function Secrets. Old personal credentials are deleted.
begin;

alter table public.ai_provider_credentials
  drop constraint if exists ai_provider_credentials_scope_type_check;

delete from vault.secrets s
where s.id in (
  select c.vault_secret_id
  from public.ai_provider_credentials c
  where c.scope_type = 'user'
);

delete from public.ai_provider_credentials
where scope_type = 'user';

alter table public.ai_provider_credentials
  add constraint ai_provider_credentials_department_only_check
  check (scope_type = 'department');

-- Tighten all service-only credential writers in case the prior version was
-- already installed. The Edge Function still performs caller-role checks.
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
  secret_name := 'apms-ai-department-' || p_scope_id::text || '-' || p_provider;
  select c.vault_secret_id into existing_secret from public.ai_provider_credentials c
    where c.scope_type = 'department' and c.scope_id = p_scope_id and c.provider = p_provider;
  if existing_secret is null then
    secret_id := vault.create_secret(p_api_key, secret_name, 'APMS department AI provider credential');
  else
    perform vault.update_secret(existing_secret, p_api_key, secret_name, 'APMS department AI provider credential');
    secret_id := existing_secret;
  end if;
  insert into public.ai_provider_credentials(scope_type,scope_id,provider,model,vault_secret_id,monthly_request_limit,monthly_token_limit,updated_by,updated_at,enabled)
  values ('department',p_scope_id,p_provider,nullif(btrim(p_model),''),secret_id,p_monthly_request_limit,p_monthly_token_limit,p_updated_by,now(),true)
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
  delete from public.ai_provider_credentials where scope_type='department' and scope_id=p_scope_id and provider=p_provider returning vault_secret_id into secret_id;
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

-- Remove the old resolver signature (which preferred personal credentials)
-- and install the department-only resolver.
drop function if exists public.ai_provider_resolve_key(uuid, uuid, text);

create or replace function public.ai_provider_resolve_key(p_class_record_id uuid, p_provider text)
returns table(api_key text, provider text, model text, scope_type text, scope_id uuid, monthly_request_limit integer, monthly_token_limit bigint)
language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret,c.provider,c.model,c.scope_type,c.scope_id,c.monthly_request_limit,c.monthly_token_limit
  from public.class_records cr
  join public.ai_provider_credentials c
    on c.scope_type = 'department'
    and c.scope_id = cr.department_id
    and c.provider = p_provider
    and c.enabled
  join vault.decrypted_secrets ds on ds.id = c.vault_secret_id
  where cr.id = p_class_record_id
  limit 1
$$;

revoke all on function public.ai_provider_resolve_key(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_provider_resolve_key(uuid, text) to service_role;

-- Prediction history is class-readable. Remove any previously persisted
-- prompt context so those rows retain provenance but cannot expose inputs.
update public.prediction_runs
set input_snapshot = input_snapshot - array['inputs','grading_system','evaluation_criteria']
where input_snapshot ?| array['inputs','grading_system','evaluation_criteria'];

commit;
