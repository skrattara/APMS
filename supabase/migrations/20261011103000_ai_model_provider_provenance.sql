alter table public.model_versions
  add column if not exists provider text not null default 'unknown';

alter table public.model_versions
  drop constraint if exists model_versions_provider_nonempty;
alter table public.model_versions
  add constraint model_versions_provider_nonempty check (length(btrim(provider)) > 0);
