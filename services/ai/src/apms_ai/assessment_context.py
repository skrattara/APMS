"""Versioned, identity-free assessment features shared by training and serving.

References in this module are local joins used to validate relationships. They
are never returned as features. All summaries are cut off before the requested
assessment, and tied sequence values are aggregated rather than ordered.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

ASSESSMENT_CONTEXT_VERSION = 1
ASSESSMENT_CONTEXT_NORMALIZATION_VERSION = (
    "assessment_context_v1_fixed_caps_512_signed_log_days36500_score100"
)
ASSESSMENT_RESULT_CUTOFF = "strictly_prior_sequence_and_observed_day_le_0"

ASSESSMENT_CONTEXT_FEATURE_NAMES = (
    "assessment_query",
    "assessment_type_index",
    "component_index",
    "scoring_linear",
    "scoring_numeric_mapping",
    "scoring_value_mapping",
    "maximum_score_log",
    "sequence_position",
    "period_present",
    "period_sequence",
    "group_present",
    "group_type_index",
    "group_position_within_type",
    "group_depth",
    "scope_overall",
    "scope_per_period",
    "scope_per_group",
    "same_type_scope_position",
    "prior_same_type_scope_count",
    "prior_latest_present",
    "prior_latest_percent",
    "prior_mean_percent",
    "prior_std_percent",
    "prior_change_percent",
    "prior_age_steps",
    "relative_day_present",
    "relative_day_scaled",
    "due_in_days_present",
    "due_in_days_scaled",
    "prior_same_type_count",
    "prior_same_type_latest_present",
    "prior_same_type_latest_percent",
    "prior_same_type_mean_percent",
    "prior_same_type_std_percent",
)

BASE_QUERY_FEATURES = 8
QUERY_FEATURES_V1 = BASE_QUERY_FEATURES + len(ASSESSMENT_CONTEXT_FEATURE_NAMES)
_ORDINAL_CAP = 512
_DAY_CAP = 36500.0


def validate_assessment_context_metadata(metadata: dict[str, Any]) -> int:
    """Fail closed if bundle metadata and learned tensor width disagree."""
    model_config = metadata.get("model_config", {})
    config_version = model_config.get("assessment_context_version", 0)
    metadata_version = metadata.get("assessment_context_version", config_version)
    for value in (config_version, metadata_version):
        if isinstance(value, bool) or not isinstance(value, int) or value not in (0, 1):
            raise ValueError("Invalid assessment_context_version in artifact metadata")
    if config_version != metadata_version:
        raise ValueError("Artifact assessment context version fields disagree")
    if config_version == 1:
        if tuple(metadata.get("assessment_context_feature_names", ())) != ASSESSMENT_CONTEXT_FEATURE_NAMES:
            raise ValueError("Artifact assessment context feature names do not match v1")
        if metadata.get("assessment_context_normalization_version") != ASSESSMENT_CONTEXT_NORMALIZATION_VERSION:
            raise ValueError("Artifact assessment context normalization version is unsupported")
        if metadata.get("assessment_result_cutoff") != ASSESSMENT_RESULT_CUTOFF:
            raise ValueError("Artifact assessment result cutoff semantics are unsupported")
    return config_version


def _component_by_type(grading: dict[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    result = {}
    for component_index, component in enumerate(grading.get("components", [])):
        definition = component.get("assessmentDefinition")
        if definition:
            type_ref = definition["typeId"]
            if type_ref in result:
                raise ValueError("Assessment type is ambiguous in grading schema")
            result[type_ref] = (component_index, component)
    return result


def _mean(values: list[float]) -> float:
    return math.fsum(values) / len(values) if values else 0.0


def _std(values: list[float]) -> float:
    if not values:
        return 0.0
    center = _mean(values)
    return math.sqrt(
        math.fsum((value - center) ** 2 for value in values) / len(values)
    )


def _ordinal(value: int | float, cap: int = _ORDINAL_CAP) -> float:
    return min(max(float(value), 0.0), float(cap)) / float(cap)


def _dense_ranks(values: list[float]) -> dict[float, int]:
    """Map distinct sequence values to ranks without resolving ties by ID."""
    return {value: index for index, value in enumerate(sorted(set(values)))}


def assessment_query_horizon(
    target: dict[str, Any],
    inventory: list[dict[str, Any]],
    results: list[dict[str, Any]],
) -> int:
    """Return the rank distance from the nearest known prior scored item.

    The rank is based on distinct declared sequence values, so tied instances
    do not create artificial ordering. Unknown-time results remain scored for
    suppression purposes but cannot establish a temporal horizon.
    """
    if (
        isinstance(target.get("sequence"), bool)
        or not isinstance(target.get("sequence"), (int, float))
        or not math.isfinite(float(target["sequence"]))
    ):
        raise ValueError("Assessment horizon requires a numeric target sequence")
    by_ref = {item.get("assessment_ref"): item for item in inventory}
    if len(by_ref) != len(inventory) or target.get("assessment_ref") not in by_ref:
        raise ValueError("Assessment horizon requires a unique inventory target")
    sequences = []
    for item in inventory:
        sequence = item.get("sequence")
        if (
            isinstance(sequence, bool)
            or not isinstance(sequence, (int, float))
            or not math.isfinite(float(sequence))
        ):
            raise ValueError("Assessment horizon requires finite instance sequences")
        sequences.append(float(sequence))
    ranks = _dense_ranks(sequences)
    target_sequence = float(target["sequence"])
    target_rank = ranks[target_sequence]
    result_by_ref = {item.get("assessment_ref"): item for item in results}
    if len(result_by_ref) != len(results):
        raise ValueError("Assessment horizon results must have unique references")
    known_prior = []
    for ref, result in result_by_ref.items():
        instance = by_ref.get(ref)
        if instance is None:
            raise ValueError("Assessment horizon result references an unknown instance")
        observed_day = result.get("observed_day", 0)
        if observed_day is None:
            continue
        if (
            isinstance(observed_day, bool)
            or not isinstance(observed_day, (int, float))
            or not math.isfinite(float(observed_day))
            or observed_day > 0
        ):
            raise ValueError("Assessment horizon results must be at or before cutoff")
        sequence = float(instance["sequence"])
        if sequence < target_sequence:
            known_prior.append(ranks[sequence])
    horizon = target_rank - max(known_prior) if known_prior else 1
    if not 1 <= horizon <= 128:
        raise ValueError("Assessment query horizon must be between 1 and 128")
    return horizon


def _mapped_percent(instance: dict[str, Any], raw: Any) -> float:
    scoring = instance["scoring"]
    mode = scoring["mode"]
    if mode == "linear":
        maximum = float(scoring["maximum_score"])
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError("Linear assessment result must be numeric")
        if not math.isfinite(float(raw)) or not 0 <= float(raw) <= maximum:
            raise ValueError("Linear assessment result is outside its score domain")
        return float(raw) * 100.0 / maximum
    mapping = scoring.get("mapping", [])
    for row in mapping:
        declared = row["value"]
        if isinstance(declared, bool) or isinstance(raw, bool):
            matches = type(declared) is type(raw) and declared == raw
        elif isinstance(declared, (int, float)) and isinstance(raw, (int, float)):
            matches = math.isfinite(float(declared)) and math.isfinite(float(raw)) and float(declared) == float(raw)
        else:
            matches = type(declared) is type(raw) and declared == raw
        if matches:
            return float(row["percentage"])
    raise ValueError("Assessment result is outside its grading mapping")


def _scope_matches(
    candidate: dict[str, Any], target: dict[str, Any], scope_type: str
) -> bool:
    if scope_type == "per_group":
        return candidate.get("group_ref") == target.get("group_ref")
    if scope_type == "per_period":
        return candidate.get("period_ref") == target.get("period_ref")
    if scope_type == "overall":
        return True
    raise ValueError("Unsupported assessment count scope")


def compile_assessment_contexts(example) -> list[list[float]]:
    """Compile one 34-float descriptor for every query, in query order.

    The compiler is deterministic under input inventory/result permutations and
    opaque reference renaming. Callers must pass an already schema-validated
    grading snapshot and instances validated by `validate_assessment_instances`.
    """
    query_count = len(example.queries)
    empty = [0.0] * len(ASSESSMENT_CONTEXT_FEATURE_NAMES)
    if not example.queries or not any("assessment_ref" in q for q in example.queries):
        return [empty.copy() for _ in example.queries]

    grading = example.schema.get("gradingSystem")
    if not isinstance(grading, dict):
        raise ValueError("Assessment context requires a grading schema")
    instances = example.assessment_instances
    if not instances:
        raise ValueError("Assessment context requires its full instance inventory")
    from .contracts import (
        compile_assessment_constraint,
        validate_assessment_instances,
    )

    # Validate the inventory once. Per-item constraint compilation below is
    # then a pure lookup; revalidating the entire schema for every instance is
    # quadratic for large grading books. Inventory completeness is enforced
    # by the shared query binder, which knows whether this is a complete or
    # partial assessment request.
    validate_assessment_instances(grading, instances, inventory="partial")

    compiled_domains = {
        item["assessment_ref"]: compile_assessment_constraint(
            grading, item, validate=False
        )
        for item in instances
    }
    by_ref = {item["assessment_ref"]: item for item in instances}
    if len(by_ref) != len(instances):
        raise ValueError("Assessment references must be unique")
    if any("sequence" not in item for item in instances):
        raise ValueError("Assessment context instances require relative sequence values")
    results_by_ref = {item["assessment_ref"]: item for item in example.assessment_results}
    if len(results_by_ref) != len(example.assessment_results):
        raise ValueError("Assessment results must be unique by reference")
    if set(results_by_ref) - set(by_ref):
        raise ValueError("Assessment result references an unknown instance")

    types = grading.get("assessmentTypes", [])
    type_indexes = {item["id"]: index for index, item in enumerate(types)}
    components = _component_by_type(grading)
    periods = grading.get("periods", [])
    period_sequences = _dense_ranks([float(item["sequence"]) for item in periods])
    period_rank_cap = max(1, len(period_sequences) - 1)
    group_types = grading.get("groupTypes", [])
    group_type_indexes = {item["id"]: index for index, item in enumerate(group_types)}
    groups = grading.get("groups", [])
    group_by_ref = {item["id"]: item for item in groups}
    group_sequences_by_type = {
        type_ref: _dense_ranks(
            [float(item["sequence"]) for item in groups if item.get("typeId") == type_ref]
        )
        for type_ref in group_type_indexes
    }

    def group_depth(group_ref: str | None) -> int:
        depth, active, current = 0, set(), group_ref
        while current is not None:
            if current in active:
                raise ValueError("Assessment group hierarchy contains a cycle")
            active.add(current)
            group = group_by_ref.get(current)
            if group is None:
                raise ValueError("Assessment references an unknown grading group")
            current = group.get("parentGroupId")
            if current is not None:
                depth += 1
        return depth

    sequences = [float(item["sequence"]) for item in instances]
    sequence_rank = _dense_ranks(sequences)
    max_sequence_rank = max(1, len(sequence_rank) - 1)
    result_rows = []
    for ref, result in results_by_ref.items():
        instance = by_ref[ref]
        observed_day = result.get("observed_day", 0)
        if observed_day is not None and (
            isinstance(observed_day, bool)
            or not isinstance(observed_day, (int, float))
            or not math.isfinite(float(observed_day))
            or observed_day > 0
        ):
            raise ValueError("Assessment results must be observed at or before cutoff")
        mapped_percent = _mapped_percent(instance, result["value"])
        # A value with unknown observation time suppresses a forecast for its
        # own reference but cannot enter any time-bounded summary.
        if observed_day is not None:
            result_rows.append(
                (instance, float(instance["sequence"]), mapped_percent)
            )

    compiled = []
    for query in example.queries:
        vector = empty.copy()
        target_ref = query.get("assessment_ref")
        if target_ref is None:
            compiled.append(vector)
            continue
        target = by_ref.get(target_ref)
        if target is None:
            raise ValueError("Assessment query references an unknown instance")
        if target_ref in results_by_ref or target.get("has_result") is True:
            raise ValueError("Assessment query must reference an unscored instance")
        spec = next(
            (field for field in example.fields if field.name == query.get("field")),
            None,
        )
        domain = compiled_domains[target_ref]
        if spec is None or (domain["kind"] == "category") != (spec.kind == "category"):
            raise ValueError("Assessment query and compiled grading type disagree")
        requested_choices = query.get("choices")
        if requested_choices is not None and any(
            value not in domain["choices"] for value in requested_choices
        ):
            raise ValueError("Assessment query choices widen the grading mapping")
        for key, lower_bound in (("minimum", True), ("maximum", False)):
            value = query.get(key)
            allowed_bound = domain["minimum" if lower_bound else "maximum"]
            if value is not None and allowed_bound is not None and (
                value < allowed_bound if lower_bound else value > allowed_bound
            ):
                raise ValueError("Assessment query bounds widen the grading domain")
        type_ref = target["assessment_type_ref"]
        if type_ref not in type_indexes or type_ref not in components:
            raise ValueError("Assessment query type is not in the grading schema")
        component_index, component = components[type_ref]
        definition = component["assessmentDefinition"]
        scope_type = definition.get("count", {}).get("scope", {}).get("type", "overall")
        scoring_mode = target["scoring"]["mode"]
        target_sequence = float(target["sequence"])
        target_period = target.get("period_ref")
        target_group = target.get("group_ref")

        same_type_instances = [
            item for item in instances if item["assessment_type_ref"] == type_ref
        ]
        same_type_scope_instances = [
            item
            for item in same_type_instances
            if _scope_matches(item, target, scope_type)
        ]
        within_type_ranks = _dense_ranks(
            [float(item["sequence"]) for item in same_type_scope_instances]
        )
        group_ref = target_group
        group = group_by_ref.get(group_ref) if group_ref is not None else None
        group_type_ref = group.get("typeId") if group else None
        group_type_index = group_type_indexes.get(group_type_ref, -1)
        group_position_rank = (
            group_sequences_by_type.get(group_type_ref, {}).get(
                float(group["sequence"]), 0
            )
            if group is not None
            else 0
        )
        group_rank_cap = max(
            1, len(group_sequences_by_type.get(group_type_ref, {})) - 1
        )
        period_position_rank = (
            period_sequences.get(
                float(next(p["sequence"] for p in periods if p["id"] == target_period)),
                0,
            )
            if target_period is not None
            else 0
        )
        maximum = float(target["maximum_score"])

        vector[0] = 1.0
        vector[1] = _ordinal(type_indexes[type_ref], _ORDINAL_CAP - 1)
        vector[2] = _ordinal(component_index, _ORDINAL_CAP - 1)
        vector[3] = float(scoring_mode == "linear")
        vector[4] = float(scoring_mode == "numeric_mapping")
        vector[5] = float(scoring_mode == "value_mapping")
        vector[6] = min(math.log1p(maximum) / math.log1p(1_000_000.0), 1.0)
        vector[7] = sequence_rank[target_sequence] / max_sequence_rank
        vector[8] = float(target_period is not None)
        vector[9] = period_position_rank / period_rank_cap if target_period is not None else 0.0
        vector[10] = float(group_ref is not None)
        vector[11] = _ordinal(group_type_index, _ORDINAL_CAP - 1) if group_type_index >= 0 else 0.0
        vector[12] = group_position_rank / group_rank_cap if group is not None else 0.0
        vector[13] = _ordinal(group_depth(group_ref)) if group_ref else 0.0
        vector[14] = float(scope_type == "overall")
        vector[15] = float(scope_type == "per_period")
        vector[16] = float(scope_type == "per_group")
        vector[17] = _ordinal(within_type_ranks[target_sequence])

        eligible_scope = [
            (instance, sequence, percent)
            for instance, sequence, percent in result_rows
            if instance["assessment_type_ref"] == type_ref
            and sequence < target_sequence
            and _scope_matches(instance, target, scope_type)
        ]
        eligible_type = [
            (instance, sequence, percent)
            for instance, sequence, percent in result_rows
            if instance["assessment_type_ref"] == type_ref and sequence < target_sequence
        ]

        # Scope-specific summary has six base fields, including standard
        # deviation, change between distinct sequence groups, and age.
        scope_groups: dict[float, list[float]] = defaultdict(list)
        for _instance, sequence, percent in eligible_scope:
            scope_groups[sequence].append(percent)
        scope_sequences = sorted(scope_groups)
        scope_values = [value for values in scope_groups.values() for value in values]
        vector[18] = _ordinal(len(eligible_scope))
        vector[19] = float(bool(scope_sequences))
        vector[20] = _mean(scope_groups[scope_sequences[-1]]) / 100.0 if scope_sequences else 0.0
        vector[21] = _mean(scope_values) / 100.0 if scope_values else 0.0
        vector[22] = _std(scope_values) / 100.0 if scope_values else 0.0
        vector[23] = (
            (_mean(scope_groups[scope_sequences[-1]]) - _mean(scope_groups[scope_sequences[-2]])) / 100.0
            if len(scope_sequences) > 1
            else 0.0
        )
        vector[24] = (
            _ordinal(target_sequence - scope_sequences[-1]) if scope_sequences else 0.0
        )

        for position, key in ((25, "relative_day"), (27, "due_in_days")):
            if key in target and target[key] is not None:
                vector[position] = 1.0
                days = float(target[key])
                vector[position + 1] = (
                    math.copysign(math.log1p(abs(days)), days)
                    / math.log1p(_DAY_CAP)
                )
        vector[29] = _ordinal(len(eligible_type))
        vector[30] = float(bool(eligible_type))
        if eligible_type:
            type_groups: dict[float, list[float]] = defaultdict(list)
            for _instance, sequence, percent in eligible_type:
                type_groups[sequence].append(percent)
            type_sequences = sorted(type_groups)
            type_values = [value for values in type_groups.values() for value in values]
            vector[31] = _mean(type_groups[type_sequences[-1]]) / 100.0
            vector[32] = _mean(type_values) / 100.0
            vector[33] = _std(type_values) / 100.0
        compiled.append(vector)

    if len(compiled) != query_count:
        raise RuntimeError("Assessment context compiler lost query alignment")
    return compiled
