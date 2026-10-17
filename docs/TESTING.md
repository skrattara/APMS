# Testing

```powershell
npm run typecheck
npm test
npm run test:schema
npm run test:e2e
npm run build
```

Vitest covers generic weights, missing-versus-zero scores, score validation, SWUNEXT rubric transmutation, P1/P2/P3 running views, final-grade conversion, the dual 80% passing rule, attendance, trends, CSV parsing/duplicates/errors, reports, three-role permissions, and scopes. The schema contract verifies attendance/import additions and the safe legacy-role migration. Playwright covers invalid login, unauthenticated routes, all three role redirects, cross-role denial, and Faculty workflows. The isolated AI package has its own pytest suite and synthetic lifecycle checks; see [the service guide](../services/ai/README.md). Model quality must be measured separately from software correctness, using independent real validation, calibration, and test cohorts.

Connected-project smoke tests should use the public/publishable key and a role-specific session. Verify that Academic Admin receives only its department-scoped classes and that System Admin can call `admin-users` with `action: list`. Never place a service-role credential in Expo environment files or browser tests. Account creation tests must use a disposable environment with a documented cleanup path.

Database reset/lint requires Docker Desktop. When Docker is unavailable, run the static schema contract and verify the connected schema through authorized read-only inspection; deployment remains a separate recorded step.

## Forecasting deployment checks

`npm test` includes the shared custom-service connector's HTTPS/redirect, credential-header, response-size/type, timeout, status allowlist, unauthorized-status and usage-reservation tests. The Python suite (`.venv\Scripts\python.exe -m pytest services\ai -q`) also covers startup-loaded secret files, authenticated status and inference-only packaging. In `services/ai/deploy/cloudflare`, `npm ci` then `npm run check` checks the isolated gateway; run its mocked gateway tests from the repository root with `npm run test:ai-cloudflare`. Generated binding types can be checked with the pinned Wrangler using `wrangler types worker-configuration.d.ts --check --include-runtime false`.

Local static checks and mocked tests do not replace a Docker build, target-runtime prediction parity, full Supabase auth/RLS testing, TLS/DNS checks, or a cloud canary. The actual quota SQL was also exercised in an isolated local PostgreSQL-compatible PGlite harness; hosted roles, migration history and concurrent multi-session reservations still need staging verification. The deployment runbook describes these target checks and their expected failure behavior: [Docker/Supabase/AWS/Cloudflare deployment](AI_MODEL_CLOUD_DEPLOYMENT.md).

`supabase/tests/ai_custom_usage.sql` retains rollback-only pgTAP coverage for direct execution privileges, unlimited/disabled/capped quotas and UTC month accounting. On the Docker computer, apply migrations to local Supabase and run `node_modules\.bin\supabase.cmd test db`. This pgTAP runner was not available on the development PC. Shared/status/prediction Edge sources passed a local TypeScript check using Deno/npm declarations; a native Deno or Supabase runtime check is still required before deployment.

Artifact-storage checks include machine-token rejection before Storage access, private-bucket/manifest validation, signing only approved files, bounded Storage streaming and redirects/timeouts. Python checks cover pinned downloads, per-file hashes/sizes, corrupted caches, verified offline reuse and fail-closed readiness. `supabase/tests/ai_model_artifact_storage.sql` retains rollback-only tests showing broad permissive policies cannot expose artifact objects/bucket metadata or make the bucket public, while unrelated buckets remain unaffected; the migration was also exercised in local PGlite. App/domain tests cover zero-valued forecasts, unscored overlays, large-class batch planning and confidence-gate semantics. See [artifact deployment and target checks](AI_MODEL_ARTIFACT_STORAGE.md).
