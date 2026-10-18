# Manage forecasting service keys

Use this runbook with [cloud deployment](AI_MODEL_CLOUD_DEPLOYMENT.md). Commands use Windows `cmd.exe`; run repository-relative commands from the repository root unless a different directory is shown. Examples are instructions for an authorized operator, not actions already performed against your cloud accounts.

## Which credential belongs where

| Credential | Purpose | Stored by |
| --- | --- | --- |
| `APMS_AI_SERVICE_API_KEY` | Authenticate prediction/status requests to the model service | Supabase Edge secrets, plus the Docker key file, AWS Secrets Manager, or native Cloudflare Worker secret |
| Tunnel connector token | Connect `cloudflared` to one Cloudflare Tunnel | Protected Docker-host file referenced by `APMS_CF_TUNNEL_TOKEN_HOST_PATH` |
| Access Client ID and Client Secret | Let the Supabase gateway pass the Cloudflare Access Service Auth policy | Supabase `APMS_AI_CF_ACCESS_CLIENT_ID` and `APMS_AI_CF_ACCESS_CLIENT_SECRET` |
| `APMS_AI_ARTIFACT_TOKEN` (optional) | Fetch an approved model release from the artifact broker | Supabase broker secret plus the worker's private environment, AWS secret, or native Worker secret |

Generate a separate random credential for each purpose and environment. For a new service token, 32 cryptographically random bytes encoded as 64 hex characters are a practical choice. The current Python service accepts your existing 1024-character ASCII hex token too; a longer token does not compensate for an exposed file. Store the exact token without quotes or a `NAME=` prefix in raw key files. Keep encrypted recovery copies in an approved password/secret manager. Record owner, purpose, creation/rotation date, expiry where applicable, and secret identifier; do not put its value in the release record.

The model worker receives no Supabase service-role key. Never put these credentials in frontend variables, Git, image layers, build arguments, command arguments, or screenshots. Avoid printing full `docker inspect`, `docker compose config`, environment dumps, secret values, or authenticated request headers. Host/Docker administrators and a compromised worker can access its runtime credential even when a secret manager supplies it.

## Common gateway configuration and rotation order

The gateway and worker must use the **same service token**. For file-based Docker, that means the file token, not an old value left in `.env.deploy`. Update the existing Supabase project's Edge secrets through its dashboard, or prepare an ignored, access-restricted file `supabase/functions/.env.ai-key-rotation` containing only the intended settings:

```dotenv
APMS_AI_SERVICE_API_KEY=REPLACE_WITH_THE_NEW_SERVICE_TOKEN
```

Apply it without placing the value in command history:

```bat
node_modules\.bin\supabase.cmd secrets set --env-file supabase\functions\.env.ai-key-rotation --project-ref YOUR_EXISTING_PROJECT_REF
```

Supabase documents that changed function secrets do not require a function redeployment. Protect or remove the private staging file after use according to your credential-retention policy. See [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets).

This service accepts one service token at a time, loaded when Python starts. Use a maintenance window: pause forecast requests and automated probes, update the serving side using the relevant procedure below, update the gateway secret, verify, then resume. A brief mismatch produces authentication failures; do not repeatedly retry predictions because failed reserved requests can consume quota. For uninterrupted rotation, stage a separately configured endpoint with the new token and switch the gateway endpoint/token together after validation; the supplied single-endpoint setup does not provide dual-key overlap.

## AWS ECS Fargate

Create a Secrets Manager **Other type of secret / plaintext** secret holding only the token, rather than a JSON object. Alternatively, use an already protected raw token file in the ignored `services/ai/secrets/` folder:

```bat
aws secretsmanager create-secret --name apms/ai/service-token --secret-string file://services/ai/secrets/service-token.txt --query ARN --output text
```

Pass the returned ARN as `ServiceTokenSecretArn` to `services/ai/deploy/aws-fargate.yaml`. The template injects it as `APMS_AI_SERVICE_API_KEY`; do not also configure a key file or a plaintext task-definition environment value. The execution role is restricted to the specified secret. For a customer-managed KMS key, configure the template's `KmsKeyArn` and the key policy; limit operator/CI access to the required secret and environment.

To rotate, prepare the new raw token in the protected file, then run during the common maintenance procedure:

```bat
aws secretsmanager put-secret-value --secret-id YOUR_SERVICE_TOKEN_SECRET_ARN --secret-string file://services/ai/secrets/service-token.txt --query VersionId --output text
aws ecs update-service --cluster YOUR_CLUSTER --service YOUR_SERVICE --force-new-deployment --query service.serviceName --output text
aws ecs wait services-stable --cluster YOUR_CLUSTER --services YOUR_SERVICE
```

