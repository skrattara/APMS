"""Assessment-context simulator for controlled architecture experiments.

This is deliberately synthetic. Opaque references connect inventory, results,
and queries for validation, but student identity and reference strings never
appear as model features.
"""

from __future__ import annotations

import json
import math
import random
from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .contracts import Example, FieldSpec, SCHEMAS, validate_example
from .assessment_context import assessment_query_horizon


@dataclass(frozen=True)
class AssessmentSyntheticConfig:
    groups: int = 400
    seed: int = 7319
    history_fraction: float = 0.62
    score_missing_probability: float = 0.10
    label_missing_probability: float = 0.02
    noise_sd: float = 5.0

    def __post_init__(self):
        if isinstance(self.groups, bool) or not isinstance(self.groups, int) or self.groups < 1:
            raise ValueError("groups must be a positive integer")
        if not 0 < self.history_fraction < 1:
            raise ValueError("history_fraction must be between zero and one")
        if not 0 <= self.score_missing_probability < 1:
            raise ValueError("score_missing_probability must be in [0, 1)")
        if not 0 <= self.label_missing_probability < 1:
            raise ValueError("label_missing_probability must be in [0, 1)")
        if not math.isfinite(self.noise_sd) or self.noise_sd < 0:
            raise ValueError("noise_sd must be finite and non-negative")


@lru_cache(maxsize=1)
def _templates():
    grading = json.loads((SCHEMAS / "grading" / "systems" / "it_global_grading_system.json").read_text(encoding="utf-8"))
    evaluation = json.loads((SCHEMAS / "evaluation" / "legacy_default_evaluation_system.json").read_text(encoding="utf-8"))
    return grading, evaluation


def _small_schema(seed: int, rng: random.Random):
    """Build a compact, production-schema-valid grading snapshot.

    Three copied production assessment definitions exercise value mapping,
    numeric mapping, and linear scores. Each component has a different count
    scope so the shared assessment compiler sees all supported scope modes.
    """
    template, evaluation = _templates()
    source = {c["assessmentDefinition"]["typeId"]: c for c in template["components"] if "assessmentDefinition" in c}
    selected = [deepcopy(source[key]) for key in ("soc", "lp", "wuq")]
    types = {t["id"]: deepcopy(t) for t in template["assessmentTypes"]}
    scopes = {"soc": ("per_group", "module"), "lp": ("per_period", None), "wuq": ("overall", None)}
    for component in selected:
        definition = component["assessmentDefinition"]
        key = definition["typeId"]
        scope_type, group_type = scopes[key]
        definition["count"] = {"min": 0, "max": 512, "scope": {"type": scope_type, **({"groupTypeId": group_type} if group_type else {})}}
        component["calculation"] = {"mode": "assessments"}
        component["sequence"] = len([c for c in selected if c["sequence"] <= component["sequence"]])
    # Vary opaque IDs across examples to make it impossible to memorize them.
    suffix = f"{seed:08x}"
    type_ids = {"soc": f"presence-{suffix}", "lp": f"mapped-{suffix}", "wuq": f"linear-{suffix}"}
    component_ids = {key: f"component-{key}-{suffix}" for key in type_ids}
    for component in selected:
        old_type = component["assessmentDefinition"]["typeId"]
        component["id"] = component_ids[old_type]
        component["assessmentDefinition"]["typeId"] = type_ids[old_type]
        component["assessmentDefinition"]["count"]["scope"].pop("groupTypeId", None)
        if old_type == "soc":
            component["assessmentDefinition"]["count"]["scope"]["groupTypeId"] = f"module-{suffix}"
    periods = [{"id": f"period-{suffix}-{i}", "name": f"Period {i+1}", "sequence": i+1} for i in range(2)]
    group_types = [{"id": f"module-{suffix}", "name": "Module"}]
    groups = [{"id": f"group-{suffix}-{i}", "name": f"Group {i+1}", "typeId": group_types[0]["id"], "sequence": i+1} for i in range(4)]
    periods[0]["groupIds"] = [groups[0]["id"], groups[1]["id"]]
    periods[1]["groupIds"] = [groups[2]["id"], groups[3]["id"]]
    result = {
        "id": f"synthetic-grading-{suffix}", "name": "Synthetic assessment grading",
        "periods": periods, "groupTypes": group_types, "groups": groups,
        "assessmentTypes": [types[key] | {"id": type_ids[key]} for key in ("soc", "lp", "wuq")],
        "components": selected, "calculationRootComponentId": component_ids["wuq"],
        "finalResult": {"source": "component", "componentId": component_ids["wuq"]},
        "finalGradeConversion": deepcopy(template["finalGradeConversion"]),
    }
    evaluation_copy = deepcopy(evaluation)
    # The template's factors refer to the large checked-in IT tree. Rebind
    # those structural references to this example's compact, valid snapshot.
    def rebind(value):
        if isinstance(value, dict):
            for key, item in list(value.items()):
                if key in {"gradingComponentId", "calculationRootComponentId"}:
                    value[key] = component_ids["wuq"]
                elif key == "periodId":
                    value[key] = periods[0]["id"]
                elif key in {"groupId", "gradingGroupId"}:
                    value[key] = groups[0]["id"]
                else:
                    rebind(item)
        elif isinstance(value, list):
            for item in value:
                rebind(item)
    rebind(evaluation_copy)
    # Schema display labels are stable boilerplate. Local IDs above are unique
    # per example and are never included in the compiled numeric context.
    return {"gradingSystem": result, "evaluationCriteria": evaluation_copy}


