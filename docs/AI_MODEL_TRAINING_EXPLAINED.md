# How the APMS forecasting model learns

This is a beginner's guide to the AI code under `services\ai`. It explains what the training reports can and cannot tell you. The model makes advisory forecasts only; it does not assign official APMS grades or risk levels.

## The task in plain language

The model receives a short, ordered history of typed observations, a description of the active grading/evaluation rules, and one or more questions such as “predict score at horizon 2.” It learns patterns from examples that include future labels. At inference time the labels are absent. The model can predict numeric values with quantiles, legal categories, trend classes, and a failure probability.

The schema matters because the same history can have a different interpretation under a different grading rule. The schema encoder reads structural relationships, numeric limits, thresholds, and mappings; it does not learn institution names or opaque record IDs. The application still validates the full schema and owns official grading and evaluation logic.

## What the four partitions do

Examples are separated by learner/group before fitting:

- **Train** teaches model parameters and fits numeric preprocessing. A train-only mean baseline is also computed per query/domain, preferring real train labels when available.
- **Validation** helps compare model settings and decide when to stop. It must not be used to fit the final transforms or calibration.
- **Calibration** fits interval adjustments and risk-temperature scaling after the model choice is frozen.
- **Test** is held for a final evaluation. Looking at test results repeatedly and changing the model based on them turns the test set into another validation set.

When repeated records for the same learner cross these partitions, the evaluation can look better than performance on new learners. The group key is used to prevent that leakage; it is not a model feature. A later cohort or forward-time evaluation is useful because a random group split cannot show how much the population or policy changes over time.

## What “accuracy” means here

Different output types have different measures. There is no single accuracy number that covers every task.

- **Numeric score:** MAE is the average absolute error in score units; RMSE squares each error before averaging and gives large misses more influence. For example, on a 0–100 target an RMSE of 10 is roughly a 10-point root-mean-square error. It is not “90% accurate.” Always read the label count, target unit, field, horizon, and data origin beside it.
- **Persistence:** predicts the last observed target. It is a strong simple baseline when scores change slowly. The matched comparison measures model and persistence on exactly the same labeled rows that also have an observed history. A positive skill means the model's error is lower; negative skill means persistence is lower. If persistence beats the model, that is useful evidence to investigate, not a reason to hide the comparison.
- **Training mean:** predicts a per-query average fitted from train labels. It should be weaker than persistence for many stable sequences, but it is a useful check that the model learned something beyond a global average. External scoring can use a mean saved in the artifact; the external labels never fit that mean.
- **Category and trend:** accuracy is the fraction of labeled choices/classes predicted correctly. Read its own label count. Accuracy can hide class imbalance, so inspect per-class counts and confusion patterns when available.
- **Failure risk:** Brier score measures squared probability error (lower is better); AUROC and average precision measure ranking and require both outcome classes. A risk score may rank cases well while its probabilities are poorly calibrated. Temperature calibration is not proof that the probabilities are safe for a new institution or cohort.
- **Intervals:** coverage is the share of labeled outcomes inside the reported interval; width is how broad the intervals are. Wide intervals can cover more outcomes but be less useful. Split-conformal coverage is marginal and depends on the calibration population and exchangeability; it does not promise coverage for an individual.

Metrics must be compared with their denominators. Missing labels are excluded rather than treated as zero. A baseline may have fewer matched rows than the model's overall metric. Use the `model_vs_persistence` or `model_vs_training_mean` block and its count for apples-to-apples skill; do not compare different subsets as if they were identical.

## Why a newer model may look worse

In the earlier comprehensive-v2 synthetic validation selection, the protocol selected the legacy candidate. The report lists mean score RMSE of about 13.00 for legacy, 13.46 for the primary residual candidate, and 13.27 for the optional candidate. Those are synthetic validation results, not test-set evidence or real-learner accuracy; the selection protocol records that the test role was unopened at selection time (`services\ai\artifacts\comprehensive-v2\selection.json`).

This comparison uses the same comprehensive dataset and broad training budget, but the candidate settings also change residual mode, input dropout, standard dropout, center loss, weight decay, and early-stopping threshold. The result therefore does not isolate one setting as the cause. A larger/harder generator can also change absolute error, and scores from different data profiles, sample counts, horizons, splits, field bounds, or model capacity are not directly comparable. Harder synthetic cases are a stress test; they do not prove the architecture regressed, nor that it improved.

The earlier four-family run also used two Transformer layers and stopped at epoch 18; the comprehensive comparison used one layer and 16 epochs. Model capacity, training budget, data and sampled groups all changed, so attributing the score difference to the generator alone would be incorrect. More varied data is not automatically harder for every metric: the reported horizon-1 persistence MAE was 5.896 in the earlier run and 5.769 in the comprehensive run, on their respective matched subsets.

