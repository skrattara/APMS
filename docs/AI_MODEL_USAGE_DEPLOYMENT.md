# APMS forecasting model: data, evaluation, and deployment

This guide covers a controlled workflow for the isolated `services/ai` package. The model is advisory; APMS grading and evaluation remain authoritative. Do not use synthetic demonstrations as evidence of student-level accuracy or institutional validity. Keep student data inside approved institutional systems and keep provider credentials on the server side.

## 1. Prepare the environment

Run these commands from the repository root in Windows `cmd.exe`. Create a fresh environment and install the AI package with its test dependencies:

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -e "services\ai[ml,test]"
```

The `ml` extra includes PyTorch, Fabric, NumPy, Optuna, SHAP, ONNX, and ONNX Runtime. Install a PyTorch wheel compatible with the target CUDA stack only when GPU training is intended; the default installation and documented baseline are CPU. Keep the environment isolated from the application runtime.

Generated datasets, models, reports, and exports should go under `services\ai\artifacts`, which is ignored by Git. Use a new output name for each run because saved bundles and ONNX sidecars are immutable.

## 2. Understand the data contract

The primary interchange formats are JSON and JSONL. Each example contains:

- `fields`: explicit scalar roles, each with `name`, `kind` (`float`, `integer`, `boolean`, or `category`), and optional finite bounds or a categorical `categories` list.
- `history`: ordered records with only declared fields. A missing property means unobserved; `null` means explicitly missing. Neither means zero.
- `queries`: one requested field per output and a positive integer `horizon`; numeric domains may narrow field bounds, and categorical/mapped outputs may declare legal `choices`.
- `labels`: one row aligned with each query, containing the target field and optional `trend` or `failure` labels. Unknown or unavailable labels are omitted or set to `null`.
- `group`: a stable local learner/group key used for partitioning only. It is not encoded as a feature or returned by inference. Real records need a group key so records for the same learner cannot cross splits.
- `origin`: `real` for real observations or `synthetic` for generated examples. Keep simulator family and noise identities outside predictive inputs.
- `schema`: optional applied `gradingSystem` and `evaluationCriteria` snapshots. The validator checks JSON Schema constraints, references, mappings, cycles, and domain semantics. Preserve the original snapshots when validation fails; never patch identifiers or aliases just to make the AI pipeline accept them.

Keep direct identifiers, names, dates, narrative descriptions, and other private attributes out of model fields. Use relative record order for the history; if elapsed time matters, encode a validated relative-duration feature. Use the same horizon units for every example of a field. The group key is permitted only for split integrity and must not be added to `fields` or history.

One JSONL line can look like this synthetic illustration (actual schema snapshots must be valid applied APMS definitions):

```json
{"fields":[{"name":"score","kind":"float","minimum":0,"maximum":100},{"name":"attendance","kind":"float","minimum":0,"maximum":1},{"name":"status","kind":"category","categories":["ready","support"]}],"history":[{"score":68,"attendance":0.91,"status":"ready"},{"score":null,"attendance":0.88,"status":"support"}],"queries":[{"field":"score","horizon":1,"minimum":0,"maximum":100},{"field":"status","horizon":2}],"labels":[{"score":74,"trend":"improving","failure":0},{"status":"ready","failure":0}],"group":"local_group_key","origin":"synthetic-family-example","schema":{}}
```

In production, group keys should be opaque local identifiers and excluded from app/provider payloads. Dataset provenance, cohort dates, and source-system lineage should be tracked beside the model input data, under the institution's access controls, rather than passed as predictive fields.

For longitudinal, mixed-type, mapped, or schema-conditioned records, author JSONL. The flat CSV adapter supports a simple numeric snapshot and numeric target:

```bat
.venv\Scripts\python.exe -m apms_ai.cli ingest-csv --input data.csv --output services\ai\artifacts\records.jsonl --group-column learner_group --target-column next_score --fields current_score,attendance_rate
```

Use a stable de-identified group column and inspect the resulting JSONL before training. The adapter does not infer assessment mappings or grading snapshots.

## 3. Generate a synthetic demonstration

Synthetic data helps exercise the pipeline, variable history lengths, missingness, schema paths, mapped targets, horizons, and output validation. It does not measure how students behave. The comprehensive profile makes scenario selection explicit and reproducible:

```bat
mkdir services\ai\artifacts
.venv\Scripts\python.exe -m apms_ai.cli generate --config services\ai\examples\synthetic-comprehensive.json --output services\ai\artifacts\synthetic.jsonl
```

Generator profiles control `history_min`, `history_max`, the two increasing `horizons`, any subset of ten supported `family_names`, six `noise_laws`, noise and slope ranges, cross-subject and attendance coupling, field/structural/burst missingness, sparse and empty histories, missing labels/tasks, windows per student, and passing/attendance threshold ranges. The checked-in profile includes all ten families and six noise laws. `count` counts windows: its 640 windows form 320 independent learner groups. Keep the seed explicit when comparing runs.

Record the profile, seed, and generator version with the dataset. Keep synthetic and real origins separate in reports. Do not set the service's synthetic-artifact opt-in outside development.

## 4. Train and select a candidate

Training partitions are group-disjoint train, validation, calibration, and test sets. Preprocessing and categorical vocabularies are fitted from the training role only. Real validation examples are preferred for model selection; when a training set contains both real and synthetic examples, `real_fraction` controls the supervised sampling mix. A robust numeric residual configuration can anchor numeric predictions to the last observed target and learn a bounded correction; when no usable observation exists, it uses the configured unanchored path. Optional supervised dropout regularization is a training setting. These options do not replace held-out evaluation.

Example CPU training using the checked-in profile:

```bat
.venv\Scripts\python.exe -m apms_ai.cli train --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\candidate --config services\ai\examples\demo-training.json
```

Training writes a bundle and a metrics JSONL log. Review split counts, source counts, validation behavior, task label coverage, and the full configuration. Fresh runs default to `numeric_residual=true`; `input_dropout=0.05` masks only observed training tokens, `numeric_center_loss_weight=0.25` adds normalized median SmoothL1 loss, and `min_delta=0` controls early stopping sensitivity. The checked-in training profile uses `min_delta=0.001`. Resume inherits unspecified saved settings; fine-tuning inherits its saved residual mode and rejects changing that head's semantics. To compare the legacy and residual designs, train separate fresh models. A run that has only synthetic training/validation data is a software demonstration, not a release candidate for student records.

Fresh residual training uses `residual_link=additive`: corrections are in normalized target units and quantiles are bounded inside the model graph. The optional `logit` link preserves existing residual bundles. The additive path keeps useful learning gradients for zero/full-mark observations and uses normalized zero (the training median) as its no-observation starting point, bounded to the applied domain. Supervised fine-tuning retains both mode and link. When transferring a masked-pretraining bundle, a changed forecasting head is reset while its encoder transfers.

The JSON profile takes precedence over flags with the same name. For GPU training, copy the profile to a new file, set `accelerator` to `cuda` and choose compatible `precision` (for example `bf16-mixed` on supported hardware), then pass that profile. Alternatively, omit `--config` and specify `--accelerator cuda --precision bf16-mixed` explicitly. Use a distinct output path for each run; CUDA and mixed precision have not been tested on this CPU-only host.

For masked-observation pretraining, run `pretrain` on approved histories, then pass the resulting bundle with `train --init-from`. Fine-tuning uses `finetune --init-from` with new fields appended to the existing contract; the optimizer and calibration lifecycle restart. Exact training resume uses `train --resume` with the same dataset fingerprint, seed, model contract, and training settings.

Hyperparameter tuning uses validation data only. Do not repeatedly tune or choose a model based on test results. Keep a separate later-cohort or forward-time cohort for final evidence.

```bat
.venv\Scripts\python.exe -m apms_ai.cli tune --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\search --trials 8 --epochs 8 --seed 42 --accelerator cpu
.venv\Scripts\python.exe -m apms_ai.cli evaluate --bundle services\ai\artifacts\search\selected-model --data services\ai\artifacts\synthetic.jsonl --role validation --output services\ai\artifacts\selected-validation.json
```

For a later independent cohort, `evaluate --external --bundle ... --data ... --output ...` scores every supplied eligible record and rejects any group overlapping the saved train/validation/calibration/test groups. Do not use `--external` to bypass separation checks by renaming the same learners.

For the documented controlled comparison, generate with `synthetic-comprehensive.json` and train separate fresh bundles using `comprehensive-legacy-training.json` and `comprehensive-residual-training.json`. Evaluate both with `--role validation` on that same generated dataset before selecting. The profiles reproduce the measured 16-epoch CPU settings; `demo-training.json` is a shorter playground profile. The residual candidate reduced validation MAE but increased RMSE in the recorded comparison, so it was not selected. See [the validation report](AI_MODEL_VALIDATION.md) for the selection rule, task tradeoffs and matched test baselines. Decide the selection metric and tolerances before looking at outcomes.

The newer history-context experiment uses a fresh dataset seed and three controlled variants. Its runner freezes the profile, data digest and source snapshot, refuses source changes between runs, and keeps validation selection separate from final test evaluation. Choose an output directory that does not exist yet:

```bat
.venv\Scripts\python.exe services\ai\examples\compare_history_models.py prepare --output services\ai\artifacts\my-history-comparison
.venv\Scripts\python.exe services\ai\examples\compare_history_models.py train --output services\ai\artifacts\my-history-comparison --name absolute
.venv\Scripts\python.exe services\ai\examples\compare_history_models.py train --output services\ai\artifacts\my-history-comparison --name residual_control
.venv\Scripts\python.exe services\ai\examples\compare_history_models.py train --output services\ai\artifacts\my-history-comparison --name history_context
.venv\Scripts\python.exe services\ai\examples\compare_history_models.py select --output services\ai\artifacts\my-history-comparison
.venv\Scripts\python.exe services\ai\examples\compare_history_models.py final --output services\ai\artifacts\my-history-comparison
```

The declarations live in `examples/history-comparison.json`; a comparison is synthetic software evidence, not automatic deployment approval. Keep failed runs and selection decisions. After final evaluation, a new data cohort is needed for an independent new claim; do not retune against the same test groups. To try the options outside that comparison, pass `--numeric-history-context --numeric-center-loss-kind mse --numeric-center-loss-weight 1 --selection-metric numeric_rmse` to a fresh `train` command, or use the corresponding JSON keys. Defaults retain compatible behavior. See [the beginner explanation](AI_MODEL_TRAINING_EXPLAINED.md) for why the center-loss choice affects the interpretation of the middle quantile.

For a single fresh run with the selected experimental configuration:

```bat
.venv\Scripts\python.exe -m apms_ai.cli train --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\history-candidate --config services\ai\examples\history-aware-training.json
```

The measured comparison improved numeric test errors but regressed on categorical P/A accuracy and missed nominal interval coverage. Review the complete [validation report](AI_MODEL_VALIDATION.md) before choosing a candidate for real-data fine-tuning or deployment. The configured bundle is not automatically switched by training.

## 5. Read evaluation reports correctly

Evaluate the untouched test role after model selection:

```bat
.venv\Scripts\python.exe -m apms_ai.cli evaluate --bundle services\ai\artifacts\candidate --data services\ai\artifacts\synthetic.jsonl --role test --output services\ai\artifacts\candidate-test.json
```

The report contains per-query metrics keyed by field, horizon, and legal domain. Numeric `score_mae` and `score_rmse` are in the raw units of the target; RMSE squares residuals before averaging and therefore penalizes large errors more. `count` counts windows, while `independent_group_count` counts independent learner/group keys. Per-query numeric metrics include a label count, raw-target regression metrics, and RMSE/MAE slices by data origin. Category and trend accuracy report their own label counts. Failure risk reports Brier score, AUROC, average precision, calibration error, and recall at 0.5 where defined; AUROC and average precision are unavailable if only one class is present.

Persistence compares each prediction with the last observed value for the same target role. Its report uses only rows with both a target label and a usable prior observation. `model_vs_persistence` additionally recomputes model and persistence metrics on that exact matched subset; its count and skill scores make the denominator visible. Training-mean comparisons likewise use matched query labels and a per-field/horizon/domain mean fitted on train labels only, preferring real train records when present. New bundles may carry these means so disjoint external evaluation can use them without refitting. Older bundles without saved means report the external training-mean comparison unavailable; an exact saved-dataset evaluation can reconstruct it from the train role.

Baseline skill is `1 - model_error / baseline_error`: positive values favor the model, zero ties, and negative values favor the baseline. Skill is `null` if the baseline error is zero because the ratio has no finite denominator. Always inspect matched counts alongside skills; a persistence baseline on fewer rows must not be compared as though it covered every model label. Missing task labels do not become zeros. Empty or single-class metrics remain unavailable rather than being replaced with a favorable number.

Split-conformal intervals and risk-temperature calibration are fitted only from the calibration role:

```bat
.venv\Scripts\python.exe -m apms_ai.cli calibrate --bundle services\ai\artifacts\candidate --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\candidate-calibrated --coverage 0.9
```

Calibration produces a new immutable bundle. The interval radius is matched to field, horizon, and domain; insufficient samples leave the interval uncalibrated. Marginal coverage relies on exchangeability and adequate calibration data and gives no individual guarantee. Risk temperature scaling does not establish meaningful probabilities without representative real outcomes. Apply an external evaluation only to groups disjoint from every saved training and held-out group. The Python API supports explicit external evaluation with `score_bundle(..., external=True)`; it never fits transforms or calibration on those external labels.

## 6. Export, compress, and explain

Export the calibrated artifact with one representative input from the training dataset:

```bat
.venv\Scripts\python.exe -m apms_ai.cli export-onnx --bundle services\ai\artifacts\candidate-calibrated --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\candidate.onnx
```

Export checks dynamic ONNX parity and writes metadata plus a conformance fixture. Selective dynamic INT8 quantization requires held-out validation tensor parity and task-quality gates:

```bat
.venv\Scripts\python.exe -m apms_ai.cli quantize-int8 --bundle services\ai\artifacts\candidate-calibrated --onnx services\ai\artifacts\candidate.onnx --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\candidate-int8.onnx
```

If a gate fails, keep the original artifact and investigate the report; do not bypass the gate to obtain a smaller file. The `services\ai\mobile` JavaScript adapter accepts an injected ONNX Runtime session, encodes the eleven inputs, decodes constrained outputs, and includes a cross-language JSON feed helper. Mobile CPU inference is a portable baseline only. This workspace has no verified physical-device latency, memory, battery, Android, or iOS result.

Bounded SHAP explanations use a fixed schema and query with a background drawn from the train role:

```bat
.venv\Scripts\python.exe -m apms_ai.cli explain --bundle services\ai\artifacts\candidate-calibrated --data services\ai\artifacts\synthetic.jsonl --output services\ai\artifacts\explanation.json --max-evaluations 128
```

These are local model attributions for selected history values, not causal or policy explanations. Do not expose explanations as reasons for an official grade or risk decision.

## 7. Fine-tune or make an online candidate

For field-contract changes, preserve all old features and append new roles within embedding capacity. Keep validation, calibration, and test groups disjoint from the new training groups. Fine-tune creates a new candidate with fresh optimizer and calibration state; re-evaluate and recalibrate it before use.

`online-update` takes new real observations, bounded replay, and a real-only disjoint guard set. It validates group separation, trains a candidate, and reports non-regression against the incumbent. It never promotes automatically. Reuse of a guard set can overfit selection, so reserve a final untouched cohort and retain the incumbent bundle for rollback. Do not train or update inside an inference request.

The default guard permits no worsening of standing MAE, standing RMSE, or failure Brier. The respective `--mae-tolerance`, `--rmse-tolerance`, and `--brier-tolerance` options must be finite and nonnegative. Missing labels that leave any required metric unavailable reject the candidate; they never count as a perfect score. Set tolerances from an agreed real-data evaluation policy before inspecting candidate results.

## 8. Run the private service

Set the artifact, device, and a long random API key in the server process environment. Keep the key in a secret manager or an untracked environment file; never place it in a mobile app, repository, command-line argument, or log. The example below explicitly opts into synthetic artifacts for local development only. For a real-trained artifact, leave `APMS_AI_ENABLE_SYNTHETIC_DEMO` unset or `false`.

```bat
set APMS_MODEL_ARTIFACT_PATH=C:\apms\APMS\services\ai\artifacts\candidate-calibrated
set APMS_AI_DEVICE=cpu
set APMS_AI_SERVICE_API_KEY=replace-with-a-random-local-development-token
set APMS_AI_ENABLE_SYNTHETIC_DEMO=true
.venv\Scripts\python.exe -m uvicorn apms_ai.main:app --app-dir services\ai\src --host 127.0.0.1 --port 8080
```

`/health` reports liveness; `/ready` fails until a digest-checked model and service key are loaded. Authenticated inference routes are `/v1/predictions` for the gateway adapter and `/v2/forecasts` for typed examples. Keep the inference service private behind the authenticated gateway and TLS boundary. The service rejects unsupported schemas, malformed typed values, out-of-bounds outputs, oversized requests, and busy-worker requests; the application should continue its existing rule-based flow when advisory inference is unavailable.

Example server-side Python client for the local typed `/v2/forecasts` route. It reads one generated example so field names, units, and schema snapshots match the demonstration model; labels and training group keys are excluded from the request:

```python
import os
import json
from pathlib import Path
import httpx

