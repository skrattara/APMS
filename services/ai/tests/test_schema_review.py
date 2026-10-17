"""Regression cases found during the primary agent's architecture review."""

import copy
import json
import uuid
from pathlib import Path

import pytest
from apms_ai.contracts import (
    FieldSpec,
    compile_schema_context,
    validate_evaluation,
    validate_grading,
)
from apms_ai.encoding import token_rows

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def grading():
    return json.loads(
        (
            ROOT / "packages/domain/src/grading/systems/it_global_grading_system.json"
        ).read_text()
    )


@pytest.fixture
def evaluation():
    return json.loads(
        (
            ROOT
            / "packages/domain/src/evaluation/legacy_default_evaluation_system.json"
        ).read_text()
    )


def test_schema_encoder_preserves_weight_assignment_mapping_and_pass_threshold(grading):
    baseline = token_rows(grading, None)
    changed = copy.deepcopy(grading)
    edges = changed["components"][-1]["calculation"]["components"]
    edges[0]["weight"], edges[1]["weight"] = edges[1]["weight"], edges[0]["weight"]
    assert token_rows(changed, None) != baseline
    changed = copy.deepcopy(grading)
    changed["components"][1]["assessmentDefinition"]["scoring"]["mapping"][1][
        "percentage"
    ] = 55
    assert token_rows(changed, None) != baseline
    changed = copy.deepcopy(grading)
    changed["finalGradeConversion"]["passingPercentage"] = 75
    assert token_rows(changed, None) != baseline


def test_opaque_identity_and_display_renaming_leave_model_context_invariant(
    grading, evaluation
):
    identities = {}

    def find(value):
        if isinstance(value, dict):
            if "id" in value:
                identities[value["id"]] = str(
                    uuid.uuid5(uuid.NAMESPACE_DNS, value["id"])
                )
            for child in value.values():
                find(child)
        elif isinstance(value, list):
            for child in value:
                find(child)

    find(grading)
    find(evaluation)

    def rename(value):
        if isinstance(value, dict):
            return {
                k: "redacted" if k in {"name", "description"} else rename(v)
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [rename(v) for v in value]
        return identities.get(value, value) if isinstance(value, str) else value

    assert compile_schema_context(grading, evaluation) == compile_schema_context(
        rename(grading), rename(evaluation)
    )


def test_categorical_rule_threshold_is_not_discarded(grading, evaluation):
    baseline = token_rows(grading, evaluation)
    changed = copy.deepcopy(evaluation)
    changed["levels"][0]["rules"][0]["threshold"] = "low"
    assert token_rows(grading, changed) != baseline


def test_invalid_schema_relationships_and_domains_fail_before_model(
    grading, evaluation
):
    duplicate = copy.deepcopy(grading)
    duplicate["components"].append(copy.deepcopy(duplicate["components"][0]))
    with pytest.raises(ValueError, match="unique"):
        validate_grading(duplicate)
    bad_count = copy.deepcopy(grading)
    bad_count["components"][0]["assessmentDefinition"]["count"]["min"] = 3
    with pytest.raises(ValueError, match="count"):
        validate_grading(bad_count)
    override = copy.deepcopy(grading)
    project = next(c for c in override["components"] if c["id"] == "pg")
    project["calculation"]["rules"][0]["override"]["components"][0]["componentId"] = (
        "pg"
    )
    with pytest.raises(ValueError, match="cycle"):
        validate_grading(override)
    bad_factor = copy.deepcopy(evaluation)
    bad_factor["factors"][0]["minimum"] = 101
    with pytest.raises(ValueError, match="minimum"):
        validate_evaluation(bad_factor)


def test_invalid_scalar_specifications_fail_early():
    for kwargs in (
        {"kind": "text"},
        {"kind": "category"},
        {"kind": "integer", "minimum": 0.1, "maximum": 0.9},
        {"kind": "float", "maximum": float("nan")},
    ):
        with pytest.raises(ValueError):
            FieldSpec("x", **kwargs)
