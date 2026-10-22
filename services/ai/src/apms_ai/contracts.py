"""Typed, privacy-minimal records and schema constraint compilation."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[4]
_REPOSITORY_SCHEMAS = ROOT / "packages" / "domain" / "src"
_PACKAGED_SCHEMAS = Path(__file__).resolve().parent / "schema_data"
SCHEMAS = (
    _REPOSITORY_SCHEMAS
    if (_REPOSITORY_SCHEMAS / "grading" / "grading_system_schema.json").is_file()
    else _PACKAGED_SCHEMAS
)


@dataclass(frozen=True)
class FieldSpec:
    name: str
    kind: Literal["float", "integer", "boolean", "category"]
    categories: tuple[str, ...] = ()
    minimum: float | None = None
    maximum: float | None = None

    def __post_init__(self) -> None:
        if not self.name or self.kind not in {
            "float",
            "integer",
            "boolean",
            "category",
        }:
            raise ValueError("A field needs a name and a supported scalar kind")
        object.__setattr__(self, "categories", tuple(self.categories))
        if any(not isinstance(x, str) for x in self.categories):
            raise ValueError("Category tokens must be strings")
        if len(set(self.categories)) != len(self.categories):
            raise ValueError("Category tokens must be unique")
        if self.kind == "category" and not self.categories:
            raise ValueError("Categorical fields need an explicit legal domain")
        for bound in (self.minimum, self.maximum):
            if bound is not None and (
                isinstance(bound, bool) or not math.isfinite(bound)
            ):
                raise ValueError("Numeric bounds must be finite")
        if self.minimum is not None and self.maximum is not None:
            if self.minimum > self.maximum:
                raise ValueError("Minimum cannot exceed maximum")
            if self.kind == "integer" and math.ceil(self.minimum) > math.floor(
                self.maximum
            ):
                raise ValueError("Integer bounds contain no legal integer")


@dataclass(frozen=True)
class Value:
    field: str
    value: Any = None


@dataclass
class Example:
    history: list[dict[str, Any]]
    queries: list[dict[str, Any]]
    fields: list[FieldSpec]
    labels: list[dict[str, Any]] = field(default_factory=list)
    group: str | None = None
    origin: str = "real"
    schema: dict[str, Any] = field(default_factory=dict)
    # These optional joins are local to one example. Their opaque references
    # are validated but never used as model tokens or vocabulary entries.
    assessment_instances: list[dict[str, Any]] = field(default_factory=list)
    assessment_results: list[dict[str, Any]] = field(default_factory=list)


def example_fingerprint_record(example: Example) -> dict[str, Any]:
    """Stable serialization; empty v1 fields preserve legacy dataset hashes."""
    from dataclasses import asdict

    record = asdict(example)
    if not example.assessment_instances:
        record.pop("assessment_instances", None)
    if not example.assessment_results:
        record.pop("assessment_results", None)
    if example.assessment_instances:
        record["assessment_instances"] = example.assessment_instances
    if example.assessment_results:
        record["assessment_results"] = example.assessment_results
    return record


@lru_cache(maxsize=2)
def _validator(path: Path) -> Draft202012Validator:
    if not path.is_file():
        raise ValueError(f"Schema not found: {path}")
    schema = json.loads(path.read_text(encoding="utf-8"))
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _finite_tree(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Schema and data numbers must be finite")
    if isinstance(value, dict):
        for item in value.values():
            _finite_tree(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _finite_tree(item)


def _schema(path: Path, value: Any) -> None:
    _finite_tree(value)
    errors = sorted(
        _validator(path).iter_errors(value), key=lambda e: list(map(str, e.path))
    )
    if errors:
        raise ValueError(
            "; ".join(f"{'.'.join(map(str, e.path))}: {e.message}" for e in errors[:20])
        )


def _unique(items: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
    result = {item["id"]: item for item in items}
    if len(result) != len(items):
        raise ValueError(f"{label} IDs must be unique")
    return result


def _acyclic(graph: dict[str, list[str]], label: str) -> None:
    active, done = set(), set()

    def visit(node: str) -> None:
        if node in active:
            raise ValueError(f"{label} contains a cycle")
        if node in done:
            return
        active.add(node)
        for child in graph[node]:
            visit(child)
        active.remove(node)
        done.add(node)

    for node in graph:
        visit(node)


def validate_grading(definition: dict[str, Any]) -> None:
    _schema(SCHEMAS / "grading" / "grading_system_schema.json", definition)
    for collection in (
        "components",
        "periods",
        "groups",
        "groupTypes",
        "assessmentTypes",
    ):
        _unique(definition.get(collection, []), collection)
    periods = {p["id"] for p in definition.get("periods", [])}
    groups = {g["id"] for g in definition.get("groups", [])}
    group_types = {g["id"] for g in definition.get("groupTypes", [])}
    components = {c["id"]: c for c in definition["components"]}
    types = {a["id"] for a in definition.get("assessmentTypes", [])}
    if definition["calculationRootComponentId"] not in components:
        raise ValueError("Calculation root references an unknown component")
    final_result = definition.get("finalResult", {})
    if (
        final_result.get("source") in {"component", "period_component"}
        and final_result.get("componentId") not in components
    ):
        raise ValueError("Final result references an unknown component")
    for period in definition.get("periods", []):
        if any(group_id not in groups for group_id in period.get("groupIds", [])):
            raise ValueError("Period references an unknown grading group")
    group_graph = {}
    for group in definition.get("groups", []):
        if group.get("typeId") not in group_types:
            raise ValueError("Group references an unknown group type")
        parent = group.get("parentGroupId")
        if parent and parent not in groups:
            raise ValueError("Group references an unknown parent group")
        group_graph[group["id"]] = [parent] if parent else []
    graph: dict[str, list[str]] = {}
    for cid, comp in components.items():
        calc = comp.get("calculation", {})
        children = []
        for edge in calc.get("components", []):
            child = edge.get("componentId")
            if edge.get("source") in {"component", "period_component"}:
                if child not in components:
                    raise ValueError(f"Unknown component reference: {child}")
                children.append(child)
            if edge.get("periodId") and edge["periodId"] not in periods:
                raise ValueError("Unknown period reference")
        graph[cid] = children
        ad = comp.get("assessmentDefinition")
        if ad:
            if ad.get("typeId") not in types:
                raise ValueError(f"Unknown assessment type: {ad.get('typeId')}")
            count = ad.get("count", {})
            if (
                count.get("min") is not None
                and count.get("max") is not None
                and count["min"] > count["max"]
            ):
                raise ValueError("Assessment minimum count exceeds maximum")
            scope = count.get("scope", {})
            if scope.get("type") == "per_group":
                if scope.get("groupTypeId") not in group_types:
                    raise ValueError("Unknown group type in count scope")
            scoring = ad.get("scoring", {})
            if scoring.get("mode") in {
                "numeric_mapping",
                "value_mapping",
            } and not scoring.get("mapping"):
                raise ValueError(
                    "Mapped assessment scoring requires allowed mapping values"
                )
            if scoring.get("mode") in {"numeric_mapping", "value_mapping"}:
                mapped = [item.get("value") for item in scoring["mapping"]]
                if len(set(map(str, mapped))) != len(mapped):
                    raise ValueError("Scoring mapping values must be unique")
                for item in scoring["mapping"]:
                    percentage = item.get("percentage")
                    if (
                        not isinstance(percentage, (int, float))
                        or not math.isfinite(percentage)
                        or not 0 <= percentage <= 100
                    ):
                        raise ValueError(
                            "Mapped percentages must be finite values from 0 to 100"
                        )
        for group in comp.get("groups", []):
            if group not in groups:
                raise ValueError(f"Unknown group reference: {group}")
    active, done = set(), set()

    def visit(node: str) -> None:
        if node in active:
            raise ValueError("Grading component graph contains a cycle")
        if node in done:
            return
        active.add(node)
        for child in graph[node]:
            visit(child)
        active.remove(node)
        done.add(node)

    for node in graph:
        visit(node)
    active.clear()
    done.clear()

    def visit_group(node: str) -> None:
        if node in active:
            raise ValueError("Grading group hierarchy contains a cycle")
        if node in done:
            return
        active.add(node)
        for parent in group_graph[node]:
            visit_group(parent)
        active.remove(node)
        done.add(node)

    for node in group_graph:
        visit_group(node)
    _validate_grading_links(definition)


def _assessment_component(
    grading: dict[str, Any], type_ref: str
) -> dict[str, Any] | None:
    """Resolve a request-local type reference to exactly one grading component."""
    matches = [
        component
        for component in grading.get("components", [])
        if component.get("assessmentDefinition", {}).get("typeId") == type_ref
    ]
    if len(matches) > 1:
        raise ValueError("Assessment type is ambiguous in the grading definition")
    return matches[0] if matches else None


def _numeric_weight(value: Any) -> float:
    if isinstance(value, dict):
        return float(value["numerator"]) / float(value["denominator"])
    return float(value)


def _assessment_domain(
    grading: dict[str, Any], component: dict[str, Any]
) -> tuple[str, float | None, float | None, list[Any]]:
    definition = component["assessmentDefinition"]
    scoring = definition["scoring"]
    maximum = definition.get("maxScore")
    mode = scoring["mode"]
    if mode == "value_mapping":
        return "category", None, None, [item["value"] for item in scoring["mapping"]]
    if mode == "numeric_mapping":
        values = [item["value"] for item in scoring["mapping"]]
        kind = (
            "integer"
            if all(
                isinstance(value, int) and not isinstance(value, bool)
                for value in values
            )
            else "float"
        )
        return kind, min(values), max(values), values
    return "float", 0.0, float(maximum) if maximum is not None else None, []


def _validate_assessment_instances(
    grading: dict[str, Any],
    instances: list[dict[str, Any]],
    *,
    enforce_counts: bool,
    inventory: str = "complete",
) -> None:
    """Fail closed on assessment context before binding any model queries.

    The records are the privacy-projected gateway contract. Counts include all
    instances supplied, including ones whose result is already recorded.
    """
    if not isinstance(inventory, str) or inventory not in ("partial", "complete"):
        raise ValueError("Assessment inventory must be 'partial' or 'complete'")
    validate_grading(grading)
    if not isinstance(instances, list):
        raise ValueError("Assessment instances must be a list")
    if len(instances) > 512:
        raise ValueError("Assessment instance limit exceeded")
    periods = {item["id"]: item for item in grading.get("periods", [])}
    groups = {item["id"]: item for item in grading.get("groups", [])}
    type_refs = {item["id"] for item in grading.get("assessmentTypes", [])}
    seen: set[str] = set()
    parsed: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for instance in instances:
        if not isinstance(instance, dict):
            raise ValueError("Each assessment instance must be an object")
        required = {"assessment_ref", "assessment_type_ref", "maximum_score", "scoring"}
        optional_keys = {
            "period_ref", "group_ref", "weight", "optional", "has_result",
            "sequence", "relative_day", "due_in_days",
        }
        if required - set(instance) or set(instance) - required - optional_keys:
            raise ValueError(
                "Assessment instance fields do not match the supported contract"
            )
        if "sequence" in instance:
            sequence = instance["sequence"]
            if (
                isinstance(sequence, bool)
                or not isinstance(sequence, (int, float))
                or not math.isfinite(float(sequence))
                or sequence < 0
                or sequence > 1_000_000_000
            ):
                raise ValueError("Assessment sequence must be finite and nonnegative")
        for temporal_key in ("relative_day", "due_in_days"):
            if temporal_key in instance:
                day = instance[temporal_key]
                if day is None:
                    continue
                if (
                    isinstance(day, bool)
                    or not isinstance(day, (int, float))
                    or not math.isfinite(float(day))
                    or not -36500 <= day <= 36500
                ):
                    raise ValueError(
                        f"{temporal_key} must be finite and within 36500 days"
                    )
        ref, type_ref = instance["assessment_ref"], instance["assessment_type_ref"]
        if not isinstance(ref, str) or not ref or ref in seen:
            raise ValueError("Assessment references must be nonempty and unique")
        seen.add(ref)
        if not isinstance(type_ref, str) or type_ref not in type_refs:
            raise ValueError(
                "Assessment instance references an unknown assessment type"
            )
        component = _assessment_component(grading, type_ref)
        if component is None:
            raise ValueError("Assessment type is not used by an assessment component")
        definition = component["assessmentDefinition"]
        maximum = instance["maximum_score"]
        if (
            isinstance(maximum, bool)
            or not isinstance(maximum, (int, float))
            or not math.isfinite(maximum)
            or not 0 < maximum <= 100000
        ):
            raise ValueError(
                "Assessment maximum score must be finite and from 0 to 100000"
            )
        declared_maximum = definition.get("maxScore")
        if declared_maximum is not None and maximum > declared_maximum:
            raise ValueError(
                "Assessment maximum exceeds the grading definition maximum"
            )
        scoring = instance["scoring"]
        expected = definition["scoring"]
        if not isinstance(scoring, dict) or scoring.get("mode") != expected["mode"]:
            raise ValueError(
                "Assessment scoring mode differs from its grading definition"
            )
        if expected["mode"] == "linear":
            if (
                set(scoring) != {"mode", "maximum_score"}
                or scoring["maximum_score"] != maximum
            ):
                raise ValueError(
                    "Linear scoring maximum must match the instance maximum"
                )
        else:
            if set(scoring) != {"mode", "mapping"} or not isinstance(
                scoring["mapping"], list
            ):
                raise ValueError(
                    "Mapped scoring must match the grading mapping contract"
                )
            if len(scoring["mapping"]) != len(expected["mapping"]):
                raise ValueError(
                    "Assessment scoring mapping differs from its grading definition"
                )
            for actual, declared in zip(scoring["mapping"], expected["mapping"]):
                if not isinstance(actual, dict) or set(actual) != {
                    "value",
                    "percentage",
                }:
                    raise ValueError(
                        "Mapped scoring entries require value and percentage"
                    )
                if (
                    actual["value"] != declared["value"]
                    or actual["percentage"] != declared["percentage"]
                ):
                    raise ValueError(
                        "Assessment scoring mapping differs from its grading definition"
                    )
                if (
                    isinstance(actual["percentage"], bool)
                    or not isinstance(actual["percentage"], (int, float))
                    or not math.isfinite(actual["percentage"])
                    or not 0 <= actual["percentage"] <= 100
                ):
                    raise ValueError(
                        "Mapping percentages must be finite and within 0 to 100"
                    )
                value = actual["value"]
                if (
                    isinstance(value, bool)
                    or not isinstance(value, (str, int, float))
                    or (isinstance(value, float) and not math.isfinite(value))
                ):
                    raise ValueError(
                        "Mapping values must be finite numeric or categorical scalars"
                    )
                if expected["mode"] == "numeric_mapping" and (
                    value < 0 or value > maximum
                ):
                    raise ValueError(
                        "Numeric mapping values must be within the instance maximum"
                    )
        period_ref = instance.get("period_ref")
        group_ref = instance.get("group_ref")
        if period_ref is not None and period_ref not in periods:
            raise ValueError("Assessment instance references an unknown period")
        if group_ref is not None and group_ref not in groups:
            raise ValueError("Assessment instance references an unknown group")
        count = definition.get("count")
        if count:
            scope = count.get("scope", {"type": "overall"})
            scope_type = scope.get("type", "overall")
            if scope_type == "per_period" and period_ref is None:
                raise ValueError(
                    "Assessment instance requires period_ref for per_period count scope"
                )
            if scope_type == "per_group":
                if group_ref is None:
                    raise ValueError(
                        "Assessment instance requires group_ref for per_group count scope"
                    )
                if groups[group_ref]["typeId"] != scope["groupTypeId"]:
                    raise ValueError(
                        "Assessment instance group type differs from its per_group count scope"
                    )
        if period_ref is not None and group_ref is not None:
            period, group = periods[period_ref], groups[group_ref]
            ancestors = {group_ref}
            parent = group.get("parentGroupId")
            while parent is not None:
                if parent in ancestors:
                    raise ValueError("Assessment group hierarchy contains a cycle")
                ancestors.add(parent)
                parent = groups[parent].get("parentGroupId")
            allowed_groups = period.get("groupIds")
            if allowed_groups is not None and not ancestors.intersection(
                allowed_groups
            ):
                raise ValueError("Assessment group is outside its assigned period")
        weight = instance.get("weight")
        if weight is not None and (
            isinstance(weight, bool)
            or not isinstance(weight, (int, float))
            or not math.isfinite(weight)
            or weight < 0
        ):
            raise ValueError("Assessment weight must be finite and non-negative")
        if (
            definition.get("aggregation", {}).get("mode") == "weighted"
            and weight is None
        ):
            raise ValueError("Weighted assessment instance requires an explicit weight")
        if "optional" in instance and not isinstance(instance["optional"], bool):
            raise ValueError("Assessment optional flag must be boolean")
        if "has_result" in instance and not isinstance(instance["has_result"], bool):
            raise ValueError("Assessment result-presence flag must be boolean")
        parsed.append((instance, component))

    # Count constraints cover known-result and forecastable instances alike.
    if not enforce_counts:
        return
    for component in grading["components"]:
        definition = component.get("assessmentDefinition")
        count = definition.get("count") if definition else None
        if not count:
            continue
        matching = [
            item
            for item, _ in parsed
            if item["assessment_type_ref"] == definition["typeId"]
        ]
        scope = count.get("scope", {"type": "overall"})
        scope_type = scope.get("type", "overall")
        scopes: list[list[dict[str, Any]]]
        if scope_type == "overall":
            scopes = [matching]
        elif scope_type == "per_period":
            scopes = [
                [item for item in matching if item.get("period_ref") == period_id]
                for period_id in periods
            ]
        elif scope_type == "per_group":
            wanted_type = scope["groupTypeId"]
            scopes = [
                [item for item in matching if item.get("group_ref") == group_id]
                for group_id, group in groups.items()
                if group["typeId"] == wanted_type
            ]
        else:
            raise ValueError("Unsupported assessment count scope")
        for scoped in scopes:
            # Partial inventory is a prefix of the final inventory, so minima
            # belong to the eventual complete snapshot; maxima always apply.
            if (
                inventory == "complete"
                and count.get("min") is not None
                and len(scoped) < count["min"]
            ):
                raise ValueError(
                    "Assessment instances violate the minimum count in scope"
                )
            if count.get("max") is not None and len(scoped) > count["max"]:
                raise ValueError(
                    "Assessment instances violate the maximum count in scope"
                )


def validate_assessment_instances(
    grading: dict[str, Any],
    instances: list[dict[str, Any]],
    *,
    inventory: str = "complete",
) -> None:
    """Validate supplied instances; partial mode relaxes minimum counts only."""
    _validate_assessment_instances(
        grading, instances, enforce_counts=True, inventory=inventory
    )


def compile_assessment_constraint(
    grading: dict[str, Any], instance: dict[str, Any], *, validate: bool = True
) -> dict[str, Any]:
    """Compile a validated assessment instance into a model output constraint."""
    if validate:
        _validate_assessment_instances(grading, [instance], enforce_counts=False)
    component = _assessment_component(grading, instance["assessment_type_ref"])
    kind, minimum, maximum, choices = _assessment_domain(grading, component)
    if instance["scoring"]["mode"] == "linear":
        maximum = float(instance["maximum_score"])
    elif instance["scoring"]["mode"] == "numeric_mapping":
        maximum = min(float(maximum), float(instance["maximum_score"]))
    compiled = {
        "kind": kind,
        "minimum": minimum,
        "maximum": maximum,
        "choices": list(choices),
    }
    compiled["component_index"] = grading["components"].index(component)
    return compiled


def _validate_grading_links(definition: dict[str, Any]) -> None:
    """JSON Schema cannot express referential integrity or dependency ordering."""
    components = {x["id"]: x for x in definition["components"]}
    periods = {x["id"]: x for x in definition.get("periods", [])}
    group_types = {x["id"] for x in definition.get("groupTypes", [])}
    graph = {key: [] for key in components}

    def check_edges(edges: list[dict], parent: str) -> None:
        total = 0.0
        for edge in edges:
            child = edge["componentId"]
            if child not in components:
                raise ValueError(
                    "Calculation or override references an unknown component"
                )
            graph[parent].append(child)
            if edge.get("periodId") is not None and edge["periodId"] not in periods:
                raise ValueError("Calculation or override references an unknown period")
            weight = edge["weight"]
            total += float(
                weight
                if isinstance(weight, (int, float))
                else weight["numerator"] / weight["denominator"]
            )
        if total <= 0:
            raise ValueError("A weighted calculation needs positive total weight")

    for key, component in components.items():
        calculation = component["calculation"]
        if calculation["mode"] == "weighted":
            check_edges(calculation["components"], key)
            for rule in calculation.get("rules", []):
                if rule["when"]["componentId"] not in components:
                    raise ValueError("Count condition references an unknown component")
                check_edges(rule["override"]["components"], key)
        assessment = component.get("assessmentDefinition")
        if assessment and calculation["mode"] != "assessments":
            raise ValueError(
                "Assessment definition must use assessment calculation mode"
            )
        if not assessment and calculation["mode"] == "assessments":
            raise ValueError("Assessment calculation requires an assessment definition")
        if assessment:
            scope = assessment.get("count", {}).get("scope", {})
            if scope.get("type") == "per_period" and not periods:
                raise ValueError("Per-period counts require declared periods")
            scoring = assessment["scoring"]
            if scoring["mode"] == "numeric_mapping":
                for mapping in scoring["mapping"]:
                    if mapping["value"] < 0 or mapping["value"] > assessment.get(
                        "maxScore", math.inf
                    ):
                        raise ValueError(
                            "Numeric mapping is outside the assessment raw-score range"
                        )
    _acyclic(graph, "Grading component graph (including conditional overrides)")
    final = definition["finalResult"]
    if final.get("periodId") is not None and final["periodId"] not in periods:
        raise ValueError("Final result references an unknown period")
    strategy = definition.get("periodCalculation", {})
    if (
        strategy.get("scope") == "groups"
        and strategy.get("groupTypeId") not in group_types
    ):
        raise ValueError("Cumulative strategy references an unknown group type")
    if (
        strategy.get("finalPeriodId") is not None
        and strategy["finalPeriodId"] not in periods
    ):
        raise ValueError("Cumulative strategy references an unknown final period")
    formulas = strategy.get("periods", [])
    if len({x["periodId"] for x in formulas}) != len(formulas):
        raise ValueError("Period formulas must be unique")
    for formula in formulas:
        period = formula["periodId"]
        if period not in periods:
            raise ValueError("Formula references an unknown period")
        total = 0.0
        for edge in formula["components"]:
            weight = edge["weight"]
            total += float(
                weight
                if isinstance(weight, (int, float))
                else weight["numerator"] / weight["denominator"]
            )
            if edge["source"] == "period_grade":
                previous = edge["periodId"]
                if (
                    previous not in periods
                    or periods[previous]["sequence"] >= periods[period]["sequence"]
                ):
                    raise ValueError(
                        "Period formulas may only reference earlier declared periods"
                    )
        if total <= 0:
            raise ValueError("Period formula needs positive total weight")


def validate_evaluation(definition: dict[str, Any]) -> None:
    _schema(SCHEMAS / "evaluation" / "evaluation_system_schema.json", definition)
    factors = _unique(definition["factors"], "Factor")
    _unique(definition["levels"], "Risk level")
    priorities = [x["priority"] for x in definition["levels"]]
    if len(set(priorities)) != len(priorities):
        raise ValueError("Risk level priorities must be unique")
    if not any(x["severity"] == "low" for x in definition["levels"]):
        raise ValueError("Evaluation needs a low risk fallback level")
    for factor in factors.values():
        kind = evaluation_kind(factor)
        if factor.get("valueType", kind) != kind:
            raise ValueError("Evaluation value type does not match its source")
        if factor.get("minimum", -math.inf) > factor.get("maximum", math.inf):
            raise ValueError("Factor minimum cannot exceed maximum")
        if factor.get("missingValuePolicy") == "treat_as_zero" and kind != "number":
            raise ValueError("Only numeric factors may treat missing values as zero")
        if factor["source"] == "grading_component" and not factor.get(
            "gradingComponentId"
        ):
            # The existing default includes an unused component placeholder.
            if any(
                r["factorId"] == factor["id"]
                for level in definition["levels"]
                for r in level["rules"]
            ):
                raise ValueError(
                    "A used grading-component factor needs a component reference"
                )
    for level in definition["levels"]:
        for rule in level.get("rules", []):
            if rule.get("factorId") not in factors:
                raise ValueError("Evaluation rule references unknown factor")
            factor = factors[rule["factorId"]]
            kind, operator, threshold = (
                evaluation_kind(factor),
                rule["operator"],
                rule["threshold"],
            )
            numeric = isinstance(threshold, (int, float)) and not isinstance(
                threshold, bool
            )
            if operator in {"below", "at_most", "above", "at_least"}:
                if kind != "number" or not numeric:
                    raise ValueError(
                        "Numeric comparison requires a numeric factor and threshold"
                    )
                if threshold < factor.get(
                    "minimum", -math.inf
                ) or threshold > factor.get("maximum", math.inf):
                    raise ValueError("Evaluation threshold is outside its factor range")
            if operator in {"is_true", "is_false"} and kind != "boolean":
                raise ValueError("Boolean comparison requires a boolean factor")
            if operator in {"contains", "not_contains"} and (
                kind != "number_array" or not numeric
            ):
                raise ValueError(
                    "Contains requires a numeric array and numeric threshold"
                )
            if operator in {"in", "not_in"} and kind != "category":
                raise ValueError("Inclusion comparison requires a categorical factor")
            if operator in {"equals", "not_equals"}:
                compatible = (
                    (kind == "number" and numeric)
                    or (kind == "boolean" and isinstance(threshold, bool))
                    or (kind == "category" and isinstance(threshold, str))
                )
                if not compatible:
                    raise ValueError(
                        "Equality threshold type does not match its factor"
                    )
            if (
                kind == "category"
                and factor.get("categories")
                and operator in {"equals", "not_equals", "in", "not_in"}
            ):
                values = (
                    threshold
                    if isinstance(threshold, list)
                    else threshold.split(",")
                    if operator in {"in", "not_in"} and isinstance(threshold, str)
                    else [threshold]
                )
                if any(
                    not isinstance(x, str) or x.strip() not in factor["categories"]
                    for x in values
                ):
                    raise ValueError(
                        "Categorical rule threshold is outside the allowed categories"
                    )


def evaluation_kind(factor: dict[str, Any]) -> str:
    source = factor["source"]
    if source in {"recent_trend", "ai_risk_level", "trend", "data_basis"}:
        return "category"
    if source == "prediction_available":
        return "boolean"
    return "number_array" if source == "recent_scores" else "number"


def validate_example(ex: Example, limits: dict[str, int] | None = None) -> None:
    lim = {
        "history": 512,
        "queries": 128,
        "fields": 512,
        "categories": 4096,
        **(limits or {}),
    }
    if (
        len(ex.history) > lim["history"]
        or len(ex.queries) > lim["queries"]
        or len(ex.fields) > lim["fields"]
    ):
        raise ValueError("Example exceeds configured sequence/schema limits")
    names = [f.name for f in ex.fields]
    if len(set(names)) != len(names):
        raise ValueError("Field names must be unique within an example")
    spec = {f.name: f for f in ex.fields}

    def validate_value(key: str, value: Any, *, allow_missing: bool = True) -> None:
        if key not in spec:
            raise ValueError(f"Record contains an undeclared field: {key}")
        f = spec[key]
        if value is None:
            if not allow_missing:
                raise ValueError(f"Target label cannot be missing for {key}")
            return
        if f.kind in ("float", "integer"):
            if (
                isinstance(value, bool)
                or not isinstance(value, (float, int))
                or not math.isfinite(float(value))
            ):
                raise ValueError(f"Invalid numeric value for {key}")
            if f.kind == "integer" and int(value) != value:
                raise ValueError(f"Non-integer value for {key}")
            if (
                f.minimum is not None
                and value < f.minimum
                or f.maximum is not None
                and value > f.maximum
            ):
                raise ValueError(f"Value outside bounds for {key}")
        elif f.kind == "boolean" and not isinstance(value, bool):
            raise ValueError(f"Invalid boolean value for {key}")
        elif f.kind == "category" and value not in f.categories:
            raise ValueError(f"Unknown category for {key}")

    for row in ex.history:
        if not isinstance(row, dict) or set(row) - set(spec):
            raise ValueError("History records may contain only declared fields")
        for key, value in row.items():
            validate_value(key, value)

    for query in ex.queries:
        if not isinstance(query, dict) or set(query) - {
            "field",
            "horizon",
            "choices",
            "minimum",
            "maximum",
            "assessment_ref",
        }:
            raise ValueError(
                "Queries must use the declared field/horizon/choice/bounds contract"
            )
        key = query.get("field")
        if not isinstance(key, str) or key not in spec:
            raise ValueError("Every query must identify one declared field")
        horizon = query.get("horizon", 1)
        if (
            isinstance(horizon, bool)
            or not isinstance(horizon, int)
            or not 1 <= horizon <= 128
        ):
            raise ValueError("Query horizon must be an integer from 1 to 128")
        f = spec[key]
        choices = query.get("choices")
        if choices is not None:
            if (
                not isinstance(choices, list)
                or not 1 <= len(choices) <= lim["categories"]
                or len({json.dumps(x, sort_keys=True) for x in choices}) != len(choices)
            ):
                raise ValueError(
                    "Query choices must be unique and within the configured capacity"
                )
            for value in choices:
                validate_value(key, value, allow_missing=False)
        for bound in (query.get("minimum"), query.get("maximum")):
            if bound is not None and (
                isinstance(bound, bool)
                or not isinstance(bound, (int, float))
                or not math.isfinite(float(bound))
            ):
                raise ValueError("Query numeric bounds must be finite")
        lower = query.get("minimum") if query.get("minimum") is not None else f.minimum
        upper = query.get("maximum") if query.get("maximum") is not None else f.maximum
        if lower is not None and upper is not None and lower > upper:
            raise ValueError("Query minimum cannot exceed maximum")
        if (
            f.minimum is not None
            and lower is not None
            and lower < f.minimum
            or f.maximum is not None
            and upper is not None
            and upper > f.maximum
        ):
            raise ValueError("Query bounds cannot widen the declared field domain")
        if (
            f.kind == "integer"
            and lower is not None
            and upper is not None
            and math.ceil(lower) > math.floor(upper)
        ):
            raise ValueError("Query domain contains no legal integer")

    instance_refs = set()
    for instance in ex.assessment_instances:
        if not isinstance(instance, dict):
            raise ValueError("Assessment instances must be objects")
        ref = instance.get("assessment_ref")
        if not isinstance(ref, str) or not ref or ref in instance_refs:
            raise ValueError("Assessment references must be nonempty and unique")
        instance_refs.add(ref)
    result_refs = set()
    for result in ex.assessment_results:
        if not isinstance(result, dict) or set(result) - {
            "assessment_ref", "value", "observed_day"
        } or {"assessment_ref", "value"} - set(result):
            raise ValueError("Assessment results require a reference and raw value")
        ref = result["assessment_ref"]
        if not isinstance(ref, str) or ref not in instance_refs or ref in result_refs:
            raise ValueError("Assessment results must uniquely reference an instance")
        result_refs.add(ref)
        if "observed_day" in result:
            day = result["observed_day"]
            if day is not None and (
                isinstance(day, bool)
                or not isinstance(day, (int, float))
                or not math.isfinite(float(day))
                or day > 0
            ):
                raise ValueError("Observed assessment results must be at or before the cutoff")
    for query in ex.queries:
        if "assessment_ref" in query:
            ref = query["assessment_ref"]
            if not isinstance(ref, str) or ref not in instance_refs:
                raise ValueError("Query references an unknown assessment instance")
            if ref in result_refs:
                raise ValueError("Assessment query must reference an unscored instance")

    if ex.labels and len(ex.labels) != len(ex.queries):
        raise ValueError("Labels must align with query positions")
    for index, row in enumerate(ex.labels):
        if not isinstance(row, dict):
            raise ValueError("Each label row must be an object")
        query = ex.queries[index]
        key = query["field"]
        allowed = {key, "trend", "failure"}
        if set(row) - allowed:
            raise ValueError(
                "Labels may contain the queried field and reserved trend/failure targets"
            )
        if key in row:
            value = row[key]
            if query.get("choices") is not None:
                if value is not None and value not in query["choices"]:
                    raise ValueError(
                        "Mapped label is outside its declared legal choices"
                    )
            else:
                validate_value(key, value)
            if isinstance(value, (float, int)) and not isinstance(value, bool):
                lower = (
                    query.get("minimum")
                    if query.get("minimum") is not None
                    else spec[key].minimum
                )
                upper = (
                    query.get("maximum")
                    if query.get("maximum") is not None
                    else spec[key].maximum
                )
                if (
                    lower is not None
                    and value < lower
                    or upper is not None
                    and value > upper
                ):
                    raise ValueError("Numeric label violates the query domain")
        if (
            "trend" in row
            and row["trend"] is not None
            and row["trend"] not in (0, 1, 2, "improving", "stable", "declining")
        ):
            raise ValueError("Trend label must be a supported class")
        if (
            "failure" in row
            and row["failure"] is not None
            and row["failure"] not in (0, 1, False, True)
        ):
            raise ValueError("Failure label must be boolean or binary")

    if ex.origin not in {"real", "synthetic"} and not ex.origin.startswith(
        "synthetic-family-"
    ):
        raise ValueError("Record origin must be real or a documented synthetic family")
    if ex.group is not None and (not isinstance(ex.group, str) or not ex.group.strip()):
        raise ValueError("Group key must be a nonempty local string")
    for s in (ex.schema.get("gradingSystem"), ex.schema.get("evaluationCriteria")):
        if s is not None:
            (
                validate_grading
                if s is ex.schema.get("gradingSystem")
                else validate_evaluation
            )(s)


def compile_schema_context(
    grading: dict[str, Any] | None, evaluation: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """Encode the policy tree and every reference without learning opaque IDs.

    Each token retains its parent, property, array position, scalar value or
    referenced entity index. Unlike summaries of weights or mapping values,
    this representation distinguishes .3/.7 from .7/.3, and preserves nested
    conditional overrides. Category labels are local ordinal references, so
    per-request anonymization does not change the numeric representation.
    The 16-column format is versioned with the model's preprocessing contract.
    """
    if grading is not None:
        validate_grading(grading)
    if evaluation is not None:
        validate_evaluation(evaluation)
    if grading and evaluation:
        component_ids = {x["id"] for x in grading["components"]}
        group_ids = {x["id"] for x in grading.get("groups", [])}
        for factor in evaluation["factors"]:
            if (
                factor.get("gradingComponentId")
                and factor["gradingComponentId"] not in component_ids
            ):
                raise ValueError(
                    "Evaluation factor references an unknown grading component"
                )
            if (
                factor.get("gradingGroupId")
                and factor["gradingGroupId"] not in group_ids
            ):
                raise ValueError(
                    "Evaluation factor references an unknown grading group"
                )

    symbols = _schema_symbols()
    ignored = {
        "id",
        "name",
        "description",
        "shortCode",
        "color",
        "recommendedAction",
        "provider",
        "modelName",
        "modelVersion",
        "officialRecordSystem",
        "effectiveFrom",
        "effectiveUntil",
        "schemaVersion",
        "definitionVersion",
        "inputFeatures",
        "outputFields",
        "supportedScenarios",
        "explanation",
    }
    namespaces = (
        "components",
        "periods",
        "groups",
        "groupTypes",
        "assessmentTypes",
        "factors",
        "levels",
    )
    entities = {
        name: {
            item["id"]: index
            for index, item in enumerate(
                (grading or {}).get(name, (evaluation or {}).get(name, []))
            )
        }
        for name in namespaces
    }
    factors = {item["id"]: item for item in (evaluation or {}).get("factors", [])}
    # Category domains may be omitted for record-only factors. For rule-only
    # categories build a local domain from their declared thresholds.
    category_domains = {
        key: list(item.get("categories", [])) for key, item in factors.items()
    }
    for level in (evaluation or {}).get("levels", []):
        for rule in level["rules"]:
            if evaluation_kind(factors[rule["factorId"]]) != "category":
                continue
            threshold = rule["threshold"]
            values = (
                threshold
                if isinstance(threshold, list)
                else threshold.split(",")
                if isinstance(threshold, str) and rule["operator"] in {"in", "not_in"}
                else [threshold]
            )
            for value in values:
                if (
                    isinstance(value, str)
                    and value.strip() not in category_domains[rule["factorId"]]
                ):
                    category_domains[rule["factorId"]].append(value.strip())

    tokens: list[dict[str, Any]] = []

    def emit(
        kind: int,
        parent: int,
        key: str,
        index: int,
        scalar: float = 0.0,
        symbol: int = 0,
        namespace: int = 0,
        reference: int = -1,
    ) -> int:
        # Small signed-log scaling keeps large count limits and tiny fractions
        # usable without imposing a distribution on student observations.
        numeric = math.copysign(math.log1p(abs(scalar)), scalar)
        values = [
            float(kind),
            float(parent),
            float(symbols.get(key, 0)),
            float(index),
            numeric,
            float(symbol),
            float(namespace),
            float(reference),
        ] + [0.0] * 8
        tokens.append({"kind": kind, "values": values})
        return len(tokens) - 1

    references = {
        "componentId": "components",
        "calculationRootComponentId": "components",
        "gradingComponentId": "components",
        "periodId": "periods",
        "finalPeriodId": "periods",
        "groupId": "groups",
        "groupIds": "groups",
        "parentGroupId": "groups",
        "gradingGroupId": "groups",
        "groupTypeId": "groupTypes",
        "factorId": "factors",
    }

    def walk(
        value: Any,
        parent: int,
        key: str,
        index: int = -1,
        path: tuple[str, ...] = (),
        factor_id: str | None = None,
    ) -> None:
        if key in ignored:
            return
        if isinstance(value, dict):
            node = emit(1, parent, key, index)
            factor_id = value.get(
                "factorId", value.get("id") if key == "factors" else factor_id
            )
            for child_key in sorted(value):
                walk(
                    value[child_key],
                    node,
                    child_key,
                    path=path + (key,),
                    factor_id=factor_id,
                )
        elif isinstance(value, list):
            node = emit(2, parent, key, index, scalar=len(value))
            for position, item in enumerate(value):
                walk(item, node, key, position, path, factor_id)
        elif isinstance(value, bool):
            emit(4, parent, key, index, scalar=float(value))
        elif isinstance(value, (int, float)):
            emit(3, parent, key, index, scalar=float(value))
        elif value is None:
            emit(0, parent, key, index)
        elif isinstance(value, str):
            namespace = references.get(key)
            if key == "typeId":
                namespace = "groupTypes" if "groups" in path else "assessmentTypes"
            if namespace:
                if value not in entities[namespace]:
                    raise ValueError(f"Unknown {namespace} reference")
                emit(
                    6,
                    parent,
                    key,
                    index,
                    namespace=namespaces.index(namespace) + 1,
                    reference=entities[namespace][value],
                )
            elif (
                key == "categories"
                or key == "letter"
                or (key == "value" and "mapping" in path)
            ):
                position = index if index >= 0 else int(tokens[parent]["values"][3])
                emit(7, parent, key, index, reference=position)
            elif (
                key == "threshold"
                and factor_id
                and evaluation_kind(factors[factor_id]) == "category"
            ):
                for position, category in enumerate(
                    value.split(",") if "," in value else [value]
                ):
                    emit(
                        7,
                        parent,
                        key,
                        position,
                        reference=category_domains[factor_id].index(category.strip()),
                    )
            elif value in symbols:
                emit(5, parent, key, index, symbol=symbols[value])
            else:
                raise ValueError(f"Unsupported symbolic schema attribute: {key}")
        else:
            raise ValueError("Unsupported schema scalar")

    if grading:
        walk(grading, -1, "gradingSystem")
    if evaluation:
        walk(evaluation, -1, "evaluationCriteria")
    return tokens


@lru_cache(maxsize=1)
def _schema_symbols() -> dict[str, int]:
    """Stable structural symbols from the checked-in schemas, never user text."""
    symbols = {"gradingSystem", "evaluationCriteria"}

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            symbols.update(value.get("properties", {}))
            symbols.update(
                item for item in value.get("enum", []) if isinstance(item, str)
            )
            if isinstance(value.get("const"), str):
                symbols.add(value["const"])
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    for relative in (
        "grading/grading_system_schema.json",
        "evaluation/evaluation_system_schema.json",
    ):
        collect(json.loads((SCHEMAS / relative).read_text(encoding="utf-8")))
    return {symbol: index + 1 for index, symbol in enumerate(sorted(symbols))}
