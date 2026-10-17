"""Configurable synthetic forecasting examples for software development.

The simulator varies dynamics, stochastic noise, policy cutoffs, observation
quality, and sequence lengths independently. Noise is deliberately irreducible:
these data can exercise code paths, but no simulation can guarantee that it
represents a real institution or improve real-world accuracy by itself.
"""

from __future__ import annotations

import json
import math
import random
from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

from .contracts import SCHEMAS, Example, FieldSpec

FAMILY_NAMES = (
    "smooth",
    "rising",
    "falling",
    "mean_reverting",
    "seasonal",
    "delayed_response",
    "shock",
    "intervention",
    "volatility_regime",
    "nonlinear_plateau",
)
NOISE_LAWS = ("normal", "uniform", "triangular", "heavy_tailed", "skewed", "mixture")


@dataclass(frozen=True)
class SyntheticConfig:
    """Controls for realistic-looking but non-institutional examples."""

    history_min: int = 2
    history_max: int = 12
    horizons: tuple[int, int] = (1, 2)
    family_names: tuple[str, ...] = FAMILY_NAMES
    noise_laws: tuple[str, ...] = NOISE_LAWS
    noise_scale_range: tuple[float, float] = (1.5, 8.0)
    slope_magnitude_range: tuple[float, float] = (0.15, 3.8)
    other_subject_correlation: float = 0.62
    attendance_score_correlation: float = 0.28
    field_missing_probability: float = 0.07
    structural_absence_probability: float = 0.035
    burst_missing_probability: float = 0.16
    burst_missing_length: tuple[int, int] = (2, 5)
    sparse_history_probability: float = 0.035
    empty_history_probability: float = 0.015
    label_missing_probability: float = 0.08
    task_missing_probability: float = 0.035
    windows_per_student: int = 1
    passing_threshold_range: tuple[float, float] = (57.0, 81.0)
    attendance_threshold_range: tuple[float, float] = (54.0, 84.0)

    def __post_init__(self) -> None:
        object.__setattr__(self, "horizons", tuple(self.horizons))
        object.__setattr__(self, "family_names", tuple(self.family_names))
        object.__setattr__(self, "noise_laws", tuple(self.noise_laws))
        for name in (
            "noise_scale_range",
            "slope_magnitude_range",
            "burst_missing_length",
            "passing_threshold_range",
            "attendance_threshold_range",
        ):
            object.__setattr__(self, name, tuple(getattr(self, name)))
        if (
            any(
                isinstance(value, bool) or not isinstance(value, int)
                for value in (self.history_min, self.history_max)
            )
            or self.history_min < 0
            or self.history_max < self.history_min
            or self.history_max > 512
        ):
            raise ValueError("History lengths must satisfy 0 <= min <= max <= 512")
        if len(self.horizons) != 2 or any(
            isinstance(x, bool) or not isinstance(x, int) for x in self.horizons
        ):
            raise ValueError(
                "Exactly two integer horizons are required for the six-query default contract"
            )
        if not 1 <= self.horizons[0] < self.horizons[1] <= 128:
            raise ValueError("Horizons must be increasing integers from 1 to 128")
        if not self.family_names or len(set(self.family_names)) != len(
            self.family_names
        ):
            raise ValueError("Choose one or more distinct dynamics families")
        if any(name not in FAMILY_NAMES for name in self.family_names):
            raise ValueError("Unknown dynamics family")
        if not self.noise_laws or len(set(self.noise_laws)) != len(self.noise_laws):
            raise ValueError("Choose one or more distinct noise laws")
        if any(name not in NOISE_LAWS for name in self.noise_laws):
            raise ValueError("Unknown noise law")
        for name in (
            "noise_scale_range",
            "slope_magnitude_range",
            "passing_threshold_range",
            "attendance_threshold_range",
        ):
            bounds = getattr(self, name)
            if (
                len(bounds) != 2
                or any(
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(float(value))
                    for value in bounds
                )
                or bounds[0] > bounds[1]
            ):
                raise ValueError(f"{name} must be an ordered pair")
        if (
            len(self.burst_missing_length) != 2
            or any(
                isinstance(value, bool) or not isinstance(value, int)
                for value in self.burst_missing_length
            )
            or self.burst_missing_length[0] < 1
            or self.burst_missing_length[0] > self.burst_missing_length[1]
        ):
            raise ValueError(
                "burst_missing_length must be an ordered positive integer pair"
            )
        if self.noise_scale_range[0] <= 0 or self.slope_magnitude_range[0] < 0:
            raise ValueError(
                "Noise scales must be positive and slope magnitudes non-negative"
            )
        for name in ("passing_threshold_range", "attendance_threshold_range"):
            lower, upper = getattr(self, name)
            if not 0 <= lower <= upper <= 100:
                raise ValueError(f"{name} must be within 0..100")
        for name in (
            "field_missing_probability",
            "structural_absence_probability",
            "burst_missing_probability",
            "sparse_history_probability",
            "empty_history_probability",
            "label_missing_probability",
            "task_missing_probability",
        ):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or not 0 <= value <= 1
            ):
                raise ValueError(f"{name} must be a probability")
        correlations = (
            self.other_subject_correlation,
            self.attendance_score_correlation,
        )
        if any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            or not -1 <= value <= 1
            for value in correlations
        ):
            raise ValueError("Feature correlations must be within -1..1")
        if (
            isinstance(self.windows_per_student, bool)
            or not isinstance(self.windows_per_student, int)
            or self.windows_per_student < 1
        ):
            raise ValueError("windows_per_student must be positive")


