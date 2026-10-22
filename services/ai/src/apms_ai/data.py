"""Deterministic ingestion, group-safe partitions, and train-only transforms."""

from __future__ import annotations

import csv
import json
import random
from pathlib import Path
from typing import Iterable

from .contracts import Example, FieldSpec, validate_example


def _example_from_mapping(raw, label="record") -> Example:
    if not isinstance(raw, dict):
        raise ValueError(f"{label} must be an object")
    fields = [FieldSpec(**f) for f in raw["fields"]]
    ex = Example(
        raw["history"],
        raw["queries"],
        fields,
        raw.get("labels", []),
        raw.get("group"),
        raw.get("origin", "real"),
        raw.get("schema", {}),
        raw.get("assessment_instances", []),
        raw.get("assessment_results", []),
    )
    validate_example(ex)
    return ex


def load_json(path: str | Path) -> list[Example]:
    """Read a JSON array or an object with an `examples` array."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        rows = raw.get("examples") if isinstance(raw, dict) else raw
        if not isinstance(rows, list):
            raise ValueError("JSON input must be an array or contain an examples array")
        return [
            _example_from_mapping(row, f"record {i}") for i, row in enumerate(rows, 1)
        ]
    except Exception as exc:
        raise ValueError(f"Invalid JSON dataset: {exc}") from exc


def load_jsonl(path: str | Path) -> list[Example]:
    out = []
    for line_no, line in enumerate(
        Path(path).read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
            ex = _example_from_mapping(raw, f"line {line_no}")
            out.append(ex)
        except Exception as e:
            raise ValueError(f"Invalid JSONL record at line {line_no}: {e}") from e
    return out


def load_csv(
    path: str | Path, *, group_column: str, target_column: str, field_columns: list[str]
) -> list[Example]:
    """Flat adapter: one current row and one future numeric target; IDs stay in group only."""
    out = []
    with Path(path).open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            specs = []
            obs = {}
            for key in field_columns:
                if key not in row:
                    raise ValueError(f"CSV column not found: {key}")
                raw = row[key]
                value = None if raw == "" else float(raw)
                specs.append(FieldSpec(key, "float"))
                obs[key] = value
            target = (
                None if row.get(target_column, "") == "" else float(row[target_column])
            )
            specs.append(FieldSpec(target_column, "float"))
            out.append(
                Example(
                    [obs],
                    [{"field": target_column, "horizon": 1}],
                    specs,
                    [{target_column: target}],
                    row.get(group_column),
                    "real",
                )
            )
    return out


def group_split(
    examples: list[Example], seed: int = 42, ratios=(0.7, 0.1, 0.1, 0.1)
) -> dict[str, list[Example]]:
    if len(ratios) != 4 or any(r <= 0 for r in ratios) or abs(sum(ratios) - 1.0) > 1e-6:
        raise ValueError(
            "Four positive train/validation/calibration/test ratios must sum to one"
        )
    groups = {}
    for i, e in enumerate(examples):
        if e.origin == "real" and not e.group:
            raise ValueError(
                "Real records require an independent group key to prevent leakage"
            )
        groups.setdefault(e.group or f"__row_{i}", []).append(e)
    keys = list(groups)
    # Split independent learners before fitting any transform. Multiple
    # overlapping windows from one learner must follow the same group key;
    # shuffling windows independently would leak near-duplicates into holdout.
    random.Random(seed).shuffle(keys)
    n = len(keys)
    if n < 4:
        raise ValueError(
            "At least four independent groups are required for train/validation/calibration/test"
        )
    counts = [max(1, int(n * r)) for r in ratios]
    while sum(counts) > n:
        ix = max(
            (i for i, c in enumerate(counts) if c > 1),
            key=lambda i: counts[i] - n * ratios[i],
        )
        counts[ix] -= 1
    while sum(counts) < n:
        ix = max(range(4), key=lambda i: n * ratios[i] - counts[i])
        counts[ix] += 1
    cuts = [0]
    for count in counts:
        cuts.append(cuts[-1] + count)
    result = {
        role: [e for g in keys[cuts[i] : cuts[i + 1]] for e in groups[g]]
        for i, role in enumerate(("train", "validation", "calibration", "test"))
    }
    memberships = {
        name: {e.group for e in values if e.group is not None}
        for name, values in result.items()
    }
    names = list(memberships)
    for i, name in enumerate(names):
        for other in names[i + 1 :]:
            if memberships[name] & memberships[other]:
                raise RuntimeError("Group leakage detected")
    return result


class RobustPreprocessor:
    """Empirical median/IQR scaling; callers supply training rows only.

    This transform does not assume Gaussian or stationary scores. Reuse its
    saved statistics at inference rather than refitting on each request.
    """

    def fit(self, examples: Iterable[Example]) -> "RobustPreprocessor":
        from statistics import median

        # Keep history and target-only samples separate. A target label is a
        # useful training-unit scale fallback when a feature (for example,
        # CSV ``next_score``) is never observed in any history row, but must
        # never shift an established observed-feature transform.
        history_values = {}
        target_values = {}
        for ex in examples:
            specs = {field.name: field for field in ex.fields}
            for row in ex.history:
                for k, v in row.items():
                    # bool subclasses int in Python, but has a categorical
                    # model token and must not acquire a continuous scale.
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        history_values.setdefault(k, []).append(float(v))
            # Labels are only fallback scaling data for declared numeric,
            # non-mapped queries. The caller must pass the training partition;
            # validation, calibration, and test records never fit transforms.
            for query, label in zip(ex.queries, ex.labels):
                name = query.get("field")
                spec = specs.get(name)
                value = label.get(name) if isinstance(label, dict) else None
                if (
                    spec is not None
                    and spec.kind in {"float", "integer"}
                    and query.get("choices") is None
                    and isinstance(value, (int, float))
                    and not isinstance(value, bool)
                ):
                    target_values.setdefault(name, []).append(float(value))
        self.stats = {}
        # Prefer observed history without change. Only numeric target fields
        # with no observed numeric history use their own train-label fallback.
        vals = dict(history_values)
        for name, values in target_values.items():
            if name not in history_values:
                vals[name] = values
        for k, x in vals.items():
            x.sort()
            q1 = x[len(x) // 4]
            q3 = x[(3 * len(x)) // 4]
            # A constant feature has zero IQR. The floor makes the saved
            # transform defined; diagnostics flag large subsequent changes.
            scale = max(q3 - q1, 1e-6)
            self.stats[k] = (median(x), scale)
        return self

    def transform(self, name, value):
        if value is None:
            return (0.0, 1.0)
        center, scale = self.stats.get(name, (0.0, 1.0))
        return ((value - center) / scale, 0.0)
