import copy
import json
import math
from dataclasses import asdict, replace
from pathlib import Path

import pytest

from apms_ai.assessment_context import (
    ASSESSMENT_CONTEXT_FEATURE_NAMES,
    QUERY_FEATURES_V1,
    assessment_query_horizon,
    compile_assessment_contexts,
)
from apms_ai.contracts import Example, FieldSpec, example_fingerprint_record, validate_example

ROOT = Path(__file__).resolve().parents[3]


def grading():
    value = json.loads(
        (ROOT / "packages/domain/src/grading/systems/it_global_grading_system.json").read_text()
    )
    for component in value["components"]:
        definition = component.get("assessmentDefinition")
        if definition:
            definition.pop("count", None)
    return value


def instance(schema, ref, type_ref, sequence, *, period=None, group=None, **extra):
    component = next(
        item
        for item in schema["components"]
        if item.get("assessmentDefinition", {}).get("typeId") == type_ref
    )
    definition = component["assessmentDefinition"]
    maximum = definition.get("maxScore") or 100
    scoring = copy.deepcopy(definition["scoring"])
    if scoring["mode"] == "linear":
        scoring = {"mode": "linear", "maximum_score": maximum}
    return {
        "assessment_ref": ref,
        "assessment_type_ref": type_ref,
        "sequence": sequence,
        "maximum_score": maximum,
        "scoring": scoring,
        **({"period_ref": period} if period else {}),
        **({"group_ref": group} if group else {}),
        **extra,
    }


def example():
    schema = grading()
    instances = [
        instance(schema, "soc-old", "soc", 0, period="p1", group="m1"),
        instance(schema, "soc-tie-a", "soc", 1, period="p1", group="m1"),
        instance(schema, "soc-tie-b", "soc", 1, period="p1", group="m1"),
        instance(schema, "soc-query", "soc", 2, period="p1", group="m1"),
        instance(schema, "lp-old", "lp", 0, period="p1", group="m1"),
        instance(schema, "lp-query", "lp", 2, period="p1", group="m1"),
        instance(schema, "cig-old", "cig", 0),
        instance(schema, "cig-query", "cig", 2, relative_day=-14, due_in_days=7),
    ]
    fields = [
        FieldSpec("assessment_score", "float", minimum=0, maximum=100),
        FieldSpec("mapped_score", "float", minimum=0, maximum=3),
        FieldSpec("category_score", "category", ("P", "A")),
    ]
    queries = [
        {"field": "category_score", "horizon": 1, "assessment_ref": "soc-query"},
        {"field": "mapped_score", "horizon": 1, "assessment_ref": "lp-query"},
        {"field": "assessment_score", "horizon": 1, "assessment_ref": "cig-query"},
    ]
    results = [
        {"assessment_ref": "soc-old", "value": "P", "observed_day": -10},
        {"assessment_ref": "soc-tie-a", "value": "A", "observed_day": -5},
        {"assessment_ref": "soc-tie-b", "value": "P", "observed_day": -5},
        {"assessment_ref": "lp-old", "value": 1, "observed_day": -5},
        {"assessment_ref": "cig-old", "value": 40, "observed_day": -5},
    ]
    ex = Example(
        history=[{"assessment_score": 50}],
        queries=queries,
        fields=fields,
        labels=[{"category_score": "A"}, {"mapped_score": 2}, {"assessment_score": 45}],
        group="student-a",
        origin="synthetic",
        schema={"gradingSystem": schema},
        assessment_instances=instances,
        assessment_results=results,
    )
    validate_example(ex)
    return ex


def test_v1_compiler_covers_mixed_scoring_and_maps_raw_scores_to_percentages():
    ex = example()
    rows = compile_assessment_contexts(ex)
    assert len(ASSESSMENT_CONTEXT_FEATURE_NAMES) == 34
    assert QUERY_FEATURES_V1 == 42
    assert len(rows) == 3 and all(len(row) == 34 for row in rows)
    category = rows[0]
    # The latest tied SoC observations average 0% and 100%, independent of ref.
    assert category[19] == 1.0
    assert category[20] == pytest.approx(0.5)
    assert category[21] == pytest.approx(2 / 3)
    assert category[22] == pytest.approx(math.sqrt(2 / 9))
    assert category[23] == pytest.approx(-0.5)
    assert category[24] == pytest.approx(1 / 512)
    assert rows[1][20] == pytest.approx(0.6)  # numeric mapping value 1 -> 60%
    assert rows[2][20] == pytest.approx(0.4)  # linear raw score 40/100
    assert rows[2][25] == 1.0 and rows[2][27] == 1.0
    assert rows[2][26] < 0 and rows[2][28] > 0