The comprehensive model's saved horizon-1 test report also exposes a specific weakness: its seven labeled windows without a usable prior score had MAE 25.987 and RMSE 36.474, compared with MAE 10.648 and RMSE 12.320 on the 52 windows with a prior score. This descriptive slice is small and does not establish a causal explanation. It does show why hiding missing-history cases or comparing the model's full sample with persistence's smaller sample would be misleading. The new optional objectives and history summaries target these weaknesses, but improvement must be measured on a fresh comparison.

Persistence won the earlier comprehensive-v2 score comparison. That is an acceptable development finding: it says the model was not consistently adding value over a simple forecast. It is also a reason not to treat that synthetic result as production acceptance. A release decision needs representative permissioned real data, group-disjoint and later-time evaluation, matched baselines, uncertainty/calibration checks, and review under institutional policy.

The latest history-v3 experiment used a fresh seed, a frozen three-variant comparison, and a separate test role. The selected history-context model reduced mean test MAE by 22.1% and RMSE by 10.8% relative to the same-data absolute control, and beat persistence on matched rows at both horizons. This is a useful measured improvement, but it is not a universal accuracy percentage. Category accuracy fell, the nominal 90% intervals covered only 79.3%/74.6% of test outcomes, and failure Brier was slightly worse on an additional synthetic cohort. The appropriate conclusion is “better numeric forecasts on these synthetic cohorts, with unresolved task and uncertainty weaknesses.” Do not change settings after seeing these results and then reuse these groups as an untouched test. Full counts and tradeoffs are in [the validation report](AI_MODEL_VALIDATION.md).

## Why training can overfit

Overfitting happens when a model fits quirks of the training examples that do not repeat in new examples. Risk increases when the dataset is small or narrow, the model has too much capacity, train and evaluation records overlap, labels are noisy, or experiment selection repeatedly reuses the same validation groups. Synthetic examples can add variety, but they can also teach the model the generator's habits instead of real student behavior.

Input dropout masks some observed history tokens during training. Weight decay and dropout regularize learning. With the additive residual link, the numeric head starts at the training median in normalized units when no same-field observation is available, then learns a correction; the optional logit link instead uses its absolute forecast path. A center loss adds a direct penalty to the predicted median in addition to quantile loss. These choices can improve stability, but none guarantees generalization or prevents overfitting. Compare each candidate on the same split and retain an untouched test cohort.

## Optional ideas are experiments, not evidence

The following switches are opt-in experiments, not evidence of improved accuracy:

- `numeric_history_context` adds per-query summaries from observed fields, including counts, latest/previous values, mean, spread, age, and missingness flags. The exact feature list is versioned with the implementation. It does not change the external input contract. Summaries must use observed history only and need dynamic-schema, missingness, and held-out baseline tests.
- `numeric_center_loss_kind=mse` squares the normalized median forecast residual. Large errors therefore contribute more than under SmoothL1; when mixed with pinball loss, the center is no longer optimized as a pure conditional median. This is not a parametric likelihood.
- `selection_metric=numeric_rmse` selects a checkpoint by the square root of aggregate normalized squared residuals divided by the observed numeric label count. This normalized checkpoint score differs from the raw-unit, per-field RMSE shown in reports. `weighted_loss` remains the compatibility default.

These switches change features, optimization, or selection. Evaluate them with a predeclared experiment on identical train/validation splits, keeping calibration and test untouched until selection is frozen.

These options are implemented, reviewed and tested; they remain opt-in because a synthetic improvement does not establish suitability for a real cohort. Current model settings and metrics should be read from the saved bundle/report. The selected `examples/history-aware-training.json` profile reproduces the measured configuration; it is not automatic deployment approval.

## Suggested review order

1. Check the data profile, split counts, target units, task label counts, and real/synthetic source counts.
2. Read validation metrics and compare with persistence and train mean on matched rows.
3. Freeze the candidate before calibration; inspect calibration counts, interval coverage/width, and risk calibration class balance.
4. Open the test role once for final evidence and report the result with the exact data seed/profile, model config, source cohort, and metric denominators.
5. If any key metric is unavailable, keep it unavailable and identify what data is missing. Never report a null metric as zero error or perfect accuracy.

For reproducible commands and data formats, see [the usage and deployment guide](AI_MODEL_USAGE_DEPLOYMENT.md). For storage and safe cleanup, see [AI model files and cleanup](AI_MODEL_FILES_AND_CLEANUP.md).
