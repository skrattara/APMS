# APMS advisory forecasting service

This private service provides schema-conditioned sequence forecasts. It predicts only fields explicitly requested by the existing gateway contract. The APMS grading and evaluation engines remain authoritative for official grades and risk classifications. Predictions are advisory, require human review, and have not been institutionally validated.

The checked-in component grading example is semantically invalid: it references assessment types absent from its declaration. The validator rejects it. The service does not repair the fixture or silently accept aliases that the domain engine rejects.

## Local setup

From the repository root in cmd.exe:

    python -m venv .venv
    .venv\Scripts\python.exe -m pip install -e "services\ai[ml,test]"
    set PYTHONPATH=services\ai\src
    set APMS_AI_SERVICE_API_KEY=use-a-long-server-only-secret
    set APMS_MODEL_ARTIFACT_PATH=C:\apms\APMS\artifacts\active
    .venv\Scripts\python.exe -m uvicorn apms_ai.main:app --host 127.0.0.1 --port 8080

Only the gateway may possess the bearer secret. Mount the selected artifact directory read-only and run the process as an unprivileged user. /health reports liveness; /ready requires a digest-checked artifact. Artifact load, authentication, schema, request-size, or output-contract failures fail closed.

## Workflow

The apms-ai CLI exposes generate, ingest-csv, pretrain, train, finetune, distill, tune, evaluate, calibrate, online-update, explain, export-onnx, and quantize-int8. Resume is available with train --resume, while train --init-from initializes supervised learning from a compatible pretraining bundle. Distillation trains a smaller student against a saved teacher and keeps the original split roles for its supervised loss. JSON datasets may be a single array or an object with an `examples` array; JSONL remains supported. Training commands accept a JSON parameter profile such as examples/demo-training.json through --config; data and output paths remain explicit command arguments. Task loss weights default to numeric=3, category=1, trend=0.5, and failure=1 and can be adjusted in the profile. The notebook in examples demonstrates a short synthetic-only workflow. A CLI demonstration:

    mkdir services\ai\artifacts
    .venv\Scripts\python.exe -m apms_ai.cli generate --output services\ai\artifacts\demo.jsonl --count 320 --seed 42
    .venv\Scripts\python.exe -m apms_ai.cli train --data services\ai\artifacts\demo.jsonl --output services\ai\artifacts\demo --width 32 --epochs 25 --patience 6
    .venv\Scripts\python.exe -m apms_ai.cli evaluate --bundle services\ai\artifacts\demo --data services\ai\artifacts\demo.jsonl --role test --output services\ai\artifacts\demo-test.json
    .venv\Scripts\python.exe -m apms_ai.cli calibrate --bundle services\ai\artifacts\demo --data services\ai\artifacts\demo.jsonl --output services\ai\artifacts\demo-calibrated --coverage 0.9

Generated datasets and artifacts stay in the ignored `services/ai/artifacts` directory. Choose a fresh output path for each final bundle. The JSON configuration overrides parser defaults and flags with the same names; keep `data` and `output` paths explicit. To serve this synthetic demonstration, explicitly set `APMS_AI_ENABLE_SYNTHETIC_DEMO=true` and point `APMS_MODEL_ARTIFACT_PATH` at the calibrated directory before starting the server. The opt-in is a development setting.

Calibration writes a new immutable bundle; its held-out interval radius and optional binary risk temperature are persisted and used by inference. A query with insufficient calibration data records an unavailable reason and remains explicitly uncalibrated. Fine-tuning starts from a saved model with a fresh optimizer. Exact resume requires matching data fingerprint and training configuration and restores the last optimizer/model state separately from the best inference model.

JSONL records declare typed fields, ordered history, one scalar query per requested field and horizon, aligned labels, a local group, origin, and optional grading/evaluation snapshots in schema. Numeric observations may be null; missing data is not imputed as zero. Query choices and bounds become model inputs and output constraints. Group partitions are disjoint train, validation, calibration, and test roles. Preprocessing and vocabularies are fit on training data; opaque source IDs are not predictive features.

Assessment-instance context uses the gateway's privacy-projected `assessment_ref`, `assessment_type_ref`, `maximum_score`, `scoring`, and optional period/group/weight fields. `validate_assessment_instances` rejects mismatched scoring maps, invalid scope/count inventories, and weighted records without explicit weights. `compile_assessment_constraint` exposes numeric bounds or a closed legal-choice set for each instance; it does not rewrite an invalid record. Synthetic examples exercise numeric, mapped numeric, categorical P/A, trend, failure, and multiple forecast horizons.

The CSV adapter supports a flat numeric snapshot and future numeric target. Use JSONL for longitudinal records, mixed types, mappings, or schema snapshots. Real records must have a stable local group key for leakage-safe splitting. A group should cover the same student across classes and windows when leakage is possible. The built-in split is seeded and grouped, not a chronological split: use independent later-cohort external evaluation before deployment. New feature names use append-only fine-tuning with incumbent fields retained; within configured embedding capacity this does not change the architecture. Online update requires a separate non-overlapping real guard set and produces a candidate bundle only; it never promotes the candidate automatically. Repeatedly selecting against the same guard set can overfit it; retain a fresh final cohort for promotion evidence.

## Model and evidence

The model encodes typed history tokens with temporal position, attends to the full structural grading/evaluation schema and per-query field, horizon, type, legal choices, and bounds. It has monotone numeric quantiles plus categorical, trend, and failure heads with independent masks. Artifact bundles include the schema files and hashes used for encoding.

