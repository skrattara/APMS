# Store model artifacts in Supabase

Yes: a private Supabase Storage bucket can hold model releases and their supporting artifacts. The inference service still needs compute and enough memory for the loaded model. It downloads a pinned release at startup, verifies it, then serves predictions from memory. No Storage request is made for each prediction.

The implemented deployment supports either a local/read-only or image-baked bundle, or a Supabase-backed bundle with a local cache. Existing local deployment remains available. Storage changes how a release arrives; the model architecture and the artifact's predictions do not change.

## When it is efficient

| Approach | Advantages | Tradeoffs |
| --- | --- | --- |
| Model in the container image | One release image; startup uses the pulled image's layers; no separate artifact credential | Model updates require another image release; image layers still need transfer/storage |
| Private Supabase Storage + verified cache | Update model independently of runtime image; central release/rollback archive; cache can avoid repeat downloads | Cold cache needs network transfer, checksumming and model loading; introduces a startup dependency and Storage egress |
| Storage fetch for each prediction | None for this model's serving design | Repeated transfer and loading would unnecessarily increase latency, bandwidth and failure opportunities; not implemented |

For a long-running ECS service or your Docker computer, Storage with a cache is a practical choice. For frequently sleeping/replaced Cloudflare instances, keep Storage as the release archive and compare cold-start measurements with a baked model before deciding. An ephemeral cache is lost when its container/task is replaced; it is not a shared global cache. The Compose variant supplies a named volume, while the provided ECS/Cloudflare configurations use task/container-local temporary storage. This recommendation follows from the deployment lifecycle; no live Storage latency benchmark has been run here.

Measure using the actual release size, restart frequency and network path between compute and the existing Supabase project's region. Include any AWS NAT/network charges in the operational comparison. A smaller runtime image does not by itself prove a cheaper or faster deployment.

