alter table public.backup_restores
  add column if not exists backup_created_at timestamptz;
