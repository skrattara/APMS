"""Frozen, group-disjoint synthetic comparison of assessment context v0/v1.

Example from the repository root (use the workspace AI runtime):
    python services/ai/examples/compare_assessment_context.py prepare --output services/ai/artifacts/assessment-context-20261020
    python services/ai/examples/compare_assessment_context.py train --output services/ai/artifacts/assessment-context-20261020 --name context_control
    python services/ai/examples/compare_assessment_context.py train --output services/ai/artifacts/assessment-context-20261020 --name assessment_context_v1
    python services/ai/examples/compare_assessment_context.py select --output services/ai/artifacts/assessment-context-20261020
    python services/ai/examples/compare_assessment_context.py calibrate --output services/ai/artifacts/assessment-context-20261020
    python services/ai/examples/verify_assessment_context_runtime.py --experiment services/ai/artifacts/assessment-context-20261020
    python services/ai/examples/compare_assessment_context.py final --output services/ai/artifacts/assessment-context-20261020

All score comparisons are synthetic software evidence, not claims about a
school, student population, or deployed model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter, defaultdict
from dataclasses import asdict, replace
from pathlib import Path


# Exact hashes reviewed by the parent for the narrowly scoped source updates
# between the first control snapshot and the candidate run. An unrecognized
# source change stops the comparison rather than being implicitly approved.
APPROVED_SOURCE_AMENDMENTS = {
    "training.py": {
        "before_sha256": "3055231059b4ed0381623548e40dd74ec8c8690379d4e40253fd278e3d629993",
        "after_sha256": "9b9c8076590a580d4915c6102d4dc5e8ed166dec754415114d80bb3265d9ff91",
        "allowed_change": "Only implicit v0 target-role validation and fallback from older resume contracts; explicit primary_target_field=current_standing fresh-training path is unchanged.",
    },
    "cli.py": {
        "before_sha256": "4b47613563400aad6f4c3b0df675621b2d84d636f3bd5a4c112e694fc6ff7a43",
        "after_sha256": "35ca1ca8312bc27f46e097c653e1747ba48ab52bc2d8f9e472f98127da58a7da",
        "allowed_change": "Export conformance fixtures are zeroed so observed assessment summaries are not published; training and inference behavior is unchanged.",
    },
    "evaluation.py": {
        "before_sha256": "d0e2ab82687e33d69c975db526c875a77dec687ba8db22f285595856a2fe9a74",
        "after_sha256": "ba5340cc60b093d0214317cd56a93de0bf2e4193e5db5c64b79c4ffc61f6b048",
        "allowed_change": "The _schema_bound guard reuses already-bound Example queries instead of binding partial runtime queries a second time; query identities and training data domains are unchanged.",
    },
}


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_new(path, value):
    # Serialization errors must not leave an empty exclusive output behind.
    encoded = json.dumps(value, indent=2, allow_nan=False)
    with Path(path).open("x", encoding="utf-8") as stream:
        stream.write(encoded)


def _write_or_verify(path, value):
    """Allow a retry without replacing immutable experiment evidence."""
    path = Path(path)
    if path.exists():
        if _read(path) != value:
            raise ValueError(
                f"Existing selection evidence differs: {path}. "
                "Keep it for review; do not overwrite it or change the frozen protocol."
            )
        return
    _write_new(path, value)


def _digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _summary(values):
    if not values:
        return {"count": 0, "mae": None, "rmse": None}
    errors = [actual - predicted for actual, predicted in values]
    return {
        "count": len(values),
        "mae": sum(abs(error) for error in errors) / len(errors),
        "rmse": math.sqrt(sum(error * error for error in errors) / len(errors)),
    }


def _baseline_predictions(train, evaluation, mode, bundle=None):
    """Fit simple baselines using training-role labels only."""
    sums, counts, classes = defaultdict(float), Counter(), defaultdict(Counter)
    for example in train:
        for query, label in zip(example.queries, example.labels):
            if "assessment_ref" not in query:
                continue
            value = label.get(query["field"])
            if value is None:
                continue
            field = query["field"]
            instance = next(row for row in example.assessment_instances if row["assessment_ref"] == query["assessment_ref"])
            mode_name = instance["scoring"]["mode"]
            if mode_name == "linear":
                value = float(value) * 100.0 / float(instance["maximum_score"])
                field = "__linear_percent__"
            elif mode_name == "numeric_mapping":
                mapping = instance["scoring"]["mapping"]
                value = next(row["percentage"] for row in mapping if row["value"] == value)
                field = "__numeric_mapping_percent__"
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                sums[field] += float(value)
                counts[field] += 1
            else:
                classes[field][value] += 1
    global_mean = {
        field: sums[field] / counts[field] for field in sums if counts[field]
    }
    majority = {
        field: values.most_common(1)[0][0]
        for field, values in classes.items()
        if values
    }
    output = {"global_mean": defaultdict(list), "last_same_type": defaultdict(list)}
    matched_linear = {"global_mean": [], "last_same_type": []}
    model = metadata = None
    if bundle is not None:
        from apms_ai.inference import model_from_bundle, predict_example
        from apms_ai.lifecycle import load_bundle

        state, metadata = load_bundle(bundle)
        model = model_from_bundle(state, metadata)
    from apms_ai.assessment_context import compile_assessment_contexts

    for example in evaluation:
        features = compile_assessment_contexts(example)
        model_values = None
        if model is not None:
            from apms_ai.inference import predict_example

            model_values = predict_example(
                state, metadata, replace(example, labels=[]), model=model
            )["predictions"]
        instance_by_ref = {row["assessment_ref"]: row for row in example.assessment_instances}
        for index, (query, label) in enumerate(zip(example.queries, example.labels)):
            ref = query.get("assessment_ref")
            if ref is None:
                continue
            actual = label.get(query["field"])
            if actual is None:
                continue
            field = query["field"]
            instance = instance_by_ref[ref]
            mode_name = instance["scoring"]["mode"]
            if isinstance(actual, (int, float)) and not isinstance(actual, bool):
                if mode_name == "linear":
                    actual_percent = float(actual) * 100.0 / float(instance["maximum_score"])
                    pred = global_mean.get("__linear_percent__")
                    if pred is not None:
                        output["global_mean"][mode_name].append((actual_percent, pred))
                        if model_values is not None:
                            model_percent = float(model_values[index]["value"]) * 100.0 / float(instance["maximum_score"])
                            matched_linear["global_mean"].append((actual_percent, pred, model_percent))
                if mode_name == "numeric_mapping":
                    actual_percent = next(row["percentage"] for row in instance["scoring"]["mapping"] if row["value"] == actual)
                    pred = global_mean.get("__numeric_mapping_percent__")
                    if pred is not None:
                        output["global_mean"][mode_name].append((actual_percent, pred))
                pred = global_mean.get(field)
                if pred is not None:
                    output["global_mean"][mode_name].append((float(actual), pred))
            elif field in majority:
                output["global_mean"][mode_name].append((actual, majority[field]))
            # The shared compiler emits the most recent same-type historical
            # percentage at slot 31. Decode it through this instance's policy.
            feature = features[index]
            if feature[30] == 0.0:
                continue
            prior_percent = feature[31] * 100.0
            if mode_name == "linear":
                actual_percent = float(actual) * 100.0 / float(instance["maximum_score"])
                output["last_same_type"][mode_name].append((actual_percent, prior_percent))
                if model_values is not None:
                    model_percent = float(model_values[index]["value"]) * 100.0 / float(instance["maximum_score"])
                    matched_linear["last_same_type"].append((actual_percent, prior_percent, model_percent))
            else:
                mapping = instance["scoring"]["mapping"]
                closest = min(mapping, key=lambda row: abs(float(row["percentage"]) - prior_percent))
                if mode_name == "numeric_mapping":
                    actual_percent = next(row["percentage"] for row in mapping if row["value"] == actual)
                    output["last_same_type"][mode_name].append((actual_percent, float(closest["percentage"])))
                else:
                    output["last_same_type"][mode_name].append((actual, closest["value"]))
    baseline_metrics = {
        name: {mode: _metric_for_pairs(pairs) for mode, pairs in modes.items()}
        for name, modes in output.items()
    }
    units = {
        "linear": "percentage points, normalized by each target maximum_score",
        "numeric_mapping": "percentage points from the declared scoring mapping",
        "value_mapping": "category accuracy",
    }
    for method_metrics in baseline_metrics.values():
        for mode_name, metric in method_metrics.items():
            metric["units"] = units.get(mode_name, "field or category units")
    if model is not None:
        baseline_metrics["model_vs_baseline_matched_linear_percentage_points"] = {
            name: {
                "count": len(rows),
                "baseline_rmse": _summary([(actual, baseline) for actual, baseline, _ in rows])["rmse"],
                "model_rmse": _summary([(actual, predicted) for actual, _, predicted in rows])["rmse"],
                "units": "percentage points; identical assessment labels for model and baseline",
            }
            for name, rows in matched_linear.items()
        }
    return baseline_metrics


def _metric_for_pairs(pairs):
    if not pairs:
        return {"count": 0, "mae": None, "rmse": None, "accuracy": None}
    numeric = all(
        isinstance(actual, (int, float)) and not isinstance(actual, bool)
        and isinstance(predicted, (int, float)) and not isinstance(predicted, bool)
        for actual, predicted in pairs
    )
    accuracy = sum(actual == predicted for actual, predicted in pairs) / len(pairs)
    if numeric:
        summary = _summary([(float(a), float(p)) for a, p in pairs])
        return {**summary, "accuracy": accuracy}
    return {
        "count": len(pairs),
        "mae": None,
        "rmse": None,
        "accuracy": accuracy,
    }


SUPPORTED_GUARDS = frozenset({
    "standing_mae", "standing_rmse", "failure_brier", "ai_risk_level_accuracy",
    "mapped_score_accuracy_or_mae", "categorical_score_accuracy",
})


def _validate_selection_rules(selection):
    """Reject unsupported rules before training or writing selection reports."""
    if selection.get("primary_metric") != "linear_assessment_score_rmse":
        raise ValueError("Unsupported selection primary metric")
    names = selection.get("guard_metrics")
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise ValueError("Selection guard_metrics must be a list of guard names")
    if len(names) != len(set(names)):
        raise ValueError("Selection guard_metrics must not contain duplicates")
    unknown = set(names) - SUPPORTED_GUARDS
    if unknown:
        raise ValueError(f"Unknown declared selection guard(s): {sorted(unknown)}")
    for key in ("standing_error_tolerance", "failure_brier_tolerance", "category_accuracy_tolerance"):
        value = selection.get(key)
        if not _finite_metric(value) or value < 0:
            raise ValueError(f"Selection {key} must be finite and nonnegative")


def _finite_metric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _query_guard(control, candidate, field, *, allow_mae, tolerance):
    """Guard every matching horizon/domain rather than hiding a weak slice.

    Mapped scores usually use the categorical head. For older reports with
    numeric mapped outputs, compare raw-score MAE instead. Never substitute
    MAE when one model has categorical accuracy and the other does not.
    """
    old_rows = {key: row for key, row in control.get("by_query", {}).items() if row.get("field") == field}
    new_rows = {key: row for key, row in candidate.get("by_query", {}).items() if row.get("field") == field}
    checks = {}
    for key in sorted(old_rows.keys() | new_rows.keys()):
        old, new = old_rows.get(key, {}), new_rows.get(key, {})
        use_accuracy = not allow_mae or "category_accuracy" in old or "category_accuracy" in new
        if use_accuracy:
            metric, count_key = "category_accuracy", "category_count"
            before, after = old.get(metric), new.get(metric)
            allowance = tolerance["category_accuracy_tolerance"]
        else:
            metric, count_key = "mae", "numeric_count"
            before, after = old.get("regression", {}).get(metric), new.get("regression", {}).get(metric)
            allowance = tolerance["standing_error_tolerance"]
        counts = (old.get(count_key), new.get(count_key))
        aligned = all(isinstance(count, int) and not isinstance(count, bool) and count > 0 for count in counts) and counts[0] == counts[1]
        available = _finite_metric(before) and _finite_metric(after)
        passed = aligned and available and (
            after >= before - allowance if use_accuracy else after <= before + allowance
        )
        checks[key] = {
            "passed": passed, "metric": metric, "control": before, "candidate": after,
            "control_count": counts[0], "candidate_count": counts[1], "tolerance": allowance,
        }
    return {"passed": bool(checks) and all(row["passed"] for row in checks.values()), "by_query": checks}


def _declared_guards_pass(control, candidate, guard_metrics, tolerance):
    """Apply only the guard names frozen in the experiment protocol."""
    definitions = {
        "standing_mae": ("score_mae", "max", tolerance["standing_error_tolerance"]),
        "standing_rmse": ("score_rmse", "max", tolerance["standing_error_tolerance"]),
        "failure_brier": ("failure_brier", "max", tolerance["failure_brier_tolerance"]),
        "ai_risk_level_accuracy": ("ai_risk_level_accuracy", "min", tolerance["category_accuracy_tolerance"]),
    }
    unknown = set(guard_metrics) - SUPPORTED_GUARDS
    if unknown:
        raise ValueError(f"Unknown declared selection guard(s): {sorted(unknown)}")
    results = {}
    for name in guard_metrics:
        if name in {"mapped_score_accuracy_or_mae", "categorical_score_accuracy"}:
            results[name] = _query_guard(
                control, candidate,
                "mapped_score" if name == "mapped_score_accuracy_or_mae" else "categorical_score",
                allow_mae=name == "mapped_score_accuracy_or_mae", tolerance=tolerance,
            )
            continue
        metric, direction, allowance = definitions[name]
        old, new = control.get(metric), candidate.get(metric)
        finite = all(_finite_metric(value) for value in (old, new))
        if not finite:
            results[name] = {"passed": False, "control": old, "candidate": new, "tolerance": allowance}
            continue
        passed = new <= old + allowance if direction == "max" else new >= old - allowance
        results[name] = {"passed": passed, "control": old, "candidate": new, "tolerance": allowance}
    return all(row["passed"] for row in results.values()), results


def _select_comparison(folder, train, validation):
    """Publish a validation decision, or safely resume an interrupted select.

    Cached review reports are reused only when their non-baseline evidence
    still matches the original validation report. This preserves the first
    baseline computation, including floating-point results, across retries.
    """
    profile = _read(folder / "protocol.json")
    tolerance = profile["selection"]
    _validate_selection_rules(tolerance)
    reports, pending_reviews = {}, {}
    for name in ("context_control", "assessment_context_v1"):
        report = _read(folder / f"{name}-validation-assessment.json")
        path = folder / f"{name}-validation-assessment-reviewed.json"
        if path.exists():
            reviewed = _read(path)
            original_core = {key: value for key, value in report.items() if key != "baselines"}
            reviewed_core = {key: value for key, value in reviewed.items() if key != "baselines"}
            if original_core != reviewed_core or not isinstance(reviewed.get("baselines"), dict):
                raise ValueError(f"Existing review does not match original validation evidence: {path}")
            report = reviewed
        else:
            report["baselines"] = _baseline_predictions(train, validation, "validation", folder / name)
        reports[name] = report
        pending_reviews[path] = report
    control_standard = _read(folder / "context_control-validation.json")
    candidate_standard = _read(folder / "assessment_context_v1-validation.json")
    def guard_inputs(standard):
        accuracy = next((row.get("category_accuracy") for row in standard["by_query"].values()
                         if row.get("field") == "ai_risk_level"), None)
        return {**standard, "ai_risk_level_accuracy": accuracy}
    guard_ok, guard_results = _declared_guards_pass(
        guard_inputs(control_standard), guard_inputs(candidate_standard),
        tolerance["guard_metrics"], tolerance,
    )
    before = reports["context_control"].get("linear_percentage_point_metrics", {}).get("rmse")
    after = reports["assessment_context_v1"].get("linear_percentage_point_metrics", {}).get("rmse")
    selected = "assessment_context_v1" if (
        _finite_metric(before) and _finite_metric(after) and after < before and guard_ok
    ) else "context_control"
    decision = {
        "selected": selected, "validation_only": True,
        "context_control_linear_rmse": before, "assessment_context_v1_linear_rmse": after,
        "base_standing_and_risk_guard_passed": guard_ok,
        "declared_guard_results": guard_results, "validation_assessment_metrics": reports,
        "test_unopened_at_selection": True,
    }
    # Check all existing outputs before writing any missing ones. A partial
    # run can be retried; different evidence is never silently overwritten.
    outputs = {**pending_reviews, folder / "selection.json": decision}
    for path, value in outputs.items():
        if path.exists() and _read(path) != value:
            raise ValueError(f"Existing selection evidence differs: {path}")
    if not (folder / "selection.json").exists() and any(
        (folder / name).exists() for name in ("calibration-report.json", "selected-calibrated", "final-started.json", "final-report.json")
    ):
        raise ValueError("Cannot create a new selection after calibration or final evaluation has started")
    for path, value in outputs.items():
        _write_or_verify(path, value)
    return decision


def _assessment_report(bundle, evaluation):
    from apms_ai.inference import model_from_bundle, predict_example
    from apms_ai.lifecycle import load_bundle

    state, metadata = load_bundle(bundle)
    model = model_from_bundle(state, metadata)
    pairs = defaultdict(list)
    linear_percent_pairs = []
    linear_raw_domains = defaultdict(list)
    duplicate_differences = []
    for source in evaluation:
        example = replace(source, labels=[])
        outputs = predict_example(state, metadata, example, model=model)["predictions"]
        for index, (query, predicted) in enumerate(zip(source.queries, outputs)):
            if "assessment_ref" not in query:
                continue
            target = next(row for row in source.assessment_instances if row["assessment_ref"] == query["assessment_ref"])
            mode = target["scoring"]["mode"]
            actual = source.labels[index].get(query["field"])
            if actual is not None:
                pairs[mode].append((actual, predicted["value"]))
                if mode == "linear":
                    maximum = float(target["maximum_score"])
                    linear_percent_pairs.append((float(actual) * 100.0 / maximum, float(predicted["value"]) * 100.0 / maximum))
                    linear_raw_domains[str(maximum)].append((float(actual), float(predicted["value"])))
            if query["assessment_ref"].endswith("-equivalent"):
                base_ref = query["assessment_ref"][:-11]
                twin_output = predicted["value"]
                base_index = next((i for i, q in enumerate(source.queries) if q.get("assessment_ref") == base_ref), None)
                if base_index is not None:
                    base_value = outputs[base_index]["value"]
                    duplicate_differences.append(abs(float(base_value) - float(twin_output)))
    metrics = {mode: _metric_for_pairs(rows) for mode, rows in pairs.items()}
    context = {
        "model_config": metadata.get("model_config", {}),
        "assessment_context_version": metadata.get("assessment_context_version", 0),
        "training_query_counts": metadata.get("training", {}).get("assessment_query_counts", {}),
        "duplicate_equivalent": {
            "count": len(duplicate_differences),
            "max_absolute_prediction_difference": max(duplicate_differences) if duplicate_differences else None,
        },
        "assessment_metrics_by_scoring_mode": metrics,
        "linear_percentage_point_metrics": _summary(linear_percent_pairs),
        "linear_raw_score_metrics_by_maximum": {
            maximum: _summary(values) for maximum, values in linear_raw_domains.items()
        },
        "synthetic_only": True,
    }
    return context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["prepare", "train", "evaluate", "select", "calibrate", "final"])
    parser.add_argument("--output", required=True)
    parser.add_argument("--name", choices=["context_control", "assessment_context_v1"])
    # Test is intentionally absent. Only the final stage may open held-out
    # test data, after selection, calibration, and external parity gates.
    parser.add_argument("--role", choices=["validation", "calibration"], default="validation")
    args = parser.parse_args()
    folder = Path(args.output)
    if args.stage == "prepare":
        from apms_ai.assessment_synthetic import AssessmentSyntheticConfig, generate_assessment_examples
        from apms_ai.contracts import validate_example

        profile = _read(Path(__file__).with_name("assessment-context-comparison.json"))
        _validate_selection_rules(profile["selection"])
        folder.mkdir(parents=True, exist_ok=False)
        examples = generate_assessment_examples(AssessmentSyntheticConfig(**profile["dataset"]))
        data_path = folder / "data.jsonl"
        with data_path.open("x", encoding="utf-8") as stream:
            for example in examples:
                validate_example(example)
                stream.write(json.dumps(asdict(example), allow_nan=False) + "\n")
        _write_new(folder / "protocol.json", profile)
        _write_new(folder / "data-digest.json", {
            "sha256": _digest(data_path),
            "groups": len({row.group for row in examples}),
            "examples": len(examples),
            "assessment_queries": sum("assessment_ref" in q for row in examples for q in row.queries),
            "assessment_results": sum(len(row.assessment_results) for row in examples),
            "test_unopened": True,
        })
        print(json.dumps(_read(folder / "data-digest.json")))
        return

    if _digest(folder / "data.jsonl") != _read(folder / "data-digest.json")["sha256"]:
        raise ValueError("Frozen comparison data changed")
    from apms_ai.data import group_split, load_jsonl
    from apms_ai.evaluation import score_bundle
    profile = _read(folder / "protocol.json")
    _validate_selection_rules(profile["selection"])
    examples = load_jsonl(folder / "data.jsonl")
    split = group_split(examples, profile["split"]["seed"], profile["split"]["ratios"])

    if args.stage == "train":
        if args.name is None:
            parser.error("train requires --name")
        import apms_ai
        from apms_ai.training import train

        source_dir = Path(apms_ai.__file__).resolve().parent
        full_digests = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(source_dir.glob("*.py"))}
        # The parent explicitly approved three narrow source amendments
        # between the first and second run. The explicit current_standing
        # training profile follows the same training/model/inference path.
        shared_digests = {name: digest for name, digest in full_digests.items() if name not in {"training.py", "cli.py", "evaluation.py"}}
        source_id = hashlib.sha256(json.dumps(shared_digests, sort_keys=True).encode("utf-8")).hexdigest()[:12]
        source_digest = folder / f"source-digests-{source_id}.json"
        manifest = {"shared_training_inference_modules": shared_digests, "training.py": full_digests.get("training.py"), "cli.py": full_digests.get("cli.py"), "evaluation.py": full_digests.get("evaluation.py")}
        if source_digest.exists():
            if _read(source_digest) != manifest:
                raise ValueError("Training or inference source changed between model runs")
        else:
            # Migrate the first run's full-module snapshot and document only
            # the parent-approved compatibility/export changes.
            prior_paths = sorted(folder.glob("source-digests-*.json"))
            prior_snapshot = None
            prior_manifest = None
            for candidate in prior_paths:
                candidate_data = _read(candidate)
                snapshot_candidate = folder / candidate.name.replace("source-digests-", "source-snapshot-").replace(".json", "")
                if snapshot_candidate.is_dir() and all(name in candidate_data for name in shared_digests):
                    if {name: candidate_data[name] for name in shared_digests} == shared_digests:
                        prior_snapshot, prior_manifest = snapshot_candidate, candidate_data
                        break
            amendments = {}
            if prior_manifest is not None and prior_snapshot is not None:
                old_training = prior_manifest.get("training.py")
                old_cli = prior_manifest.get("cli.py")
                old_evaluation = prior_manifest.get("evaluation.py")
                if old_training is None:
                    old_training = hashlib.sha256((prior_snapshot / "training.py").read_bytes()).hexdigest()
                if old_cli is None:
                    old_cli = hashlib.sha256((prior_snapshot / "cli.py").read_bytes()).hexdigest()
                if old_evaluation is None:
                    old_evaluation = hashlib.sha256((prior_snapshot / "evaluation.py").read_bytes()).hexdigest()
                if old_training != manifest["training.py"]:
                    amendments["training.py"] = {
                        "before_sha256": old_training,
                        "after_sha256": manifest["training.py"],
                        "allowed_change": "Only implicit v0 target-role validation and fallback from older resume contracts; explicit primary_target_field=current_standing fresh-training path is unchanged.",
                    }
                if old_cli != manifest["cli.py"]:
                    amendments["cli.py"] = {
                        "before_sha256": old_cli,
                        "after_sha256": manifest["cli.py"],
                        "allowed_change": "Export conformance fixtures are zeroed so observed assessment summaries are not published; training and inference behavior is unchanged.",
                    }
                if old_evaluation != manifest["evaluation.py"]:
                    amendments["evaluation.py"] = {
                        "before_sha256": old_evaluation,
                        "after_sha256": manifest["evaluation.py"],
                        "allowed_change": "The _schema_bound guard reuses already-bound Example queries instead of binding partial runtime queries a second time; query identities and training data domains are unchanged.",
                    }
                if amendments != APPROVED_SOURCE_AMENDMENTS:
                    raise ValueError("Source differences do not match the exact parent-reviewed amendment hashes")
            elif prior_paths:
                raise ValueError("No matching shared-source snapshot can verify the candidate run")
            snapshot = folder / f"source-snapshot-{source_id}"
            snapshot.mkdir(exist_ok=False)
            for path in sorted(source_dir.glob("*.py")):
                (snapshot / path.name).write_bytes(path.read_bytes())
            _write_new(source_digest, manifest)
            if amendments:
                amendment_path = folder / "source-amendments.json"
                if amendment_path.exists():
                    previous = _read(amendment_path)
                    if previous.get("changes") != amendments:
                        raise ValueError("Source amendment record differs from the reviewed change")
                else:
                    _write_new(amendment_path, {
                        "reason": "Parent-approved narrow compatibility/export changes after the original control snapshot; explicit fresh-training profile remains semantically matched.",
                        "before_snapshot": str(prior_snapshot.relative_to(folder)),
                        "after_snapshot": str(snapshot.relative_to(folder)),
                        "changes": amendments,
                    })
        settings = {**profile["training"], **profile["models"][args.name]}
        result = train(examples, folder / args.name, ratios=profile["split"]["ratios"], **settings)
        _write_new(folder / f"{args.name}-training.json", result)
        report = _assessment_report(folder / args.name, split["validation"])
        report["baselines"] = _baseline_predictions(split["train"], split["validation"], args.name, folder / args.name)
        _write_new(folder / f"{args.name}-validation-assessment.json", report)
        standard = score_bundle(folder / args.name, examples, role="validation")
        _write_new(folder / f"{args.name}-validation.json", standard)
        print(json.dumps({"model": args.name, "assessment": report["assessment_metrics_by_scoring_mode"]}))
        return

    if args.stage == "evaluate":
        if args.name is None:
            parser.error("evaluate requires --name")
        report = _assessment_report(folder / args.name, split[args.role])
        report["baselines"] = _baseline_predictions(split["train"], split[args.role], args.name, folder / args.name)
        standard = score_bundle(folder / args.name, examples, role=args.role)
        report["standard_multitask"] = standard
        _write_new(folder / f"ad_hoc-{args.name}-{args.role}-assessment.json", report)
        print(json.dumps({"model": args.name, "role": args.role, "metrics": report["assessment_metrics_by_scoring_mode"]}))
        return

    if args.stage == "select":
        print(json.dumps(_select_comparison(folder, split["train"], split["validation"])))
        return

    if args.stage == "calibrate":
        if (folder / "final-started.json").exists():
            raise FileExistsError("Final evaluation already started")
        selection = _read(folder / "selection.json")
        from apms_ai.calibration import calibrate_bundle

        calibrated_path = folder / "selected-calibrated"
        if calibrated_path.exists():
            raise FileExistsError("The selected calibrated bundle is immutable")
        calibration = calibrate_bundle(
            folder / selection["selected"],
            examples,
            output=calibrated_path,
            coverage=0.9,
        )
        _write_new(folder / "calibration-report.json", {
            "selected": selection["selected"],
            "bundle": str(calibrated_path),
            "calibration_role": "calibration",
            "result": calibration,
            "test_unopened": True,
        })
        print(json.dumps({"selected": selection["selected"], "calibration": calibration, "test_unopened": True}))
        return

    if (folder / "final-started.json").exists():
        raise FileExistsError("Final evaluation already started")
    selection = _read(folder / "selection.json")
    calibration_report = _read(folder / "calibration-report.json")
    gates_path = folder / "validation-gates.json"
    gates = _read(gates_path)
    if calibration_report.get("selected") != selection.get("selected"):
        raise ValueError("Calibration bundle does not match the frozen validation selection")
    if gates.get("selected") != selection.get("selected") or gates.get("status") != "passed":
        raise ValueError("Export, runtime, and mobile parity gates must pass before test evaluation")
    required_gates = {"gateway_contract", "onnx_export", "dynamic_parity", "calibrated_bundle"}
    if not required_gates.issubset({key for key, value in gates.get("checks", {}).items() if value is True}):
        raise ValueError("Validation gate evidence is incomplete")
    _write_new(folder / "final-started.json", {"selection": selection["selected"], "test_started": True})
    summaries = {}
    scored = [("context_control", folder / "context_control"), ("selected_calibrated", folder / "selected-calibrated")]
    for name, bundle in scored:
        summaries[name] = _assessment_report(bundle, split["test"])
        summaries[name]["baselines"] = _baseline_predictions(split["train"], split["test"], name, bundle)
        summaries[name]["standard_multitask"] = score_bundle(bundle, examples, role="test")
        _write_new(folder / f"{name}-test-assessment.json", summaries[name])
    amendments_path = folder / "source-amendments.json"
    source_amendments = _read(amendments_path) if amendments_path.exists() else None
    _write_new(folder / "final-report.json", {"selected": selection["selected"], "test": summaries, "calibration": calibration_report, "validation_gates": gates, "source_amendments": source_amendments, "synthetic_only": True})
    print(json.dumps({"selected": selection["selected"], "test_metrics": {name: row["assessment_metrics_by_scoring_mode"] for name, row in summaries.items()}}))


if __name__ == "__main__":
    main()
