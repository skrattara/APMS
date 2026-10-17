# Transformer implementation review and validation

Validated locally on October 17, 2026. GPT-6 Luna with medium reasoning wrote the implementation and mobile reference adapter; the primary agent reviewed the changes, corrected findings, and ran the checks below. Existing unrelated app, domain, gateway, and database edits were preserved. Commands ran through `cmd.exe`; environments, caches, notebook runs, datasets, and artifacts stayed inside this workspace.

## Verification evidence

| Check | Result |
| --- | --- |
| Python service tests | 98 passing, including comprehensive generation, target-only scaling, RMSE denominators, history-context padding/gradient/export checks, new and legacy exact CPU resume, pretraining transfer, Windows checkpoint retries, typed/missing records, schema semantics, real-first preprocessing, calibration, serving, quantization rejection, and JavaScript tensor conformance |
| Existing domain tests | 22 passing across four test files |
| Static checks and formatting | Ruff undefined-name/import checks pass; Python source and tests formatted |
| Installable package | Wheel builds; an extracted package loads its bundled schemas, generates data, and verifies the final bundle without repository schema paths |
| Playground | Current notebook executed all seven default code cells; optional expensive workflows are disabled by default |
| Lifecycle commands | Masked pretrain, supervised initialization, two-trial tuning, fine-tune, distillation, calibration, evaluation, SHAP, debugging, export and guarded online candidate workflows exercised |
| Loaded HTTP service | Final calibrated synthetic bundle serves authenticated typed forecasts; unauthenticated requests reject; readiness and aggregate metrics checked |
| Mobile reference | Four full-schema examples match all eleven Python tensors at `1e-6`, ONNX outputs at `1e-4`, decoded values at `1e-3`, and calibrated risk probabilities at `1e-5` on CPU |

The online protocol fixtures were artificial data explicitly marked `origin=real` solely to exercise the real-data guard path. Its permissive smoke tolerances are **not accuracy evidence**. No model was automatically promoted. The final distillation and tuning commands were rerun after review fixes; the exact CPU resume invariant is part of the current test suite.

Runtime: Python 3.14.3, PyTorch 2.14.1, Lightning Fabric 2.6.6, NumPy 2.5.4, ONNX 1.23.2 and ONNX Runtime 1.31.0. Artifact metadata also records installed runtime versions. CPU was available; CUDA was unavailable. Export uses ONNX opset 17 and verifies dynamic batch/history/query/schema dimensions. PyTorch legacy-export and nested-tensor warnings remain; parity checks pass despite those warnings.

## History-context architecture comparison: latest result

The new optional branch summarizes each requested numeric field's observed history and supplies those features to the Transformer and numeric head. It preserves the external tensor and schema contracts. Training can use an auxiliary squared-error center loss and numeric-RMSE checkpoint selection. Existing bundles retain their original settings. See [the architecture](AI_MODEL_ARCHITECTURE.md) and [beginner explanation](AI_MODEL_TRAINING_EXPLAINED.md).

The comparison declaration is `services/ai/examples/history-comparison.json`, with a checked-in runner `compare_history_models.py`. The comprehensive generator was unchanged; a **fresh seed 20261021** produced 640 windows/320 independent learner groups. Splits contain 448/64/64/64 windows and 224/32/32/32 groups. Data, protocol, source digests/snapshot and environment versions were saved before selection. These numbers must not be compared directly with the different-seed historical runs below.

All variants used seed 42, width 32, one layer, four heads, batch size 32, learning rate 0.001, dropout 0.1, weight decay 0.01, up to 24 epochs, patience six and minimum improvement 0.0001. Checkpoints were selected by normalized pooled numeric validation RMSE. The absolute control had no center auxiliary loss or input dropout. The residual control used the additive link, MSE center weight 1 and input dropout 0.03. The history-context variant added only the new branch to that residual configuration. Shared parameter initialization was preserved; stochastic training and differing selected epochs still limit causal attribution to one component.

| Validation variant | Mean score MAE | Mean score RMSE | Horizon-1 failure Brier | Selected epoch / epochs run |
| --- | ---: | ---: | ---: | ---: |
| Absolute control | 10.038 | 13.035 | 0.07293 | 23 / 24 |
| Residual control | **8.306** | 13.078 | 0.16014 | 4 / 10 |
| History context, selected | 8.383 | **13.000** | **0.07250** | 10 / 16 |

