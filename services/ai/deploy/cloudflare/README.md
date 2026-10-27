# Cloudflare Containers gateway

For a second deployment of the already packaged assessment-context model, follow [parallel experimental deployment](../../../../docs/AI_EXPERIMENTAL_PARALLEL_DEPLOYMENT.md). Use `wrangler.experimental.example.jsonc` as the separate template, copy it to ignored `wrangler.experimental.local.jsonc`, and always select that file explicitly for its secret/deploy commands. The existing default config continues targeting the original Worker.

This Worker exposes only the authenticated model prediction and status routes. Its Cloudflare service key must match the model container's `APMS_AI_SERVICE_API_KEY`; set it as a Worker secret, never in `wrangler.jsonc` or client configuration.

Follow [service key management](../../../../docs/AI_SERVICE_KEY_MANAGEMENT.md#native-cloudflare-containers) for provisioning and rotation. A running Python process retains its startup key; a Worker secret update alone is not proof that the process has reloaded it. The guide also covers the separate Tunnel/Access deployment and optional artifact token.

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

`npm run check` checks the deployed Worker source and generated bindings only; it excludes `src/**/*.test.ts` and `src/**/*.spec.ts`. The isolated deployment package intentionally has no Vitest dependency, so building/deploying from another computer does not require installing the full app's root dependencies. If an older copy reports `Cannot find module 'vitest'` from `src/index.test.ts`, update `tsconfig.json` to include the checked-in `exclude` patterns and rerun the check. Do not install an unpinned test runner just to deploy.

The test suite is discoverable from the repository root and uses the root Vitest installation:

```cmd
cd C:\apms\APMS
npm run test:ai-cloudflare
```

For that separate test workflow, install the repository-root dependencies with `npm ci` as well as this deployment package's dependencies. The tests remain in source and run through the root script even though they are excluded from the deployment type check.

To regenerate `worker-configuration.d.ts` after changing Wrangler bindings, run `npm exec -- wrangler types worker-configuration.d.ts --include-runtime false` from this directory, then review the generated diff.

## Build and deploy from a Docker-capable host

Deployment has not been run from this workspace. The model image must be built for `linux/amd64` from the sanitized output produced by `services/ai/deploy/package_model.py`. The packed model directory is the Docker build context and contains `metadata.json`, `weights.pt`, and `schemas/`. Use a published or locally available CPU runtime image for the Dockerfile's `RUNTIME_IMAGE` argument:

```cmd
docker build --platform linux/amd64 --build-arg RUNTIME_IMAGE=apms-ai:cpu -f services/ai/deploy/Dockerfile.model -t apms-ai-model:20261017 services/ai/artifacts/release-20261017
```

Push that local image to Cloudflare's managed registry and record the registry URI printed by Wrangler:

```cmd
cd services\ai\deploy\cloudflare
npm exec -- wrangler containers push apms-ai-model:20261017
```

Replace the placeholder image in `wrangler.jsonc` with the URI returned by the push, such as `registry.cloudflare.com/<ACCOUNT_ID>/apms-ai-model:20261017`. Set the service key, then deploy:

```cmd
npm exec -- wrangler secret put APMS_AI_SERVICE_API_KEY
npm run deploy
```

Copy the **complete image URI printed by a successful push**, including the actual account ID and exact tag, into `containers[0].image`. Do not deploy the checked-in `REPLACE_WITH_ACCOUNT_ID` template or construct another account/repository prefix around that URI. The model image must already exist in the selected account's registry; a successful Worker/secret upload does not upload a local Docker image automatically when the configuration references a prebuilt image. Use `wrangler containers images list` to inspect the registry inventory. See Cloudflare's [prebuilt image push flow](https://developers.cloudflare.com/containers/guides/image-management/#push-images-to-the-cloudflare-registry).

The build tag and push argument must match exactly: `apms-ai-model:20261017` in both commands above. `apms-forecast:2026-10-17` is a different local image reference. If Docker reports `No such image`, inspect only the expected image with `docker image inspect apms-ai-model:20261017 --format "{{.Id}}"` and push that exact name/tag; do not rebuild a successful image solely to change this example name.

If deployment reports `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`, check the account, repository and tag against the push output, push the intended image if missing, update `image`, and redeploy. The Worker may have uploaded before container application creation failed; keep the existing Worker and its secret and retry the deployment after fixing the image. Do not delete the Durable Object namespace to retry.

The checked-in Wrangler configuration explicitly selects `./tsconfig.json` so bundling does not discover the repository-root Expo configuration on a deployment-only machine. If an older copy warns that `expo/tsconfig.base` is missing, add the top-level field `"tsconfig": "./tsconfig.json"` or deploy once with `wrangler deploy --tsconfig ./tsconfig.json`. This warning is separate from an image-registry error; installing Expo is unnecessary for this isolated package.

Wrangler requires Docker to build images or deploy a local Dockerfile; this flow pushes the prebuilt image. Keep the key identical to the service key configured for the model container. The gateway fixes the container name, disables container internet access for baked models, allows only the two documented paths, and returns non-cacheable responses. Cloudflare's [Containers getting-started guide](https://developers.cloudflare.com/containers/get-started/) and [image management guide](https://developers.cloudflare.com/containers/guides/image-management/) describe current image and deployment behavior.

For a model stored in a private Supabase bucket, use the generic CPU runtime image and follow [artifact storage](../../../../docs/AI_MODEL_ARTIFACT_STORAGE.md). Set the artifact endpoint and pinned manifest in Worker variables, and `APMS_AI_ARTIFACT_TOKEN` as a separate Worker secret. The class enables container internet access only when remote mode is configured and passes these server-only values to Python at startup. Its temporary cache can be lost across container replacement; measure cold starts and egress for the chosen sleep policy. Regenerate binding types with `--include-runtime false` after changing Wrangler variables.
