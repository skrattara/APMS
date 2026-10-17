from pathlib import Path

import pytest
import torch
from apms_ai.lifecycle import load_bundle, save_bundle
from apms_ai.pretraining import pretrain
from apms_ai.synthetic import generate
from apms_ai.training import _selection_score, train


def test_normalized_numeric_rmse_pools_squared_error_by_label_count():
    assert _selection_score("numeric_rmse", 99.0, 18.0, 2) == 3.0
    assert _selection_score("weighted_loss", 1.25, 100.0, 1) == 1.25
    with pytest.raises(ValueError, match="requires labeled numeric"):
        _selection_score("numeric_rmse", 1.0, 0.0, 0)
    with pytest.raises(ValueError, match="selection_metric"):
        _selection_score("raw_rmse", 1.0, 0.0, 0)


def test_numeric_context_loss_kind_and_rmse_selection_resume(tmp_path: Path):
    examples = generate(32, 141)
    common = {
        "seed": 37,
        "batch_size": 8,
        "width": 32,
        "layers": 1,
        "heads": 4,
        "patience": 4,
        "learning_rate": 1e-3,
        "numeric_residual": True,
        "residual_link": "additive",
        "input_dropout": 0.03,
        "numeric_center_loss_weight": 1.0,
        "numeric_history_context": True,
        "numeric_center_loss_kind": "mse",
        "selection_metric": "numeric_rmse",
    }
    first = tmp_path / "context-first"
    train(examples, first, epochs=1, **common)
    _, first_metadata = load_bundle(first)
    assert first_metadata["model_config"]["numeric_history_context"] is True
    assert (
        first_metadata["training"]["resume_contract"]["numeric_center_loss_kind"]
        == "mse"
    )
    assert first_metadata["training"]["selection_metric"] == "numeric_rmse"
    assert first_metadata["training"]["best_validation_score"] >= 0
    assert first_metadata["training"]["best_validation_loss"] >= 0

    # Leaving the new options unset on exact resume restores their saved values.
    resumed = tmp_path / "context-resumed"
    train(
        examples,
        resumed,
        epochs=2,
        resume=str(first) + ".checkpoint",
        **{
            key: value
            for key, value in common.items()
            if key
            not in {
                "numeric_history_context",
                "numeric_center_loss_kind",
                "selection_metric",
                "numeric_center_loss_weight",
                "input_dropout",
            }
        },
    )
    _, resumed_metadata = load_bundle(resumed)
    assert resumed_metadata["model_config"]["numeric_history_context"] is True
    assert (
        resumed_metadata["training"]["resume_contract"]["numeric_center_loss_kind"]
        == "mse"
    )
    assert resumed_metadata["training"]["selection_metric"] == "numeric_rmse"

    # A single uninterrupted run and an exact checkpoint continuation should
    # see the same minibatches, dropout draws, and optimizer updates.
    uninterrupted = tmp_path / "context-uninterrupted"
    train(examples, uninterrupted, epochs=2, **common)
    resumed_state, _ = load_bundle(str(resumed) + ".checkpoint")
    uninterrupted_state, _ = load_bundle(str(uninterrupted) + ".checkpoint")
    assert resumed_state["epoch"] == uninterrupted_state["epoch"] == 2
    assert (
        resumed_state["resume_model"].keys()
        == uninterrupted_state["resume_model"].keys()
    )
    for key, value in resumed_state["resume_model"].items():
        assert torch.equal(value, uninterrupted_state["resume_model"][key]), key

    with pytest.raises(ValueError, match="cannot change numeric_history_context"):
        train(
            examples,
            tmp_path / "invalid-context-resume",
            epochs=2,
            resume=str(first) + ".checkpoint",
            numeric_history_context=False,
            **{
                key: value
                for key, value in common.items()
                if key
                not in {
                    "numeric_history_context",
                    "numeric_center_loss_kind",
                    "selection_metric",
                    "numeric_center_loss_weight",
                    "input_dropout",
                }
            },
        )


def test_masked_pretraining_transfers_to_new_numeric_context_and_rejects_flip(
    tmp_path: Path,
):
    examples = generate(32, 913)
    masked = tmp_path / "masked-pretraining"
    pretrain(examples, masked, seed=19, epochs=1, width=32)

    trained = tmp_path / "context-from-pretraining"
    train(
        examples,
        trained,
        seed=19,
        epochs=1,
        batch_size=8,
        width=32,
        layers=2,
        heads=4,
        patience=2,
        init_from=masked,
        numeric_history_context=True,
    )
    state, metadata = load_bundle(trained)
    assert metadata["model_config"]["numeric_history_context"] is True
    assert any(key.startswith("numeric_context_encoder.") for key in state["model"])
    assert all(torch.isfinite(value).all() for value in state["model"].values())

    with pytest.raises(
        ValueError, match="Fine-tuning cannot change numeric_history_context"
    ):
        train(
            examples,
            tmp_path / "invalid-supervised-context-flip",
            seed=19,
            epochs=1,
            batch_size=8,
            width=32,
            layers=2,
            heads=4,
            init_from=trained,
            numeric_history_context=False,
        )


def test_legacy_bundle_without_new_resume_contract_fields_defaults_safely(
    tmp_path: Path,
):
    examples = generate(32, 220)
    original = tmp_path / "legacy-source"
    common = {
        "seed": 44,
        "epochs": 1,
        "batch_size": 8,
        "width": 32,
        "layers": 1,
        "heads": 4,
        "patience": 3,
    }
    train(examples, original, **common)
    state, metadata = load_bundle(str(original) + ".checkpoint")
    metadata["model_config"].pop("numeric_history_context", None)
    contract = metadata["training"]["resume_contract"]
    for key in ("numeric_center_loss_kind", "selection_metric"):
        contract.pop(key, None)
    legacy = tmp_path / "legacy-bundle"
    save_bundle(legacy, state=state, metadata=metadata)

    resumed = tmp_path / "legacy-resumed"
    train(
        examples,
        resumed,
        seed=44,
        epochs=2,
        batch_size=8,
        width=32,
        layers=1,
        heads=4,
        patience=3,
        resume=str(legacy),
    )
    _, resumed_metadata = load_bundle(resumed)
    assert resumed_metadata["model_config"]["numeric_history_context"] is False
    assert (
        resumed_metadata["training"]["resume_contract"]["numeric_center_loss_kind"]
        == "smooth_l1"
    )
    assert (
        resumed_metadata["training"]["resume_contract"]["selection_metric"]
        == "weighted_loss"
    )
