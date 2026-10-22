"""Held-out metrics, calibration, baselines, and bounded error summaries."""

from __future__ import annotations

import math
from typing import Sequence


def regression_metrics(
    actual: Sequence[float], predicted: Sequence[float]
) -> dict[str, float | None]:
    """Compute raw-target-unit errors over exactly the supplied labeled pairs."""
    if len(actual) != len(predicted):
        raise ValueError("Evaluation target and prediction lengths differ")
    if not actual:
        return {"mae": None, "rmse": None, "bias": None}
    if any(
        not math.isfinite(value) for values in (actual, predicted) for value in values
    ):
        raise ValueError("Evaluation values must be finite")
    errors = [float(p) - float(y) for y, p in zip(actual, predicted)]
    return {
        "mae": sum(abs(x) for x in errors) / len(errors),
        "rmse": math.sqrt(sum(x * x for x in errors) / len(errors)),
        "bias": sum(errors) / len(errors),
    }


def persistence_baseline(
    histories: Sequence[Sequence[float | None]],
) -> list[float | None]:
    return [
        next((float(x) for x in reversed(h) if x is not None), None) for h in histories
    ]


def conformal_radius(
    actual: Sequence[float],
    lower: Sequence[float],
    upper: Sequence[float],
    coverage: float = 0.9,
) -> float:
    if not 0 < coverage < 1 or not actual:
        raise ValueError("Calibration partition and valid coverage are required")
    if not (len(actual) == len(lower) == len(upper)):
        raise ValueError("Calibration arrays have different lengths")
    if any(not math.isfinite(x) for values in (actual, lower, upper) for x in values):
        raise ValueError("Calibration values must be finite")
    if any(lo > hi for lo, hi in zip(lower, upper)):
        raise ValueError("Calibration intervals must be ordered")
    scores = sorted(max(lo - y, y - hi, 0.0) for y, lo, hi in zip(actual, lower, upper))
    rank = max(1, math.ceil((len(scores) + 1) * coverage))
    if rank > len(scores):
        raise ValueError(
            "Calibration sample is too small to support the requested finite-sample coverage"
        )
    return scores[rank - 1]


def temperature_scale(logits, labels, iterations=100):
    """Fit a positive scalar on held-out calibration labels only."""
    import torch

    x = torch.as_tensor(logits, dtype=torch.float32)
    y = torch.as_tensor(labels, dtype=torch.float32)
    if len(y) == 0 or len(set(y.tolist())) < 2:
        raise ValueError("Temperature calibration needs multiple classes")
    raw = torch.nn.Parameter(torch.zeros(()))
    opt = torch.optim.LBFGS([raw], max_iter=iterations)

    def closure():
        opt.zero_grad()
        temperature = raw.clamp(-5.0, 5.0).exp()
        if x.ndim == 1:
            loss = torch.nn.functional.binary_cross_entropy_with_logits(
                x / temperature, y
            )
        else:
            loss = torch.nn.functional.cross_entropy(x / temperature, y.long())
        loss.backward()
        return loss

    if not torch.isfinite(x).all():
        raise ValueError("Calibration logits must be finite")
    opt.step(closure)
    return float(raw.detach().clamp(-5.0, 5.0).exp())


def calibration_report(actual, lower, upper):
    """Coverage and width use only rows with both target and interval values."""
    if not len(actual) == len(lower) == len(upper):
        raise ValueError("Interval evaluation lengths differ")
    return {
        "count": len(actual),
        "coverage": sum(lo <= y <= hi for y, lo, hi in zip(actual, lower, upper))
        / len(actual)
        if actual
        else None,
        "mean_width": sum(hi - lo for lo, hi in zip(lower, upper)) / len(actual)
        if actual
        else None,
    }


def error_slices(actual, predicted, groups):
    """Return per-group MAE/RMSE; each denominator is that group's labeled rows."""
    if not (len(actual) == len(predicted) == len(groups)):
        raise ValueError("Error-slice arrays differ in length")
    out = {}
    for y, p, g in zip(actual, predicted, groups):
        out.setdefault(str(g), []).append(float(p) - float(y))
    return {
        group: {
            "count": len(errors),
            "mae": sum(abs(x) for x in errors) / len(errors),
            "rmse": math.sqrt(sum(x * x for x in errors) / len(errors)),
        }
        for group, errors in out.items()
    }