with Path("services/ai/artifacts/synthetic.jsonl").open(encoding="utf-8") as stream:
    example = json.loads(next(line for line in stream if line.strip()))
payload = {
    "record_ref": "local-reference",
    "fields": example["fields"],
    "history": example["history"],
    "queries": example["queries"],
    "schema_context": example.get("schema", {}),
    "assessment_instances": [],
}

response = httpx.post(
    "http://127.0.0.1:8080/v2/forecasts",
    json=payload,
    headers={"Authorization": f"Bearer {os.environ['APMS_AI_SERVICE_API_KEY']}"},
    timeout=10.0,
)
response.raise_for_status()
forecast = response.json()
# Display as advisory with educator review; retain APMS rule outputs as authoritative.
```

The local address is for this development server. In deployment, authorized server-side callers use its private TLS route; the existing APMS gateway uses `/v1/predictions`. Field names and units must match roles supported by the selected bundle. Browser/mobile clients continue through the authorized application gateway and never hold the service token. Never log the payload, model inputs, student record references, or bearer key.

## 9. Container, monitoring, and rollback

For the complete app/Supabase connection, Docker running on another computer, secret-file mounts, custom usage limits, AWS ECS Fargate and Cloudflare Tunnel/Containers, follow [the cloud deployment guide](AI_MODEL_CLOUD_DEPLOYMENT.md). That guide also explains the required target-image/runtime verification; local Python tests do not establish Linux-container parity.

For versioned models and supporting artifacts stored outside a container image, follow [Supabase artifact storage](AI_MODEL_ARTIFACT_STORAGE.md). The optional worker loader verifies a pinned release and caches it at startup; training/checkpoint/report archives are not automatically loaded into serving.

The checked-in Compose configuration binds the service to loopback, mounts one artifact read-only, runs with a read-only filesystem and a temporary `/tmp`, drops capabilities, and checks `/ready`. From the repository root, copy the environment example to the ignored deployment file, edit the server-only token and absolute artifact path, and start it:

```bat
copy services\ai\deploy.env.example services\ai\.env.deploy
notepad services\ai\.env.deploy
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml up -d --build
docker compose --env-file services\ai\.env.deploy -f services\ai\compose.yaml ps
```

Do not commit `.env.deploy`; keep its token in an approved secret manager in deployed environments. The example binds only to `127.0.0.1`, so a remote Supabase gateway needs a deployed private/TLS service route or private reverse proxy. `localhost` is suitable only when the gateway and worker share the same host or a local reverse proxy. Never send the worker token to a browser or mobile app.

The container runs as UID 10001. Set request and concurrency limits for measured worker capacity. Use `/metrics` only from trusted infrastructure with authorization; it reports worker-local counts and latency without request bodies. CUDA use requires a CUDA-enabled image, compatible PyTorch/CUDA libraries, and host GPU container runtime; the checked-in Compose service and image default to CPU. No GPU performance is claimed.

For a release, stage a new immutable bundle, run its evaluation and calibration checks, start a candidate worker with the read-only mount, verify the Compose health check and `/ready`, and direct a small private canary through the gateway. Monitor errors and latency, then switch traffic only under the institution's deployment process. Roll back by selecting the prior immutable artifact in the deployment environment and restarting workers. Model rollout is independent of the APMS grading and risk engines. The Compose file was inspected but no Docker build or deployment was run as part of this documentation work.

## 10. Evidence and limitations

Run the package checks with:

```bat
.venv\Scripts\python.exe -m pytest services\ai -q
```

Synthetic metrics describe only the synthetic generator. Release decisions require representative, permissioned real data, group-disjoint and preferably later-time evaluation, baseline comparison, calibration review, and subgroup/error analysis appropriate to the institution. Forecasts do not guarantee outcomes, calibrated risk on a new population, fairness, or institutional validity. See [the architecture](AI_MODEL_ARCHITECTURE.md), [validation report](AI_MODEL_VALIDATION.md), and [mobile contract](../services/ai/mobile_contract.json).

For a beginner's explanation of training, metrics, baselines, and the current accuracy evidence, see [how the forecasting model learns](AI_MODEL_TRAINING_EXPLAINED.md). For a non-destructive inventory of model bundles, checkpoints, data, environments, and experiment files, see [AI workspace files and safe cleanup](AI_MODEL_FILES_AND_CLEANUP.md).