def test_context_is_invariant_to_inventory_and_result_order_and_opaque_refs():
    original = example()
    expected = compile_assessment_contexts(original)
    shuffled = copy.deepcopy(original)
    shuffled.assessment_instances.reverse()
    shuffled.assessment_results.reverse()
    assert compile_assessment_contexts(shuffled) == expected

    renamed = copy.deepcopy(original)
    schema = renamed.schema["gradingSystem"]
    id_map = {}
    for collection in ("components", "periods", "groups", "groupTypes", "assessmentTypes"):
        for index, item in enumerate(schema.get(collection, [])):
            id_map[item["id"]] = f"opaque-{collection}-{index}"

    def rewrite_references(value):
        if isinstance(value, dict):
            for key, item in value.items():
                reference_keys = {
                    "componentId", "calculationRootComponentId", "periodId",
                    "finalPeriodId", "groupId", "groupIds", "parentGroupId",
                    "groupTypeId", "typeId", "assessment_type_ref", "period_ref",
                    "group_ref",
                }
                if key == "id" and isinstance(item, str):
                    value[key] = id_map.get(item, item)
                elif isinstance(item, str) and key in reference_keys:
                    value[key] = id_map.get(item, item)
                elif isinstance(item, list) and key in reference_keys:
                    value[key] = [id_map.get(entry, entry) for entry in item]
                else:
                    rewrite_references(item)
        elif isinstance(value, list):
            for item in value:
                rewrite_references(item)

    rewrite_references(schema)
    rewrite_references(renamed.assessment_instances)
    ref_map = {item["assessment_ref"]: f"private-{index}" for index, item in enumerate(renamed.assessment_instances)}
    for item in renamed.assessment_instances:
        item["assessment_ref"] = ref_map[item["assessment_ref"]]
    for item in renamed.assessment_results:
        item["assessment_ref"] = ref_map[item["assessment_ref"]]
    for query in renamed.queries:
        query["assessment_ref"] = ref_map[query["assessment_ref"]]
    assert compile_assessment_contexts(renamed) == expected


def test_inference_horizon_uses_prior_known_sequence_rank_and_ties():
    ex = example()
    target = next(
        item for item in ex.assessment_instances if item["assessment_ref"] == "soc-query"
    )
    # The latest prior sequence is rank 1 even though it has two tied items.
    assert assessment_query_horizon(
        target, ex.assessment_instances, ex.assessment_results
    ) == 1
    only_old_known = [
        item
        for item in ex.assessment_results
        if item["assessment_ref"] == "soc-old"
    ]
    assert assessment_query_horizon(
        target, ex.assessment_instances, only_old_known
    ) == 2
    unknown_time_tie = only_old_known + [
        {"assessment_ref": "soc-tie-a", "value": "A", "observed_day": None}
    ]
    assert assessment_query_horizon(
        target, ex.assessment_instances, unknown_time_tie
    ) == 2


def test_query_identity_uses_shared_bound_instance_domains():
    from apms_ai.evaluation import query_identity
    from apms_ai.inference import bind_schema_queries

    raw = example()
    bound, _references = bind_schema_queries(raw)
    for index in range(len(raw.queries)):
        raw_key = query_identity(raw, index)
        bound_key = query_identity(bound, index)
        assert raw_key == bound_key
        assert raw_key[3] == bound_key[3]
    assert query_identity(bound, 0)[3]["choices"] == ["P", "A"]
    assert query_identity(bound, 1)[3]["maximum"] == 3


def test_unknown_time_suppresses_forecast_but_is_excluded_and_future_time_rejected():
    ex = example()
    ex.assessment_results.append(
        {"assessment_ref": "cig-query", "value": 10, "observed_day": None}
    )
    with pytest.raises(ValueError, match="unscored instance"):
        validate_example(ex)
    # It is no longer a queryable target, but its unknown-time value cannot
    # enter the summary for the other future target either.
    ex.queries.pop()
    ex.labels.pop()
    before = compile_assessment_contexts(ex)
    ex.assessment_results[-1]["value"] = 90
    after = compile_assessment_contexts(ex)
    assert before == after

    bad = example()
    bad.assessment_results[0]["observed_day"] = 0.01
    with pytest.raises(ValueError, match="at or before cutoff"):
        compile_assessment_contexts(bad)