def _matched_regression_report(actual, predicted, baseline):
    """Compare model and baseline on identical rows; skill > 0 favors model."""
    if not (len(actual) == len(predicted) == len(baseline)):
        raise ValueError("Matched regression comparison arrays differ in length")
    model = regression_metrics(actual, predicted)
    reference = regression_metrics(actual, baseline)
    return {
        "count": len(actual),
        "model": model,
        "baseline": reference,
        "skill_mae": (
            1.0 - model["mae"] / reference["mae"] if reference["mae"] else None
        ),
        "skill_rmse": (
            1.0 - model["rmse"] / reference["rmse"] if reference["rmse"] else None
        ),
    }


def _training_mean_baselines(examples, metadata):
    """Fit per-query raw-unit means from train labels only, preferring real rows."""
    from .data import group_split
    from .training import _query_field

    persisted = metadata.get("training_baselines")
    if isinstance(persisted, dict):
        means = {
            key: float(entry["mean"])
            for key, entry in persisted.items()
            if isinstance(entry, dict)
            and isinstance(entry.get("mean"), (int, float))
            and math.isfinite(entry["mean"])
        }
        return means, {
            "source": "saved_train_labels",
            "label_count": sum(
                int(entry.get("count", 0))
                for entry in persisted.values()
                if isinstance(entry, dict)
            ),
            "query_count": len(means),
        }

    training = metadata.get("training", {})
    train = group_split(
        examples,
        training.get("seed", 42),
        training.get("split_ratios", (0.7, 0.1, 0.1, 0.1)),
    )["train"]
    values = {"real": {}, "other": {}}
    for example in train:
        source = "real" if example.origin == "real" else "other"
        specs = {field.name: field for field in example.fields}
        for i, query in enumerate(example.queries):
            name = _query_field(query, specs)
            if name is None or query.get("choices") or i >= len(example.labels):
                continue
            value = example.labels[i].get(name)
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                key, _, _, _ = query_identity(example, i)
                values[source].setdefault(key, []).append(float(value))
    keys = set(values["real"]) | set(values["other"])
    selected = {
        key: values["real"].get(key) or values["other"].get(key, []) for key in keys
    }
    selected = {key: rows for key, rows in selected.items() if rows}
    has_real, has_other = (
        any(key in values["real"] for key in selected),
        any(key in values["other"] and key not in values["real"] for key in selected),
    )
    source_name = (
        "real_train_preferred_with_synthetic_fallback"
        if has_real and has_other
        else "real_train"
        if has_real
        else "all_train"
    )
    return {key: sum(rows) / len(rows) for key, rows in selected.items()}, {
        "source": source_name,
        "label_count": sum(map(len, selected.values())),
        "query_count": len(selected),
    }


def dataset_fingerprint(examples):
    import hashlib
    import json
    from .contracts import example_fingerprint_record

    return hashlib.sha256(
        json.dumps(
            [example_fingerprint_record(x) for x in examples],
            sort_keys=True,
            separators=(",", ":"),
            default=list,
        ).encode()
    ).hexdigest()


def select_partition(examples, metadata, role, *, external=False):
    """Use the trained split; never silently repartition a different dataset."""
    import hashlib

    from .data import group_split

    training = metadata.get("training", {})
    if external:
        known = training.get("split_group_hashes")
        if not known:
            raise ValueError(
                "External evaluation requires saved training/split group fingerprints"
            )
        previous = {value for values in known.values() for value in values}
        if any(not example.group for example in examples):
            raise ValueError(
                "External evaluation requires explicit independent group keys"
            )
        requested = {
            hashlib.sha256(str(example.group).encode()).hexdigest()
            for example in examples
        }
        if previous & requested:
            raise ValueError(
                "External evaluation overlaps a previously used training or held-out group"
            )
        subset = list(examples)
    else:
        expected = training.get("data_fingerprint")
        if not expected or dataset_fingerprint(examples) != expected:
            raise ValueError(
                "Dataset differs from the saved split; use explicit external evaluation for new disjoint groups"
            )
        if role not in {"validation", "calibration", "test"}:
            raise ValueError("Evaluation requires a held-out partition")
        subset = group_split(
            examples,
            training.get("seed", 42),
            training.get("split_ratios", (0.7, 0.1, 0.1, 0.1)),
        )[role]
    real = [example for example in subset if example.origin == "real"]
    if real:
        subset = real
    if not subset:
        raise ValueError("Evaluation partition is empty")
    return subset


