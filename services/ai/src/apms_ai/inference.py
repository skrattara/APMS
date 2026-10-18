"""Shared typed inference and the existing privacy-projected APMS adapter."""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

from .contracts import Example, FieldSpec, compile_schema_context, validate_example

TREND_CLASSES = ("improving", "stable", "declining")


def model_from_bundle(state, metadata, *, device="cpu"):
    import torch

    from .model import SchemaForecaster

    model = SchemaForecaster(**metadata["model_config"]).to(torch.device(device))
    model.load_state_dict(state.get("model", state))
    return model.eval()


def field_specs(metadata):
    """Recover declared domains, including older development bundle defaults."""
    saved = metadata.get("field_specs", {})
    result = []
    for name in metadata["fields"]:
        if name in saved:
            result.append(FieldSpec(**saved[name]))
        else:
            kind = metadata.get("field_kinds", {}).get(name, "float")
            categories = tuple(metadata.get("vocabulary", {}).get(name, {}))
            result.append(FieldSpec(name, kind, categories))
    return result


def _roundoff(value, minimum, maximum):
    """Correct only FP32 bound-transform roundoff, never invalid predictions."""
    tolerance = 2e-5 * max(1.0, abs(minimum or 0), abs(maximum or 0))
    if minimum is not None and minimum - tolerance <= value < minimum:
        return float(minimum)
    if maximum is not None and maximum < value <= maximum + tolerance:
        return float(maximum)
    return value


def bind_schema_queries(
    example, *, assessment_instances=None, assessment_inventory="complete"
):
    """Resolve requested schema references into the actual neural head domains.

    References are removed before tensorization and restored only in response
    records. Caller-supplied constraints may narrow a schema, never widen it.
    The full assessment inventory includes scored instances for count checks.
    """
    from .contracts import compile_assessment_constraint, validate_assessment_instances

    if not isinstance(assessment_inventory, str) or assessment_inventory not in (
        "partial",
        "complete",
    ):
        raise ValueError("Assessment inventory must be 'partial' or 'complete'")
    schema = example.schema
    grading, evaluation = schema.get("gradingSystem"), schema.get("evaluationCriteria")
    compile_schema_context(grading, evaluation)
    instances = assessment_instances or []
    if instances:
        if not grading:
            raise ValueError("Assessment instances require a grading representation")
        validate_assessment_instances(
            grading, instances, inventory=assessment_inventory
        )
    by_ref = {item["assessment_ref"]: item for item in instances}
    specs = {field.name: field for field in example.fields}
    queries, references = [], []
    for original in example.queries:
        query = dict(original)
        reference = {
            key: query.pop(key)
            for key in ("assessment_ref", "factor_ref")
            if key in query
        }
        if len(reference) > 1:
            raise ValueError("A scalar query cannot bind two different schema entities")
        spec = specs.get(query.get("field"))
        if spec is None:
            raise ValueError("Query identifies an undeclared field")
        constraint = {}
        if "assessment_ref" in reference:
            instance = by_ref.get(reference["assessment_ref"])
            if instance is None or instance.get("has_result") is True:
                raise ValueError(
                    "Assessment query is unknown or already has a recorded result"
                )
            constraint = compile_assessment_constraint(grading, instance)
            if (constraint["kind"] == "category") != (spec.kind == "category"):
                raise ValueError("Assessment scoring and output field type disagree")
        elif "factor_ref" in reference:
            factor = next(
                (
                    item
                    for item in (evaluation or {}).get("factors", [])
                    if item["id"] == reference["factor_ref"]
                ),
                None,
            )
            if factor is None or not (
                factor.get("aiGenerated") or factor.get("origin") == "ai_prediction"
            ):
                raise ValueError(
                    "Only declared AI-owned factors can receive a model forecast"
                )
            kind = factor.get("valueType") or (
                "category"
                if factor["source"]
                in {"trend", "recent_trend", "ai_risk_level", "data_basis"}
                else "number"
            )
            if kind == "number_array":
                raise ValueError(
                    "Array factors require explicitly indexed scalar queries"
                )
            if kind == "category":
                if spec.kind != "category":
                    raise ValueError(
                        "Categorical factor needs a categorical output field"
                    )
                constraint["choices"] = factor.get("categories") or list(
                    spec.categories
                )
            elif kind == "boolean":
                if spec.kind != "boolean":
                    raise ValueError("Boolean factor needs a boolean output field")
                constraint["choices"] = [False, True]
            else:
                if spec.kind not in {"float", "integer"}:
                    raise ValueError("Numeric factor needs a numeric output field")
                constraint.update(
                    minimum=factor.get("minimum"), maximum=factor.get("maximum")
                )
        for key, select in (("minimum", max), ("maximum", min)):
            values = [
                value
                for value in (getattr(spec, key), query.get(key), constraint.get(key))
                if value is not None
            ]
            if values:
                query[key] = select(values)
        if constraint.get("choices"):
            choices = list(constraint["choices"])
            if query.get("choices") is not None:
                if any(value not in choices for value in query["choices"]):
                    raise ValueError("Query choices violate the referenced schema")
                choices = list(query["choices"])
            # Request schemas are privacy-projected and may replace category
            # labels with local opaque tokens. The schema compiler above has
            # already established the legal domain; do not compare those labels
            # with the training artifact's category spellings here. The model
            # predicts an ordinal within this query's own ordered domain, and
            # predict_example decodes that ordinal using these exact choices.
            query["choices"] = choices
        queries.append(query)
        references.append(reference)
    # validate_example checks query choices against each FieldSpec domain. Keep
    # the artifact immutable, and extend only this request's typed field view
    # with validated, schema-derived category labels. Multiple schema queries
    # over one output field retain their own ordered choices for decoding.
    request_domains: dict[str, list[str]] = {}
    for query, reference in zip(queries, references):
        if (
            reference
            and query.get("choices")
            and specs[query["field"]].kind == "category"
        ):
            domain = request_domains.setdefault(query["field"], [])
            for value in query["choices"]:
                if not isinstance(value, str):
                    raise ValueError("Categorical schema choices must be strings")
                if value not in domain:
                    domain.append(value)
    request_fields = [
        replace(
            field,
            categories=tuple(
                dict.fromkeys((*field.categories, *request_domains.get(field.name, [])))
            ),
        )
        if field.kind == "category" and field.name in request_domains
        else field
        for field in example.fields
    ]
    result = replace(example, queries=queries, fields=request_fields)
    validate_example(result)
    return result, references


