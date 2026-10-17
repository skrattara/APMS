# AI workspace files and safe cleanup

This page is an inventory guide, not a cleanup script. No files were removed while preparing it. An ignored file is merely untracked by Git; it may still be the only copy of a trained model, data split, test report, or reproducibility protocol.

## Keep these source and contract files

Keep the code and declarations required to rebuild or understand the AI package:

Keep the repository's `.git\` history, `.agents\` instructions, and application/domain/database sources under `apps\`, `packages\`, `supabase\`, `scripts\`, `tests\` and `docs\`. They are not temporary AI outputs. In particular, migrations, schema examples and uncommitted application work must not be removed during model cleanup.

- `services\ai\src\apms_ai\` — model, training, inference, encoding, evaluation, lifecycle, and CLI code.
- `services\ai\src\apms_ai\schema_data\` and the authoritative domain schemas under `packages\domain\src\` — structural contracts used when validating and encoding grading/evaluation snapshots.
- `services\ai\examples\` — configuration profiles and `advisory_forecasting_demo.ipynb`. The notebook source is the `.ipynb` file; saved cell outputs may be useful evidence, so preserve a copy before clearing them.
- `services\ai\tests\`, `services\ai\pyproject.toml`, `services\ai\Dockerfile`, `services\ai\compose.yaml`, `services\ai\deploy.env.example`, `services\ai\mobile\`, `services\ai\mobile_contract.json`, and documentation.
- Root and package lockfiles, workspace configuration, and build scripts needed to recreate the JavaScript and Python environments.

Never move an active deployment secret into the repository while organizing these files. `services\ai\.env.deploy` is a local secret-bearing file; keep it in an approved secret store and do not copy it into a source archive.

## Generated artifacts: preserve by purpose

Training and inference bundles are directories. A saved bundle contains `metadata.json`, `weights.pt`, and a `schemas\` directory. Metadata includes model settings, preprocessing, field contracts, split fingerprints, calibration when available, and integrity hashes. It does not replace the original training dataset: the fingerprint proves identity but cannot recreate the records.

The `.checkpoint` directory is a separate training-resume artifact. It carries optimizer and random-state data in addition to weights and metadata. Keep it while a run may need resuming. The final bundle is what inference loads. Deleting a bundle loses the trained weights; retraining can be costly and nondeterministic, especially on GPU.

During an interrupted run, the checkpoint may be the only saved latest training state; the final bundle is published only after training finishes. The current completed training bundles also carry resume state, but preserve the explicit checkpoint until its matching completed bundle has been verified. Do not assume an inference-only export contains an optimizer or can resume training.

Keep the following together for every model considered, selected, deployed, or retained for rollback:

- The final bundle, its checkpoint when resume is still relevant, and its matching configuration.
- The exact training dataset or a controlled reproducible source snapshot, generator profile/seed when synthetic, partition definition or split hashes, and source/label provenance.
- Training metrics logs (`*.metrics.jsonl`), validation/test/evaluation reports, calibration reports and calibrated bundle, diagnostics, selection decisions, and the predeclared comparison protocol.
- An exported ONNX file with its matching `*.metadata.json`, `*.contract.json`, and `*.conformance.npz` sidecars. Keep the ONNX original with an INT8 derivative and its `*.quantization.json`; the derivative alone cannot replace its source model.
- Any production artifact and its previous known-good rollback bundle. Confirm which path the service's `APMS_MODEL_ARTIFACT_PATH` or container mount uses before changing anything.

Quantized files can be regenerated only when the original ONNX and bundle, matching code and runtime, and validation data/configuration remain available. ONNX metadata contains preprocessing and decoding information needed by mobile callers; the graph alone is insufficient for a typed client.

Current ignored artifact examples include `services\ai\artifacts\comprehensive-v2\`, `notebook-*` directories, `synthetic-final-model`, `synthetic-final-calibrated`, their `.checkpoint` directories, JSONL training/stress data, candidate reports, ONNX exports, and quantized exports. Names such as `candidate`, `selected`, or `final` do not prove that a model is active. Read its report and check the configured service path before treating it as disposable.

## Rebuildable environments and caches

| Item | Can it be deleted? | What is needed to recover it? |
| --- | --- | --- |
| Code, docs, schema sources, checked-in profiles and source notebook | Keep | These define the implementation and contract; retain them in version control |
| `__pycache__`, `.pytest_cache`, `.ruff_cache`, build/egg-info outputs | Usually, after stopping users of those paths | Rerun Python, tests, lint or package build |
| `.venv`, `node_modules` | Rebuildable, but needed by running commands/services | Manifests, lockfiles, compatible wheels and preferably exact recorded versions |
| Synthetic datasets | Conditionally | Exact generator implementation, profile, seed and data fingerprint; preserve benchmark snapshots |
| Real input/label datasets | Keep under approved data controls | They are not reproducible from a seed or model fingerprint |
| Trained bundles, active/rollback models and needed checkpoints | Keep or verify an archive first | No cheap regeneration; retraining needs original data, source, runtime, settings and compute |
| ONNX/INT8 models and matching metadata/sidecars | Conditional, after confirming no deployment uses them | Original bundle, code/runtime, export settings and representative/validation data |
| `tmp` scripts, protocols, reports and executed notebooks | Review individually | Archive unique evidence first; generic scratch/cache files can be recreated |

This table covers AI-related work. Other project folders such as `generated-data`, `supabase`, `packages`, application assets and application test reports have separate owners and purposes. A name containing “generated” or “temporary” is not enough evidence to delete it.

These are usually reproducible but should stay in place while a task, notebook, test, build, or service is using them:

- Root `.venv\` — Python interpreter and installed packages for the AI work. It can be rebuilt from `services\ai\pyproject.toml` and the selected CPU/CUDA-compatible package set, but downloading ML packages may take time and the exact wheel versions affect reproduction.
- Root `node_modules\` — JavaScript dependencies. Recreate only from the repository's package manifest and lockfile.
- `services\ai\build\`, `services\ai\src\apms_ai_service.egg-info\`, `__pycache__\`, `.pytest_cache\`, `.ruff_cache\`, and temporary compiler/cache directories — generated outputs that can usually be regenerated once their processes are stopped.
- Executed notebook output — can be regenerated from a copy of the source notebook, environment, and data. Preserve any notebook copy whose outputs are being used as a review record.

The current workspace includes `.venv`, `node_modules`, `services\ai\build`, `services\ai\src\apms_ai_service.egg-info`, `.pytest_cache`, `.ruff_cache`, Python `__pycache__` directories, and generated model/data artifacts. Do not stop or replace an environment simply because it is large; confirm that no active agent, test, notebook kernel, or service depends on it.

## Temporary files may be the only experiment record

The current `tmp\` contains AI review and experiment material such as `ai-improvement-benchmark.py`, `ai-improvement-protocol.json`, `ai-improvement-progress.py`, `ai-final-review.py`, `ai-comprehensive-runtime-review.py`, `ai-mobile-conformance.py`, `ai-mobile-case-*.json`, model review bundles, reports, and wheel directories. These are not all generic scratch files. Some scripts/protocols may be the only record of comparison settings or conformance cases. Archive and inspect them before any cleanup; keep the exact data/profile, seeds, command settings, environment versions, and reports needed to reproduce each result.

More specific examples in this workspace:

- `tmp\pip-cache\`, Python `__pycache__`, Ruff/pytest caches, and `tmp\torchinductor_Administrator\` are rebuildable caches. Stop dependent processes first; later commands may download or compile again.
- `tmp\pytest-of-Administrator\` contains isolated test outputs and model fixtures. It can be removed after tests stop and any failure evidence has been retained. These fixtures are not deployment models.
- `tmp\ai-wheels*\` and `tmp\ai-packaged-review\` contain built wheels and extracted-package checks. They are rebuildable from the matching source/runtime, unless a particular wheel is your retained distribution artifact.
- `tmp\ai-luna-verification\` contains the notebook runner and executed review notebook. The source playground under `services\ai\examples\` must remain; archive executed results if they support a validation claim.
- `services\ai\artifacts\history-v3\` contains the newer frozen comparison, including exact data, generator/protocol, package source snapshot/digests, environment versions, model candidates, metrics and selection/test evidence. Preserve or archive it as a unit. The checked-in `examples/compare_history_models.py` and `history-comparison.json` define how to run a new comparison, but do not replace the saved trained weights or measured reports.

Inspect the actual file type: this implementation's bundles and `.checkpoint` paths are directories. A filename extension such as `.json` is not by itself proof that an experiment path contains a disposable report rather than a bundle directory.

## A safe, non-destructive review sequence

1. Check the intended output and current directory before starting any cleanup. Inventory files and sizes, including hidden/ignored files, and inspect `git status --short --ignored` so you can distinguish tracked source from ignored generated work.
2. Stop only the specific service, test runner, notebook kernel, or build using a candidate environment or artifact. Confirm that no other process or active task depends on it.
3. For every model/review candidate, open its `metadata.json` and reports, then verify that its weights digest loads. Confirm the selected bundle and rollback path with the owner of the deployment.
4. Archive important ignored artifacts, training data, split/protocol files, and sidecars to an approved location. Preserve access controls for any real student data. A file hash can check that a copy arrived intact, but it does not replace the file.
5. Test that the archive can be read and that a model can be restored from it. Record which environment, source revision, model config, data profile, seed, and split produced the result.
6. Only after this review should a human choose specific disposable caches or rebuildable outputs. Avoid blanket cleanup of `tmp\`, `services\ai\artifacts\`, `.venv\`, or `node_modules\`.

For a fresh generated comparison, use a new output directory so existing evidence and rollback artifacts remain untouched:

```bat
mkdir services\ai\artifacts\rebuild-20261017
.venv\Scripts\python.exe -m apms_ai.cli generate --config services\ai\examples\synthetic-comprehensive.json --output services\ai\artifacts\rebuild-20261017\data.jsonl
.venv\Scripts\python.exe -m apms_ai.cli train --data services\ai\artifacts\rebuild-20261017\data.jsonl --output services\ai\artifacts\rebuild-20261017\candidate --config services\ai\examples\comprehensive-residual-training.json
.venv\Scripts\python.exe -m apms_ai.cli evaluate --bundle services\ai\artifacts\rebuild-20261017\candidate --data services\ai\artifacts\rebuild-20261017\data.jsonl --role validation --output services\ai\artifacts\rebuild-20261017\validation.json
```

The workflow guide explains calibration, export, deployment, and CPU/GPU considerations: [AI model usage and deployment](AI_MODEL_USAGE_DEPLOYMENT.md).

## Container and cloud deployment files

Keep `services/ai/Dockerfile`, the Compose files, `deploy.env.example`, `services/ai/deploy/` source/templates, its Cloudflare `package.json` and lockfile, the shared Edge connector/status function, the custom-usage migration, and deployment documentation. These are maintained source, not temporary Docker outputs. The Cloudflare `worker-configuration.d.ts` is generated but checked in for typechecking; regenerate with the deployment subproject's pinned Wrangler (`wrangler types worker-configuration.d.ts --include-runtime false`) after binding/variable changes, rather than deleting it before a build.

`services/ai/deploy/cloudflare/node_modules/`, `.wrangler/`, build caches and downloaded local test runtimes under `tmp/` are rebuildable once dependent processes stop. Recreate the deployment dependencies with `npm ci` inside that subproject. The ignored PGlite verification environment is separate from the live Supabase database and can be recreated for regression checks.

`services/ai/.env.deploy`, private `.env.ai-production` / `.env.aws-parameters.json` files and `services/ai/secrets/` contain deployment configuration or credentials. Keep them out of Git and image build contexts, restrict access and back up required credentials securely. Removing a key/tunnel-token file may prevent the service from restarting; revoke/rotate credentials if retiring the deployment. They are not ordinary caches.

Packaged release bundles under `services/ai/artifacts/`, published Docker image digests, active and rollback model mounts, and release manifests may be the only reproducible deployment record. Keep or verify an approved archive before deleting them. Packaging deliberately omits optimizer state and training-only fingerprints, so a release image cannot replace the original training bundle for exact resume or later evaluation. Local Docker image layers can be rebuilt only while the exact source, base/runtime versions and model package remain available. Avoid blanket Docker volume/image pruning when active services or rollback images may depend on them.

## Supabase artifact releases and startup caches

Keep `artifact_store.py`, `compose.storage.yaml`, the artifact-broker source, its private-bucket migration/tests and manifest-generation code. In a release package, `manifest.json` is part of the exact pinned deployment contract: reformatting it changes its digest. Retain that pin together with the four inference files and validation evidence. Bucket objects under an active or rollback release prefix are deployment artifacts; deleting or replacing them prevents a cold worker from loading that release.

The remote loader's cache is organized by manifest digest. Compose uses a named cache volume; ECS and Cloudflare use temporary local storage. A cache can be regenerated only while the matching private release, manifest, working credentials and compatible runtime remain available. It may also be the only copy allowing startup during an outage, so verify the remote archive before removing it. Stop dependent workers before explicitly retiring cache versions. Never run blanket volume deletion against an active deployment. Archive checkpoints, reports and real datasets separately under their own retention controls; serving packages intentionally omit training-only state. See [artifact storage and rollback](AI_MODEL_ARTIFACT_STORAGE.md).