def query_identity(example, index):
    """Identify calibration units without merging unrelated numeric domains."""
    import hashlib
    import json

    from .training import _query_field

    # A bound assessment query carries its actual score domain (for example a
    # 0..10 instance within a field that also supports 0..100). Use the same
    # schema compiler as serving so calibration keys match inference keys.
    if "assessment_ref" in example.queries[index] or "factor_ref" in example.queries[index]:
        bound = getattr(example, "_assessment_query_binding", None)
        if bound is None:
            if getattr(example, "_schema_bound", False):
                bound = example
            else:
                from .inference import bind_schema_queries

                bound, _references = bind_schema_queries(example)
            # This cache is an internal acceleration only; dataclass
            # serialization and dataset fingerprints ignore dynamic attrs.
            example._assessment_query_binding = bound
        example = bound
    specs = {field.name: field for field in example.fields}
    query = example.queries[index]
    name = _query_field(query, specs)
    spec = specs[name]
    horizon = float(query.get("horizon", 1))
    domain = {
        "kind": spec.kind,
        "minimum": query.get("minimum", spec.minimum),
        "maximum": query.get("maximum", spec.maximum),
        "categories": list(spec.categories),
        "choices": query.get("choices", []),
    }
    signature = hashlib.sha256(json.dumps(domain, sort_keys=True).encode()).hexdigest()[
        :16
    ]
    return f"{name}|{horizon:g}|{signature}", name, horizon, domain


