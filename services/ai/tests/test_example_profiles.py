"""The documented commands must consume valid, unambiguous JSON profiles."""

import json
from pathlib import Path


def test_checked_in_profiles_have_no_duplicate_keys():
    def unique_pairs(items):
        result = {}
        for key, value in items:
            assert key not in result, f"Ambiguous duplicate profile key: {key}"
            result[key] = value
        return result

    examples = Path(__file__).resolve().parents[1] / "examples"
    for path in examples.glob("*.json"):
        profile = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs
        )
        assert isinstance(profile, dict), path.name


def test_comprehensive_training_profiles_reproduce_predeclared_comparison():
    examples = Path(__file__).resolve().parents[1] / "examples"
    common = {
        "seed": 42,
        "epochs": 16,
        "batch_size": 32,
        "width": 32,
        "layers": 1,
        "heads": 4,
        "patience": 4,
        "learning_rate": 0.001,
        "accelerator": "cpu",
    }
    legacy = json.loads(
        (examples / "comprehensive-legacy-training.json").read_text(encoding="utf-8")
    )
    residual = json.loads(
        (examples / "comprehensive-residual-training.json").read_text(encoding="utf-8")
    )
    assert {key: legacy[key] for key in common} == common
    assert {key: residual[key] for key in common} == common
    assert {
        key: legacy[key]
        for key in (
            "numeric_residual",
            "input_dropout",
            "numeric_center_loss_weight",
            "dropout",
            "weight_decay",
            "min_delta",
        )
    } == {
        "numeric_residual": False,
        "input_dropout": 0.0,
        "numeric_center_loss_weight": 0.0,
        "dropout": 0.1,
        "weight_decay": 0.01,
        "min_delta": 0.0,
    }
    assert {
        key: residual[key]
        for key in (
            "numeric_residual",
            "residual_link",
            "input_dropout",
            "numeric_center_loss_weight",
            "dropout",
            "weight_decay",
            "min_delta",
        )
    } == {
        "numeric_residual": True,
        "residual_link": "additive",
        "input_dropout": 0.05,
        "numeric_center_loss_weight": 0.5,
        "dropout": 0.15,
        "weight_decay": 0.02,
        "min_delta": 0.002,
    }
