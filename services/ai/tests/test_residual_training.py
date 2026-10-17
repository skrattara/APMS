"""Regression checks for persistence-centered numeric residual forecasts."""

from dataclasses import replace

import pytest

torch = pytest.importorskip("torch")
from apms_ai.contracts import Example, FieldSpec
from apms_ai.model import SchemaForecaster, multitask_loss
from apms_ai.training import _prepare


def _inputs(values, field_ids, kinds, query_ids, bounds, query_types=None, mask=None):
    batch, history = values.shape
    queries = query_ids.shape[1]
    query_features = torch.zeros(batch, queries, 8)
    if query_types is not None:
        query_features[..., 1] = query_types
    return (
        values,
        field_ids,
        kinds,
        torch.zeros(batch, 1, 16),
        torch.zeros(batch, history, dtype=torch.bool) if mask is None else mask,
        query_ids,
        torch.zeros(batch, queries, dtype=torch.bool),
        torch.ones(batch, queries, 4, dtype=torch.bool),
        torch.zeros(batch, 1, dtype=torch.bool),
        bounds,
        query_features,
    )


@pytest.mark.parametrize("residual_link", ["logit", "additive"])
@pytest.mark.parametrize(
    "minimum,maximum,anchor",
    [
        (0.0, 100.0, 42.0),  # two-sided logit link
        (0.0, float("inf"), 42.0),  # lower inverse-softplus link
        (-float("inf"), 100.0, 42.0),  # upper inverse-softplus link
        (-float("inf"), float("inf"), 42.0),  # identity link
    ],
)
def test_zero_initialized_residual_median_is_persistence(
    minimum, maximum, anchor, residual_link
):
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_residual=True,
        residual_link=residual_link,
    ).eval()
    bounds = torch.tensor([minimum, maximum]).reshape(1, 1, 1, 2)
    inputs = _inputs(
        torch.tensor([[anchor / 10.0, 2.0]]),
        torch.tensor([[0, 1]]),
        torch.tensor([[0, 0]]),
        torch.tensor([[0]]),
        bounds / 10.0,
        torch.tensor([[0.0]]),
    )
    with torch.inference_mode():
        quantiles = model(*inputs)["quantiles"][0, 0, 0]
    assert torch.all(quantiles[1:] >= quantiles[:-1])
    assert quantiles[1].item() == pytest.approx(anchor / 10.0, abs=2e-5)
    normalized_bounds = inputs[9][0, 0, 0]
    if torch.isfinite(normalized_bounds[0]):
        assert (quantiles >= normalized_bounds[0]).all()
    if torch.isfinite(normalized_bounds[1]):
        assert (quantiles <= normalized_bounds[1]).all()


@pytest.mark.parametrize("residual_link", ["logit", "additive"])
def test_anchor_ignores_other_fields_missing_tokens_and_padding_and_no_anchor_is_finite(
    residual_link,
):
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_residual=True,
        residual_link=residual_link,
    ).eval()
    inputs = _inputs(
        torch.tensor([[0.1, 0.8, 0.9, 0.7], [0.2, 0.4, 0.0, 0.0]]),
        torch.tensor([[0, 1, 0, 0], [1, 1, 0, 0]]),
        torch.tensor([[0, 0, 4, 0], [1, 5, 0, 0]]),
        torch.tensor([[0], [0]]),
        torch.tensor([0.0, 1.0]).reshape(1, 1, 1, 2).expand(2, 1, 1, 2),
        torch.zeros(2, 1),
        mask=torch.tensor([[False, False, False, True], [False, False, True, True]]),
    )
    with torch.inference_mode():
        quantiles = model(*inputs)["quantiles"][:, 0, 0]
    assert quantiles[0, 1].item() == pytest.approx(0.1)
    # Learner 2 has no observed value for queried field 0: the fallback is
    # finite and still respects its declared normalized bounds.
    assert torch.isfinite(quantiles[1]).all()
    expected_center = 0.5 if residual_link == "logit" else 0.0
    assert quantiles[1, 1].item() == pytest.approx(expected_center, abs=1e-6)
    assert (quantiles[1] >= 0).all() and (quantiles[1] <= 1).all()


def test_residual_queries_are_permutation_equivariant():
    torch.manual_seed(14)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_residual=True,
        residual_link="additive",
    ).eval()
    bounds = torch.tensor([-1.0, 2.0]).reshape(1, 1, 1, 2).expand(1, 2, 1, 2)
    inputs = list(
        _inputs(
            torch.tensor([[0.2, 0.7, 0.4]]),
            torch.tensor([[0, 1, 0]]),
            torch.tensor([[0, 1, 0]]),
            torch.tensor([[0, 1]]),
            bounds,
            torch.zeros(1, 2),
        )
    )
    with torch.inference_mode():
        original = model(*inputs)["quantiles"]
        permutation = torch.tensor([1, 0])
        for index in (5, 6, 7, 10):
            inputs[index] = inputs[index][:, permutation]
        inputs[9] = inputs[9][:, permutation]
        reordered = model(*inputs)["quantiles"][:, permutation]
    assert torch.allclose(original, reordered, atol=1e-6)