def predict_example(
    state,
    metadata,
    example,
    *,
    model=None,
    assessment_instances=None,
    assessment_inventory="complete",
):
    """Use exactly the shared training encoder, then decode every typed query."""
    import torch

    from .evaluation import query_identity
    from .model import constrain_numeric
    from .training import _prepare

    example, references = bind_schema_queries(
        example,
        assessment_instances=assessment_instances,
        assessment_inventory=assessment_inventory,
    )
    if example.labels:
        raise ValueError("Inference requests must not include future labels")
    unknown = {field.name for field in example.fields} - set(metadata["fields"])
    if unknown:
        raise ValueError(
            "Untrained feature roles require an appended-field fine-tuning lifecycle"
        )
    if not example.queries:
        raise ValueError("At least one future output query is required")
    model = model or model_from_bundle(state, metadata)
    device = next(model.parameters()).device
    local_vocab = dict(metadata.get("vocabulary", {}))
    for spec in example.fields:
        if spec.kind == "category":
            local_vocab[spec.name] = {
                value: index + 1 for index, value in enumerate(spec.categories)
            }
    inputs, _, _ = _prepare(
        [example],
        metadata["fields"],
        local_vocab,
        metadata.get("preprocessing", {}),
        device,
        model_config=metadata["model_config"],
    )
    if inputs[3].shape[1] > metadata.get("maximum_schema_tokens", 4096):
        raise ValueError("Applied schema exceeds the configured context token limit")
    with torch.inference_mode():
        outputs = model(*inputs)
    specs = {field.name: field for field in example.fields}
    calibration = metadata.get("calibration", {})
    predictions = []
    for index, query in enumerate(example.queries):
        key, name, horizon, domain = query_identity(example, index)
        spec = specs[name]
        lower, upper = domain["minimum"], domain["maximum"]
        result = {"field": name, "horizon": int(horizon), **references[index]}
        choices = query.get("choices") or (
            list(spec.categories)
            if spec.kind == "category"
            else [False, True]
            if spec.kind == "boolean"
            else []
        )
        if choices:
            probabilities = outputs["categorical"][0, index, : len(choices)].softmax(-1)
            choice = int(probabilities.argmax())
            result.update(
                value=choices[choice],
                kind=spec.kind,
                class_probability=float(probabilities[choice]),
                class_probability_calibrated=False,
            )
        else:
            center, scale = metadata.get("preprocessing", {}).get(name, (0.0, 1.0))
            quantiles = [
                float(value) * scale + center
                for value in outputs["quantiles"][0, index, 0]
            ]
            point = _roundoff(quantiles[len(quantiles) // 2], lower, upper)
            point = constrain_numeric(
                point, minimum=lower, maximum=upper, integer=spec.kind == "integer"
            )
            entry = calibration.get("by_query", {}).get(key, {})
            radius = entry.get("radius")
            lo, hi = quantiles[0] - (radius or 0.0), quantiles[-1] + (radius or 0.0)
            if spec.kind == "integer":
                lo, hi = math.floor(lo), math.ceil(hi)
            if lower is not None:
                lo = max(math.ceil(lower) if spec.kind == "integer" else lower, lo)
            if upper is not None:
                hi = min(math.floor(upper) if spec.kind == "integer" else upper, hi)
            if (
                not math.isfinite(point)
                or not math.isfinite(lo)
                or not math.isfinite(hi)
                or lo > hi
            ):
                raise ValueError("Model produced an invalid numeric interval")
            result.update(
                value=point,
                kind=spec.kind,
                interval={
                    "lower": lo,
                    "upper": hi,
                    "calibrated": radius is not None,
                    "nominal_coverage": calibration.get("coverage_target", 0.8)
                    if radius is not None
                    else 0.8,
                },
            )
        risk = calibration.get("risk_by_query", {}).get(key, {})
        temperature = float(risk.get("temperature", 1.0))
        if not math.isfinite(temperature) or temperature <= 0:
            raise ValueError("Artifact contains invalid risk calibration")
        result["risk_probability"] = float(
            torch.sigmoid(outputs["failure"][0, index] / temperature)
        )
        result["risk_calibrated"] = risk.get("calibrated", False)
        result["trend"] = TREND_CLASSES[int(outputs["trend"][0, index].argmax())]
        predictions.append(result)
    return {
        "predictions": predictions,
        "model_version": metadata.get("model_version"),
        "artifact_id": metadata.get("artifact_id", metadata.get("weights_sha256")),
        "advisory_only": True,
        "institutionally_validated": False,
        "training_data_basis": "real_or_mixed"
        if metadata.get("training", {}).get("source_counts", {}).get("train", 0)
        else "controlled_synthetic_demonstration",
    }


def predict_record(
    state: dict[str, Any],
    metadata: dict[str, Any],
    payload: dict[str, Any],
    adapter: dict[str, Any],
    *,
    model=None,
) -> dict[str, Any]:
    """Preserve the gateway's exact allowlisted response; no extra metadata."""
    if adapter != {"name": "apms_custom_v1", "version": 1}:
        raise ValueError("Unsupported inference adapter version")
    grading, evaluation = payload["grading_system"], payload["evaluation_criteria"]
    compile_schema_context(grading, evaluation)
    task_contract = payload.get("task_contract") or {}
    if not isinstance(task_contract, dict):
        raise ValueError("Task contract must be an object")
    assessment_inventory = task_contract.get("assessment_inventory", "complete")
    if not isinstance(assessment_inventory, str) or assessment_inventory not in (
        "partial",
        "complete",
    ):
        raise ValueError("Assessment inventory must be 'partial' or 'complete'")
    fields = field_specs(metadata)
    by_name = {field.name: field for field in fields}
    primary = metadata.get("target_field")
    if primary not in by_name or by_name[primary].kind not in {"float", "integer"}:
        raise ValueError("Artifact has no numeric standing forecast target")
    record = payload.get("student_records") or {}
    if not isinstance(record, dict):
        raise ValueError("Gateway records must be a projected evidence object")
    snapshots = {}
    for source in (record, payload.get("evaluation_values") or {}):
        if not isinstance(source, dict):
            raise ValueError("Evaluation values must be an object")
        for key, value in source.items():
            if key in by_name and not isinstance(value, (dict, list)):
                snapshots[key] = value
        for factor in evaluation["factors"]:
            if factor["id"] in source and factor["source"] in by_name:
                snapshots[factor["source"]] = source[factor["id"]]
    history = []
    recent = record.get("recent_scores", [])
    if not isinstance(recent, list):
        raise ValueError("Recent score evidence must be an ordered array")
    for value in recent:
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= 100
        ):
            raise ValueError("Recent scores must be finite percentages or null")
        if "current_standing" in by_name:
            history.append({"current_standing": value})
        elif primary in by_name:
            history.append({primary: value})
    if snapshots:
        history.append(snapshots)
    if not any(value is not None for row in history for value in row.values()):
        raise ValueError("Request has no supported observed evidence")
    standing = next(
        (
            factor
            for factor in evaluation["factors"]
            if factor["source"] == "predicted_standing"
        ),
        {},
    )
    lower, upper = (
        max(0, standing.get("minimum", 0)),
        min(100, standing.get("maximum", 100)),
    )
    queries = [{"field": primary, "horizon": 1, "minimum": lower, "maximum": upper}]
    allowed = set(task_contract.get("allowed_outputs", []))
    instances = payload.get("assessment_instances") or []
    scored = {
        item.get("assessment_ref")
        for item in record.get("assessment_results", [])
        if isinstance(item, dict)
        and any(
            item.get(key) is not None
            for key in ("score", "percentage", "categorical_value")
        )
    }
    if "assessment_score_predictions" in allowed:
        for instance in instances:
            if instance["assessment_ref"] in scored:
                instance = dict(instance, has_result=True)
            if instance.get("has_result"):
                continue
            mode = instance.get("scoring", {}).get("mode")
            target = (
                metadata.get("assessment_category_target")
                if mode == "value_mapping"
                else metadata.get("assessment_mapped_target")
                or next(iter(metadata.get("mapped_target_fields", [])), None)
                if mode == "numeric_mapping"
                else primary
            )
            if target not in by_name:
                raise ValueError(
                    "Artifact has no trained target for a requested assessment scoring mode"
                )
            queries.append(
                {
                    "field": target,
                    "horizon": 1,
                    "assessment_ref": instance["assessment_ref"],
                }
            )
    fixed = {
        "predicted_standing",
        "risk_probability",
        "model_confidence",
        "trend",
        "recent_trend",
        "prediction_available",
        "prediction_age_hours",
        "ai_factor_count",
        "data_basis",
    }
    factor_queries = []
    if "evaluation_scores" in allowed or "risk_level" in allowed:
        for factor in evaluation["factors"]:
            if (
                not (
                    factor.get("aiGenerated") or factor.get("origin") == "ai_prediction"
                )
                or factor["source"] in fixed
            ):
                continue
            if factor["source"] in metadata.get("target_fields", []):
                factor_queries.append(factor)
                queries.append(
                    {
                        "field": factor["source"],
                        "horizon": 1,
                        "factor_ref": factor["id"],
                    }
                )
            elif (
                factor.get("required")
                or factor.get("missingValuePolicy") == "unavailable"
            ):
                raise ValueError("Artifact cannot produce a required AI factor")
    example = Example(
        history,
        queries,
        fields,
        origin="real",
        schema={"gradingSystem": grading, "evaluationCriteria": evaluation},
    )
    outputs = predict_example(
        state,
        metadata,
        example,
        model=model,
        assessment_instances=instances,
        assessment_inventory=assessment_inventory,
    )["predictions"]
    first = outputs[0]
    result = {
        "record_id": payload["record_id"],
        "predicted_standing": first["value"],
        "trend": first["trend"],
    }
    if "risk_probability" in allowed:
        probability = first["risk_probability"]
        factor = next(
            (
                item
                for item in evaluation["factors"]
                if item["source"] == "risk_probability"
            ),
            {},
        )
        if not factor.get("minimum", 0) <= probability <= factor.get("maximum", 1):
            raise ValueError("Probability violates the applied evaluation domain")
        result["risk_probability"] = probability
    if "factors" in allowed:
        result[
            "factors"
        ] = []  # Explanations are produced by the bounded SHAP workflow.
    if "assessment_score_predictions" in allowed:
        instance_by_ref = {item["assessment_ref"]: item for item in instances}
        forecasts = []
        for item in outputs[1:]:
            if "assessment_ref" not in item:
                continue
            numeric = isinstance(item["value"], (int, float)) and not isinstance(
                item["value"], bool
            )
            output = {
                "kind": "numeric" if numeric else "categorical",
                "value": item["value"],
            }
            if numeric:
                output["maximum"] = instance_by_ref[item["assessment_ref"]][
                    "maximum_score"
                ]
            forecasts.append(
                {"assessment_ref": item["assessment_ref"], "result": output}
            )
        result["assessment_predictions"] = forecasts
    if "evaluation_scores" in allowed:
        result["evaluation_scores"] = {
            item["factor_ref"]: item["value"]
            for item in outputs
            if "factor_ref" in item
            and next(f for f in factor_queries if f["id"] == item["factor_ref"])[
                "source"
            ]
            != "ai_risk_level"
        }
    risk_category = next(
        (
            item["value"]
            for item in outputs
            if "factor_ref" in item
            and next(f for f in factor_queries if f["id"] == item["factor_ref"])[
                "source"
            ]
            == "ai_risk_level"
        ),
        None,
    )
    if "risk_level" in allowed and risk_category is not None:
        result["ai_risk_level"] = risk_category
    return result