The predeclared rule minimized mean raw score RMSE across horizons 1 and 2, required MAE no worse than the absolute control, and allowed at most 0.02 worse horizon-1 failure Brier. The residual control failed the risk guard. History context passed and was selected before test/calibration results were opened. Its validation RMSE margin was only **0.27%**, so it should not be oversold. Calibration and final evaluation did not change the selected model.

| Held-out synthetic test metric | Horizon 1 | Horizon 2 |
| --- | ---: | ---: |
| Numeric label count | 58 | 59 |
| Absolute-control MAE, all numeric labels | 9.428 | 9.695 |
| History-context MAE, same labels | **6.849** | **8.044** |
| Absolute-control RMSE, all numeric labels | 13.564 | 14.532 |
| History-context RMSE, same labels | **11.584** | **13.468** |
| Matched persistence comparison count | 55 | 56 |
| History-context MAE, matched subset | **5.671** | **6.770** |
| Persistence MAE, same subset | 6.039 | 7.483 |
| History-context RMSE, matched subset | **9.405** | **11.447** |
| Persistence RMSE, same subset | 10.150 | 12.410 |
| Absolute-control uncalibrated failure Brier | 0.11442 | 0.10569 |
| History-context uncalibrated failure Brier | **0.08839** | **0.06655** |
| History-context calibrated failure Brier | 0.08852 | 0.06828 |
| History-context failure AUROC | 0.955 | 0.972 |
| History-context trend-head accuracy | 56.90% | 45.00% |
| Calibrated interval coverage, nominal 90% | **79.31%** | **74.58%** |
| Calibrated interval mean width | 28.626 | 36.582 |

Mean MAE across horizons decreased **22.1%** (9.561 → 7.447) and mean RMSE decreased **10.8%** (14.048 → 12.526) against the same-data absolute control. On matched rows, persistence MAE was beaten by 6.1%/9.5% and RMSE by 7.3%/7.8%. These are error reductions, not percentages of student-level accuracy. There are only **32 independent test groups**, and training used one model seed.

The gain is not universal. Categorical P/A accuracy fell 55.93% → **50.85%** (59 labels). Boolean failure-target accuracy stayed 85.19% (54); mapped-score accuracy rose 69.23% → 71.15% (52), and categorical trend-target accuracy rose 48.21% → 53.57% (56). Dedicated trend-head accuracy rose from 46.55%/41.67%, but remains modest. The numeric-focused selection rule guards failure Brier, not every categorical task.

**Uncertainty calibration did not meet its nominal coverage on this test cohort.** Neither the 90% label nor a saved calibrated flag establishes usable coverage. Repeated windows within a learner are correlated, and the current calibration routine uses per-window scores; student-group exchangeability and group-aware calibration need separate validation before a student-level coverage claim. Do not widen intervals or retune temperature using these test outcomes and then describe the same cohort as independent acceptance evidence. A new untouched cohort is required for a new calibration-method claim. Risk temperature scaling also slightly worsened Brier here; report both versions.

Post-selection descriptive analysis resampled learner groups rather than individual windows: 2,000 paired bootstrap samples, seed 20261023, 31 groups with horizon-1 numeric labels. The selected-minus-absolute 95% percentile intervals were MAE [-3.975, -1.057] and RMSE [-3.843, -0.376] points. This supports the observed gain within this synthetic cohort; it does not establish real-world performance or variation across training seeds. The three no-prior-score test windows remain difficult: MAE 28.444 for history context versus 30.202 for the absolute control. Missing information has not been solved by architecture alone.

An additional fixed cohort was generated **after selection**, with seed 20261022 and the same generator profile: 256 windows/128 disjoint groups. No outcomes changed the model. Mean score MAE improved 9.669 → 7.309 and RMSE 13.639 → 11.641. Horizon-1 uncalibrated failure Brier **worsened** 0.12151 → 0.12655; calibration reduced it to 0.12495, still slightly worse than the absolute control. Calibrated interval coverage remained below nominal at 83.69%/85.96%. This is an additional synthetic-cohort check, not a new institution or time-shift test. Risk improvement is not consistent across cohorts.