Updating the secret does not update running tasks. The forced deployment starts tasks with the new value; wait for old tasks to drain, check target health, and update the gateway token before resuming. ECS stability alone does not prove gateway authentication. See [ECS secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html), [secret version updates](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html), and [forcing a deployment](https://docs.aws.amazon.com/cli/latest/reference/ecs/update-service.html).

Keep the approved prior secret version only for controlled rollback. An image rollback does not restore a token automatically: coordinate the chosen secret value, fresh tasks, and gateway value. Do not restore a known-compromised token. Automatic Secrets Manager rotation of this arbitrary token is not configured by the template; rotation must coordinate both parties.

## Docker computer with Cloudflare Tunnel

### Store and mount the service token

Use a protected host file, for example your `D:/apms-docker/APMS/run/secrets/apms_ai_service_key`. In Windows Properties → Security, restrict read access to the Docker-running account and trusted administrators/system accounts that need it; preserve Docker's ability to read the file. Use encrypted storage and protected backups. Compose file-backed secrets mount the host file; they do not encrypt the original file. See [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

Both `/run/secrets/` at the repository root and `services/ai/secrets/` are ignored by Git; secret directories are excluded from the generic Docker build context. Ignoring a path does not untrack a file already committed. If it was committed/shared, rotate the credential and handle repository history under your incident process.

Set the private `.env.deploy`:

```dotenv
APMS_AI_SERVICE_API_KEY=
APMS_AI_KEY_HOST_PATH=D:/apms-docker/APMS/run/secrets/apms_ai_service_key
APMS_CF_TUNNEL_TOKEN_HOST_PATH=D:/apms-docker/APMS/run/secrets/cloudflare_tunnel_token
```

The base Compose entry must be `${APMS_AI_SERVICE_API_KEY:-}`. The key-file overlay sets `APMS_AI_SERVICE_API_KEY: ""` and `APMS_AI_SERVICE_API_KEY_FILE: /run/secrets/apms_ai_service_key`. Use two double quotes for an empty value; an apostrophe or a literal quoted token is not an empty value. A nonempty environment token together with a key-file path is rejected. Keep the key-file overlay after the base file.

Rotate the service token by replacing the protected file contents, updating the gateway token, and recreating the model worker during maintenance:

```bat
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml -f services\ai\compose.keyfile.yaml -f services\ai\compose.cloudflare.yaml up -d --force-recreate ai
curl.exe --fail http://127.0.0.1:8080/ready
```

Use `compose.storage.yaml` instead of `compose.yaml` for remote artifacts. Editing the file alone does not replace the key already loaded into Python. The Tunnel connector does not need a new connector token just because the service key changed.

### Manage the separate Tunnel and Access credentials

Create/refresh the **Tunnel connector token** through Cloudflare's Tunnel settings, put only that token in the separate protected connector-token file, and recreate the connector:

```bat
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml -f services\ai\compose.keyfile.yaml -f services\ai\compose.cloudflare.yaml up -d --force-recreate cloudflared
```

Refresh prevents new connections with the old token; existing connections can remain active. For compromise, follow Cloudflare's procedure to refresh the token and remove existing tunnel connections, then reconnect approved replicas. The supplied single connector can have an interruption; multiple replicas need a coordinated rotation. See [Tunnel token rotation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/).

Create a distinct **Cloudflare Access service token** and authorize it in the hostname's **Service Auth** policy. Save its Client ID and Client Secret as the Supabase Access secrets from the table above. Use Access's separate headers, keeping `Authorization` for the model service token. During Access rotation, use **Rotate secret** and an appropriate grace period, update the gateway's Client Secret, verify the protected probe, and retire the old secret. Track the Access token's expiry separately; renewal and secret rotation serve different purposes. Revoke immediately when exposure requires it. See [Access service tokens and rotation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Native Cloudflare Containers

Store the service token as a **Worker secret**, not a `vars` entry in `wrangler.jsonc`. From the isolated deployment package directory:

```bat
cd services\ai\deploy\cloudflare
node_modules\.bin\wrangler.cmd secret put APMS_AI_SERVICE_API_KEY
node_modules\.bin\wrangler.cmd secret list
```

Enter the value at the prompt. Listing shows secret names, not values. For the first deployment, complete the image/configuration steps in the cloud guide. `secret put` creates and deploys a Worker version immediately; schedule updates accordingly. The checked-in `APMSContainer` passes this Worker secret to Python's environment at container startup. No host key file or Tunnel connector token is needed for this native path. If using a Wrangler named environment, use the same `--env NAME` on all secret and deployment commands and configure that environment's bindings. See [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [passing secrets into containers](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).

Do not assume that a Worker secret update changes the environment of an already-running Python process. For this starter's single fixed container and five-minute idle policy: pause all forecast traffic and probes, let the instance become idle, and confirm it has stopped using platform instance state/logs. Update the Worker secret and the gateway secret, then run the explicit admin connection check to start a fresh process. If it remains running, keep maintenance active until you have replaced/stopped that process through an approved platform operation. Do not infer completion from elapsed time alone. The gateway exposes no public stop/restart route, and `wrangler containers delete` is not a restart command. Cloudflare's [container lifecycle API](https://developers.cloudflare.com/containers/api/container-class/) describes stop behavior; no new administrative route is added by this runbook.

Keep a protected recovery copy: Worker secret values cannot be read back through Wrangler. Rolling back code does not establish which key the live Python process has loaded; reconcile Worker/gateway values and process state before resuming. Restrict Cloudflare deployment permissions and protect your Wrangler login/API credentials separately.

## Optional artifact-fetch credential

Keep `APMS_AI_ARTIFACT_TOKEN` independent of the service key. For AWS, use a separate Secrets Manager secret referenced by `ArtifactTokenSecretArn`; for native Containers, use `wrangler secret put APMS_AI_ARTIFACT_TOKEN`; for Compose, use a protected private environment/secret-manager delivery mechanism supported by the current deployment. The supplied Compose key-file overlay applies only to the **service** token, not the artifact token. Update the Supabase artifact broker's token to match and restart candidate workers; test a cold cache because a valid cache may avoid broker authentication entirely. Follow [artifact storage and rollback](AI_MODEL_ARTIFACT_STORAGE.md). Token rotation does not revoke downloaded model copies.

## Verify and recover

After changing a credential, use System Admin → System Settings → **Check connection**, then one small authorized forecast. A local `/ready` response verifies model/key configuration but does not verify matching gateway credentials or Cloudflare Access. Confirm missing/wrong credentials remain rejected; use an approved client with protected credential storage, never inline tokens in shared commands. During rotation, verify the previous service token is rejected by the authenticated endpoint; an unauthenticated `/health` success does not prove this.

If `/ready` says authentication is not configured, inspect whether exactly one source is set, the file is nonempty/readable, the key-file overlay was included after the base, and the container was recreated. To validate file loading without printing the token, run from the repository root:

```bat
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml -f services\ai\compose.keyfile.yaml exec -T ai python -c "from apms_ai.main import _read_service_key; print('Loaded key length:', len(_read_service_key()))"
```

Add the same overlays used by your deployment and use the storage base when applicable. This checks the current file/configuration; recreate before relying on the process's cached startup key. For an exposure, rotate the affected credential, revoke old access/connections as appropriate, check for copied values in logs/backups/history, and never roll back to the exposed value.

### Diagnostic import fails: older runtime package

If that diagnostic raises `ImportError: cannot import name '_read_service_key'`, the running package lacks the key-file loader. Changing environment values cannot add the missing implementation. Update the Docker computer's service source and Dockerfile from the reviewed workspace/release, including `services/ai/src/apms_ai/main.py`, packaged schema data and `services/ai/pyproject.toml`. Check the host source before rebuilding:

```bat
findstr /n _read_service_key services\ai\src\apms_ai\main.py
```

If there is no match, synchronize the updated source first. With the provided local-model Compose files, rebuild and replace the container:

```bat
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml -f services\ai\compose.keyfile.yaml build --no-cache ai
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml -f services\ai\compose.keyfile.yaml up -d --no-build --force-recreate ai
```

Run the second command only after the build succeeds. Use your normal additional overlays and the storage base if applicable. A no-cache rebuild is a diagnostic recovery step, not required for every future deployment; see [Compose build](https://docs.docker.com/reference/cli/docker/compose/build/) and [container recreation](https://docs.docker.com/reference/cli/docker/compose/up/).

Then inspect only nonsecret runtime identity fields and rerun the key-loading diagnostic above:

```bat
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml -f services\ai\compose.keyfile.yaml exec -T ai python -c "import sys; import apms_ai.main as m; print('Python:', sys.executable); print('Package:', m.__file__); print('Key-file support:', callable(getattr(m, '_read_service_key', None)))"
```

Expect `Key-file support: True`. The current supplied image uses `/opt/venv/bin/python` and a package under `/opt/venv/`; a traceback under `/usr/local/lib/.../site-packages` is additional evidence of a different runtime. If support remains absent, check the actual Compose build context/Dockerfile, selected image and Docker context; a successful rebuild of another image or another Docker daemon does not replace this service. Do not print the full environment to diagnose it.

This documentation was checked against repository configuration and official provider documentation. No credentials were generated, read from your Docker computer, uploaded, rotated or revoked, and no cloud processes were restarted here.
