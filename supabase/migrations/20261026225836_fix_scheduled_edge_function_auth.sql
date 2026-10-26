-- Remove the previous dispatchers, which paired an sb_publishable key in
-- `apikey` with an sb_secret key in `Authorization`. Supabase rejects that
-- combination as conflicting API keys. Edge Functions use verify_jwt=false,
-- and validate the service key from `apikey` in their own handlers.
do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in ('apms-scheduled-backup-dispatch', 'apms-google-classroom-grade-sync')
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end
$$;

select cron.schedule(
  'apms-scheduled-backup-dispatch',
  '*/15 * * * *',
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

select cron.schedule(
  'apms-google-classroom-grade-sync',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := cfg.project_url || '/functions/v1/google-classroom',
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
