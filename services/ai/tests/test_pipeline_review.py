"""Review checks for the existing gateway adapter and aggregate diagnostics."""

import json
from dataclasses import asdict

import pytest

torch = pytest.importorskip("torch")

from apms_ai.contracts import FieldSpec
from apms_ai.data import RobustPreprocessor
from apms_ai.diagnostics import diagnose_bundle
from apms_ai.inference import predict_record
from apms_ai.lifecycle import save_bundle
from apms_ai.model import SchemaForecaster
from apms_ai.synthetic import generate


def test_gateway_exact_response_and_mixed_assessment_scoring():
    example = generate(1, 27)[0]
    grading = example.schema["gradingSystem"]
    for component in grading["components"]:
        if component.get("assessmentDefinition"):
            component["assessmentDefinition"].pop("count", None)
    config = dict(width=16, heads=2, layers=1, categories=16, dropout=0.0)
    model = SchemaForecaster(**config).eval()
    metadata = dict(
        model_config=config,
        fields=[f.name for f in example.fields],
        field_specs={f.name: asdict(f) for f in example.fields},
        target_field="current_standing",
        target_fields=[q["field"] for q in example.queries],
        assessment_mapped_target="mapped_score",
        assessment_category_target="categorical_score",
        preprocessing=RobustPreprocessor().fit([example]).stats,
        vocabulary={},
    )
    instances = []
    for component in grading["components"]:
        definition = component.get("assessmentDefinition")
        if definition and definition["typeId"] in {"soc", "lp"}:
            instances.append(
                dict(
                    assessment_ref=definition["typeId"],
                    assessment_type_ref=definition["typeId"],
                    maximum_score=3 if definition["typeId"] == "lp" else 100,
                    scoring=definition["scoring"],
                )
            )
    payload = dict(
        record_id="opaque-reference",
        grading_system=grading,
        evaluation_criteria=example.schema["evaluationCriteria"],
        task_contract={
            "allowed_outputs": ["risk_probability", "assessment_score_predictions"]
        },
        student_records={"recent_scores": [50, None, 70]},
        assessment_instances=instances,
    )
    response = predict_record(
        {"model": model.state_dict()},
        metadata,
        payload,
        {"name": "apms_custom_v1", "version": 1},
        model=model,
    )
    assert set(response) == {
        "record_id",
        "predicted_standing",
        "trend",
        "risk_probability",
        "assessment_predictions",
    }
    predictions = {
        item["assessment_ref"]: item["result"]
        for item in response["assessment_predictions"]
    }
    assert predictions["soc"]["kind"] == "categorical" and predictions["soc"][
        "value"
    ] in {"P", "A"}
    assert predictions["lp"]["kind"] == "numeric" and predictions["lp"]["value"] in {
        0,
        1,
        2,
        3,
    }


def test_diagnostics_distinguish_nulls_and_absent_without_identifiers(tmp_path):
    from apms_ai.contracts import Example

    fields = [FieldSpec("score", "float", minimum=0, maximum=100)]
    example = Example(
        [{"score": 90}, {"score": None}, {}],
        [{"field": "score"}],
        fields,
        [{"score": 85}],
        group="PRIVATE-STUDENT-GROUP",
    )
    config = dict(width=16, heads=2, layers=1, categories=4, dropout=0.0)
    model = SchemaForecaster(**config)
    metadata = dict(
        model_config=config,
        fields=["score"],
        field_specs={"score": asdict(fields[0])},
        field_kinds={"score": "float"},
        preprocessing={"score": [20, 10]},
    )
    path = tmp_path / "diagnostic"
    save_bundle(path, state={"model": model.state_dict()}, metadata=metadata)
    report = diagnose_bundle(path, [example], backward_check=True)
    assert report["backward_check"] == "finite"
    assert report["fields"]["score"]["explicit_null"] == 1
    assert report["fields"]["score"]["structurally_absent"] == 1
    assert report["fields"]["score"]["investigate_shift"]
    assert "PRIVATE-STUDENT-GROUP" not in json.dumps(report)
