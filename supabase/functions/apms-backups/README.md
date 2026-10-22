# APMS JSON backups

`BACKUP_SCHEDULER_TOKEN` and `BACKUP_ENCRYPTION_KEY` are optional. When the scheduler token is unset, the scheduled runner authenticates with the existing service-role key. When the encryption key is unset, scheduled backups are stored as JSON in the private backup bucket without encryption; configure the key to encrypt scheduled backups. Manual backups remain password-protected. Do not commit real secret values to this repository.

Set the Edge Function secrets after deploying the function. In the SQL Editor, store the scheduler connection values in Supabase Vault under these exact names:

- `apms_project_url` — `https://<project-ref>.supabase.co`
- `apms_publishable_key` — the project's publishable key
- `apms_service_role_key` — the project's service-role key, stored only in Vault for the cron request

The migration installs a 15-minute `pg_cron` dispatcher. It checks for due schedules and does nothing until all three Vault values are present. The System Admin can restore a stored scheduled backup with its **Restore** action. Scheduled backups are encrypted server-side when `BACKUP_ENCRYPTION_KEY` is set. Manual backups use the password supplied by the System Admin and are restored by selecting the JSON file and entering that password.

The encrypted JSON format excludes Supabase Auth credentials and the `ai_provider_credentials` table. Authentication identities must already exist when their APMS profile data is restored. Restore updates rows that share primary keys with the backup and leaves rows created after that backup in place. It is an application-data restore, not a full PostgreSQL point-in-time restore.

Restore uploads use Supabase Storage's TUS resumable protocol. The Edge Function currently caps generated plaintext snapshots at 40 MiB and stored restore files at 110 MiB because it decrypts and validates JSON within the Edge Function memory budget. Set the project's Storage global file limit high enough for the desired upload size; the hosted project limit is controlled in Supabase Storage settings and also depends on its plan.
