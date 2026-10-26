# Google Classroom grade sync

This integration links one APMS class to one Google Classroom course and links
an APMS assessment instance to a published Classroom coursework item. It reads
Classroom rosters and assigned grades only; it never changes Classroom courses,
coursework, or grades. Student identities are matched by normalized email.

## Configure Google and Supabase

1. Enable the Google Classroom API in the Google Cloud project.
2. Configure the Google OAuth consent screen and create a web OAuth client.
3. Add this exact authorized redirect URI to the OAuth client:
   `https://<project-ref>.supabase.co/functions/v1/google-classroom`
4. Set these required Edge Function secrets:
   - `GOOGLE_CLASSROOM_CLIENT_ID`
   - `GOOGLE_CLASSROOM_CLIENT_SECRET`
   - `GOOGLE_CLASSROOM_REDIRECT_URI`
   - `GOOGLE_CLASSROOM_TOKEN_ENCRYPTION_KEY` (at least 32 characters; use a
     randomly generated secret and retain it securely)
5. Set `APMS_ALLOWED_APP_ORIGINS` to a comma-separated list of exact origins
   allowed to start Google OAuth, for example
   `http://localhost:8081,https://apms.example.edu`. Use your actual production
   origin. The callback returns only to the origin saved when OAuth starts;
   unlisted origins are rejected.
6. Deploy the `google-classroom` Edge Function and apply the migration that
   creates its protected tables and scheduled reconciliation job.

The scheduled reconciliation job uses `apms_project_url` and
`apms_service_role_key` from Supabase Vault. It sends the service key only in
the `apikey` header; do not send it as a bearer token. The backup and Google
Classroom cron jobs share these Vault values.

Google may require OAuth app verification before users outside the configured
test-user list can grant the Classroom scopes.

## Faster updates with Pub/Sub (optional)

Without Pub/Sub, the scheduled reconciliation checks active links every 15
minutes. To receive changes sooner:

1. Create a Google Cloud Pub/Sub topic and set
   `GOOGLE_CLASSROOM_PUBSUB_TOPIC=projects/<project>/topics/<topic>`.
2. Grant `classroom-notifications@system.gserviceaccount.com` permission to
   publish to that topic.
3. Create a push subscription targeting
   `https://<project-ref>.supabase.co/functions/v1/google-classroom`.
4. Enable OIDC authentication for the push subscription. Set its audience to
   the value in `GOOGLE_CLASSROOM_PUBSUB_AUDIENCE`, and set
   `GOOGLE_CLASSROOM_PUBSUB_SERVICE_ACCOUNT` to the exact push service-account
   email.

Classroom registrations expire after one week. The scheduled reconciliation
renews them when they are close to expiry, and also catches missed push events.
The sync processes submissions in pages, caps Google requests per run, and
retries transient and rate-limit responses with backoff. If a large course
needs more than one run, the next reconciliation continues from its saved page
token.

## Grade mapping

For a Google score `x`, configured source range `[s0, s1]`, and APMS target
range `[t0, t1]`, APMS stores:

`t0 + clamp((x - s0) / (s1 - s0), 0, 1) * (t1 - t0)`

Only returned `assignedGrade` values are used. Draft grades are ignored. APMS
grade-encoding deadlines and database validation still apply; blocked rows are
reported in the sync status and can be retried after correction.

## Account deletion, reset, and restore

Deleting a faculty profile removes the stored Google credentials and cascades
through that account's class and assessment links. It does not delete or change
anything in Google Classroom. Unlinking a class also attempts to remove its
Google push registration; registrations left behind by account deletion expire
at Google and are ignored by APMS once the APMS link is gone.

Resetting application data clears Google credentials and mappings. APMS JSON
backups intentionally omit OAuth credentials and Classroom mappings. A restore
can restore the APMS grade rows, but it does not resume external sync. Faculty
must reconnect their Google account and recreate class and assessment links
after checking the restored roster and assessment IDs.
