"""Loaded artifact and mixed-type HTTP inference, beyond readiness mocks."""

from dataclasses import asdict

import pytest
from fastapi.testclient import TestClient

torch = pytest.importorskip("torch")
from apms_ai.contracts import FieldSpec
from apms_ai.lifecycle import save_bundle
from apms_ai.main import app, registry
from apms_ai.model import SchemaForecaster


@pytest.fixture
def serving(tmp_path, monkeypatch):
    torch.manual_seed(19)
    fields = [
        FieldSpec("score", "float", minimum=0, maximum=10),
        FieldSpec("count", "integer", minimum=0, maximum=5),
        FieldSpec("flag", "boolean"),
        FieldSpec("category", "category", ("A", "B")),
    ]
    config = {"width": 16, "heads": 2, "layers": 1, "categories": 4, "dropout": 0.0}
    model = SchemaForecaster(**config)
    metadata = {
        "model_version": "test-fixture",
        "model_config": config,
        "fields": [field.name for field in fields],
        "field_specs": {field.name: asdict(field) for field in fields},
        "field_kinds": {field.name: field.kind for field in fields},
        "target_fields": [field.name for field in fields],
        "target_field": "score",
        "preprocessing": {},
        "vocabulary": {"category": {"A": 1, "B": 2}},
        "training": {"source_counts": {"train": 1}},
        "inference_adapter": {"name": "apms_custom_v1", "version": 1},
    }
    path = tmp_path / "fixture"
    save_bundle(path, state={"model": model.state_dict()}, metadata=metadata)
    monkeypatch.setenv("APMS_MODEL_ARTIFACT_PATH", str(path))
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "private-test-token")
    with TestClient(app) as client:
        yield client, fields


def payload(fields):
    return {
        "fields": [asdict(field) for field in fields],
        "history": [
            {"score": 5.0, "count": 2, "flag": True, "category": "A"},
            {"score": None, "count": 3, "flag": None, "category": "B"},
        ],
        "queries": [{"field": field.name, "horizon": 2} for field in fields],
    }


def test_typed_http_predictions_constraints_and_query_permutation(serving):
    client, fields = serving
    headers = {"Authorization": "Bearer private-test-token"}
    assert client.get("/ready").status_code == 200
    source = payload(fields)
    response = client.post("/v2/forecasts", json=source, headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    values = {item["field"]: item for item in result["predictions"]}
    assert 0 <= values["score"]["value"] <= 10
    assert (
        isinstance(values["count"]["value"], int) and 0 <= values["count"]["value"] <= 5
    )
    assert isinstance(values["flag"]["value"], bool)
    assert values["category"]["value"] in {"A", "B"}
    assert result["advisory_only"] and not result["institutionally_validated"]
    reordered = dict(source, queries=list(reversed(source["queries"])))
    output = client.post("/v2/forecasts", json=reordered, headers=headers).json()
    assert {item["field"]: item["value"] for item in output["predictions"]} == {
        name: item["value"] for name, item in values.items()
    }
    assert client.get("/metrics").status_code == 401
    assert client.get("/metrics", headers=headers).json()["requests"] > 0


def test_missing_history_invalid_schema_and_body_bounds(serving, monkeypatch):
    client, fields = serving
    headers = {"Authorization": "Bearer private-test-token"}
    source = dict(payload(fields), history=[])
    assert client.post("/v2/forecasts", json=source, headers=headers).status_code == 200
    source["schema_context"] = {"gradingSystem": {}}
    assert client.post("/v2/forecasts", json=source, headers=headers).status_code == 422
    monkeypatch.setenv("APMS_AI_MAX_REQUEST_BYTES", "10")
    assert client.post("/v2/forecasts", json=source, headers=headers).status_code == 413


def test_partial_artifact_load_failure_is_not_ready(serving, monkeypatch):
    client, _ = serving
    monkeypatch.setenv("APMS_AI_DEVICE", "not-a-device")
    registry.load()
    assert registry.state is None and registry.model is None
    assert client.get("/ready").status_code == 503
