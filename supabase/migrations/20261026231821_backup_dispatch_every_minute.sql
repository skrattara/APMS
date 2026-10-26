-- Poll every minute so backups run near the time selected in APMS instead of
-- waiting for the next 15-minute dispatcher interval.
do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job where jobname = 'apms-scheduled-backup-dispatch'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end
$$;

select cron.schedule(
  'apms-scheduled-backup-dispatch',
  '* * * * *',
  $$
    select net.http_post(
      url := cfg.project_url || '/functions/v1/apms-backups',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', cfg.service_role_key
      ),
      body := '{"action":"scheduled"}'::jsonb
    )
    from (
      select
        max(decrypted_secret) filter (where name = 'apms_project_url') as project_url,
        max(decrypted_secret) filter (where name = 'apms_service_role_key') as service_role_key
      from vault.decrypted_secrets
      where name in ('apms_project_url', 'apms_service_role_key')
    ) cfg
    where cfg.project_url is not null and cfg.service_role_key is not null;
  $$
);