def prediction_records(bundle, examples, *, batch_size=32):
    """Return per-query evidence for metrics/calibration, never student IDs."""
    import torch

    from .lifecycle import load_bundle
    from .model import SchemaForecaster, constrain_numeric
    from .training import _prepare

    state, metadata = load_bundle(bundle)
    model = SchemaForecaster(**metadata["model_config"])
    model.load_state_dict(state.get("model", state))
    model.eval()
    records = []
    prep = metadata.get("preprocessing", {})
    with torch.inference_mode():
        for offset in range(0, len(examples), batch_size):
            batch = examples[offset : offset + batch_size]
            inputs, targets, masks = _prepare(
                batch,
                metadata["fields"],
                metadata.get("vocabulary", {}),
                prep,
                torch.device("cpu"),
                model_config=metadata["model_config"],
            )
            outputs = model(*inputs)
            for row, example in enumerate(batch):
                for column in range(len(example.queries)):
                    key, name, horizon, domain = query_identity(example, column)
                    item = {
                        "key": key,
                        "field": name,
                        "horizon": horizon,
                        "domain": domain,
                        "origin": example.origin,
                        "history_length": len(example.history),
                    }
                    if masks["numeric"][row, column]:
                        center, scale = prep.get(name, (0.0, 1.0))
                        quantiles = [
                            float(value) * scale + center
                            for value in outputs["quantiles"][row, column, 0]
                        ]
                        point = quantiles[len(quantiles) // 2]
                        if domain["kind"] == "integer":
                            point = constrain_numeric(
                                point,
                                minimum=domain["minimum"],
                                maximum=domain["maximum"],
                                integer=True,
                            )
                        item.update(
                            actual=float(targets["numeric"][row, column]) * scale
                            + center,
                            predicted=point,
                            lower=quantiles[0],
                            upper=quantiles[-1],
                        )
                        observed_name = (
                            "current_standing" if name == "predicted_standing" else name
                        )
                        item["persistence"] = next(
                            (
                                record[observed_name]
                                for record in reversed(example.history)
                                if isinstance(record.get(observed_name), (int, float))
                                and not isinstance(record.get(observed_name), bool)
                            ),
                            None,
                        )
                    if masks["category"][row, column]:
                        item.update(
                            category_actual=int(targets["category"][row, column]),
                            category_predicted=int(
                                outputs["categorical"][row, column].argmax()
                            ),
                        )
                    if masks["trend"][row, column]:
                        item.update(
                            trend_actual=int(targets["trend"][row, column]),
                            trend_predicted=int(outputs["trend"][row, column].argmax()),
                        )
                    if masks["failure"][row, column]:
                        logit = float(outputs["failure"][row, column])
                        item.update(
                            failure_actual=int(targets["failure"][row, column]),
                            failure_logit=logit,
                            failure_probability=1
                            / (1 + math.exp(-max(-80.0, min(80.0, logit)))),
                        )
                    records.append(item)
    return records, metadata


def binary_metrics(actual, probability):
    """Risk metrics use labeled binary rows; ranking metrics need both classes."""
    import numpy as np

    if not actual:
        return {"count": 0, "brier": None, "auroc": None, "average_precision": None}
    y, p = np.asarray(actual), np.asarray(probability)
    positives, negatives = int(y.sum()), int((1 - y).sum())
    auroc, ap = None, None
    if positives and negatives:
        order = np.argsort(p, kind="stable")
        ranks = np.empty(len(y), dtype=float)
        start = 0
        while start < len(y):
            end = start + 1
            while end < len(y) and p[order[end]] == p[order[start]]:
                end += 1
            ranks[order[start:end]] = (start + 1 + end) / 2
            start = end
        auroc = float(
            (ranks[y == 1].sum() - positives * (positives + 1) / 2)
            / (positives * negatives)
        )
        tp, seen, previous_recall, ap = 0, 0, 0.0, 0.0
        order = np.argsort(-p, kind="stable")
        start = 0
        while start < len(y):
            end = start + 1
            while end < len(y) and p[order[end]] == p[order[start]]:
                end += 1
            tp += int(y[order[start:end]].sum())
            seen += end - start
            recall = tp / positives
            ap += (recall - previous_recall) * tp / seen
            previous_recall, start = recall, end
    ece = 0.0
    for lower in np.linspace(0, 0.9, 10):
        selected = (p >= lower) & (p < lower + 0.1 if lower < 0.9 else p <= 1)
        if selected.any():
            ece += float(selected.mean() * abs(p[selected].mean() - y[selected].mean()))
    return {
        "count": len(y),
        "positive_count": positives,
        "brier": float(((p - y) ** 2).mean()),
        "auroc": auroc,
        "average_precision": ap,
        "ece": ece,
        "recall_at_0_5": float(((p >= 0.5) & (y == 1)).sum() / positives)
        if positives
        else None,
    }


def score_bundle(bundle, examples, *, role="test", batch_size=32, external=False):
    """Per-field/horizon metrics and baselines on held-out labels only.

    Model-versus-baseline skill uses identical labeled rows for numerator and
    denominator. The training mean is fitted only from the saved train split;
    external records cannot supply that baseline without the original data.
    """
    from .lifecycle import load_bundle

    _, metadata = load_bundle(bundle)
    subset = select_partition(examples, metadata, role, external=external)
    records, metadata = prediction_records(bundle, subset, batch_size=batch_size)
    if external and not isinstance(metadata.get("training_baselines"), dict):
        train_means, mean_fit = (
            {},
            {"source": "unavailable_external", "label_count": 0, "query_count": 0},
        )
    else:
        train_means, mean_fit = _training_mean_baselines(examples, metadata)
    by_query = {}
    for key in sorted({item["key"] for item in records}):
        items = [item for item in records if item["key"] == key]
        numeric = [item for item in items if "actual" in item]
        categorical = [item for item in items if "category_actual" in item]
        risk = [item for item in items if "failure_actual" in item]
        trend = [item for item in items if "trend_actual" in item]
        report = {
            "field": items[0]["field"],
            "horizon": items[0]["horizon"],
            "count": len(items),
        }
        if numeric:
            for item in numeric:
                item["training_mean"] = train_means.get(key)
            report["regression"] = regression_metrics(
                [item["actual"] for item in numeric],
                [item["predicted"] for item in numeric],
            )
            report["numeric_count"] = len(numeric)
            baseline = [item for item in numeric if item["persistence"] is not None]
            report["persistence"] = regression_metrics(
                [item["actual"] for item in baseline],
                [item["persistence"] for item in baseline],
            )
            report["model_vs_persistence"] = _matched_regression_report(
                [item["actual"] for item in baseline],
                [item["predicted"] for item in baseline],
                [item["persistence"] for item in baseline],
            )
            mean_rows = [item for item in numeric if item["training_mean"] is not None]
            report["model_vs_training_mean"] = (
                _matched_regression_report(
                    [item["actual"] for item in mean_rows],
                    [item["predicted"] for item in mean_rows],
                    [item["training_mean"] for item in mean_rows],
                )
                if mean_rows
                else {
                    "count": 0,
                    "model": regression_metrics([], []),
                    "baseline": regression_metrics([], []),
                    "skill_mae": None,
                    "skill_rmse": None,
                }
            )
            calibration = (
                metadata.get("calibration", {}).get("by_query", {}).get(key, {})
            )
            radius = calibration.get("radius") or 0.0
            lo = [
                max(
                    item["domain"]["minimum"]
                    if item["domain"]["minimum"] is not None
                    else -math.inf,
                    item["lower"] - radius,
                )
                for item in numeric
            ]
            hi = [
                min(
                    item["domain"]["maximum"]
                    if item["domain"]["maximum"] is not None
                    else math.inf,
                    item["upper"] + radius,
                )
                for item in numeric
            ]
            report["interval"] = {
                **calibration_report([item["actual"] for item in numeric], lo, hi),
                "calibrated": calibration.get("radius") is not None,
            }
            report["error_by_origin"] = error_slices(
                [item["actual"] for item in numeric],
                [item["predicted"] for item in numeric],
                [item["origin"] for item in numeric],
            )
        if categorical:
            report["category_count"] = len(categorical)
            report["category_accuracy"] = sum(
                item["category_actual"] == item["category_predicted"]
                for item in categorical
            ) / len(categorical)
        if trend:
            report["trend_count"] = len(trend)
            report["trend_accuracy"] = sum(
                item["trend_actual"] == item["trend_predicted"] for item in trend
            ) / len(trend)
        if risk:
            temperature = (
                metadata.get("calibration", {})
                .get("risk_by_query", {})
                .get(key, {})
                .get("temperature", 1.0)
            )
            probabilities = [
                1
                / (
                    1
                    + math.exp(
                        -max(-80.0, min(80.0, item["failure_logit"] / temperature))
                    )
                )
                for item in risk
            ]
            report["failure"] = binary_metrics(
                [item["failure_actual"] for item in risk], probabilities
            )
        by_query[key] = report
    primary = next(
        (
            report
            for report in by_query.values()
            if report["field"] == metadata.get("target_field")
            and report["horizon"] == 1
        ),
        next(iter(by_query.values()), {}),
    )
    return {
        "count": len(subset),
        # Windows from one learner are correlated. Report the independent
        # group count separately so window counts do not imply more evidence.
        "independent_group_count": len(
            {item.group for item in subset if item.group is not None}
        ),
        "origin": "real" if subset[0].origin == "real" else "synthetic_demonstration",
        "partition": "external" if external else role,
        "by_query": by_query,
        "standing": primary.get("regression", regression_metrics([], [])),
        "score_mae": primary.get("regression", {}).get("mae"),
        "score_rmse": primary.get("regression", {}).get("rmse"),
        "score_label_count": primary.get("numeric_count", 0),
        "persistence_mae": primary.get("model_vs_persistence", {})
        .get("baseline", {})
        .get("mae"),
        "persistence_rmse": primary.get("model_vs_persistence", {})
        .get("baseline", {})
        .get("rmse"),
        "persistence_matched_count": primary.get("model_vs_persistence", {}).get(
            "count", 0
        ),
        "persistence_skill_mae": primary.get("model_vs_persistence", {}).get(
            "skill_mae"
        ),
        "persistence_skill_rmse": primary.get("model_vs_persistence", {}).get(
            "skill_rmse"
        ),
        "training_mean_mae": primary.get("model_vs_training_mean", {})
        .get("baseline", {})
        .get("mae"),
        "training_mean_rmse": primary.get("model_vs_training_mean", {})
        .get("baseline", {})
        .get("rmse"),
        "training_mean_matched_count": primary.get("model_vs_training_mean", {}).get(
            "count", 0
        ),
        "training_mean_skill_mae": primary.get("model_vs_training_mean", {}).get(
            "skill_mae"
        ),
        "training_mean_skill_rmse": primary.get("model_vs_training_mean", {}).get(
            "skill_rmse"
        ),
        "training_mean_fit": mean_fit,
        "trend_accuracy": primary.get("trend_accuracy"),
        "failure_brier": primary.get("failure", {}).get("brier"),
        "standing_label_count": primary.get("count", 0),
        "failure_label_count": primary.get("failure", {}).get("count", 0),
        "institutionally_validated": False,
    }
