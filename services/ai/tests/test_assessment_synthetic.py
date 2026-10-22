from dataclasses import replace
from pathlib import Path

from apms_ai.assessment_context import compile_assessment_contexts
from apms_ai.assessment_context import assessment_query_horizon
from apms_ai.assessment_synthetic import (
    AssessmentSyntheticConfig,
    generate_assessment_examples,
)
from apms_ai.contracts import validate_example


def test_assessment_generator_is_seeded_grouped_and_schema_valid():
    config = AssessmentSyntheticConfig(groups=3, seed=51)
    left = generate_assessment_examples(config)
    right = generate_assessment_examples(config)
    assert [item.group for item in left] == [item.group for item in right]
    assert left[0].assessment_instances == right[0].assessment_instances
    assert left[0].assessment_results == right[0].assessment_results
    assert len({item.group for item in left}) == 3
    for example in left:
        validate_example(example)
        assert {item["scoring"]["mode"] for item in example.assessment_instances} == {
            "linear",
            "numeric_mapping",
            "value_mapping",
        }
        assert any(query.get("assessment_ref") for query in example.queries)
        for query, label in zip(example.queries, example.labels):
            if "assessment_ref" in query:
                assert query["assessment_ref"] not in {
                    result["assessment_ref"] for result in example.assessment_results
                }
                assert query["field"] in label
                target = next(row for row in example.assessment_instances if row["assessment_ref"] == query["assessment_ref"])
                assert query["horizon"] == assessment_query_horizon(
                    target, example.assessment_instances, example.assessment_results
                )


def test_assessment_context_is_stable_under_inventory_and_result_permutation():
    example = generate_assessment_examples(AssessmentSyntheticConfig(groups=1, seed=18))[0]
    baseline = compile_assessment_contexts(example)
    permuted = replace(
        example,
        assessment_instances=list(reversed(example.assessment_instances)),
        assessment_results=list(reversed(example.assessment_results)),
    )
    assert compile_assessment_contexts(permuted) == baseline
    for query, vector in zip(example.queries, baseline):
        if "assessment_ref" in query:
            assert vector[0] == 1.0
            assert len(vector) == 34


def test_context_history_is_cut_off_before_each_target():
    example = generate_assessment_examples(AssessmentSyntheticConfig(groups=1, seed=27))[0]
    baseline = compile_assessment_contexts(example)
    target_ref = next(q["assessment_ref"] for q in example.queries if "assessment_ref" in q)
    target = next(i for i in example.assessment_instances if i["assessment_ref"] == target_ref)
    # Adding a future score must not alter that target's prior-summary features.
    future = max(example.assessment_instances, key=lambda row: row["sequence"])
    altered = replace(
        example,
        queries=[q for q in example.queries if q.get("assessment_ref") != future["assessment_ref"]],
        labels=[label for q, label in zip(example.queries, example.labels) if q.get("assessment_ref") != future["assessment_ref"]],
        assessment_results=example.assessment_results
        + [{"assessment_ref": future["assessment_ref"], "value": future["maximum_score"] if future["scoring"]["mode"] == "linear" else ("P" if future["scoring"]["mode"] == "value_mapping" else 3)}],
    )
    if future["sequence"] > target["sequence"]:
        changed = compile_assessment_contexts(altered)
        index = altered.queries.index(next(q for q in altered.queries if q.get("assessment_ref") == target_ref))
        original_index = example.queries.index(next(q for q in example.queries if q.get("assessment_ref") == target_ref))
        assert changed[index] == baseline[original_index]


def test_prior_same_type_score_changes_only_the_shared_compiled_context():
    example = generate_assessment_examples(AssessmentSyntheticConfig(groups=1, seed=31))[0]
    query_index = next(
        index for index, query in enumerate(example.queries)
        if "assessment_ref" in query
        and next(row for row in example.assessment_instances if row["assessment_ref"] == query["assessment_ref"])["scoring"]["mode"] == "linear"
    )
    query = example.queries[query_index]
    target = next(row for row in example.assessment_instances if row["assessment_ref"] == query["assessment_ref"])
    prior = next(
        row for row in example.assessment_results
        if next(instance for instance in example.assessment_instances if instance["assessment_ref"] == row["assessment_ref"])["assessment_type_ref"] == target["assessment_type_ref"]
        and next(instance for instance in example.assessment_instances if instance["assessment_ref"] == row["assessment_ref"])["sequence"] < target["sequence"]
    )
    changed_results = [dict(row) for row in example.assessment_results]
    changed = next(row for row in changed_results if row["assessment_ref"] == prior["assessment_ref"])
    prior_instance = next(row for row in example.assessment_instances if row["assessment_ref"] == prior["assessment_ref"])
    changed["value"] = 0.0 if float(changed["value"]) else prior_instance["maximum_score"]
    changed_example = replace(example, assessment_results=changed_results)
    assert compile_assessment_contexts(changed_example)[query_index] != compile_assessment_contexts(example)[query_index]


def test_assessment_baselines_report_same_type_history_and_percentage_units():
    import runpy

    runner = runpy.run_path(str(Path(__file__).resolve().parents[1] / "examples" / "compare_assessment_context.py"))
    examples = generate_assessment_examples(AssessmentSyntheticConfig(
        groups=12, seed=90210, history_fraction=0.62,
        score_missing_probability=0.0, label_missing_probability=0.0,
    ))
    baseline = runner["_baseline_predictions"](examples[:8], examples[8:], "validation")
    assert baseline["global_mean"]["linear"]["count"] > 0
    assert baseline["global_mean"]["numeric_mapping"]["count"] > 0
    assert baseline["last_same_type"]["linear"]["count"] > 0
    assert baseline["last_same_type"]["numeric_mapping"]["count"] > 0
    assert baseline["global_mean"]["linear"]["units"] == "percentage points, normalized by each target maximum_score"
    assert baseline["global_mean"]["numeric_mapping"]["units"] == "percentage points from the declared scoring mapping"


def test_selection_uses_only_frozen_declared_guards_and_rejects_unknown_names():
    import runpy

    runner = runpy.run_path(str(Path(__file__).resolve().parents[1] / "examples" / "compare_assessment_context.py"))
    guard = runner["_declared_guards_pass"]
    tolerance = {
        "standing_error_tolerance": 1.0,
        "failure_brier_tolerance": 0.02,
        "category_accuracy_tolerance": 0.03,
    }
    control = {"score_mae": 4.78, "score_rmse": 6.10, "failure_brier": 0.013,
               "ai_risk_level_accuracy": 0.6667}
    candidate = {"score_mae": 4.89, "score_rmse": 6.13, "failure_brier": 0.0164,
                 "ai_risk_level_accuracy": 0.6410}
    passes, detail = guard(
        control, candidate,
        ["standing_mae", "standing_rmse", "failure_brier", "ai_risk_level_accuracy"],
        tolerance,
    )
    assert passes
    assert detail["ai_risk_level_accuracy"]["passed"]
    try:
        guard(control, candidate, ["unknown_guard"], tolerance)
    except ValueError as error:
        assert "Unknown declared selection guard" in str(error)
    else:
        raise AssertionError("Unknown guard names must stop selection")
