# Run the experimental context model alongside the existing service

The context-v1 bundle below is already trained, calibrated, evaluated and packaged. Further training is not a prerequisite for building its Docker image. It is an experimental synthetic model: interval coverage missed its nominal target and some risk metrics worsened. Real institutional accuracy remains unmeasured. Docker/runtime compatibility and authenticated inference must still be checked on the deployment target.

## The exact model to use

Use the entire verified inference directory:

`services/ai/artifacts/assessment-context-20261020/horizon-v2/runtime-review-2/release`

It contains `weights.pt`, `metadata.json`, `manifest.json`, and the `schemas` directory. Its assessment context version is 1 and its artifact ID is `fa57985ddd9714a4ba349afd3ca598a04f560877528c6beb92a646bfcd68fe3c`. The manifest pin is `b8ff1675c960621f2c711ee426b941425c8c62495d2363c7e488e6d87b216ec0`.

Your separate `my-assessment-comparison` selected `context_control` under its stricter six guards. That selected package is context version zero. These instructions explicitly deploy the earlier experimental context-v1 package; they do not change either experiment's selection rules or results.

## Separate Cloudflare Worker and container

Cloudflare supports a separate Worker or environment with its own container deployment ([deployment guidance](https://developers.cloudflare.com/containers/guides/deploy/)). This recipe creates `apms-ai-context-v1-experimental`, with its own URL, secret and Durable Object/container binding. It does not deploy the existing `apms-ai-container-gateway` Worker. The existing source class and binding names can be reused within the separate Worker; do not add a `script_name` binding that points back to the old Worker.

First copy the updated AI service source and this entire release directory to the Docker computer's existing checkout. Also copy `services/ai/deploy/cloudflare/wrangler.experimental.example.jsonc`. Keep the Docker computer's existing secret files and account-specific `wrangler.jsonc`.

Run from Windows Command Prompt on the Docker computer:

```bat
cd /d D:\apms-docker\APMS
docker build --platform linux/amd64 -f services/ai/Dockerfile -t apms-ai:cpu-context-v1-experimental-20261027 .
docker build --platform linux/amd64 -f services/ai/deploy/Dockerfile.model --build-arg RUNTIME_IMAGE=apms-ai:cpu-context-v1-experimental-20261027 -t apms-ai-model:context-v1-experimental-20261027 services/ai/artifacts/assessment-context-20261020/horizon-v2/runtime-review-2/release

cd services\ai\deploy\cloudflare
npm ci
npm run check
node_modules\.bin\wrangler.cmd containers push apms-ai-model:context-v1-experimental-20261027
copy /-Y wrangler.experimental.example.jsonc wrangler.experimental.local.jsonc
```

Copy the **complete image URI printed by the successful push** into `containers[0].image` in `wrangler.experimental.local.jsonc`. Replace the whole image value; do not retain `REPLACE_WITH_ACCOUNT_ID` or add another account prefix. This follows [Cloudflare's image publishing flow](https://developers.cloudflare.com/containers/guides/image-management/).

The separate template already sets a different Worker name, enables its `workers.dev` URL, opts into synthetic demonstration mode and loads the model baked into `/models/active`. It has no copied production routes/custom domains. Its artifact endpoint is empty, so the new image cannot accidentally download an old remotely configured artifact instead. Keep credentials out of this JSON file.

Configure the new Worker's bearer secret interactively, then deploy **using this same explicit config on both commands**:

```bat
node_modules\.bin\wrangler.cmd secret put APMS_AI_SERVICE_API_KEY --config wrangler.experimental.local.jsonc
node_modules\.bin\wrangler.cmd deploy --config wrangler.experimental.local.jsonc
```

If Wrangler offers to create `apms-ai-context-v1-experimental` while adding its first secret, that is the intended new Worker. Use a separate server-only token and record its association with the new URL securely. [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) are configured for the targeted Worker. The secret value is not written into the example configuration. Never run these commands with the old config accidentally selected.

Record the new Worker URL returned by deployment. Allow initial container provisioning to finish. Check authenticated `GET /v1/status` and a small authorized forecast on the actual deployment target. The status should report `ready: true`, artifact ID beginning `fa57985ddd97`, `synthetic_demo: true`, and `assessment_instance_conditioning: true`. Browser visits to `/health` and `/ready` return 404 through this Worker by design; it exposes only the authenticated status and prediction routes.

If configured using the app's System Admin connection check, verify the intended artifact and capability before refreshing forecasts. Keep existing saved forecasts for comparison and review advisory outputs separately from recorded grades.

## How the app chooses an endpoint

The current gateway has one global `APMS_AI_SERVICE_URL` / `APMS_AI_SERVICE_API_KEY` pair. Both Workers can coexist, while the app uses the configured endpoint. To test the new deployment independently, leave the existing app configuration unchanged and use the new endpoint with its matching server credential.

When intentionally switching app traffic, update that URL/key pair in Supabase Edge Function secrets. The URL is the Worker's base URL, without `/v1/predictions`. Update or clear old `APMS_AI_SERVICE_MODEL` / `APMS_AI_SERVICE_MODEL_VERSION` pins if configured, and match Cloudflare Access credentials if that protection is enabled. Keep the old pair securely for switching back. Merely changing an AI model name in applied criteria does not select a different container or loaded bundle.

Supabase documents that [production secret changes are read without a function redeploy](https://supabase.com/docs/guides/functions/secrets). An environment-secret update selects the app's custom service globally; it is not per-class A/B routing. Simultaneous old/new choices inside the app require an endpoint registry and authorized routing support, which this deployment-only recipe does not add. Do not randomly balance a class batch between model versions: existing provenance checks require predictions to match the probed artifact.

No production endpoint or cloud resource was changed while preparing these instructions.
