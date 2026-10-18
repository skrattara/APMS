from copy import deepcopy
from dataclasses import asdict

import pytest

torch = pytest.importorskip("torch")

from apms_ai.data import RobustPreprocessor
from apms_ai.contracts import Example
from apms_ai.inference import bind_schema_queries, predict_record
from apms_ai.model import SchemaForecaster
from apms_ai.synthetic import generate


def _instance(component, reference):
    definition = component["assessmentDefinition"]
    return {
        "assessment_ref": reference,
        "assessment_type_ref": definition["typeId"],
        "maximum_score": definition.get("maxScore", 100),
        "scoring": definition["scoring"],
        "period_ref": "p1",
        "group_ref": "m1",
    }


@pytest.fixture
def partial_assessment_request():
    example = generate(1, 20261018)[0]
    config = {"width": 16, "heads": 2, "layers": 1, "categories": 16, "dropout": 0.0}
    model = SchemaForecaster(**config).eval()
    fields = example.fields
    metadata = {
        "model_version": "partial-inventory-test",
        "model_config": config,
        "fields": [field.name for field in fields],
        "field_specs": {field.name: asdict(field) for field in fields},
        "field_kinds": {field.name: field.kind for field in fields},
        "target_field": "current_standing",
        "target_fields": [
            "current_standing",
            "categorical_score",
            "mapped_score",
        ],
        "assessment_category_target": "categorical_score",
        "assessment_mapped_target": "mapped_score",
        "preprocessing": RobustPreprocessor().fit([example]).stats,
        "vocabulary": {},
        "training": {"source_counts": {"train": 1}},
    }
    components = {
        component.get("assessmentDefinition", {}).get("typeId"): component
        for component in example.schema["gradingSystem"]["components"]
        if component.get("assessmentDefinition")
    }
    instances = [
        _instance(components["soc"], "active-soc-1"),
        _instance(components["lp"], "active-lp-1"),
        {**_instance(components["tb"], "completed-tb"), "has_result": True},
    ]
    payload = {
        "record_id": "opaque-local-test-ref",
        "grading_system": example.schema["gradingSystem"],
        "evaluation_criteria": example.schema["evaluationCriteria"],
        "student_records": {"recent_scores": [0.0, 65.0]},
        "assessment_instances": instances,
        "task_contract": {
            "assessment_inventory": "partial",
            "allowed_outputs": ["assessment_score_predictions"],
        },
    }
    return {"model": model.state_dict()}, metadata, payload, instances


def test_partial_inventory_predicts_only_supplied_unscored_instances_with_schema_domains(
    partial_assessment_request,
):
    state, metadata, payload, instances = partial_assessment_request
    original_specs = deepcopy(metadata["field_specs"])
    original_vocabulary = deepcopy(metadata["vocabulary"])
    result = predict_record(
        state,
        metadata,
        payload,
        {"name": "apms_custom_v1", "version": 1},
    )

    forecasts = result["assessment_predictions"]
    assert {item["assessment_ref"] for item in forecasts} == {
        item["assessment_ref"] for item in instances if not item.get("has_result")
    }
    assert len(forecasts) == 2  # Completed and future rows are never invented.
    by_ref = {item["assessment_ref"]: item["result"] for item in forecasts}
    assert by_ref["active-soc-1"]["kind"] == "categorical"
    assert by_ref["active-soc-1"]["value"] in {"P", "A"}
    assert by_ref["active-lp-1"]["kind"] == "numeric"
    assert by_ref["active-lp-1"]["value"] in {0, 1, 2, 3}
    assert metadata["field_specs"] == original_specs
    assert metadata["vocabulary"] == original_vocabulary


def test_v1_assessment_inventory_defaults_to_complete_and_rejects_unknown(
    partial_assessment_request,
):
    state, metadata, payload, _instances = partial_assessment_request
    complete_contract = dict(payload["task_contract"])
    complete_contract.pop("assessment_inventory")
    with pytest.raises(ValueError, match="minimum count"):
        predict_record(
            state,
            metadata,
            {**payload, "task_contract": complete_contract},
            {"name": "apms_custom_v1", "version": 1},
        )
    unknown_contract = dict(payload["task_contract"], assessment_inventory="unknown")
    with pytest.raises(ValueError, match="inventory must be"):
        predict_record(
            state,
            metadata,
            {**payload, "task_contract": unknown_contract},
            {"name": "apms_custom_v1", "version": 1},
        )


