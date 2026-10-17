# Cloudflare Containers gateway

This Worker exposes only the authenticated model prediction and status routes. Its Cloudflare service key must match the model container's `APMS_AI_SERVICE_API_KEY`; set it as a Worker secret, never in `wrangler.jsonc` or client configuration.

## Install and validate

From the repository root, install this deploy package's pinned Wrangler and container dependencies:

```cmd
npm --prefix services\ai\deploy\cloudflare ci
```

Type-check the Worker and validate its generated environment types:

```cmd
cd services\ai\deploy\cloudflare
npm run check
npm exec -- wrangler types worker-configuration.d.ts --check --include-runtime false
```

The test suite is discoverable from the repository root and uses the root Vitest installation:

```cmd
cd C:\apms\APMS
npm run test:ai-cloudflare
```

To regenerate `worker-configuration.d.ts` after changing Wrangler bindings, run `npm exec -- wrangler types worker-configuration.d.ts --include-runtime false` from this directory, then review the generated diff.

## Build and deploy from a Docker-capable host

Deployment has not been run from this workspace. The model image must be built for `linux/amd64` from the sanitized output produced by `services/ai/deploy/package_model.py`. The packed model directory is the Docker build context and contains `metadata.json`, `weights.pt`, and `schemas/`. Use a published or locally available CPU runtime image for the Dockerfile's `RUNTIME_IMAGE` argument:

```cmd
docker build --platform linux/amd64 --build-arg RUNTIME_IMAGE=apms-ai:cpu -f services/ai/deploy/Dockerfile.model -t apms-forecast:20261017 services/ai/artifacts/release-20261017
```

Push that local image to Cloudflare's managed registry and record the registry URI printed by Wrangler:

```cmd
cd services\ai\deploy\cloudflare
npm exec -- wrangler containers push apms-forecast:20261017
```

Replace the placeholder image in `wrangler.jsonc` with `registry.cloudflare.com/<ACCOUNT_ID>/apms-forecast:<TAG>`. Set the service key, then deploy:

```cmd
npm exec -- wrangler secret put APMS_AI_SERVICE_API_KEY
npm run deploy
```

Wrangler requires Docker to build images or deploy a local Dockerfile; this flow pushes the prebuilt image. Keep the key identical to the service key configured for the model container. The gateway fixes the container name, disables container internet access for baked models, allows only the two documented paths, and returns non-cacheable responses. Cloudflare's [Containers getting-started guide](https://developers.cloudflare.com/containers/get-started/) and [image management guide](https://developers.cloudflare.com/containers/guides/image-management/) describe current image and deployment behavior.

For a model stored in a private Supabase bucket, use the generic CPU runtime image and follow [artifact storage](../../../../docs/AI_MODEL_ARTIFACT_STORAGE.md). Set the artifact endpoint and pinned manifest in Worker variables, and `APMS_AI_ARTIFACT_TOKEN` as a separate Worker secret. The class enables container internet access only when remote mode is configured and passes these server-only values to Python at startup. Its temporary cache can be lost across container replacement; measure cold starts and egress for the chosen sleep policy. Regenerate binding types with `--include-runtime false` after changing Wrangler variables.