@lru_cache(maxsize=1)
def _policy_templates() -> tuple[dict, dict, tuple[dict, ...], tuple[dict, ...]]:
    """Load immutable schema templates once; each record gets an isolated copy."""
    grading = json.loads(
        (SCHEMAS / "grading" / "systems" / "it_global_grading_system.json").read_text(
            encoding="utf-8"
        )
    )
    evaluation = json.loads(
        (SCHEMAS / "evaluation" / "legacy_default_evaluation_system.json").read_text(
            encoding="utf-8"
        )
    )
    numeric = next(
        component["assessmentDefinition"]["scoring"]["mapping"]
        for component in grading["components"]
        if component.get("assessmentDefinition", {}).get("scoring", {}).get("mode")
        == "numeric_mapping"
    )
    categorical = next(
        component["assessmentDefinition"]["scoring"]["mapping"]
        for component in grading["components"]
        if component.get("assessmentDefinition", {}).get("scoring", {}).get("mode")
        == "value_mapping"
    )
    return grading, evaluation, tuple(numeric), tuple(categorical)


def _draw_noise(rng: random.Random, law: str, scale: float) -> float:
    """Draw zero-centered noise with materially different tail/skew behavior."""
    if law == "normal":
        return rng.gauss(0.0, scale)
    if law == "uniform":
        return rng.uniform(-math.sqrt(3.0) * scale, math.sqrt(3.0) * scale)
    if law == "triangular":
        return rng.triangular(-math.sqrt(6.0) * scale, math.sqrt(6.0) * scale, 0.0)
    if law == "heavy_tailed":
        # Student-t(3) divided by sqrt(3) has unit variance, before scale.
        chi_square = sum(rng.gauss(0.0, 1.0) ** 2 for _ in range(3))
        return (
            rng.gauss(0.0, 1.0)
            / math.sqrt(max(chi_square / 3.0, 1e-8))
            * scale
            / math.sqrt(3.0)
        )
    if law == "skewed":
        # Centered exponential has variance one and a positive asymmetric tail.
        return (rng.expovariate(1.0) - 1.0) * scale
    if law == "mixture":
        return rng.gauss(0.0, scale * (2.6 if rng.random() < 0.12 else 0.72))
    raise ValueError(f"Unsupported noise law: {law}")


def _trajectory_value(
    family: str,
    t: float,
    *,
    level: float,
    slope: float,
    mean: float,
    amplitude: float,
    period: float,
    delay: float,
    shock_at: float,
    shock_size: float,
    intervention_at: float,
    regime_at: float,
) -> float:
    """Deterministic latent path; stochastic residuals are drawn separately."""
    if family == "smooth":
        return level + slope * t + amplitude * math.sin(t / period)
    if family == "rising":
        return level + abs(slope) * t + 0.025 * t * t
    if family == "falling":
        return level - abs(slope) * t - 0.02 * t * t
    if family == "mean_reverting":
        return mean + (level - mean) * math.exp(-0.16 * max(t, 0.0)) + slope * 0.08 * t
    if family == "seasonal":
        return (
            level + slope * 0.15 * t + amplitude * math.sin(2.0 * math.pi * t / period)
        )
    if family == "delayed_response":
        return level + slope * max(0.0, t - delay)
    if family == "shock":
        return level + slope * t + (shock_size if t >= shock_at else 0.0)
    if family == "intervention":
        elapsed = max(0.0, t - intervention_at)
        return level + slope * min(t, intervention_at) - slope * 0.72 * elapsed
    if family == "volatility_regime":
        return level + slope * t + amplitude * 0.25 * math.sin(t / period)
    if family == "nonlinear_plateau":
        direction = 1.0 if slope >= 0 else -1.0
        return level + direction * amplitude * (
            1.0 - math.exp(-abs(slope) * max(t, 0.0) / max(amplitude, 1.0))
        )
    raise ValueError(f"Unsupported dynamics family: {family}")


