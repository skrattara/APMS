# Transformer implementation plan

Read `AI_MODEL_ARCHITECTURE.md` together with `analysis/AI_PROVIDER_INTEGRATION.md`, the current Python service, domain contracts/validators, both JSON schemas, example representations, and deterministic engines before implementation. Preserve unrelated working-tree changes.

1. **Contracts and compilation:** add strict typed records, configurable limits, schema loading/validation, reference checks, scalar constraints, graph context and fixture adapters under `services/ai/src/apms_ai`.
2. **Data:** add JSON/JSONL/CSV ingestion, training-only preprocessing, seeded multi-family generation, group-disjoint partitions, masked collation and real-priority sampling. Document the real-data contract with executable examples.
3. **Model:** implement an exportable shared schema-conditioned Transformer with variable observation/query tokens, legal mixed-type decoding, quantile forecasting, trend and failure heads, and masked multi-task losses.
4. **Lifecycle:** implement Fabric pretraining/training/resume/finetuning, seeded tuning, early stopping, artifact metadata, independent calibration, evaluation/baselines/error analysis and structured logs.
5. **Adaptation:** implement bounded real-priority replay and candidate-only online updates with disjoint validation and non-regression/promotion checks.
6. **Inference and packaging:** integrate authenticated FastAPI serving and the existing custom-provider contract; add SHAP, smaller-student distillation, ONNX export/parity, INT8 validation, mobile preprocessing contract, container and operational instructions.
7. **Playground and documentation:** provide a valid `.ipynb`, small example configuration/data, service README, architecture links and exact `cmd` commands. Explain unsupported cases and evidence limitations explicitly.
8. **Review and validation:** GPT-6 Luna at medium reasoning implements; the primary agent reviews changes, fixes findings and runs meaningful CPU tests and an end-to-end smoke workflow. Record installed versions, test results, synthetic metrics, export parity and any unavailable GPU/mobile hardware verification.

Keep implementation modular. Use optional ML/export/explainability dependencies so readiness/contract behavior can be inspected without downloading a model. All temporary files, environment directories, download/install caches and generated artifacts must be inside the project workspace. Run commands through `cmd.exe`. Do not modify the app, database or gateway to bypass privacy controls. Do not silently activate a synthetic model in production.

## Accuracy and coverage follow-up

1. Extend generation through a validated `SyntheticConfig`: independent dynamics/noise/policy parameters, typed nuisance and cross-subject observations, null/absent/burst missingness, partial labels, and grouped learner windows. Keep distributions configurable and identities outside predictive inputs.
2. Keep the original absolute numeric head loadable; compare it with optional persistence-centered bounded residual quantiles. Add training-only token dropout, normalized median SmoothL1 loss, configurable minimum validation improvement, and count-weighted validation summaries.
3. Expose raw-unit RMSE/MAE, matched persistence and training-mean baselines, label counts, skill and RMSE slices. Fit means exclusively on training labels and carry them into external evaluation. Extend online non-regression checks to RMSE.
4. Freeze a common dataset and comparison settings before inspecting holdout results. Select with validation only, calibrate separately, and report both numeric improvements and any task regressions. Synthetic accuracy remains distinct from institutional evidence.
5. Add a complete cmd.exe usage/deployment guide and a private Compose recipe. Explain schema constraints, missingness, residual links, regularization and artifact compatibility in code comments. Verify tests and actual CPU export/runtime behavior; record unavailable container/GPU/device checks.

## History-aware architecture and beginner documentation

1. Add an opt-in query-local numeric-history summary branch without changing the eleven tensor inputs or four outputs. Compute summaries from the same learner's observed numeric values only; keep padding, missing-value and single-observation behavior explicit. Preserve all old bundle state dictionaries when disabled.
2. Add an optional squared-error center objective and normalized numeric-RMSE checkpoint selection. Save these choices in resume contracts, retain legacy defaults, and distinguish selected weighted loss from the actual checkpoint-selection score.
3. Freeze `examples/history-comparison.json` and a new synthetic dataset seed before validation. Compare absolute, residual-control and history-context variants on identical groups and budgets. Select on validation under MAE and risk-Brier guards, open test once after freezing selection, and retain all failures and tradeoffs.
4. Explain tokenization, attention, observed-label masks, regularization, gradient updates, held-out roles, early stopping and checkpointing in plain code comments and a separate training guide. Document conditional cleanup rules for source, caches, environments, bundles, datasets, checkpoints and export sidecars. Delete nothing as part of documentation work.

## Docker, application and Supabase integration

1. Provide a CPU inference-only runtime image, a minimal immutable model package/image, loopback/read-only Compose configuration and secret-file mounts. Building runs on a Docker-capable host; app development and Supabase API bundling can stay on this PC.
2. Extend the existing privacy-preserving gateway rather than introduce a direct client-to-worker route. Bound request/response bytes and deadlines, disallow redirects and unsafe endpoint forms, support paired Cloudflare Access credentials, and validate response record/artifact identities before any batch save.
3. Add a service-role-only atomic custom-usage reservation RPC using UTC month boundaries and a protected nullable monthly limit. Keep custom per-record budgets separate from provider token budgets. Expose quota and secret-free connection/probe status in System Admin settings, checking active global roles server-side.
4. Supply AWS Fargate/ALB/Secrets Manager and Cloudflare Tunnel/Containers deployment paths, with immutable image references, no worker database credentials, restricted networking and explicit synthetic-demo controls. Document deploy order, staging checks, target-image parity, credential rotation, canary and rollback.
5. GPT-6 Luna Medium implements the service/gateway/UI/infrastructure changes; the primary agent reviews and verifies tests, type checks, SQL semantics and template structure. Record the absence of Docker/cloud provisioning locally. Keep production promotion and real-cohort quality approval separate from an operational connection check.

## Artifact storage and user-facing forecasts

1. Add a private artifact bucket protected against broad browser policies, and a machine-only broker that signs only the files in a pinned immutable manifest. Bound Storage responses before SDK buffering. Keep the service-role key solely in the Edge Function.
2. Add an optional startup-only worker loader with strict file/origin/size/hash validation, atomic publication and verified offline-cache reuse. Preserve local/image-backed deployment and add remote settings to Compose, Fargate and Cloudflare. Do not fetch weights during a prediction request.
3. Reuse the existing authorized prediction gateway from full Gradebook, AI Prediction and attention-review actions. Show saved advisory values consistently across relevant class/detail/report views, preserve recorded scores and apply the active deterministic evaluation rules. Support API-sized batches honestly, including partial-completion reporting.
4. Correct the distinction between outcome risk probability and independent model confidence, and make absent confidence obey configured confidence gates. Preserve zero predictions, suppress overlays for assessments that now have recorded results, and label time freshness without claiming records/schema currentness.
5. Luna Medium implements; primary review checks storage/auth/cache failure behavior, class authorization, schema compatibility, UI integration, type checks, tests and deployment documentation. Live Storage uploads/cloud/Docker startup remain target-environment checks.