def test_schema_choices_are_checked_and_each_query_keeps_its_own_domain(
    partial_assessment_request,
):
    _state, _metadata, payload, instances = partial_assessment_request
    base = generate(1, 20261018)[0]
    instance = next(item for item in instances if item["assessment_ref"] == "active-soc-1")
    common = {
        "field": "categorical_score",
        "horizon": 1,
        "assessment_ref": instance["assessment_ref"],
    }
    example = Example(
        history=base.history,
        queries=[
            dict(common, choices=["P", "A"]),
            dict(common, choices=["A"]),
        ],
        fields=base.fields,
        origin="real",
        schema={
            "gradingSystem": payload["grading_system"],
            "evaluationCriteria": payload["evaluation_criteria"],
        },
    )
    bound, _ = bind_schema_queries(
        example, assessment_instances=instances, assessment_inventory="partial"
    )
    assert bound.queries[0]["choices"] == ["P", "A"]
    assert bound.queries[1]["choices"] == ["A"]

    rogue = Example(
        history=base.history,
        queries=[dict(common, choices=["not-in-schema"])],
        fields=base.fields,
        schema=example.schema,
    )
    with pytest.raises(ValueError, match="violate the referenced schema"):
        bind_schema_queries(
            rogue, assessment_instances=instances, assessment_inventory="partial"
        )

    # A request domain larger than the saved output head must fail closed.
    state, metadata, request, _ = partial_assessment_request
    too_small = deepcopy(metadata)
    too_small["model_config"]["categories"] = 1
    with pytest.raises(ValueError, match="configured category limit"):
        predict_record(
            state,
            too_small,
            request,
            {"name": "apms_custom_v1", "version": 1},
            model=SchemaForecaster(**too_small["model_config"]).eval(),
        )


def test_v1_http_accepts_request_local_anonymized_category_domain(
    partial_assessment_request, monkeypatch
):
    """The gateway's opaque schema labels need not match artifact label text."""
    from fastapi.testclient import TestClient

    from apms_ai import main

    state, metadata, payload, _instances = partial_assessment_request
    request = deepcopy(payload)

    def anonymize(value):
        if isinstance(value, dict):
            return {key: anonymize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [anonymize(item) for item in value]
        if value == "P":
            return "local_category_1"
        if value == "A":
            return "local_category_2"
        return value

    request = anonymize(request)
    request["task_contract"]["allowed_outputs"].append("risk_probability")
    metadata["inference_adapter"] = {"name": "apms_custom_v1", "version": 1}
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "test-worker-key")
    monkeypatch.delenv("APMS_AI_SERVICE_API_KEY_FILE", raising=False)
    monkeypatch.setattr(main.registry, "load", lambda: None)
    monkeypatch.setattr(main.registry, "state", state)
    monkeypatch.setattr(main.registry, "metadata", metadata)
    monkeypatch.setattr(
        main.registry,
        "model",
        SchemaForecaster(**metadata["model_config"]).eval(),
    )
    monkeypatch.setattr(main.registry, "version", "test-artifact")
    monkeypatch.setattr(main.registry, "device", "cpu")

    with TestClient(main.app) as client:
        response = client.post(
            "/v1/predictions",
            json=request,
            headers={"Authorization": "Bearer test-worker-key"},
        )

    assert response.status_code == 200, response.text
    result = response.json()
    assert isinstance(result["predicted_standing"], (int, float))
    assert 0 <= result["risk_probability"] <= 1
    assert len(result["assessment_predictions"]) == 2
    assert {item["assessment_ref"] for item in result["assessment_predictions"]} == {
        "active-soc-1",
        "active-lp-1",
    }
    category = next(
        item["result"]
        for item in result["assessment_predictions"]
        if item["result"]["kind"] == "categorical"
    )
    assert category["value"] in {"local_category_1", "local_category_2"}
    assert category["value"] not in {"P", "A"}
