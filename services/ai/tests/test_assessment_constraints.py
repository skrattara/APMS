import json
from pathlib import Path

import pytest
from apms_ai.contracts import (
    compile_assessment_constraint,
    validate_assessment_instances,
)

ROOT = Path(__file__).resolve().parents[3]


def grading():
    value = json.loads(
        (
            ROOT / "packages/domain/src/grading/systems/it_global_grading_system.json"
        ).read_text()
    )
    for component in value["components"]:
        definition = component.get("assessmentDefinition")
        if definition:
            definition.pop("count", None)
    return value


def instance(ref, type_ref="soc", value_mapping=True, **extra):
    scoring = (
        {
            "mode": "value_mapping",
            "mapping": [
                {"value": "P", "percentage": 100},
                {"value": "A", "percentage": 0},
            ],
        }
        if value_mapping
        else {"mode": "linear", "maximum_score": 100}
    )
    return {
        "assessment_ref": ref,
        "assessment_type_ref": type_ref,
        "maximum_score": 100,
        "scoring": scoring,
        "optional": False,
        **extra,
    }


def test_assessment_instances_compile_typed_schema_constraints():
    definition = grading()
    value = instance("a", period_ref="p1", group_ref="m1")
    validate_assessment_instances(
        definition, [value, instance("b", period_ref="p1", group_ref="m1")]
    )
    assert compile_assessment_constraint(definition, value) == {
        "kind": "category",
        "minimum": None,
        "maximum": None,
        "choices": ["P", "A"],
        "component_index": 0,
    }


def test_instance_scoring_references_scope_and_counts_fail_closed():
    definition = grading()
    soc = next(
        c
        for c in definition["components"]
        if c.get("assessmentDefinition", {}).get("typeId") == "soc"
    )
    soc["assessmentDefinition"]["count"] = {
        "min": 1,
        "max": 2,
        "scope": {"type": "per_group", "groupTypeId": "module"},
    }
    item = instance("a", period_ref="p1", group_ref="m1")
    with pytest.raises(ValueError, match="unique"):
        validate_assessment_instances(definition, [item, item.copy()])
    changed = instance("a", period_ref="p2", group_ref="m1")
    with pytest.raises(ValueError, match="outside its assigned period"):
        validate_assessment_instances(definition, [changed])
    wrong_mapping = instance("a", period_ref="p1", group_ref="m1")
    wrong_mapping["scoring"]["mapping"][0]["percentage"] = 90
    with pytest.raises(ValueError, match="differs from its grading definition"):
        validate_assessment_instances(definition, [wrong_mapping])
    # Count limits apply to the full supplied inventory, irrespective of whether
    # a result is already present; 3 is above SoC's per-module maximum of 2.
    too_many = [
        instance(str(i), period_ref="p1", group_ref="m1", has_result=i == 0)
        for i in range(3)
    ]
    with pytest.raises(ValueError, match="maximum count"):
        validate_assessment_instances(definition, too_many)


def test_numeric_mapping_and_weighted_instance_constraints():
    definition = grading()
    item = {
        "assessment_ref": "quiz",
        "assessment_type_ref": "lp",
        "maximum_score": 3,
        "scoring": {
            "mode": "numeric_mapping",
            "mapping": [
                {"value": 0, "percentage": 0},
                {"value": 1, "percentage": 60},
                {"value": 2, "percentage": 80},
                {"value": 3, "percentage": 100},
            ],
        },
        "group_ref": "m1",
        "period_ref": "p1",
    }
    assert compile_assessment_constraint(definition, item)["choices"] == [0, 1, 2, 3]
    item["maximum_score"] = 2
    with pytest.raises(ValueError, match="instance maximum"):
        validate_assessment_instances(definition, [item])
    weighted = json.loads(json.dumps(definition))
    component = next(
        c
        for c in weighted["components"]
        if c.get("assessmentDefinition", {}).get("typeId") == "soc"
    )
    component["assessmentDefinition"]["aggregation"] = {"mode": "weighted"}
    with pytest.raises(ValueError, match="explicit weight"):
        validate_assessment_instances(weighted, [instance("a")])
