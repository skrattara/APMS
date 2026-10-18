from dataclasses import asdict

import pytest

torch = pytest.importorskip("torch")

from apms_ai import inference
from apms_ai.synthetic import generate


@pytest.fixture
def gateway_fixture(monkeypatch):
    source = generate(1, 20261018)[0]
    fields = source.fields
    metadata = {
        "fields": [field.name for field in fields],
        "field_specs": {field.name: asdict(field) for field in fields},
        "field_kinds": {field.name: field.kind for field in fields},
        "target_field": "current_standing",
        "target_fields": ["current_standing"],
        "training": {"source_counts": {"train": 1}},
        "inference_adapter": {"name": "apms_custom_v1", "version": 1},
    }
    captured = []

    def fake_predict_example(state, model_metadata, example, **kwargs):
        captured.append(example)
        return {
            "predictions": [
                {"value": 70.0, "trend": "stable", "risk_probability": 0.1}
                for _query in example.queries
            ]
        }

    monkeypatch.setattr(inference, "predict_example", fake_predict_example)
    payload = {
        "record_id": "opaque-test-reference",
        "grading_system": source.schema["gradingSystem"],
        "evaluation_criteria": source.schema["evaluationCriteria"],
        "task_contract": {"allowed_outputs": []},
    }
    return metadata, payload, captured


@pytest.mark.parametrize(
    "student_records",
    [
        {"current_standing": None, "recent_scores": [0.0, None, 79.5]},
        {"recent_scores": [0.0, None, 79.5]},
    ],
)
def test_recent_scores_are_valid_history_without_official_standing(
    gateway_fixture, student_records
):
    metadata, payload, captured = gateway_fixture
    result = inference.predict_record(
        {},
        metadata,
        {**payload, "student_records": student_records},
        {"name": "apms_custom_v1", "version": 1},
    )

    assert result["predicted_standing"] == 70.0
    assert len(captured) == 1
    example = captured[0]
    assert example.labels == []
    assert [row.get("current_standing", "<absent>") for row in example.history] == [
        0.0,
        None,
        79.5,
    ] + ([None] if "current_standing" in student_records else [])
    assert 0.0 in [
        row.get("current_standing") for row in example.history
    ]  # A zero score is observed evidence, not a missing sentinel.


def test_all_null_recent_scores_without_other_observations_rejects(gateway_fixture):
    metadata, payload, captured = gateway_fixture
    with pytest.raises(ValueError, match="no supported observed evidence"):
        inference.predict_record(
            {},
            metadata,
            {
                **payload,
                "student_records": {
                    "current_standing": None,
                    "recent_scores": [None, None],
                },
            },
            {"name": "apms_custom_v1", "version": 1},
        )
    assert captured == []