def _bounded_score(value: float) -> float:
    return min(100.0, max(0.0, value))


def _set_attendance_threshold(evaluation: dict, threshold: float) -> None:
    factor = next(
        item for item in evaluation["factors"] if item["source"] == "attendance_rate"
    )
    level = next(
        item
        for item in evaluation["levels"]
        if item["severity"] == "high"
        and any(
            rule["factorId"] == factor["id"] and rule["operator"] == "below"
            for rule in item["rules"]
        )
    )
    next(
        rule
        for rule in level["rules"]
        if rule["factorId"] == factor["id"] and rule["operator"] == "below"
    )["threshold"] = threshold


def _observation(
    rng: random.Random,
    value,
    *,
    missing: bool,
    config: SyntheticConfig,
    row: dict,
    name: str,
) -> None:
    """Represent missingness as either explicit null or structural absence."""
    # Structural absence is sampled independently of value missingness, so a
    # feature can be absent even in a fully observed record.
    if rng.random() < config.structural_absence_probability:
        return
    if missing:
        row[name] = None
    else:
        row[name] = value


def _student_dynamics(rng: random.Random, config: SyntheticConfig) -> dict:
    family = rng.choice(config.family_names)
    direction = rng.choice((-1.0, 1.0))
    magnitude = rng.uniform(*config.slope_magnitude_range)
    return {
        "family": family,
        "level": rng.uniform(30.0, 88.0),
        "slope": direction * magnitude,
        "mean": rng.uniform(48.0, 76.0),
        "amplitude": rng.uniform(3.0, 18.0),
        "period": rng.uniform(2.5, 9.0),
        "delay": rng.uniform(1.0, 6.0),
        "shock_at": rng.uniform(2.0, 8.0),
        "shock_size": rng.choice((-1.0, 1.0)) * rng.uniform(6.0, 24.0),
        "intervention_at": rng.uniform(2.0, 7.0),
        "regime_at": rng.uniform(2.0, 7.0),
        "attendance_level": rng.uniform(52.0, 96.0),
        "attendance_slope": rng.uniform(-1.2, 1.2),
        "late_propensity": rng.uniform(0.05, 0.8),
    }


def _mapped_value(percentage: float, mapping: Iterable[dict]) -> int:
    eligible = [item for item in mapping if percentage >= item["percentage"]]
    return int(
        max(eligible or list(mapping), key=lambda item: item["percentage"])["value"]
    )


def _make_policy(
    rng: random.Random, config: SyntheticConfig
) -> tuple[dict, dict, list[dict], list[dict]]:
    grading_template, evaluation_template, numeric_mapping, categorical_mapping = (
        _policy_templates()
    )
    grading, evaluation = deepcopy(grading_template), deepcopy(evaluation_template)
    passing = rng.uniform(*config.passing_threshold_range)
    grading["finalGradeConversion"]["passingPercentage"] = passing
    attendance_threshold = rng.uniform(*config.attendance_threshold_range)
    _set_attendance_threshold(evaluation, attendance_threshold)
    numeric_map = list(numeric_mapping)
    category_map = list(categorical_mapping)
    return grading, evaluation, numeric_map, category_map


