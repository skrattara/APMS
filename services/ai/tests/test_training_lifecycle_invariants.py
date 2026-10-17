from dataclasses import replace

import pytest
import torch
from apms_ai.contracts import Example, FieldSpec
from apms_ai.data import group_split
from apms_ai.lifecycle import load_bundle
from apms_ai.training import train


def _small_examples(count=20):
    field = FieldSpec("current_standing", "float", minimum=0, maximum=100)
    rows = []
    for index in range(count):
        value = float(10 + index)
        rows.append(
            Example(
                history=[{"current_standing": value}],
                queries=[{"field": "current_standing", "horizon": 1}],
                fields=[field],
                labels=[
                    {
                        "current_standing": min(100.0, value + 2),
                        "trend": "stable",
                        "failure": 0,
                    }
                ],
                group=f"learner-{index}",
                origin="synthetic",
            )
        )
    return rows


def test_train_preprocessor_prefers_real_train_rows(tmp_path):
    examples = _small_examples()
    training_groups = {example.group for example in group_split(examples, 17)["train"]}
    real_groups = set(sorted(training_groups)[: max(1, len(training_groups) // 2)])
    mixed = [
        replace(
            example,
            fields=[replace(field, maximum=2000) for field in example.fields],
            history=[
                {
                    "current_standing": 10.0 + i
                    if example.group in real_groups
                    else 1000.0 + i
                }
            ],
            origin="real" if example.group in real_groups else "synthetic",
        )
        for i, example in enumerate(examples)
    ]
    output = tmp_path / "real-priority"
    train(mixed, output, seed=17, epochs=1, batch_size=8, width=32)
    _, metadata = load_bundle(output)
    # The fitted center comes from real train rows, not the large synthetic values.
    assert metadata["preprocessing"]["current_standing"][0] < 100
    assert metadata["training"]["source_counts"]["train"] == len(real_groups)


def test_exact_cpu_resume_matches_uninterrupted_training(tmp_path):
    examples = _small_examples(20)
    common = {
        "seed": 23,
        "batch_size": 8,
        "width": 32,
        "learning_rate": 1e-3,
        "patience": 5,
        "task_weights": {"numeric": 3.0, "category": 1.0, "trend": 0.5, "failure": 1.0},
    }
    first = tmp_path / "one-epoch"
    train(examples, first, epochs=1, **common)
    resumed = tmp_path / "resumed-two-epochs"
    train(examples, resumed, epochs=2, resume=str(first) + ".checkpoint", **common)
    uninterrupted = tmp_path / "uninterrupted-two-epochs"
    train(examples, uninterrupted, epochs=2, **common)
    resumed_state, _ = load_bundle(resumed)
    whole_state, _ = load_bundle(uninterrupted)
    assert resumed_state["model"].keys() == whole_state["model"].keys()
    for name in resumed_state["model"]:
        assert torch.equal(resumed_state["model"][name], whole_state["model"][name]), (
            name
        )


def test_programmatic_training_rejects_labels_outside_requested_domain(tmp_path):
    examples = _small_examples()
    examples[0] = replace(
        examples[0],
        queries=[{"field": "current_standing", "minimum": 50, "maximum": 100}],
    )
    with pytest.raises(ValueError, match="query domain"):
        train(examples, tmp_path / "invalid", epochs=1, width=32)
    assert not (tmp_path / "invalid").exists()