The optional `--numeric-history-context` branch adds observed same-field summaries to the Transformer and numeric correction. It handles padding and missing history explicitly and preserves the eleven-input ONNX/mobile contract. `--numeric-center-loss-kind mse` emphasizes larger point errors, and `--selection-metric numeric_rmse` selects checkpoints using normalized numeric validation error rather than weighted task loss. Existing models retain their saved behavior. A reproducible three-variant comparison is defined in `examples/history-comparison.json` and run with `examples/compare_history_models.py`; see the usage guide for its separate prepare/train/select/final stages.

The seeded generator creates distinct synthetic dynamics and policy thresholds for exercising code paths. Synthetic outputs are demonstration labels only. They do not establish prediction accuracy, calibration quality, fairness, or institutional validity. Use real de-identified records under institutional data controls and report measured held-out evidence for the specific cohort and model.

Evaluation reports include score MAE and RMSE in target units, task-specific label counts, and error RMSE slices by origin. Persistence and training-mean baselines expose their own matched-label counts; model skill compares the model and baseline on the same rows (`1 - model error / baseline error`, so positive favors the model). The training mean is fit from train labels only and prefers real train records. External evaluation can use a saved per-query training mean; old bundles without it leave the external mean comparison unavailable. See [the end-to-end data and deployment guide](../../docs/AI_MODEL_USAGE_DEPLOYMENT.md) for report denominators and workflow details.

ONNX export runs dynamic parity checks across batch, history, query, and schema sizes. INT8 publication requires tensor parity and held-out labeled non-regression; failed gates do not publish an artifact. SHAP is a bounded model explanation, not a causal or policy explanation. Mobile use is subject to mobile_contract.json; no device latency or hardware result is claimed until measured on representative devices.

`export-onnx --bundle ... --data ... --output ...onnx` writes the tensor core, portable metadata, a centered-zero conformance fixture, and a parity report. `quantize-int8 --bundle ... --data ... --onnx ... --output ...int8.onnx` checks the saved validation partition before publishing selective feed-forward INT8 weights; attention and output heads remain FP32 when full quantization would lose quality. `mobile/index.mjs` supplies the eleven-input encoder and actual ONNX Runtime tensor decoder; see [mobile integration](mobile/README.md).

## Operations and deployment

See [Docker, Supabase, AWS and Cloudflare deployment](../../docs/AI_MODEL_CLOUD_DEPLOYMENT.md) for building on another computer, secret-file mounts, System Admin connection checks, custom forecast quotas, Cloudflare Tunnel/Containers, and the AWS Fargate template. Deployments use immutable inference packages; training and online learning remain separate jobs. Docker is not required on the app development PC.

For models stored outside the image, use [Supabase artifact storage](../../docs/AI_MODEL_ARTIFACT_STORAGE.md). `package_model.py --manifest` produces the pinned release manifest; the optional startup loader fetches only the approved inference files through a machine-authenticated broker, verifies every file and caches it. It supports offline reuse of an intact pinned cache. Compose has a separate `compose.storage.yaml` variant, and AWS/Cloudflare support the same server-only artifact settings. No Supabase service-role key is installed in the worker.

Use `--accelerator cpu`, `cuda`, or `auto` for Fabric training and fine-tuning; select compatible Torch wheels for the host GPU. Set `APMS_AI_DEVICE` similarly for inference. CPU defaults to `32-true` precision; GPU mixed precision is an explicit `--precision` choice. This implementation uses one device per process. No distributed scaling or GPU hardware result is claimed.

Each checkpoint stores the last model/optimizer/RNG state and the best validation model separately. A training run writes aggregate per-task epoch metrics to `<output>.metrics.jsonl`. `debug --bundle ... --data ... --output ...json --backward-check` verifies the artifact, finite forecasts/gradients, typed label coverage, missingness, and descriptive median/IQR shift signals. Drift signals are not statistical significance tests and do not automatically retrain a model. Service logs contain event types, status, latency, model identity and device; no request bodies or student references. Configure a log collector and poll the authenticated worker-local `/metrics` endpoint in your deployment.

The container recipe is `docker build -f services/ai/Dockerfile -t apms-ai .` from the repository root. Run it behind the existing private gateway/TLS boundary, supply `APMS_AI_SERVICE_API_KEY`, and mount the selected immutable artifact read-only at the configured path. The image runs as UID 10001. Default limits are a 1 MiB request, two concurrent inferences per worker, 512 history tokens, 128 query slots, and 4096 schema tokens; field/category capacity is part of the saved model configuration. Oversized inputs fail instead of being truncated. Scale worker count against measured memory and latency. Changing the artifact requires worker restart; readiness must pass before switching traffic, and rollback selects the previous immutable bundle. CUDA container runtime and physical mobile deployment need target-environment verification.

## Verification

    .venv\Scripts\python.exe -m pytest services\ai -q

Tests cover schema semantics, privacy-safe schema encoding, group splits, missing values, output constraints, multitask gradients, schema/query dependence, train/resume/calibration/inference integration, authenticated fail-closed serving, ONNX dynamic parity, and INT8 acceptance or rejection.

See [the validation report](../../docs/AI_MODEL_VALIDATION.md) for measured synthetic results, baseline comparisons, review findings and unverified hardware/deployment checks. The latest controlled history-context comparison reduced mean test MAE by 22.1% and RMSE by 10.8% versus its absolute-head control, and beat persistence on matched score rows at both horizons. Category accuracy regressed and nominal 90% interval coverage was not met, so this remains development evidence. Earlier generator/seed results are retained separately.

For a beginner explanation of the metrics and current accuracy evidence, see [how the forecasting model learns](../../docs/AI_MODEL_TRAINING_EXPLAINED.md). Before reorganizing generated outputs, use the [AI workspace files and safe cleanup guide](../../docs/AI_MODEL_FILES_AND_CLEANUP.md); ignored artifacts can include the only copy of a model, dataset, or experiment record.