def test_prepare_emits_the_same_eleven_inputs_with_v1_query_feature_width():
    import torch

    from apms_ai.model import SchemaForecaster, multitask_loss
    from apms_ai.training import _prepare

    ex = example()
    inputs, targets, masks = _prepare(
        [ex],
        [field.name for field in ex.fields],
        {},
        {},
        "cpu",
        model_config={"max_history": 32, "max_queries": 8, "categories": 16, "assessment_context_version": 1},
    )
    assert len(inputs) == 11
    assert tuple(inputs[-1].shape) == (1, 3, QUERY_FEATURES_V1)
    assert bool(masks["category"][0, 1])
    assert targets["numeric"].shape == (1, 3)
    torch.manual_seed(77)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        max_fields=8,
        categories=16,
        max_queries=8,
        max_history=32,
        assessment_context_version=1,
    )
    outputs = model(*inputs)
    loss, _ = multitask_loss(outputs, targets, masks)
    loss.backward()
    assert model.assessment_context_projection.weight.grad is not None
    assert model.assessment_context_projection.weight.grad.abs().sum() > 0


def test_context_v1_initialization_preserves_shared_seeded_weights_and_metadata_is_fail_closed():
    import torch

    from apms_ai.assessment_context import (
        ASSESSMENT_CONTEXT_NORMALIZATION_VERSION,
        ASSESSMENT_RESULT_CUTOFF,
        validate_assessment_context_metadata,
    )
    from apms_ai.model import SchemaForecaster

    torch.manual_seed(2026)
    legacy = SchemaForecaster(width=16, heads=2, layers=1)
    torch.manual_seed(2026)
    contextual = SchemaForecaster(
        width=16, heads=2, layers=1, assessment_context_version=1
    )
    for key, value in legacy.state_dict().items():
        assert torch.equal(value, contextual.state_dict()[key])
    metadata = {
        "model_config": {"assessment_context_version": 1},
        "assessment_context_version": 1,
        "assessment_context_feature_names": list(ASSESSMENT_CONTEXT_FEATURE_NAMES),
        "assessment_context_normalization_version": ASSESSMENT_CONTEXT_NORMALIZATION_VERSION,
        "assessment_result_cutoff": ASSESSMENT_RESULT_CUTOFF,
    }
    assert validate_assessment_context_metadata(metadata) == 1
    metadata["assessment_context_feature_names"].reverse()
    with pytest.raises(ValueError, match="feature names"):
        validate_assessment_context_metadata(metadata)


def test_empty_context_extension_preserves_the_legacy_dataset_fingerprint_record():
    ex = Example([{"x": 1}], [{"field": "x"}], [FieldSpec("x", "float")])
    legacy = {
        "history": ex.history,
        "queries": ex.queries,
        "fields": [{"name": "x", "kind": "float", "categories": (), "minimum": None, "maximum": None}],
        "labels": [],
        "group": None,
        "origin": "real",
        "schema": {},
    }
    assert example_fingerprint_record(ex) == legacy


