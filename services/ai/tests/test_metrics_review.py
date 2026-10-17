import math

from apms_ai import data, evaluation
from apms_ai.contracts import Example, FieldSpec


def _example(value, origin="real", group="g"):
    return Example(
        history=[{"score": value}],
        queries=[{"field": "score", "horizon": 1}],
        fields=[FieldSpec("score", "float", minimum=0, maximum=100)],
        labels=[{"score": value}],
        group=group,
        origin=origin,
    )


def test_matched_baseline_skill_uses_same_rows_and_exposes_rmse():
    result = evaluation._matched_regression_report([1, 3], [2, 5], [0, 4])
    assert result["count"] == 2
    assert result["model"]["mae"] == 1.5
    assert math.isclose(result["model"]["rmse"], math.sqrt(2.5))
    assert result["baseline"]["mae"] == 1
    assert result["skill_mae"] == -0.5
    assert math.isclose(result["skill_rmse"], 1 - math.sqrt(2.5))


def test_error_slices_report_mae_and_rmse_with_group_counts():
    report = evaluation.error_slices([1, 3, 8], [2, 5, 5], ["a", "a", "b"])
    assert report["a"] == {"count": 2, "mae": 1.5, "rmse": math.sqrt(2.5)}
    assert report["b"] == {"count": 1, "mae": 3, "rmse": 3}


def test_training_mean_uses_train_only_and_prefers_real(monkeypatch):
    train_real = _example(10, "real", "train-real")
    train_synthetic = _example(90, "synthetic", "train-syn")
    heldout = _example(100, "real", "heldout")

    def split(examples, seed, ratios):
        assert heldout in examples
        return {
            "train": [train_real, train_synthetic],
            "validation": [],
            "calibration": [],
            "test": [heldout],
        }

    monkeypatch.setattr(data, "group_split", split)
    means, fit = evaluation._training_mean_baselines(
        [train_real, train_synthetic, heldout], {"training": {}}
    )
    key, *_ = evaluation.query_identity(train_real, 0)
    assert means == {key: 10}
    assert fit == {"source": "real_train", "label_count": 1, "query_count": 1}


def test_saved_training_mean_supports_external_evaluation_without_refitting():
    key, *_ = evaluation.query_identity(_example(1), 0)
    means, fit = evaluation._training_mean_baselines(
        [], {"training_baselines": {key: {"mean": 42.5, "count": 12}}}
    )
    assert means == {key: 42.5}
    assert fit == {"source": "saved_train_labels", "label_count": 12, "query_count": 1}
