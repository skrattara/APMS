import json
from pathlib import Path

import pytest
from apms_ai.contracts import (
    Example,
    FieldSpec,
    compile_schema_context,
    validate_example,
    validate_grading,
)

ROOT = Path(__file__).resolve().parents[3]


def test_typed_values_missingness_and_numeric_constraints():
    ex = Example(
        [{"x": None, "flag": True, "kind": "a"}],
        [{"field": "x", "horizon": 1}],
        [
            FieldSpec("x", "integer", minimum=0, maximum=3),
            FieldSpec("flag", "boolean"),
            FieldSpec("kind", "category", ("a", "b")),
        ],
        [{"x": 2}],
    )
    validate_example(ex)
    ex.history[0]["x"] = 1.5
    with pytest.raises(ValueError):
        validate_example(ex)


def test_schema_changes_compile_numeric_structure_but_discard_names_and_ids():
    grading = json.loads(
        (
            ROOT / "packages/domain/src/grading/systems/it_global_grading_system.json"
        ).read_text()
    )
    evaluation = json.loads(
        (
            ROOT
            / "packages/domain/src/evaluation/legacy_default_evaluation_system.json"
        ).read_text()
    )
    tokens = compile_schema_context(grading, evaluation)
    renamed = json.loads(json.dumps(grading))
    renamed["name"] = "Different"
    renamed["components"][0]["name"] = "Hidden label"
    assert compile_schema_context(renamed, evaluation) == tokens
    changed = json.loads(json.dumps(grading))
    changed["components"][0]["assessmentDefinition"]["maxScore"] = 4
    assert compile_schema_context(changed, evaluation) != tokens


def test_invalid_component_fixture_rejected_without_alias_repair():
    grading = json.loads(
        (
            ROOT
            / "packages/domain/src/grading/systems/it_component_grading_system.json"
        ).read_text()
    )
    with pytest.raises(ValueError, match="Unknown assessment type"):
        validate_grading(grading)


def test_reference_and_cycle_checks():
    grading = json.loads(
        (
            ROOT / "packages/domain/src/grading/systems/it_global_grading_system.json"
        ).read_text()
    )
    grading["components"][0].pop("assessmentDefinition")
    grading["components"][0]["calculation"] = {
        "mode": "weighted",
        "weightMode": "relative",
        "components": [{"source": "component", "componentId": "el", "weight": 1}],
    }
    with pytest.raises(ValueError, match="cycle"):
        validate_grading(grading)
