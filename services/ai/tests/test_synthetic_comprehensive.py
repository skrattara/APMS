import random
from dataclasses import asdict

import pytest
from apms_ai.contracts import validate_example
from apms_ai.synthetic import (
    FAMILY_NAMES,
    NOISE_LAWS,
    SyntheticConfig,
    _draw_noise,
    _student_dynamics,
    generate,
)


def _threshold(example):
    return example.schema["gradingSystem"]["finalGradeConversion"]["passingPercentage"]


def _numeric_mapping(example):
    grading = example.schema["gradingSystem"]
    for component in grading["components"]:
        scoring = component.get("assessmentDefinition", {}).get("scoring", {})
        if scoring.get("mode") == "numeric_mapping":
            return scoring["mapping"]
    raise AssertionError("numeric mapping fixture is required")


def test_comprehensive_generator_is_seeded_schema_valid_and_policy_coherent():
    config = SyntheticConfig(history_max=9, windows_per_student=2)
    first = generate(72, 20261017, config=config)
    second = generate(72, 20261017, config=config)
    assert [asdict(row) for row in first] == [asdict(row) for row in second]
    assert len(first) == 72
    assert all(row.origin == "synthetic" for row in first)
    assert len({row.group for row in first}) < len(first)
    assert all(row.group.startswith("synthetic-seed-20261017-") for row in first)
    assert len({row.group for row in generate(72, 20261018, config=config)}) < 72

    for example in first[:24]:
        validate_example(example)
        assert [query["horizon"] for query in example.queries] == [1, 2, 1, 1, 1, 1]
        assert not any(
            {"failure", "trend", "mapped_score", "categorical_score"} & set(row)
            for row in example.history
        )
        assert "family" not in example.schema and all(
            "family" not in row for row in example.history
        )
        threshold = _threshold(example)
        score1 = example.labels[0].get("current_standing")
        score2 = example.labels[1].get("current_standing")
        if score1 is not None and example.labels[0].get("failure") is not None:
            assert example.labels[0]["failure"] == (score1 < threshold)
        if score2 is not None and example.labels[1].get("failure") is not None:
            assert example.labels[1]["failure"] == (score2 < threshold)
        mapping = _numeric_mapping(example)
        mapped = example.labels[4].get("mapped_score")
        if mapped is not None and score1 is not None:
            expected = max(
                (item for item in mapping if score1 >= item["percentage"]),
                key=lambda item: item["percentage"],
            )["value"]
            assert mapped == expected
        categorical = example.labels[5].get("categorical_score")
        assert categorical is None or categorical in {"P", "A"}
        assert example.queries[5]["choices"] == ["P", "A"]


def test_dynamics_and_noise_support_broad_independent_families():
    config = SyntheticConfig()
    dynamics = {
        _student_dynamics(random.Random(seed), config)["family"] for seed in range(500)
    }
    assert set(FAMILY_NAMES) <= dynamics
    noise_laws = set()
    for law in NOISE_LAWS:
        samples = [_draw_noise(random.Random(seed), law, 1.0) for seed in range(200)]
        noise_laws.add(law)
        assert all(value == value and abs(value) < 100 for value in samples)
        assert max(samples) - min(samples) > 1
    assert noise_laws == set(NOISE_LAWS)


def test_missingness_empty_history_and_partial_labels_are_configurable():
    config = SyntheticConfig(
        history_min=3,
        history_max=3,
        horizons=(1, 2),
        field_missing_probability=1.0,
        structural_absence_probability=0.0,
        burst_missing_probability=0.0,
        sparse_history_probability=0.0,
        empty_history_probability=0.0,
        label_missing_probability=1.0,
    )
    examples = generate(8, 91, config=config)
    assert all(len(example.history) == 3 for example in examples)
    assert all(not label for example in examples for label in example.labels)
    assert any(
        value is None
        for example in examples
        for row in example.history
        for value in row.values()
    )

    sparse = generate(
        8,
        92,
        config=SyntheticConfig(
            history_min=2,
            history_max=2,
            empty_history_probability=1.0,
            structural_absence_probability=1.0,
            field_missing_probability=0.0,
            burst_missing_probability=0.0,
        ),
    )
    assert all(example.history == [] for example in sparse)

    structurally_absent = generate(
        8,
        93,
        config=SyntheticConfig(
            history_min=2,
            history_max=2,
            empty_history_probability=0.0,
            structural_absence_probability=1.0,
            field_missing_probability=0.0,
            burst_missing_probability=0.0,
            sparse_history_probability=0.0,
        ),
    )
    assert all(
        len(example.history) == 2 and all(row == {} for row in example.history)
        for example in structurally_absent
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"history_min": 5, "history_max": 4},
        {"horizons": (2, 1)},
        {"family_names": ("smooth",) * 8},
        {"noise_laws": ("unknown",)},
        {"field_missing_probability": 1.1},
        {"noise_scale_range": (1.0, float("nan"))},
        {"history_max": 2.5},
        {"burst_missing_length": (1, 2.5)},
        {"windows_per_student": 0},
    ],
)
def test_invalid_synthetic_config_fails_early(kwargs):
    with pytest.raises(ValueError):
        SyntheticConfig(**kwargs)


def test_generator_rejects_invalid_count_and_seed():
    with pytest.raises(ValueError):
        generate(0)
    with pytest.raises(ValueError):
        generate(3, 1.2)
