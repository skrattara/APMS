# Update the runtime for categorical assessment forecasts

The 2026-10-18 fix addresses a reproduced HTTP 422: the gateway replaces categorical labels with request-local opaque values, but the older inference binder compared those values with category names stored in the training artifact. The new binder derives legal query choices from the supplied, validated schema, creates a request-local typed domain, and decodes model ordinals back into that query's own choices. Saved metadata, weights and schema files remain unchanged. Invalid choices and output-head capacity limits still fail validation.

This is a Python runtime change. Updating only Supabase or restarting an old container does not install it. No retraining is required. The gateway also now marks partial inventories when they are supplied as evidence without assessment-score outputs.

## Files to transfer

An update archive is generated at `tmp/apms-ai-runtime-categories-20261018.zip`. Extract it into the existing `D:\apms-docker\APMS` directory, preserving its relative paths. It contains only:

- `.dockerignore`
- `services/ai/Dockerfile`
- `services/ai/pyproject.toml`
- the full `services/ai/src/` runtime source, including packaged schema definitions
- `services/ai/deploy/Dockerfile.model`
- this instruction document

It excludes model weights, student data, training runs, caches, dependencies, environment files, keys and Cloudflare settings. Retain the Docker computer's existing `services/ai/artifacts/release-20261017/` bundle and `services/ai/deploy/cloudflare/wrangler.jsonc`. The unchanged model bundle must contain `metadata.json`, `weights.pt`, and its `schemas/` folder. Preserve existing credentials and synthetic-demo settings.

Alternatively, copy those listed source files/folders manually. The substantive Python fix is in `services/ai/src/apms_ai/inference.py`; the complete source archive also carries the preceding runtime fixes.

## Build and deploy on the Docker computer

Start Docker Desktop and use **Command Prompt**:

```bat
cd /d D:\apms-docker\APMS
docker build --platform linux/amd64 -f services/ai/Dockerfile -t apms-ai:cpu-20261018-categories .
docker build --platform linux/amd64 -f services/ai/deploy/Dockerfile.model --build-arg RUNTIME_IMAGE=apms-ai:cpu-20261018-categories -t apms-ai-model:20261018-categories services/ai/artifacts/release-20261017
cd services\ai\deploy\cloudflare
node_modules\.bin\wrangler.cmd containers push apms-ai-model:20261018-categories
```

Both builds are required: the first installs the new runtime code, and the second adds the existing model bundle. If Wrangler requests authentication, use `node_modules\.bin\wrangler.cmd login` and repeat the push.

Open the existing configuration:

```bat
notepad wrangler.jsonc
```

Set `containers[0].image` to the **exact fully qualified image reference printed by the successful push**, ending in `apms-ai-model:20261018-categories`. Do not add an extra account prefix or restore placeholder values. Keep the Worker name, bindings, secrets and artifact settings. Then deploy:

```bat
node_modules\.bin\wrangler.cmd deploy
```

For ECS or Docker behind a Cloudflare Tunnel, rebuild the runtime/model in the same way and roll out the new image using the existing deployment workflow. The archive does not change infrastructure or credentials.

## Verify

Reload the local app so its current batch cap and gateway error messages are active. Use the System Admin connection probe, then check saved forecasts before requesting another class forecast. In Gradebook Full View, enable **AI score preview** after a successful run. Verify categorical previews belong to the applied mapping and recorded scores remain untouched.

The model version and artifact hash may stay the same because the weights did not change. Confirm the new container image tag/reference in the deployment; the model version alone cannot distinguish the old and fixed runtime. The `partial_assessment_inventory` capability also predates this category fix and cannot prove it was installed.

Local verification reproduced the failure using current policy/assessment metadata with synthetic student evidence. After the fix, the existing release returned authenticated HTTP 200 for 80 assessment forecasts, and all outputs passed the gateway's category restoration and schema validation with mocked persistence. This does not confirm deployment on the other computer or a live student forecast.

The update ZIP is disposable after extraction. Preserve the source files, active/rollback release bundles, deployment settings and credentials under the [file retention guide](AI_MODEL_FILES_AND_CLEANUP.md).
