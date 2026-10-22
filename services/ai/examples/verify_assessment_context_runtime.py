"""Verify a selected synthetic candidate before opening its final test split.

This is an engineering acceptance gate, not a production promotion command.
It never contacts a hosted service or reads the test partition's outcomes.
Run after the comparison runner's select and calibrate stages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from apms_ai.compression import INPUT_NAMES, OUTPUT_NAMES
from apms_ai.data import group_split, load_jsonl
from apms_ai.inference import model_from_bundle, predict_example
from apms_ai.lifecycle import load_bundle
from apms_ai.training import _prepare

ROOT = Path(__file__).resolve().parents[3]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(arguments, **kwargs):
    # Argument arrays avoid shell interpolation and keep review credentials out
    # of command lines. Every invoked process operates inside the workspace.
    return subprocess.run(arguments, cwd=ROOT, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", required=True)
    parser.add_argument("--attempt", default="runtime-review", help="New directory name for this attempt's evidence")
    args = parser.parse_args()
    folder = Path(args.experiment).resolve()
    folder.relative_to(ROOT)
    gate_path = folder / "validation-gates.json"
    if gate_path.exists() or (folder / "final-started.json").exists():
        raise FileExistsError("Acceptance evidence is immutable; use a new experiment")
    if Path(args.attempt).name != args.attempt or args.attempt in (".", ".."):
        raise ValueError("Attempt must be a simple new directory name")
    review = folder / args.attempt
    review.mkdir(exist_ok=False)
    profile = json.loads((folder / "protocol.json").read_text())
    selection = json.loads((folder / "selection.json").read_text())
    expected_digest = json.loads((folder / "data-digest.json").read_text())["sha256"]
    if digest(folder / "data.jsonl") != expected_digest:
        raise ValueError("Frozen experiment data changed")
    bundle = folder / "selected-calibrated"
    state, metadata = load_bundle(bundle)
    original_state, original_metadata = load_bundle(folder / selection["selected"])
    assert state["model"].keys() == original_state["model"].keys()
    assert all(torch.equal(value, original_state["model"][key]) for key, value in state["model"].items())
    assert metadata["model_config"] == original_metadata["model_config"]
    calibration = metadata.get("calibration", {})
    assert calibration.get("method") == "split_conformal_and_binary_temperature"
    usable_intervals = {
        key: entry for key, entry in calibration.get("by_query", {}).items()
        if isinstance(entry.get("radius"), (int, float)) and math.isfinite(entry["radius"])
        and entry["radius"] >= 0 and entry.get("count", 0) > 0
    }
    assert usable_intervals, "Calibration produced no usable intervals"
    model = model_from_bundle(state, metadata)
    examples = load_jsonl(folder / "data.jsonl")
    # Group assignment is deterministic and agrees with the training protocol.
    # Only validation examples are used for these cross-runtime checks.
    validation = group_split(examples, profile["split"]["seed"], profile["split"]["ratios"])["validation"]
    validation_path = review / "validation.jsonl"
    with validation_path.open("x", encoding="utf-8") as stream:
        for example in validation:
            stream.write(json.dumps(asdict(example), allow_nan=False) + "\n")
    export_path = review / "selected.onnx"
    run([sys.executable, "-m", "apms_ai.cli", "export-onnx", "--bundle", str(bundle),
         "--data", str(validation_path), "--output", str(export_path)])
    mobile_metadata = json.loads(export_path.with_suffix(".metadata.json").read_text())
    session = ort.InferenceSession(str(export_path), providers=["CPUExecutionProvider"])
    cases = []
    calibrated_decodes = 0
    for index, example in enumerate(validation[:4]):
        example = replace(example, labels=[])
        source = {"example": asdict(example), "metadata": mobile_metadata}
        helper = ["node", str(ROOT / "services/ai/mobile/conformance.mjs")]
        encoded = run(helper + ["prepare"], input=json.dumps(source), text=True,
                      capture_output=True)
        js_feed = json.loads(encoded.stdout)["feed"]
        tensors, _, _ = _prepare([example], metadata["fields"], metadata.get("vocabulary", {}),
                                metadata["preprocessing"], "cpu", model_config=metadata["model_config"])
        feed = {}
        for name, tensor in zip(INPUT_NAMES, tensors):
            candidate = js_feed[name]
            feed[name] = np.asarray(candidate["data"], dtype=tensor.numpy().dtype).reshape(candidate["dims"])
            np.testing.assert_allclose(feed[name], tensor.numpy(), atol=1e-6, rtol=1e-6,
                                       err_msg=f"case {index}: {name}")
        actual = session.run(list(OUTPUT_NAMES), feed)
        with torch.inference_mode():
            expected = model(*tensors)
        for name, values in zip(OUTPUT_NAMES, actual):
            np.testing.assert_allclose(values, expected[name].numpy(), atol=1e-4, rtol=1e-4)
        source["outputs"] = {name: values[0].tolist() for name, values in zip(OUTPUT_NAMES, actual)}
        decoded = run(helper + ["decode"], input=json.dumps(source), text=True, capture_output=True)
        js = json.loads(decoded.stdout)["predictions"]
        python = predict_example(state, metadata, example, model=model)["predictions"]
        assert len(js) == len(python) == len(example.queries)
        for a, b in zip(js, python):
            if isinstance(b["value"], (str, bool)):
                assert a["value"] == b["value"]
            else:
                np.testing.assert_allclose(a["value"], b["value"], atol=1e-3, rtol=1e-5)
            assert a["trend"] == b["trend"]
            np.testing.assert_allclose(a.get("risk_probability", a.get("failure_probability")),
                                       b["risk_probability"], atol=1e-5)
            if "interval" in b:
                assert a["interval"]["calibrated"] is b["interval"]["calibrated"]
                np.testing.assert_allclose(
                    [a["interval"]["lower"], a["interval"]["upper"]],
                    [b["interval"]["lower"], b["interval"]["upper"]], atol=1e-3, rtol=1e-5)
                calibrated_decodes += int(b["interval"]["calibrated"])
        cases.append({"case": index, "tensors": 11, "queries": len(js), "parity": "passed"})
    assert calibrated_decodes > 0, "No matching calibrated query was exercised at serving"

    # These mocks exercise the complete authenticated gateway handler without
    # a remote DB, provider request, quota charge or production write.
    run(["node", "node_modules/vitest/vitest.mjs", "run",
         "packages/domain/src/ai/assessmentContextGateway.test.ts", "--silent"])

    release = review / "release"
    run([sys.executable, "services/ai/deploy/package_model.py", "--bundle", str(bundle),
         "--output", str(release), "--manifest"])
    release_state, release_metadata = load_bundle(release)
    assert set(release_state) == {"model"}
    assert release_state["model"].keys() == state["model"].keys()
    assert all(torch.equal(value, release_state["model"][key]) for key, value in state["model"].items())
    assert release_metadata["calibration"] == metadata["calibration"]
    assert release_metadata.get("training", {}).get("assessment_query_counts", {}).get("train", 0) == (
        metadata.get("training", {}).get("assessment_query_counts", {}).get("train", 0)
        if metadata.get("assessment_context_version", 0) == 1 else 0
    )
    os.environ["APMS_MODEL_ARTIFACT_PATH"] = str(release)
    os.environ["APMS_AI_SERVICE_API_KEY"] = "local-synthetic-runtime-review"
    os.environ.pop("APMS_AI_SERVICE_API_KEY_FILE", None)
    os.environ.pop("APMS_AI_ARTIFACT_ENDPOINT", None)
    os.environ["APMS_AI_ENABLE_SYNTHETIC_DEMO"] = "true"
    from fastapi.testclient import TestClient
    from apms_ai.main import app

    with TestClient(app) as client:
        assert client.get("/ready").status_code == 200
        headers = {"Authorization": "Bearer local-synthetic-runtime-review"}
        status = client.get("/v1/status", headers=headers)
        assert status.status_code == 200, status.text
        capability = status.json()["capabilities"]["assessment_instance_conditioning"]
        assert capability is (metadata.get("assessment_context_version", 0) == 1)
        sample = validation[0]
        payload = {
            "record_id": "local-synthetic-record",
            "grading_system": sample.schema["gradingSystem"],
            "evaluation_criteria": sample.schema["evaluationCriteria"],
            "task_contract": {"allowed_outputs": ["assessment_score_predictions"]},
            "evaluation_values": {"current_standing": sample.history[-1]["current_standing"]},
            "student_records": {"recent_scores": [sample.history[-1]["current_standing"]],
                                "assessment_results": sample.assessment_results},
            "assessment_instances": sample.assessment_instances,
        }
        response = client.post("/v1/predictions", headers=headers, json=payload)
        assert response.status_code == 200, response.text
        assert client.post("/v1/predictions", json=payload).status_code == 401
        scored = {row["assessment_ref"] for row in sample.assessment_results}
        returned = {row["assessment_ref"] for row in response.json()["assessment_predictions"]}
        assert returned == {row["assessment_ref"] for row in sample.assessment_instances} - scored

    report = {
        "status": "passed", "selected": selection["selected"],
        "artifact_id": metadata["artifact_id"], "weights_sha256": metadata["weights_sha256"],
        "release_bundle": str(release.relative_to(ROOT)),
        "release_artifact_id": release_metadata["artifact_id"],
        "manifest_sha256": digest(release / "manifest.json"),
        "dataset_sha256": expected_digest,
        "checks": {"gateway_contract": True, "onnx_export": True, "dynamic_parity": True,
                   "calibrated_bundle": True},
        "mobile_reference_cases": cases,
        "onnx_path": str(export_path.relative_to(ROOT)),
        "onnx_sha256": digest(export_path),
        "calibration_usable_interval_domains": len(usable_intervals),
        "calibrated_mobile_decodes": calibrated_decodes,
        "assessment_instance_conditioning": capability,
        "device": "CPU; physical mobile and CUDA untested",
        "test_partition_opened": False, "synthetic_only": True,
    }
    with gate_path.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