The calibrated model passed dynamic FP32 ONNX parity and four full-schema Python/JavaScript/ONNX cases covering all eleven tensors, typed decoding and calibrated probabilities. Authenticated HTTP inference, rejection without credentials, metrics and finite backward diagnostics passed. Selective INT8 passed the 64-window validation gate: normalized numeric MAE 0.230006 → 0.230068, RMSE 0.357443 → 0.357558, category error 0.348214 → 0.352679, trend error 0.460411 → 0.463343 and uncalibrated failure Brier 0.099666 → 0.099330. Maximum tensor discrepancy was 0.050252 against 0.15; every task degradation stayed below 0.02. FP32 is 469,489 bytes and INT8 463,819 bytes (**1.21% smaller**); no latency gain is claimed.

The absolute-control run hit a Windows checkpoint backup-rename lock after epoch 20 metrics were written. Bounded atomic-rename retries were added and tested. Resume restored epoch 19; the orphan epoch-20 log was archived and replayed, and **all replayed epoch-20 metrics matched exactly**. The model/training executable syntax trees remained unchanged after freeze; later source changes outside checkpoint I/O were comments/formatting only. Original snapshots, recovery code, amendment and verification are retained.

Current evidence is under ignored `services/ai/artifacts/history-v3`: frozen data/profile/protocol, source snapshot/digests, environment list, three candidates/checkpoints/metrics, selection/final reports, calibrated bundle, external-cohort and descriptive reports, ONNX/INT8 sidecars, runtime checks and recovery records. `examples/history-aware-training.json` is the selected flat training profile. **No production promotion occurred.** Numeric accuracy improved on these synthetic cohorts; interval coverage, weak category/trend tasks, real data, CUDA and physical mobile hardware still need work. See [files and safe cleanup](AI_MODEL_FILES_AND_CLEANUP.md) before deleting generated evidence.

## Earlier comprehensive-generator follow-up

The expanded generator has ten dynamics families and six independently sampled noise laws, including shocks, delayed responses, interventions, seasonal paths, mean reversion, heteroscedastic regimes, skew, mixtures and heavy tails. It varies policy thresholds, feature coupling, missing fields, nulls, bursts, sparse/empty histories, partial labels, horizons and repeated learner windows. Family/noise identities are not predictive features. Generated records retain explicit synthetic provenance and validate against the same input contract as real records. No simulator can cover all possible real distributions.

The frozen `synthetic-comprehensive.json` profile produced 640 windows from 320 independent groups with seed 20261017. Group partitioning yielded 448/64/64/64 windows, or 224/32/32/32 independent groups. The matched training profiles are checked in as `comprehensive-legacy-training.json` and `comprehensive-residual-training.json`. Both ran 16 CPU epochs, width 32, one layer, four heads and training seed 42. The residual candidate uses an additive last-observation correction, median SmoothL1 weight 0.5, observed-token dropout 0.05, dropout 0.15, weight decay 0.02 and early-stop minimum improvement 0.002. Its no-observation initial anchor is the train median; bounds and quantile ordering are enforced inside the graph.

Selection minimized validation RMSE averaged across the two score horizons, with a risk Brier guard of at most 0.03 degradation. A logit residual candidate was also evaluated. The additive candidate was added after observing validation-only saturation behavior; calibration and test outcomes remained unopened until selection was frozen. Validation-only development can still overfit a small validation cohort; these results are preliminary.

| Validation model | Mean score MAE | Mean score RMSE | Horizon-1 failure Brier |
| --- | ---: | ---: | ---: |
| Legacy head, retained by selection | 10.466 | **13.000** | **0.0747** |
| Logit residual candidate | 7.940 | 13.457 | 0.0867 |
| Additive residual candidate | **7.728** | 13.274 | 0.0858 |

The additive candidate reduced validation MAE by **26.2%**, but RMSE increased **2.1%**. It was therefore **not selected**. This is a measured tradeoff, not an across-metric accuracy gain. Fresh-training residual defaults and the quick-start profile are configurable experimental starting points; neither is a validated release recommendation. Existing bundles preserve their saved head/link behavior.

Only the selected legacy model was evaluated on the held-out test role. Calibration then used the separate calibration role; the table uses the calibrated bundle. Neither test results nor stress results were used for further model selection.

