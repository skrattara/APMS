"""Bounded SHAP wrapper for one fixed-schema standing prediction."""

from __future__ import annotations

import numpy as np


def explain_numeric(predict, background, values, *, max_evaluations=256):
    if max_evaluations < 16 or max_evaluations > 2048:
        raise ValueError("SHAP evaluation budget must be from 16 to 2048")
    try:
        import shap
    except ImportError as exc:
        raise RuntimeError("Install the 'ml' extra for SHAP explanations") from exc
    background = np.asarray(background, dtype=float)
    values = np.asarray(values, dtype=float)
    if (
        background.ndim != 2
        or values.ndim != 2
        or values.shape[0] != 1
        or background.shape[1] != values.shape[1]
    ):
        raise ValueError(
            "SHAP needs a fixed-width training background and one input row"
        )

    def wrapped(rows):
        return np.asarray([predict(row) for row in rows], dtype=float)

    masker = shap.maskers.Independent(background, max_samples=min(100, len(background)))
    explainer = shap.Explainer(wrapped, masker, algorithm="permutation")
    explanation = explainer(values, max_evals=max_evaluations)
    return {
        "base_value": float(np.asarray(explanation.base_values).reshape(-1)[0]),
        "contributions": [float(x) for x in np.asarray(explanation.values).reshape(-1)],
        "feature_count": values.shape[1],
        "max_evaluations": max_evaluations,
        "interpretation": "model attribution; not causal evidence",
    }
