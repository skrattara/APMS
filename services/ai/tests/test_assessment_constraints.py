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


def test_partial_inventory_skips_only_minimum_count_requirements():
    definition = grading()
    soc = next(
        component
        for component in definition["components"]
        if component.get("assessmentDefinition", {}).get("typeId") == "soc"
    )
    soc["assessmentDefinition"]["count"] = {
        "min": 2,
        "max": 2,
        "scope": {"type": "per_group", "groupTypeId": "module"},
    }
    only_current = instance("current-soc", period_ref="p1", group_ref="m1")

    # Existing calls remain strict unless they opt in to partial inventory.
    with pytest.raises(ValueError, match="minimum count"):
        validate_assessment_instances(definition, [only_current])
    validate_assessment_instances(definition, [only_current], inventory="partial")

    too_many = [
        instance(f"soc-{index}", period_ref="p1", group_ref="m1")
        for index in range(3)
    ]
    with pytest.raises(ValueError, match="maximum count"):
        validate_assessment_instances(definition, too_many, inventory="partial")

    wrong_mapping = instance("wrong-map", period_ref="p1", group_ref="m1")
    wrong_mapping["scoring"]["mapping"][0]["percentage"] = 99
    with pytest.raises(ValueError, match="differs from its grading definition"):
        validate_assessment_instances(
            definition, [wrong_mapping], inventory="partial"
        )

    outside_scope = instance("outside", period_ref="p2", group_ref="m1")
    with pytest.raises(ValueError, match="outside its assigned period"):
        validate_assessment_instances(
            definition, [outside_scope], inventory="partial"
        )

    with pytest.raises(ValueError, match="inventory must be"):
        validate_assessment_instances(definition, [only_current], inventory="future")


def test_partial_count_scopes_require_explicit_matching_assignments():
    per_group = grading()
    soc = next(
        component
        for component in per_group["components"]
        if component.get("assessmentDefinition", {}).get("typeId") == "soc"
    )
    soc["assessmentDefinition"]["count"] = {
        "min": 1,
        "max": 2,
        "scope": {"type": "per_group", "groupTypeId": "module"},
    }
    missing_group = instance("no-group", period_ref="p1")
    with pytest.raises(ValueError, match="requires group_ref"):
        validate_assessment_instances(
            per_group, [missing_group], inventory="partial"
        )

    wrong_type = json.loads(json.dumps(per_group))
    wrong_type["groupTypes"].append(
        {"id": "seminar", "name": "Seminar", "description": "Test scope"}
    )
    wrong_type["groups"].append(
        {
            "id": "seminar-1",
            "name": "Seminar 1",
            "typeId": "seminar",
            "sequence": 1,
        }
    )
    with pytest.raises(ValueError, match="group type differs"):
        validate_assessment_instances(
            wrong_type,
            [instance("wrong-group", group_ref="seminar-1")],
            inventory="partial",
        )

    per_period = grading()
    soc = next(
        component
        for component in per_period["components"]
        if component.get("assessmentDefinition", {}).get("typeId") == "soc"
    )
    soc["assessmentDefinition"]["count"] = {
        "min": 1,
        "max": 2,
        "scope": {"type": "per_period"},
    }
    with pytest.raises(ValueError, match="requires period_ref"):
        validate_assessment_instances(
            per_period, [instance("no-period")], inventory="partial"
        )
