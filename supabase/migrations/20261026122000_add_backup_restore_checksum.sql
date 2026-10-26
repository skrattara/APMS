alter table public.backup_restores
  add column if not exists checksum text;
