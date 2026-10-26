alter table public.backup_schedules
  add column if not exists run_time_utc time without time zone not null default '02:00';