def _score_value(mode: str, percent: float, maximum: float, rng: random.Random):
    if mode == "value_mapping":
        return "P" if percent >= 55 else "A"
    if mode == "numeric_mapping":
        mapping = _templates()[0]
        numeric = next(
            component["assessmentDefinition"]["scoring"]["mapping"]
            for component in mapping["components"]
            if component.get("assessmentDefinition", {}).get("scoring", {}).get("mode") == "numeric_mapping"
        )
        return min(numeric, key=lambda row: abs(float(row["percentage"]) - percent))["value"]
    return round(min(maximum, max(0.0, percent * maximum / 100.0)), 2)


def generate_assessment_examples(config: AssessmentSyntheticConfig | None = None) -> list[Example]:
    config = config or AssessmentSyntheticConfig()
    rng = random.Random(config.seed)
    output = []
    grading_template, _ = _templates()
    components = {c["assessmentDefinition"]["typeId"]: c for c in grading_template["components"] if "assessmentDefinition" in c}
    for learner in range(config.groups):
        schema = _small_schema(config.seed * 1_000_003 + learner, rng)
        grading = schema["gradingSystem"]
        # Ability and learning dynamics vary by learner and assessment type.
        ability = rng.uniform(35, 86)
        learning = rng.uniform(-0.8, 1.8)
        family = rng.choice(("steady", "improving", "declining", "shock", "recovery", "seasonal"))
        if family == "improving":
            learning = rng.uniform(0.8, 1.8)
        elif family == "declining":
            learning = rng.uniform(-1.8, -0.8)
        elif family == "steady":
            learning = rng.uniform(-0.2, 0.2)
        type_shift = {kind: rng.uniform(-12, 12) for kind in ("soc", "lp", "wuq")}
        period_shift = [rng.uniform(-7, 7) for _ in range(2)]
        group_shift = [rng.uniform(-6, 6) for _ in range(4)]
        shock_at = rng.choice((2, 3, 4))
        shock_size = rng.uniform(-16, 16)
        history, queries, labels, instances, results = [], [], [], [], []
        sequence = 0
        records = []
        mode_by_type = {"soc": "value_mapping", "lp": "numeric_mapping", "wuq": "linear"}
        scope_by_type = {"soc": "group", "lp": "period", "wuq": "overall"}
        id_suffix = f"L{learner:04d}"
        for round_index in range(5):
            for group_index, group in enumerate(grading["groups"]):
                period = grading["periods"][group_index // 2]
                for old_type in ("soc", "lp", "wuq"):
                    sequence += 1
                    mode = mode_by_type[old_type]
                    maximum = (10.0, 20.0, 100.0)[(round_index + group_index) % 3] if mode == "linear" else (3.0 if mode == "numeric_mapping" else 1.0)
                    ref = f"{id_suffix}-a{sequence:02d}"
                    difficulty = rng.uniform(-13, 13)
                    period_effect = period_shift[period["sequence"] - 1]
                    group_effect = group_shift[group_index]
                    family_effect = {
                        "shock": shock_size if round_index >= shock_at else 0.0,
                        "recovery": (shock_size if round_index == shock_at else 0.0)
                        + (max(0, round_index - shock_at) * -shock_size / 2.0 if round_index > shock_at else 0.0),
                        "seasonal": 7.0 * math.sin(round_index * math.pi / 2.0),
                    }.get(family, 0.0)
                    percent = min(100.0, max(0.0, ability + learning * round_index * 2.5 + family_effect + type_shift[old_type] + period_effect + group_effect - difficulty + rng.gauss(0, config.noise_sd)))
                    mapped = deepcopy(components[old_type]["assessmentDefinition"]["scoring"])
                    scoring = ({"mode": "linear", "maximum_score": maximum} if mode == "linear" else mapped)
                    instance = {"assessment_ref": ref, "assessment_type_ref": next(t["id"] for t in grading["assessmentTypes"] if t["id"].startswith({"soc":"presence", "lp":"mapped", "wuq":"linear"}[old_type])), "sequence": sequence, "maximum_score": maximum, "scoring": scoring, "group_ref": group["id"], "period_ref": period["id"], "relative_day": None, "due_in_days": float((sequence % 11) - 5)}
                    instances.append(instance)
                    value = _score_value(mode, percent, maximum, rng)
                    records.append((instance, value, percent, mode, old_type, group, period))
        cut = max(1, int(len(records) * config.history_fraction))
        observed_max_sequence = records[cut - 1][0]["sequence"]
        for instance in instances:
            instance["relative_day"] = float((instance["sequence"] - observed_max_sequence) * 2)
        for instance, value, percent, mode, old_type, group, period in records[:cut]:
            if rng.random() >= config.score_missing_probability:
                results.append({"assessment_ref": instance["assessment_ref"], "value": value, "observed_day": -rng.randint(0, 8)})
        # Raw numeric score and mapped/category outputs stay distinct.
        risk_factor = next((factor for factor in schema["evaluationCriteria"]["factors"] if factor.get("source") == "ai_risk_level"), None)
        risk_categories = tuple(risk_factor.get("categories", ("low", "medium", "high"))) if risk_factor else ("low", "medium", "high")
        fields = [
            FieldSpec("current_standing", "float", minimum=0, maximum=100),
            FieldSpec("attendance_rate", "float", minimum=0, maximum=100),
            FieldSpec("missing_assessment_count", "integer", minimum=0),
            FieldSpec("engaged", "boolean"),
            FieldSpec("pattern", "category", ("up", "flat", "down")),
            FieldSpec("trend", "category", ("improving", "stable", "declining")),
            FieldSpec("failure", "boolean"),
            FieldSpec("mapped_score", "integer", minimum=0, maximum=3),
            FieldSpec("categorical_score", "category", ("P", "A")),
            FieldSpec("assessment_score", "float", minimum=0, maximum=100),
            FieldSpec("ai_risk_level", "category", risk_categories),
        ]
        latest_percent = records[cut - 1][2]
        standing = min(100, max(0, ability + learning * 8 + rng.gauss(0, 4)))
        history = [{"current_standing": standing, "attendance_rate": min(100, max(0, standing + rng.gauss(0, 10))), "missing_assessment_count": int(rng.random() * 4), "engaged": standing > 55, "pattern": "up" if learning > .5 else "down" if learning < -.2 else "flat"}]
        query_records = [row for row in records[cut:] if row[0]["sequence"] > observed_max_sequence]
        assessment_queries_added = 0
        duplicate_source = None
        duplicate_label = None
        for instance, value, percent, mode, old_type, group, period in query_records:
            if mode == "linear":
                field = "assessment_score"
                raw = value
            elif mode == "numeric_mapping":
                field = "mapped_score"
                raw = value
            else:
                field = "categorical_score"
                raw = value
            query = {
                "field": field,
                "horizon": assessment_query_horizon(instance, instances, results),
                "assessment_ref": instance["assessment_ref"],
            }
            if mode == "numeric_mapping":
                query["choices"] = [row["value"] for row in instance["scoring"]["mapping"]]
            elif mode == "value_mapping":
                query["choices"] = [row["value"] for row in instance["scoring"]["mapping"]]
            queries.append(query)
            main_label = None if rng.random() < config.label_missing_probability else raw
            labels.append({field: main_label, "trend": "improving" if learning > .3 else "declining" if learning < -.3 else "stable", "failure": standing < 60})
            assessment_queries_added += 1
            if mode == "linear" and duplicate_source is None:
                duplicate_source = (instance, query, field)
                duplicate_label = labels[-1]
        if duplicate_source is not None:
            original_instance, original_query, field = duplicate_source
            twin_ref = original_instance["assessment_ref"] + "-equivalent"
            twin = deepcopy(original_instance)
            twin["assessment_ref"] = twin_ref
            instances.append(twin)
            twin_query = {**original_query, "assessment_ref": twin_ref}
            queries.append(twin_query)
            labels.append(deepcopy(duplicate_label))
        # Base multitask forecasts prevent an assessment-only head from being
        # mistaken for a drop-in full-model release.
        for field, horizon in (("current_standing", 1), ("current_standing", 2), ("trend", 1), ("failure", 1), ("ai_risk_level", 1)):
            future = min(100, max(0, standing + learning * 4 * horizon + rng.gauss(0, config.noise_sd)))
            queries.append({"field": field, "horizon": horizon})
            main_label = future if field == "current_standing" else ("improving" if learning > .3 else "declining" if learning < -.3 else "stable") if field == "trend" else future < 60 if field == "failure" else ("low" if future >= 70 else "medium" if future >= 50 else "high")
            if rng.random() < config.label_missing_probability:
                main_label = None
            labels.append({field: main_label, "trend": "improving" if learning > .3 else "declining" if learning < -.3 else "stable", "failure": future < 60})
        example = Example(history, queries, fields, labels, group=f"assessment-learner-{config.seed}-{learner:04d}", origin="synthetic", schema=schema, assessment_instances=instances, assessment_results=results)
        # Validate at generation time so bad profiles fail before long training.
        validate_example(example)
        output.append(example)
    return output