def _make_record(
    rng: random.Random,
    config: SyntheticConfig,
    dynamics: dict,
    group: str,
    window: int,
    specs: list[FieldSpec],
) -> Example:
    family = dynamics["family"]
    noise_law = rng.choice(config.noise_laws)  # independent of family and policy
    noise_scale = rng.uniform(*config.noise_scale_range)
    history_length = rng.randint(config.history_min, config.history_max)
    max_horizon = config.horizons[-1]
    window_offset = window * max(config.history_max + max_horizon, 1)
    grading, evaluation, numeric_mapping, category_mapping = _make_policy(rng, config)
    passing_threshold = float(grading["finalGradeConversion"]["passingPercentage"])
    attendance_threshold = next(
        rule["threshold"]
        for level in evaluation["levels"]
        for rule in level["rules"]
        if rule["operator"] == "below"
        and next(
            factor
            for factor in evaluation["factors"]
            if factor["id"] == rule["factorId"]
        )["source"]
        == "attendance_rate"
    )

    # Missingness bursts apply to consecutive time positions, independently by
    # feature; isolated nulls and absent keys are sampled separately below.
    burst_fields = (
        "current_standing",
        "attendance_rate",
        "other_subject_signal",
        "assessment_completion_rate",
    )
    burst_ranges = {}
    for name in burst_fields:
        if history_length and rng.random() < config.burst_missing_probability:
            start = rng.randrange(history_length)
            length = rng.randint(*config.burst_missing_length)
            burst_ranges[name] = range(start, min(history_length, start + length))
        else:
            burst_ranges[name] = range(0)

    history = []
    observed_score = dynamics["level"]
    history_positions = []
    if rng.random() >= config.empty_history_probability:
        for t in range(history_length):
            if rng.random() < config.sparse_history_probability:
                continue
            position = window_offset + t
            volatility = (
                2.8
                if family == "volatility_regime" and position >= dynamics["regime_at"]
                else 1.0
            )
            latent = _trajectory_value(
                family,
                position,
                **{
                    key: dynamics[key]
                    for key in (
                        "level",
                        "slope",
                        "mean",
                        "amplitude",
                        "period",
                        "delay",
                        "shock_at",
                        "shock_size",
                        "intervention_at",
                        "regime_at",
                    )
                },
            )
            score = _bounded_score(
                latent + _draw_noise(rng, noise_law, noise_scale * volatility)
            )
            attendance_coupling = config.attendance_score_correlation * (
                (score - 60.0) / 20.0
            )
            attendance = _bounded_score(
                dynamics["attendance_level"]
                + dynamics["attendance_slope"] * t
                + 5.0 * attendance_coupling
                + _draw_noise(rng, noise_law, noise_scale * 0.65)
            )
            other_independent = rng.gauss(0.0, 12.0)
            other_signal = _bounded_score(
                58.0
                + config.other_subject_correlation * (score - 58.0)
                + math.sqrt(max(0.0, 1.0 - config.other_subject_correlation**2))
                * other_independent
            )
            late_days = max(
                0,
                min(
                    30,
                    int(
                        round(
                            dynamics["late_propensity"] * 10
                            - attendance / 18.0
                            + rng.gauss(0.0, 1.6)
                        )
                    ),
                ),
            )
            missing_count = max(
                0, min(9, int(round((100.0 - attendance) / 18.0 + rng.gauss(0.0, 1.5))))
            )
            completion = _bounded_score(
                100.0 - 5.5 * missing_count + rng.gauss(0.0, 8.0)
            )
            engaged_probability = 1.0 / (
                1.0 + math.exp(max(-20.0, min(20.0, (late_days - 2.0) * 0.45)))
            )
            row = {}
            values = {
                "current_standing": score,
                "attendance_rate": attendance,
                "other_subject_signal": other_signal,
                "assessment_completion_rate": completion,
                "missing_assessment_count": missing_count,
                "late_submission_days": late_days,
                "engaged": rng.random() < engaged_probability,
                # A nuisance category is sampled independently of trend/family.
                "pattern": rng.choice(("up", "flat", "down")),
            }
            for name, value in values.items():
                missing = (
                    t in burst_ranges.get(name, ())
                    or rng.random() < config.field_missing_probability
                )
                _observation(
                    rng, value, missing=missing, config=config, row=row, name=name
                )
            history.append(row)
            observed_score = score
            history_positions.append(position)

    # Empty history still defines a prior latent time from which the requested
    # horizons are generated; no synthetic future values are placed in history.
    final_position = (
        history_positions[-1]
        if history_positions
        else window_offset + max(history_length - 1, 0)
    )
    future_score = {}
    future_attendance = {}
    for horizon in config.horizons:
        future_position = final_position + horizon
        volatility = (
            2.8
            if family == "volatility_regime"
            and future_position >= dynamics["regime_at"]
            else 1.0
        )
        latent = _trajectory_value(
            family,
            future_position,
            **{
                key: dynamics[key]
                for key in (
                    "level",
                    "slope",
                    "mean",
                    "amplitude",
                    "period",
                    "delay",
                    "shock_at",
                    "shock_size",
                    "intervention_at",
                    "regime_at",
                )
            },
        )
        future_score[horizon] = _bounded_score(
            latent + _draw_noise(rng, noise_law, noise_scale * volatility)
        )
        future_attendance[horizon] = _bounded_score(
            dynamics["attendance_level"]
            + dynamics["attendance_slope"] * future_position
            + config.attendance_score_correlation
            * (future_score[horizon] - 60.0)
            * 0.25
            + _draw_noise(rng, noise_law, noise_scale * 0.7)
        )

    h1, h2 = config.horizons
    numeric_values = {h1: future_score[h1], h2: future_score[h2]}
    last_evidence = observed_score if history_positions else dynamics["level"]
    directions = {}
    failures = {}
    for horizon, value in numeric_values.items():
        delta = value - last_evidence
        directions[horizon] = (
            "improving" if delta >= 3.0 else "declining" if delta <= -3.0 else "stable"
        )
        failures[horizon] = value < passing_threshold

    queries = [
        {"field": "current_standing", "horizon": h1},
        {"field": "current_standing", "horizon": h2},
        {"field": "trend", "horizon": h1},
        {"field": "failure", "horizon": h1},
        {
            "field": "mapped_score",
            "horizon": h1,
            "choices": [int(item["value"]) for item in numeric_mapping],
        },
        {
            "field": "categorical_score",
            "horizon": h1,
            "choices": [str(item["value"]) for item in category_mapping],
        },
    ]
    mapped = _mapped_value(future_score[h1], numeric_mapping)
    # The value-mapping outcome is a noisy future attendance result, distinct
    # from the grading-policy failure label and constrained to schema values.
    attendance_probability = 1.0 / (
        1.0
        + math.exp(
            -max(-20.0, min(20.0, (future_attendance[h1] - attendance_threshold) / 9.0))
        )
    )
    categorical = "P" if rng.random() < attendance_probability else "A"
    raw_labels = [
        {
            "current_standing": future_score[h1],
            "trend": directions[h1],
            "failure": failures[h1],
        },
        {
            "current_standing": future_score[h2],
            "trend": directions[h2],
            "failure": failures[h2],
        },
        {"trend": directions[h1], "failure": failures[h1]},
        {"failure": failures[h1], "trend": directions[h1]},
        {"mapped_score": mapped, "trend": directions[h1], "failure": failures[h1]},
        {
            "categorical_score": categorical,
            "trend": directions[h1],
            "failure": failures[h1],
        },
    ]
    labels = []
    for row in raw_labels:
        if rng.random() < config.label_missing_probability:
            labels.append({})
            continue
        partial = {}
        for key, value in row.items():
            partial[key] = (
                None if rng.random() < config.task_missing_probability else value
            )
        labels.append(partial)

    # Store policy-level thresholds only in the validated schema snapshot;
    # family and noise distribution remain generator-side latent variables.
    return Example(
        history,
        queries,
        specs,
        labels,
        group,
        "synthetic",
        {"gradingSystem": grading, "evaluationCriteria": evaluation},
    )