| Comprehensive synthetic test metric | Horizon 1 | Horizon 2 |
| --- | ---: | ---: |
| Numeric label count | 59 | 59 |
| Model MAE, all numeric labels | 12.468 | 13.187 |
| Model RMSE, all numeric labels | 17.077 | 17.747 |
| Matched persistence comparison count | 52 | 51 |
| Model MAE, matched subset | 10.648 | 11.436 |
| Persistence MAE, same subset | **5.769** | **6.260** |
| Model RMSE, matched subset | 12.320 | 14.137 |
| Persistence RMSE, same subset | **8.914** | **9.659** |
| Failure label count | 55 | 56 |
| Failure AUROC | 0.897 | 0.881 |
| Calibrated failure Brier | 0.1093 | 0.1340 |
| Trend-head accuracy | 52.73% | 44.64% |
| Calibrated interval coverage, nominal 90% | 91.53% | 94.92% |
| Calibrated interval mean width | 49.880 | 58.602 |

There are **32 independent test groups**, not 64 independent students. Missing prior target values reduce the persistence comparison denominator; the matched rows above prevent misleading comparisons. Persistence wins both score metrics. Broad intervals and modest trend accuracy limit usefulness. The selected model must not be described as high accuracy or ready for institutional use.

A separately generated, unselected stress set used 128 windows/64 new groups, seed 20261018, noise scales 8–14, field missingness 0.25, structural absence 0.12, burst missingness 0.4 and empty-history probability 0.08. Horizon-1 MAE was 15.040, RMSE 20.112 and uncalibrated failure Brier 0.2001. This is a synthetic perturbation check, not an independent real population or a guarantee against shift.

New anti-overfitting controls complement the existing grouped splits, real-first fitting, weight decay, clipping and early stopping: observed-token dropout runs only during training; losses pool each task by labeled counts; exact resume restores saved regularization; online promotion guards now include RMSE and reject unavailable/nonfinite metrics. Numeric target-only fields use train labels as fallback scaling only when no observed history values exist. No held-out labels fit preprocessing. These controls reduce specific risks; they cannot guarantee absence of overfitting.

Current generated evidence is ignored under `services/ai/artifacts/comprehensive-v2`: the frozen generator/protocol, per-run validation reports, `selection.json`, `final-report.json`, `selected-calibrated-test.json`, stress reports, calibrated bundle, ONNX exports and runtime reports. The current FP32 ONNX model is 433,616 bytes; selective INT8 is 414,564 bytes (**4.39% smaller**, six feed-forward matrices). Its 64-window validation gate passed: normalized numeric MAE 0.316782 → 0.307259, **RMSE 0.393499 → 0.381631**, category error 0.331897 → 0.323276, trend error 0.551020 → 0.545190, and uncalibrated failure Brier 0.077220 → 0.077340. Maximum tensor discrepancy was 0.144750 against tolerance 0.15; each task degradation stayed below 0.02. No latency improvement is claimed.

The seven-cell notebook reran successfully with the new defaults. The new calibrated bundle passed four complete Python/JavaScript/ONNX reference cases with all eleven input tensors, authenticated HTTP inference, unauthenticated rejection, metrics and finite backward diagnostics. The package wheel rebuilt successfully. See [usage and deployment](AI_MODEL_USAGE_DEPLOYMENT.md) for CPU/GPU profiles, JSONL/CSV ingestion, evaluation denominators, fine-tuning, online guards, server/client examples and private Compose deployment. Docker, CUDA and physical mobile hardware remain unverified.

## Historical four-family synthetic benchmark

This earlier benchmark used a different generator. Its numbers are retained for traceability and must not be compared directly with the comprehensive-generator metrics above.

Seed 42, 320 independent synthetic groups, four families with normal/uniform/triangular/heavy-tail noise, varied missingness and lengths, and independently varied grading/evaluation thresholds. The group split was 224 training / 32 validation / 32 calibration / 32 test. A width-32, two-layer Transformer used dropout 0.1, AdamW weight decay 0.01, gradient clipping, task weights 3/1/0.5/1, and validation patience six. Training stopped after 18 of 25 allowed epochs; best weighted validation loss was 1.97348. Test outcomes did not select weights or calibration parameters.