@pytest.mark.parametrize("anchor,target", [(0.0, 0.6), (1.0, 0.4)])
def test_additive_link_keeps_finite_boundary_gradient_toward_interior(anchor, target):
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_residual=True,
        residual_link="additive",
    )
    inputs = _inputs(
        torch.tensor([[anchor]]),
        torch.tensor([[0]]),
        torch.tensor([[0]]),
        torch.tensor([[0]]),
        torch.tensor([0.0, 1.0]).reshape(1, 1, 1, 2),
        torch.zeros(1, 1),
    )
    outputs = model(*inputs)
    labels = {
        "numeric": torch.tensor([[target]]),
        "category": torch.zeros(1, 1, dtype=torch.long),
        "trend": torch.zeros(1, 1, dtype=torch.long),
        "failure": torch.zeros(1, 1),
    }
    masks = {
        "numeric": torch.ones(1, 1, dtype=torch.bool),
        "category": torch.zeros(1, 1, dtype=torch.bool),
        "trend": torch.zeros(1, 1, dtype=torch.bool),
        "failure": torch.zeros(1, 1, dtype=torch.bool),
    }
    loss, _ = multitask_loss(outputs, labels, masks, numeric_center_loss_weight=0.25)
    loss.backward()
    assert torch.isfinite(outputs["quantiles"]).all()
    assert torch.isfinite(loss)
    assert torch.isfinite(model.numeric.bias.grad).all()
    assert model.numeric.bias.grad[1].abs() > 0


def test_training_token_dropout_turns_only_observed_features_into_missing_kind():
    examples = [
        Example(
            history=[
                {"score": 1.0, "attendance": 0.8, "status": "present"},
                {"score": None, "attendance": 0.9, "status": "present"},
            ],
            queries=[{"field": "score"}],
            fields=[
                FieldSpec("score", "float"),
                FieldSpec("attendance", "float"),
                FieldSpec("status", "category", categories=["present"]),
            ],
            labels=[{"score": 2.0}],
        )
    ]
    clean, clean_targets, _ = _prepare(
        examples, ["score", "attendance", "status"], {}, {}, torch.device("cpu")
    )
    torch.manual_seed(11)
    dropped, dropped_targets, _ = _prepare(
        examples,
        ["score", "attendance", "status"],
        {},
        {},
        torch.device("cpu"),
        input_dropout=0.9999,
    )
    observed = clean[2] < 4
    assert torch.all(dropped[2][observed] >= 4)
    assert torch.all(dropped[0][observed] == 0)
    assert dropped[2][~observed].tolist() == clean[2][~observed].tolist()
    assert torch.equal(clean_targets["numeric"], dropped_targets["numeric"])


def test_center_loss_contributes_finite_gradient_to_median():
    quantiles = torch.tensor([[[[0.0, 0.0, 0.0]]]], requires_grad=True)
    outputs = {
        "quantiles": quantiles,
        "categorical": torch.zeros(1, 1, 4),
        "trend": torch.zeros(1, 1, 3),
        "failure": torch.zeros(1, 1),
    }
    targets = {
        "numeric": torch.ones(1, 1),
        "category": torch.zeros(1, 1),
        "trend": torch.zeros(1, 1),
        "failure": torch.zeros(1, 1),
    }
    masks = {key: torch.tensor([[key == "numeric"]]) for key in targets}
    loss, _ = multitask_loss(outputs, targets, masks, numeric_center_loss_weight=0.25)
    loss.backward()
    assert torch.isfinite(loss)
    assert torch.isfinite(quantiles.grad).all()
    assert quantiles.grad[0, 0, 0, 1] < 0


def test_training_bundle_saves_per_query_real_first_mean_baseline(tmp_path):
    from apms_ai.data import group_split
    from apms_ai.lifecycle import load_bundle
    from apms_ai.training import train

    field = FieldSpec("score", "float", minimum=0, maximum=100)
    examples = [
        Example(
            history=[{"score": float(index)}],
            queries=[{"field": "score", "horizon": 1}],
            fields=[field],
            labels=[{"score": float(index)}],
            group=f"student-{index}",
        )
        for index in range(20)
    ]
    train_groups = {row.group for row in group_split(examples, 29)["train"]}
    real_group = next(iter(train_groups))
    examples = [
        replace(
            row,
            origin="real" if row.group == real_group else "synthetic",
            labels=[{"score": 91.0 if row.group == real_group else 17.0}],
        )
        for row in examples
    ]
    bundle = tmp_path / "residual-model"
    train(examples, bundle, seed=29, epochs=1, batch_size=8, width=16, heads=2)
    _, metadata = load_bundle(bundle)
    assert metadata["model_config"]["numeric_residual"] is True
    assert len(metadata["training_baselines"]) == 1
    baseline = next(iter(metadata["training_baselines"].values()))
    assert baseline["source"] == "real_train"
    assert baseline["count"] == 1
    assert baseline["mean"] == pytest.approx(91.0)


