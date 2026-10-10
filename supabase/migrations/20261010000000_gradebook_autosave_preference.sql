alter table public.profiles
  add column if not exists gradebook_autosave boolean not null default true;
