"""Aggregate input-shift and finite-output checks without student identifiers.

These descriptive checks make no parametric distribution assumption. They are
investigation signals, not calibrated drift tests or automatic retraining rules.
"""

from __future__ import annotations

from collections import Counter
from statistics import median

from .contracts import validate_example
from .lifecycle import load_bundle


def diagnose_bundle(bundle, examples, *, shift_threshold=2.0, backward_check=False):
    import math

    import torch

    from .inference import model_from_bundle, predict_example
    from .model import multitask_loss
    from .training import _prepare

    if not examples:
        raise ValueError("Diagnostics require at least one example")
    if not math.isfinite(shift_threshold) or shift_threshold <= 0:
        raise ValueError("Shift threshold must be finite and positive")
    state, metadata = load_bundle(bundle)
    model = model_from_bundle(state, metadata)
    observed, nulls, absent, values = Counter(), Counter(), Counter(), {}
    label_counts = Counter()
    for example in examples:
        validate_example(example)
        for row in example.history:
            for spec in example.fields:
                if spec.name not in row:
                    absent[spec.name] += 1
                elif row[spec.name] is None:
                    nulls[spec.name] += 1
                else:
                    observed[spec.name] += 1
                    if spec.kind in {"float", "integer"}:
                        values.setdefault(spec.name, []).append(float(row[spec.name]))
        for query, label in zip(example.queries, example.labels):
            for key in (query["field"], "trend", "failure"):
                if label.get(key) is not None:
                    label_counts[key] += 1
        # Labels are deliberately removed at the serving boundary.
        from dataclasses import replace

        predict_example(state, metadata, replace(example, labels=[]), model=model)
    fields = {}
    for name in metadata["fields"]:
        count = observed[name] + nulls[name] + absent[name]
        entry = {
            "observed": observed[name],
            "explicit_null": nulls[name],
            "structurally_absent": absent[name],
            "missing_fraction": (nulls[name] + absent[name]) / count if count else None,
        }
        if values.get(name) and name in metadata.get("preprocessing", {}):
            center, scale = metadata["preprocessing"][name]
            shift = abs(median(values[name]) - center) / max(scale, 1e-6)
            entry.update(
                median_shift_in_training_iqr=shift,
                investigate_shift=shift > shift_threshold,
            )
        fields[name] = entry
    backward = "not_requested"
    if backward_check:
        # Anomaly mode is a debugging tool; it is intentionally opt-in because
        # it retains additional autograd state and slows training substantially.
        inputs, targets, masks = _prepare(
            examples[:1],
            metadata["fields"],
            metadata.get("vocabulary", {}),
            metadata.get("preprocessing", {}),
            torch.device("cpu"),
            model_config=metadata["model_config"],
        )
        if not any(mask.any() for mask in masks.values()):
            raise ValueError("Backward diagnostics need labeled targets")
        with torch.autograd.detect_anomaly():
            loss, _ = multitask_loss(
                model(*inputs), targets, masks, weights=metadata.get("task_weights")
            )
            loss.backward()
        if any(
            p.grad is not None and not torch.isfinite(p.grad).all()
            for p in model.parameters()
        ):
            raise FloatingPointError("Non-finite diagnostic gradients")
        backward = "finite"
    return {
        "examples": len(examples),
        "artifact_digest_verified": True,
        "finite_inference": True,
        "backward_check": backward,
        "label_counts": dict(label_counts),
        "fields": fields,
        "shift_threshold": shift_threshold,
        "interpretation": "Descriptive median/IQR signals; inspect cohort and policy changes before retraining",
    }