def _field_specs() -> list[FieldSpec]:
    """Keep legacy names/types and append plausible, bounded predictors."""
    return [
        FieldSpec("current_standing", "float", minimum=0, maximum=100),
        FieldSpec("attendance_rate", "float", minimum=0, maximum=100),
        FieldSpec("missing_assessment_count", "integer", minimum=0),
        FieldSpec("engaged", "boolean"),
        FieldSpec("pattern", "category", ("up", "flat", "down")),
        FieldSpec("trend", "category", ("improving", "stable", "declining")),
        FieldSpec("failure", "boolean"),
        FieldSpec("mapped_score", "integer", minimum=0, maximum=3),
        FieldSpec("categorical_score", "category", ("P", "A")),
        FieldSpec("late_submission_days", "integer", minimum=0, maximum=30),
        FieldSpec("other_subject_signal", "float", minimum=0, maximum=100),
        FieldSpec("assessment_completion_rate", "float", minimum=0, maximum=100),
    ]


def generate(
    count: int = 400, seed: int = 42, *, config: SyntheticConfig | None = None
) -> list[Example]:
    """Generate exactly ``count`` seeded windows using configurable dynamics.

    ``windows_per_student`` groups adjacent windows under a seed-prefixed local
    key so group-disjoint splitting prevents student leakage. Group and origin
    are metadata only and are never copied into history or schema features.
    """
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ValueError("count must be a positive integer")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    config = config or SyntheticConfig()
    rng = random.Random(seed)
    specs = _field_specs()
    output: list[Example] = []
    student_index = 0
    while len(output) < count:
        dynamics = _student_dynamics(rng, config)
        group = f"synthetic-seed-{seed}-learner-{student_index}"
        windows = min(config.windows_per_student, count - len(output))
        for window in range(windows):
            output.append(_make_record(rng, config, dynamics, group, window, specs))
        student_index += 1
    return output