Estimate artifact egress as `release size × cold-cache downloads`. For example, a hypothetical 100 MB release downloaded 100 times transfers about 10 GB, in addition to normal app traffic. A verified cache hit rehashes local files and can start without contacting Storage. Warm prediction speed depends on the same loaded model/CPU/GPU, not on which artifact store supplied its bytes. See [Supabase Storage egress](https://supabase.com/docs/guides/storage/serving/bandwidth) for bandwidth accounting and current plan limits.

Use immutable versioned paths rather than overwriting `latest`. Private bucket downloads require authorization or signed URLs. The broker mints bounded signed URLs for one approved release. Generating new signed URLs on each cold start does not guarantee a shared CDN cache hit: tokens affect cache identity. Keep URLs out of logs, screenshots and client code, and do not rely on token expiry alone to revoke an already cached artifact. See [private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals) and [Smart CDN signed-URL behavior](https://supabase.com/docs/guides/storage/cdn/smart-cdn).

## What is implemented

```mermaid
sequenceDiagram
    participant Worker as Inference worker startup
    participant Cache as Local verified cache
    participant Broker as Supabase ai-model-artifact
    participant Storage as Private Storage bucket
    Worker->>Cache: Check pinned manifest and every file hash
    alt Valid pinned cache exists
        Cache-->>Worker: Local bundle
    else Cache missing or invalid
        Worker->>Broker: Machine bearer token, GET
        Broker->>Storage: Check private bucket; read pinned manifest
        Broker->>Storage: Sign only four approved inference files
        Broker-->>Worker: Exact manifest text and signed URLs
        Worker->>Storage: Stream files; bound sizes and verify hashes
        Worker->>Cache: Publish complete verified bundle atomically
    end
    Worker->>Worker: Verify bundle/schema hashes and load model once
```

The worker holds a dedicated artifact-fetch token, not a Supabase service-role key. The broker holds Supabase's server credential, verifies the machine token before accessing Storage, and can sign only the four files listed in the pinned manifest. It accepts no caller-selected bucket, release path or object URL. App sessions and faculty permissions do not grant access to model weights.

`20261017095444_ai_model_artifact_storage.sql` creates the private `apms-ai-artifacts` bucket and denies browser roles access even if another permissive object policy exists. If that named bucket already exists as public, the migration stops for operator review. Do not make it public. Only approved deployment operators upload releases. Any custom bucket requires equivalent private access controls; the supplied policy protects the named default bucket.

The new machine endpoint is the sole added function configured with `verify_jwt=false`, because its bearer token is a machine secret rather than a Supabase user JWT. It performs its own authentication on every request. The user-facing prediction/status functions retain JWT verification and their existing authorization checks.

## 1. Package a release and pin it

Commands use Windows `cmd.exe` from the repository root. Install the existing AI environment as documented in [the lifecycle guide](AI_MODEL_USAGE_DEPLOYMENT.md). Choose a new output name:

```bat
.venv\Scripts\python.exe services\ai\deploy\package_model.py --bundle services\ai\artifacts\candidate-calibrated --output services\ai\artifacts\release-storage-20261017 --manifest
```

Packaging excludes optimizer/RNG state and training-only fingerprints. It writes `manifest.json` and prints `manifest_sha256`. Keep that exact 64-character digest in the release record. The manifest describes exactly these files:

```text
weights.pt
metadata.json
schemas/grading_system_schema.json
schemas/evaluation_system_schema.json
```

Do not edit any of those files or the manifest after recording its pin. The loader verifies the manifest hash, all file sizes/hashes, the existing bundle's weights hash and its schema-contract hashes before readiness. It does not extract arbitrary archives or accept extra relative paths. Files are limited to 512 MiB each and 1 GiB total; the manifest itself is bounded. Account-level Storage limits can be lower and must also permit the upload.

The packaged model still contains learned parameters, vocabulary/preprocessing and necessary calibration metadata. Treat it as a protected institutional artifact. Keep the original training bundle and evaluation/calibration evidence separately; an inference package is insufficient for exact training resume.

## 2. Create the private bucket and upload

Use the existing APMS Supabase project. Review and apply the new migration through the existing deployment process. The instructions in [the cloud guide](AI_MODEL_CLOUD_DEPLOYMENT.md) cover `migration list`, `db push --dry-run` and the `--include-all` case if later timestamps are already deployed. No hosted migration or upload was performed during implementation.

Upload the package into a new release prefix, preserving directory structure, using Supabase Studio or the authenticated CLI. The installed CLI's `storage cp --help` supports this syntax:

```bat
node_modules\.bin\supabase.cmd storage cp --linked --recursive services\ai\artifacts\release-storage-20261017 ss:///apms-ai-artifacts/releases/20261017
node_modules\.bin\supabase.cmd storage ls --linked ss:///apms-ai-artifacts/releases/20261017
```

Confirm all five objects are present at that exact prefix, including the two files under `schemas/`. Do not upload an entire artifacts directory into a serving prefix, overwrite an active release, or embed upload credentials in a model/image. For large files or unreliable links, use the supported resumable/TUS upload path; Supabase recommends resumable uploads for files exceeding 6 MB. See [resumable upload instructions](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).

The bucket can also archive exports, calibration reports, training checkpoints and other controlled artifacts under separate prefixes such as `archives/RUN_ID/`. The inference broker will never sign those archive paths. Large checkpoints may exceed the serving bucket's 512 MiB object cap; use a separately configured private archive bucket and the institution's retention/access controls. Keep real datasets and learner-level reports under their own approved controls rather than treating them as public model assets. Storing a checkpoint in a bucket does not automatically enable resume or online learning; download its complete original bundle into the approved training environment.

## 3. Configure the artifact broker

Create a strong, independent random machine token of at least 32 characters (maximum 512), stored through your secret manager. It is separate from `APMS_AI_SERVICE_API_KEY`, which authenticates predictions. In an ignored private Edge Function secret file, set:

```dotenv
APMS_AI_ARTIFACT_BUCKET=apms-ai-artifacts
APMS_AI_ARTIFACT_PREFIX=releases/20261017
APMS_AI_ARTIFACT_MANIFEST_SHA256=REPLACE_WITH_EXACT_MANIFEST_DIGEST
APMS_AI_ARTIFACT_TOKEN=REPLACE_WITH_ARTIFACT_MACHINE_TOKEN
```

Keep unrelated provider placeholders out of that file so deploying it cannot replace working credentials. Supabase provides its own server connection secrets to the function. Deploy the secrets and function:

```bat
node_modules\.bin\supabase.cmd secrets set --env-file supabase\functions\.env.ai-artifacts --project-ref YOUR_EXISTING_PROJECT_REF
node_modules\.bin\supabase.cmd functions deploy ai-model-artifact --project-ref YOUR_EXISTING_PROJECT_REF --use-api
```

`--use-api` avoids a local Docker requirement. Unauthorized requests must return 401 without making Storage calls. An invalid pin, a public bucket, a bad manifest or a signing failure makes the broker unavailable without returning credentials or object details in its error. Do not test by pasting bearer tokens or signed URLs into a terminal command/history.

## 4. Configure the inference worker

These values belong to the worker process or cloud secret/configuration store:

| Setting | Value |
| --- | --- |
| `APMS_AI_ARTIFACT_ENDPOINT` | `https://YOUR_PROJECT.supabase.co/functions/v1/ai-model-artifact` |
| `APMS_AI_ARTIFACT_TOKEN` | Same artifact machine token as the broker |
| `APMS_AI_ARTIFACT_MANIFEST_SHA256` | Same pinned manifest digest as the broker |
| `APMS_AI_ARTIFACT_CACHE_DIR` | Writable cache directory; container default `/tmp/apms-model-cache` |
| `APMS_AI_SERVICE_API_KEY` or its file setting | Separate inference bearer key, as before |

The endpoint and signed Storage URLs must use the same HTTPS origin; custom-domain/proxy setups must preserve that contract. The worker follows no redirects and sends its artifact bearer token only to the configured broker, never with object downloads. Remote mode takes precedence when the endpoint is set. If remote configuration/download/verification fails, readiness fails; it never quietly loads an unrelated local model. A previously verified cache for the exact pin remains usable without a new network call.

The loader checks cache contents and downloads only at process startup. It does not poll for releases, mutate a loaded model or redownload on prediction requests. It enforces a 120-second aggregate network budget, with at most one pending socket read of up to 30 seconds beyond that budget, plus bounded file sizes. Model loading/checksumming time is separate. Model loading/runtime parity and synthetic-development opt-in rules remain unchanged. A large or slow download can make an initial connection probe time out; check startup events and retry the explicit probe after readiness rather than issuing more prediction traffic.

**Docker computer:** use `services/ai/compose.storage.yaml` instead of `compose.yaml`. It has no model bind mount, uses the generic CPU runtime image and retains a named local cache volume. Put the settings in the ignored `.env.deploy`; keep the service token and artifact token protected. The secret-file service-key overlay remains optional:

```bat
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.storage.yaml up -d --build
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.storage.yaml ps
```

Add `-f services/ai/compose.keyfile.yaml` when using the inference service-key file. Add `-f services/ai/compose.cloudflare.yaml` for the existing Tunnel/Access route, with its separate connector and Access credentials. Do not publish port 8080 publicly. Avoid `down --volumes` unless deliberately retiring/rebuilding the cache after preserving required files.

**AWS:** publish the generic CPU runtime image to ECR rather than baking a model. The Fargate template accepts `ArtifactEndpoint`, `ArtifactManifestSha256` and `ArtifactTokenSecretArn`; set all three to enable remote mode. The artifact token must be its own Secrets Manager raw-string secret. The execution role is allowed to retrieve that exact secret, while the worker still receives no database/service-role credential. Use an AWS-managed secret encryption key or configure the relevant KMS permission/key policy; the template's optional `KmsKeyArn` can cover a shared approved key. Private tasks need outbound HTTPS connectivity to the Supabase broker and Storage as well as AWS platform services; an endpoints-only VPC without that route cannot fetch a cold model. Startup grace is longer for remote mode. Task-local cache is lost on task replacement. Follow the remaining ECR/ALB/TLS/change-set steps in [the cloud guide](AI_MODEL_CLOUD_DEPLOYMENT.md).

**Cloudflare Containers:** publish/reference the generic CPU runtime image. Set `APMS_AI_ARTIFACT_ENDPOINT` and `APMS_AI_ARTIFACT_MANIFEST_SHA256` as server Worker variables; set the token as a Worker secret:

```bat
cd services\ai\deploy\cloudflare
node_modules\.bin\wrangler.cmd secret put APMS_AI_ARTIFACT_TOKEN
node_modules\.bin\wrangler.cmd deploy
```

The container class passes these server values to Python and enables container internet access only when remote artifact mode is configured. The default baked-model path leaves internet disabled. Its local cache is ephemeral; measure provisioning/wake behavior on your account. Neither storage credentials nor signed URLs enter the app bundle. Keep the five-minute idle policy only if its cold-start/egress tradeoff suits measured usage.

## 5. Verify, release and roll back

Use System Admin → System Settings → **Check connection** to confirm readiness, model version, artifact ID, artifact source and manifest pin. The status response excludes locations and credentials. Then run a small authorized class prediction and check the saved provenance and advisory values in the gradebook/AI Prediction/At-Risk views. Changing the storage backend alone must not change predictions for identical weights, inputs and runtime.

The [app integration guide](AI_MODEL_APP_INTEGRATION.md) explains explicit run actions, large-class batches, protected recorded scores and time-only freshness. Mobile ONNX exports may be archived in Storage, but this private serving broker does not expose them to mobile users; approved on-device model distribution remains separate from the server artifact allowlist.

Test wrong/missing artifact tokens, invalid manifests/hashes, incorrect object bytes, unavailable Storage, cache reuse, and a changed release pin. Software tests cover these with isolated local fixtures; a live bucket, Linux Docker image and hosted cloud startup must still be verified on the target. Check upload sizes, cold-cache elapsed time, download bytes, memory use, readiness and end-to-end schema/output validation. The local machine has no Docker; no cloud resources were provisioned here.

For a model release, upload a new immutable prefix, record its manifest/artifact hashes and held-out validation evidence, update the broker prefix/pin and the worker pin together, and restart candidate workers. Each worker is pinned; it cannot silently follow a changed `latest` object. The prediction gateway also requires each response's artifact/version headers to match its probe, rejecting a mixed-artifact batch during rolling deployment. For parallel canaries, use a separately configured broker/function or release endpoint: a single broker configuration serves one pinned release at a time.

Rollback restores the previous broker prefix/pin and worker pin, then restarts workers with the previous validated release/runtime. Keep both remote objects and the original local release evidence through the rollback window. Rotating an artifact token does not remove copies already downloaded, including valid local caches; retiring a release requires stopping/replacing its workers and applying the institution's artifact-retention process. Do not automatically promote online-learning candidates based on a successful upload or readiness check.