| Synthetic test metric | Horizon 1 | Horizon 2 |
| --- | ---: | ---: |
| Score MAE, percentage points | 7.714 | 10.395 |
| Persistence MAE, percentage points | **5.896** | **8.038** |
| Failure AUROC | 0.906 | 0.827 |
| Failure average precision | 0.932 | 0.852 |
| Calibrated failure Brier | 0.128 | 0.176 |
| Trend-head accuracy | 75.0% | 75.0% |
| Calibrated interval empirical coverage, nominal 90% | 93.75% | 90.625% |
| Calibrated interval mean width, percentage points | 43.906 | 47.051 |

Other queried outputs: categorical P/A accuracy 87.5%, boolean failure-target accuracy 75.0%, four-value mapped-score accuracy 53.125%, and categorical trend-target accuracy 71.875%. These are different query heads; the categorical trend target and dedicated trend head need not agree. The sample has only 32 test groups and wide intervals. **The Transformer did not beat persistence on numeric MAE. This demonstration is not an accepted improvement over baseline and must not be presented as a high-accuracy or institutionally validated model.** Real data, cohort-specific baselines, further validation-only tuning and a new independent final cohort are required before a deployment quality decision.

The model supports new valid grading/evaluation snapshots during inference. It enforces their supported numeric/mapped/categorical domains, but semantic predictive generalization to arbitrary unseen policies is unmeasured. Conformal coverage is marginal under exchangeability, not a per-student or distribution-shift guarantee. Categorical class probabilities are explicitly uncalibrated.

## Historical compression and runtime

The final FP32 ONNX core is 502,528 bytes. Eight feed-forward matrices were dynamically quantized to INT8; attention and output heads remain FP32. The accepted artifact is 469,524 bytes, **6.57% smaller**. On 32 saved validation examples, normalized numeric MAE changed 0.295904 → 0.291746, categorical error stayed 0.304688, trend error changed 0.406250 → 0.411458, and uncalibrated failure Brier changed 0.145465 → 0.144522. Maximum observed typed-head tensor/probability discrepancy was 0.088226, within the configured 0.15 tensor gate; every task's degradation was below 0.02. This is partial quantization, not an entirely INT8 model. No latency improvement is claimed.

Artifacts are local and ignored under `services/ai/artifacts`: `synthetic-final-model`, `synthetic-final-calibrated`, `synthetic-final.onnx`, `synthetic-final.int8.onnx`, their contract/conformance/metadata reports, test reports, SHAP output and runtime diagnostics. They are generated evidence, not production defaults. The main CLI recipe is in [the service guide](../services/ai/README.md). The expanded playground is [advisory_forecasting_demo.ipynb](../services/ai/examples/advisory_forecasting_demo.ipynb).

## Review findings corrected

- Replaced lossy schema averages with versioned structural tokens retaining parent/edge/reference/weight assignments; preserved privacy-safe local references and category aliases.
- Fixed numeric masking/broadcasting, monotone upper-bound quantiles, legal integer rounding, explicit horizon conditioning and query-order invariance.
- Kept calibration units separate by field, horizon and domain; corrected binary temperature loss and insufficient-sample handling.
- Reused one encoder/model for training and serving; removed import-time training, preserved the strict existing gateway output allowlist, and added actual body-size and concurrency limits.
- Fixed dynamic ONNX attention reshapes and gated selective INT8 with held-out labels; failed exports/quality gates do not publish candidates.
- Corrected distillation normalization axes, applied training validation to in-memory records, restored RNG/resume state, and prioritized real training statistics and held-out real records.
- Corrected mobile ORT tensor decoding and categorical risk calibration lookup; cross-language execution now checks the actual exported model.

## Outstanding environment and evidence requirements

GPU training/inference/fine-tuning and mixed precision require a CUDA host check. React Native integration, physical iOS/Android runtime compatibility, acceleration, latency and memory need device checks; only the portable adapter and CPU cross-runtime path were verified. Docker was unavailable, so the container recipe was inspected but not built or deployed. No external deployment target was provided. Real institutional accuracy, calibration, fairness, temporal generalization and policy robustness remain unmeasured. The semantically invalid component grading fixture remains unchanged and is rejected with a clear validation error.