def test_v1_primary_target_is_independent_of_assessment_query_order_and_resume_locked(
    tmp_path, monkeypatch
):
    from apms_ai.assessment_synthetic import (
        AssessmentSyntheticConfig,
        generate_assessment_examples,
    )
    from apms_ai.inference import model_from_bundle
    from apms_ai.lifecycle import load_bundle
    from apms_ai.training import train
    from apms_ai.inference import predict_example, bind_schema_queries
    from apms_ai.evaluation import query_identity

    examples = generate_assessment_examples(
        AssessmentSyntheticConfig(groups=12, seed=119)
    )
    bundle = tmp_path / "v1-primary"
    train(
        examples,
        bundle,
        seed=119,
        epochs=1,
        batch_size=4,
        width=16,
        patience=1,
        assessment_context_version=1,
    )
    state, metadata = load_bundle(bundle)
    assert metadata["target_field"] == "current_standing"
    assert metadata["assessment_numeric_target"] == "assessment_score"
    assert metadata["training"]["resume_contract"]["primary_target_field"] == "current_standing"

    from argparse import Namespace
    from apms_ai.cli import _export

    data_path = tmp_path / "synthetic-export.jsonl"
    data_path.write_text(
        json.dumps(asdict(examples[0])) + "\n", encoding="utf-8"
    )
    onnx_path = tmp_path / "v1-mobile.onnx"
    _export(Namespace(bundle=str(bundle), data=str(data_path), output=str(onnx_path)))
    import numpy as np

    with np.load(onnx_path.with_suffix(".conformance.npz")) as fixture:
        assert np.count_nonzero(fixture["input_query_features"][..., 8:]) == 0
    mobile_metadata = json.loads(onnx_path.with_suffix(".metadata.json").read_text())
    assert mobile_metadata["fixture_assessment_context_is_zeroed"] is True

    sample = examples[0]
    numeric_assessment = next(
        query
        for query in sample.queries
        if query.get("field") == "assessment_score"
        and "assessment_ref" in query
        and query["assessment_ref"]
        not in {row["assessment_ref"] for row in sample.assessment_results}
    )
    calibration_example = replace(
        sample, queries=[numeric_assessment], labels=[]
    )
    bound_calibration_example, _refs = bind_schema_queries(calibration_example)
    calibration_key = query_identity(bound_calibration_example, 0)[0]
    metadata["calibration"] = {
        "coverage_target": 0.8,
        "by_query": {calibration_key: {"radius": 1.0}},
    }
    calibrated_prediction = predict_example(
        state, metadata, calibration_example, model=model_from_bundle(state, metadata)
    )["predictions"][0]
    assert calibrated_prediction["interval"]["calibrated"] is True

    # Exercise the actual authenticated v1 adapter with two students who have
    # different scored-reference sets over the same shared inventory.
    from fastapi.testclient import TestClient
    from apms_ai.main import app, registry

    model = model_from_bundle(state, metadata)
    for name, value in (
        ("state", state),
        ("metadata", metadata),
        ("model", model),
        ("version", "synthetic-test"),
        ("device", "cpu"),
        ("artifact_source", "local"),
    ):
        monkeypatch.setattr(registry, name, value)
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "test-assessment-key")
    payload = {
        "record_id": "opaque-synthetic-record",
        "grading_system": sample.schema["gradingSystem"],
        "evaluation_criteria": sample.schema["evaluationCriteria"],
        "task_contract": {"allowed_outputs": ["assessment_score_predictions"]},
        "evaluation_values": {"current_standing": sample.history[-1]["current_standing"]},
        "student_records": {
            "recent_scores": [sample.history[-1]["current_standing"]],
            "assessment_results": sample.assessment_results,
        },
        "assessment_instances": sample.assessment_instances,
    }
    client = TestClient(app)
    headers = {"Authorization": "Bearer test-assessment-key"}
    first_response = client.post("/v1/predictions", json=payload, headers=headers)
    assert first_response.status_code == 200, first_response.text
    first_body = first_response.json()
    assert first_body["predicted_standing"] >= 0
    assert first_body["record_id"] == payload["record_id"]
    first_refs = {item["assessment_ref"] for item in first_body["assessment_predictions"]}

    target = next(
        item
        for item in sample.assessment_instances
        if item["assessment_ref"] in first_refs
    )
    scoring = target["scoring"]
    known_value = (
        scoring["mapping"][0]["value"]
        if scoring["mode"] != "linear"
        else min(target["maximum_score"], 1)
    )
    second_payload = copy.deepcopy(payload)
    second_payload["record_id"] = "another-opaque-synthetic-record"
    second_payload["student_records"]["assessment_results"] = [
        *sample.assessment_results,
        {"assessment_ref": target["assessment_ref"], "value": known_value, "observed_day": -1},
    ]
    second_response = client.post("/v1/predictions", json=second_payload, headers=headers)
    assert second_response.status_code == 200, second_response.text
    second_refs = {
        item["assessment_ref"]
        for item in second_response.json()["assessment_predictions"]
    }
    assert target["assessment_ref"] in first_refs
    assert target["assessment_ref"] not in second_refs

    with pytest.raises(ValueError, match="cannot change primary_target_field"):
        train(
            examples,
            tmp_path / "v1-wrong-resume-role",
            seed=119,
            epochs=2,
            batch_size=4,
            width=16,
            patience=1,
            resume=Path(str(bundle) + ".checkpoint"),
            primary_target_field="assessment_score",
        )
    with pytest.raises(ValueError, match="cannot change assessment_context_version"):
        train(
            examples,
            tmp_path / "v1-wrong-resume-context",
            seed=119,
            epochs=2,
            batch_size=4,
            width=16,
            patience=1,
            resume=Path(str(bundle) + ".checkpoint"),
            assessment_context_version=0,
        )
    with pytest.raises(ValueError, match="cannot change assessment_context_version"):
        train(
            examples,
            tmp_path / "v1-wrong-finetune-context",
            seed=119,
            epochs=1,
            batch_size=4,
            width=16,
            patience=1,
            init_from=bundle,
            assessment_context_version=0,
        )