def test_masked_pretraining_can_initialize_explicit_residual_forecasting(tmp_path):
    from apms_ai.lifecycle import load_bundle
    from apms_ai.pretraining import pretrain
    from apms_ai.training import train

    field = FieldSpec("score", "float", minimum=0, maximum=100)
    examples = [
        Example(
            history=[{"score": float(index)}, {"score": float(index + 1)}],
            queries=[{"field": "score", "horizon": 1}],
            fields=[field],
            labels=[{"score": float(index + 2)}],
            group=f"student-{index}",
        )
        for index in range(20)
    ]
    pretraining_bundle = tmp_path / "pretraining"
    pretrain(examples, pretraining_bundle, seed=31, epochs=1, width=16)
    forecasting_bundle = tmp_path / "residual-forecast"
    train(
        examples,
        forecasting_bundle,
        seed=31,
        epochs=1,
        batch_size=8,
        width=16,
        heads=4,
        layers=2,
        numeric_residual=True,
        init_from=pretraining_bundle,
    )
    _, metadata = load_bundle(forecasting_bundle)
    assert metadata["model_config"]["numeric_residual"] is True


@pytest.mark.parametrize("residual_link", ["logit", "additive"])
def test_generated_mixed_typed_bounded_batch_has_finite_backward(residual_link):
    from apms_ai.synthetic import generate

    examples = generate(12, 37)
    fields = list(
        dict.fromkeys(field.name for example in examples for field in example.fields)
    )
    inputs, targets, masks = _prepare(examples, fields, {}, {}, torch.device("cpu"))
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=16,
        numeric_residual=True,
        residual_link=residual_link,
    )
    outputs = model(*inputs)
    loss, _ = multitask_loss(outputs, targets, masks, numeric_center_loss_weight=0.25)
    loss.backward()
    assert torch.isfinite(loss)
    assert all(
        torch.isfinite(parameter.grad).all()
        for parameter in model.parameters()
        if parameter.grad is not None
    )


def test_cli_exposes_residual_training_and_external_evaluation_flags():
    from apms_ai.cli import build_parser

    parser = build_parser()
    train_args = parser.parse_args(
        [
            "train",
            "--data",
            "data.jsonl",
            "--output",
            "bundle",
            "--numeric-residual",
            "--real-fraction",
            "0.8",
            "--min-delta",
            "0.01",
            "--numeric-center-loss-weight",
            "0.2",
            "--input-dropout",
            "0.03",
            "--residual-link",
            "additive",
        ]
    )
    assert train_args.numeric_residual is True
    assert train_args.real_fraction == pytest.approx(0.8)
    assert train_args.min_delta == pytest.approx(0.01)
    assert train_args.numeric_center_loss_weight == pytest.approx(0.2)
    assert train_args.input_dropout == pytest.approx(0.03)
    assert train_args.residual_link == "additive"
    assert SchemaForecaster(numeric_residual=True).residual_link == "logit"
    eval_args = parser.parse_args(
        [
            "evaluate",
            "--bundle",
            "bundle",
            "--data",
            "external.jsonl",
            "--output",
            "report.json",
            "--external",
        ]
    )
    assert eval_args.external is True
    online_args = parser.parse_args(
        [
            "online-update",
            "--incumbent",
            "incumbent",
            "--new-data",
            "new.jsonl",
            "--replay-data",
            "replay.jsonl",
            "--guard-data",
            "guard.jsonl",
            "--output",
            "candidate",
            "--report",
            "report.json",
        ]
    )
    assert online_args.rmse_tolerance == 0.0
    assert not hasattr(train_args, "rmse_tolerance")
    explicit_online_args = parser.parse_args(
        [
            "online-update",
            "--incumbent",
            "incumbent",
            "--new-data",
            "new.jsonl",
            "--replay-data",
            "replay.jsonl",
            "--guard-data",
            "guard.jsonl",
            "--output",
            "candidate",
            "--report",
            "report.json",
            "--rmse-tolerance",
            "0.5",
        ]
    )
    assert explicit_online_args.rmse_tolerance == pytest.approx(0.5)


def test_residual_model_preserves_dynamic_onnx_export(tmp_path):
    pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")
    from apms_ai.compression import export_onnx

    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_residual=True,
        residual_link="additive",
    ).eval()
    inputs = _inputs(
        torch.tensor([[0.2, 0.7, 0.4], [0.5, 0.1, 0.6]]),
        torch.tensor([[0, 1, 0], [0, 1, 0]]),
        torch.tensor([[0, 1, 0], [0, 1, 0]]),
        torch.tensor([[0], [0]]),
        torch.tensor([0.0, 1.0]).reshape(1, 1, 1, 2).expand(2, 1, 1, 2),
        torch.zeros(2, 1),
    )
    report = export_onnx(model, inputs, tmp_path / "residual.onnx")
    assert report["parity"] == "passed"
