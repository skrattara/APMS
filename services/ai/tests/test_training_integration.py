import json
from argparse import Namespace
from dataclasses import asdict, replace
from pathlib import Path

import torch
from apms_ai.calibration import calibrate_bundle
from apms_ai.cli import _export
from apms_ai.contracts import Example, FieldSpec
from apms_ai.data import group_split
from apms_ai.inference import predict_record
from apms_ai.lifecycle import load_bundle
from apms_ai.synthetic import generate
from apms_ai.training import _prepare, train


def test_local_category_aliases_preserve_history_and_target_encoding():
    first = Example(
        history=[{"proficiency": "beginner"}],
        queries=[{"field": "proficiency", "horizon": 2}],
        fields=[FieldSpec("proficiency", "category", ("beginner", "advanced"))],
        labels=[{"proficiency": "advanced"}],
        origin="real",
    )
    renamed = Example(
        history=[{"proficiency": "private_a"}],
        queries=[{"field": "proficiency", "horizon": 2}],
        fields=[FieldSpec("proficiency", "category", ("private_a", "private_b"))],
        labels=[{"proficiency": "private_b"}],
        origin="real",
    )
    args = (
        ["proficiency"],
        {"proficiency": {"beginner": 1, "advanced": 2}},
        {"proficiency": [0.0, 1.0]},
        "cpu",
    )
    encoded_a, targets_a, masks_a = _prepare([first], *args)
    encoded_b, targets_b, masks_b = _prepare(
        [renamed],
        ["proficiency"],
        {"proficiency": {"private_a": 41, "private_b": 99}},
        {"proficiency": [0.0, 1.0]},
        "cpu",
    )
    for a, b in zip(encoded_a, encoded_b):
        assert torch.equal(a, b)
    assert encoded_a[1][0, 0].item() == 0  # query retains the persisted field ID
    assert torch.equal(targets_a["category"], targets_b["category"])
    assert torch.equal(masks_a["category"], masks_b["category"])


def test_train_resume_calibrate_and_v1_inference(tmp_path: Path):
    examples = generate(40, 91)
    first = tmp_path / "first"
    result = train(
        examples, first, seed=13, epochs=1, batch_size=8, width=32, patience=3
    )
    assert result["splits"]["train"] > 0
    checkpoint = Path(str(first) + ".checkpoint")
    assert checkpoint.is_dir()

    resumed = tmp_path / "resumed"
    resumed_result = train(
        examples,
        resumed,
        seed=13,
        epochs=2,
        batch_size=8,
        width=32,
        patience=3,
        resume=checkpoint,
    )
    assert resumed_result["epochs_completed"] == 2

    calibration = tmp_path / "calibrated"
    report = calibrate_bundle(resumed, examples, coverage=0.8, output=calibration)
    assert report["count"] > 0
    state, metadata = load_bundle(calibration)
    assert metadata["schema_encoding_version"] == 2
    assert "radius" in metadata["calibration"]
    assert state["model"]

    example = group_split(examples, 13)["test"][0]
    grading = example.schema["gradingSystem"]
    evaluation = example.schema["evaluationCriteria"]
    payload = {
        "record_id": "opaque-record-ref",
        "grading_system": grading,
        "evaluation_criteria": evaluation,
        "evaluation_values": {"attendance_rate": 76.0},
        "student_records": {"recent_scores": [61.0, 66.0, 73.0]},
        "task_contract": {"allowed_outputs": []},
    }
    output = predict_record(state, metadata, payload, metadata["inference_adapter"])
    assert set(output) == {"record_id", "predicted_standing", "trend"}
    assert output["record_id"] == "opaque-record-ref"
    assert 0 <= output["predicted_standing"] <= 100
    assert output["trend"] in {"improving", "stable", "declining"}

    jsonl = tmp_path / "source.jsonl"
    jsonl.write_text(
        "\n".join(json.dumps(asdict(item)) for item in examples), encoding="utf-8"
    )
    onnx_path = tmp_path / "mobile.onnx"
    _export(Namespace(bundle=str(calibration), data=str(jsonl), output=str(onnx_path)))
    sidecar = onnx_path.with_suffix(".metadata.json")
    fixture = onnx_path.with_suffix(".conformance.npz")
    export_metadata = json.loads(sidecar.read_text(encoding="utf-8"))
    assert onnx_path.is_file() and fixture.is_file()
    assert len(export_metadata["input_names"]) == 11
    assert export_metadata["fixture_inputs_are_centered_zero_observations"] is True

    expanded = []
    for example in examples:
        fields = list(example.fields) + [
            FieldSpec("new_signal", "float", minimum=0, maximum=1)
        ]
        history = [dict(row, new_signal=0.5) for row in example.history]
        expanded.append(replace(example, fields=fields, history=history))
    finetuned = tmp_path / "finetuned"
    train(
        expanded,
        finetuned,
        seed=13,
        epochs=1,
        batch_size=8,
        width=32,
        patience=3,
        init_from=resumed,
    )
    _, expanded_metadata = load_bundle(finetuned)
    assert expanded_metadata["fields"][:-1] == metadata["fields"]
    assert expanded_metadata["fields"][-1] == "new_signal"
