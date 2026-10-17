"""Attention and loss regression tests from the primary implementation review."""

import pytest

torch = pytest.importorskip("torch")
from apms_ai.model import SchemaForecaster, constrain_numeric, multitask_loss


def sample_inputs(batch=2, history=3, queries=2, categories=4):
    return (
        torch.randn(batch, history),
        torch.zeros(batch, history, dtype=torch.long),
        torch.zeros(batch, history, dtype=torch.long),
        torch.randn(batch, 2, 16),
        torch.zeros(batch, history, dtype=torch.bool),
        torch.zeros(batch, queries, dtype=torch.long),
        torch.zeros(batch, queries, dtype=torch.bool),
        torch.ones(batch, queries, categories, dtype=torch.bool),
        torch.zeros(batch, 2, dtype=torch.bool),
        torch.tensor([-float("inf"), float("inf")])
        .expand(batch, queries, 1, 2)
        .clone(),
        torch.zeros(batch, queries, 8),
    )


def test_schema_and_query_descriptors_affect_single_token_attention():
    torch.manual_seed(5)
    model = SchemaForecaster(
        width=16, heads=2, layers=1, categories=4, dropout=0
    ).eval()
    inputs = sample_inputs(batch=1, history=1, queries=1)
    with torch.inference_mode():
        baseline = model(*inputs)["quantiles"]
        changed = list(inputs)
        changed[3] = changed[3] + 2
        assert not torch.allclose(baseline, model(*changed)["quantiles"])
        changed = list(inputs)
        changed[10] = changed[10] + 1
        assert not torch.allclose(baseline, model(*changed)["quantiles"])


def test_one_sided_bounds_preserve_quantile_order_and_finite_gradients():
    model = SchemaForecaster(width=16, heads=2, layers=1, categories=4, dropout=0)
    inputs = list(sample_inputs())
    inputs[9][0, :, 0, 1] = 1
    inputs[9][1, :, 0, 0] = -1
    outputs = model(*inputs)
    quantiles = outputs["quantiles"]
    assert (quantiles[..., 1:] >= quantiles[..., :-1]).all()
    assert (quantiles[0] <= 1).all() and (quantiles[1] >= -1).all()
    quantiles.sum().backward()
    assert all(
        torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None
    )


def test_numeric_loss_uses_each_learner_and_ignores_unobserved_nan():
    prediction = torch.tensor(
        [
            [[[1.0, 2.0, 3.0]], [[4.0, 5.0, 6.0]]],
            [[[7.0, 8.0, 9.0]], [[10.0, 11.0, 12.0]]],
        ],
        requires_grad=True,
    )
    outputs = {
        "quantiles": prediction,
        "categorical": torch.zeros(2, 2, 4),
        "trend": torch.zeros(2, 2, 3),
        "failure": torch.zeros(2, 2),
    }
    numeric = torch.tensor([[2.0, float("nan")], [9.0, 12.0]])
    observed = torch.tensor([[True, False], [True, True]])
    targets = {
        "numeric": numeric,
        "category": torch.zeros(2, 2),
        "trend": torch.zeros(2, 2),
        "failure": torch.zeros(2, 2),
    }
    masks = {
        key: observed if key == "numeric" else torch.zeros(2, 2, dtype=torch.bool)
        for key in targets
    }
    loss, _ = multitask_loss(outputs, targets, masks)
    selected = prediction[observed]
    error = numeric[observed, None, None] - selected
    q = torch.tensor([0.1, 0.5, 0.9])
    assert torch.allclose(loss, torch.maximum(q * error, (q - 1) * error).mean())
    loss.backward()
    assert torch.isfinite(prediction.grad).all()
    assert prediction.grad[0, 1].eq(0).all()


def test_integer_output_cannot_round_outside_legal_domain():
    assert constrain_numeric(0.6, minimum=0.5, maximum=1.5, integer=True) == 1
    with pytest.raises(ValueError, match="integer"):
        constrain_numeric(0.5, minimum=0.2, maximum=0.6, integer=True)


def test_distillation_normalization_keeps_batch_query_and_output_axes():
    from apms_ai.training import _distillation_loss

    teacher = {
        "quantiles": torch.ones(2, 3, 1, 3),
        "categorical": torch.zeros(2, 3, 4),
        "trend": torch.zeros(2, 3, 3),
        "failure": torch.zeros(2, 3),
    }
    scale = torch.arange(1, 7).reshape(2, 3).float()
    offset = -scale * 2
    adjusted = dict(
        teacher,
        quantiles=teacher["quantiles"] * scale[..., None, None]
        + offset[..., None, None],
    )
    student = {name: value.clone().requires_grad_() for name, value in adjusted.items()}
    query_mask = torch.zeros(2, 3, dtype=torch.bool)
    actual = _distillation_loss(
        student, teacher, query_mask, numeric_scale=scale, numeric_offset=offset
    )
    expected = _distillation_loss(student, adjusted, query_mask)
    assert torch.allclose(actual, expected)
    actual.backward()
    assert torch.isfinite(student["quantiles"].grad).all()
