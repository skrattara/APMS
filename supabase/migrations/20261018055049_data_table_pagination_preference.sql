alter table public.profiles
  add column if not exists table_pagination_enabled boolean not null default true;
