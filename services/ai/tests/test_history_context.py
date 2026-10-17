import pytest

torch = pytest.importorskip("torch")
from apms_ai.model import SchemaForecaster, multitask_loss


def _example_inputs():
    # Two learners, two requested fields, and five history slots. The values
    # intentionally mix fields, types, missing tokens, and padding.
    batch, queries = 2, 2
    values = torch.tensor([[0.2, 0.9, 0.6, 0.0, 0.8], [0.0, 0.7, 0.0, 0.0, 0.0]])
    field_ids = torch.tensor([[0, 1, 0, 0, 0], [0, 1, 0, 0, 0]])
    kinds = torch.tensor([[0, 0, 1, 4, 0], [4, 0, 4, 4, 4]])
    schema_tokens = torch.zeros(batch, 1, 16)
    history_mask = torch.tensor(
        [[False, False, False, False, True], [False, False, False, True, True]]
    )
    query_ids = torch.tensor([[0, 1], [0, 1]])
    query_mask = torch.zeros(batch, queries, dtype=torch.bool)
    legal_category_mask = torch.ones(batch, queries, 4, dtype=torch.bool)
    schema_mask = torch.zeros(batch, 1, dtype=torch.bool)
    numeric_bounds = (
        torch.tensor([-1.0, 1.0]).reshape(1, 1, 1, 2).expand(batch, queries, 1, 2)
    )
    query_features = torch.zeros(batch, queries, 8)
    query_features[..., 1] = 0  # float query type
    return (
        values,
        field_ids,
        kinds,
        schema_tokens,
        history_mask,
        query_ids,
        query_mask,
        legal_category_mask,
        schema_mask,
        numeric_bounds,
        query_features,
    )


def _capture_summaries(model, inputs):
    captured = []
    handle = model.numeric_context_encoder.register_forward_pre_hook(
        lambda _module, args: captured.append(args[0].detach().clone())
    )
    try:
        model(*inputs)
    finally:
        handle.remove()
    assert len(captured) == 1
    return captured[0]


def test_history_summaries_match_only_observed_numeric_values_for_each_query():
    torch.manual_seed(3)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_history_context=True,
    ).eval()
    summary = _capture_summaries(model, _example_inputs())

    # Summary slots are latest, previous, difference, mean, std, min, max,
    # count fraction, relative age, has value, and has previous.
    assert summary.shape == (2, 2, 11)
    assert torch.allclose(
        summary[0, 0, :7], torch.tensor([0.6, 0.2, 0.4, 0.4, 0.2, 0.2, 0.6])
    )
    assert summary[0, 0, 7].item() == pytest.approx(2 / 4)
    assert summary[0, 0, 8].item() == pytest.approx(1 / 3)
    assert summary[0, 0, 9:].tolist() == [1.0, 1.0]

    # The padded .8, different-field .9, and missing-kind zeros are excluded.
    assert summary[0, 1, 0].item() == pytest.approx(0.9)
    # Learner two has only a missing score token, but a real value for field 1.
    assert summary[1, 0].tolist() == [0.0] * 11
    assert summary[1, 1, 0].item() == pytest.approx(0.7)
    assert summary[1, 1, 9:].tolist() == [1.0, 0.0]


def test_history_context_is_optional_without_legacy_state_or_prediction_changes():
    torch.manual_seed(14)
    default_model = SchemaForecaster(
        width=16, heads=2, layers=1, dropout=0, categories=4
    )
    torch.manual_seed(14)
    explicit_off = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_history_context=False,
    )
    assert default_model.state_dict().keys() == explicit_off.state_dict().keys()
    inputs = _example_inputs()
    default_model.eval()
    explicit_off.eval()
    with torch.inference_mode():
        left = default_model(*inputs)
        right = explicit_off(*inputs)
    for output_name in left:
        assert torch.equal(left[output_name], right[output_name])


def test_history_context_preserves_query_order_bounds_quantile_order_and_gradients():
    torch.manual_seed(19)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_history_context=True,
        numeric_residual=True,
        residual_link="additive",
    )
    inputs = list(_example_inputs())
    outputs = model(*inputs)
    permutation = torch.tensor([1, 0])
    permuted = list(inputs)
    for index in (5, 6, 7, 10):
        permuted[index] = permuted[index][:, permutation]
    permuted[9] = permuted[9][:, permutation]
    reordered_outputs = model(*permuted)
    for output_name in outputs:
        assert torch.allclose(
            outputs[output_name][:, permutation],
            reordered_outputs[output_name],
            atol=1e-6,
        )
    quantiles = outputs["quantiles"]
    assert torch.all(quantiles[..., 1:] >= quantiles[..., :-1])
    assert torch.all(quantiles >= -1.0) and torch.all(quantiles <= 1.0)
    loss = sum(tensor.square().mean() for tensor in outputs.values())
    loss.backward()
    assert torch.isfinite(loss)
    assert all(
        torch.isfinite(parameter.grad).all()
        for parameter in model.parameters()
        if parameter.grad is not None
    )
    assert model.numeric_context_to_quantiles.weight.grad.abs().sum() > 0


def test_numeric_center_mse_penalty_has_known_squared_error_value():
    outputs = {
        "quantiles": torch.zeros(1, 1, 1, 3),
        "categorical": torch.zeros(1, 1, 4),
        "trend": torch.zeros(1, 1, 3),
        "failure": torch.zeros(1, 1),
    }
    targets = {
        "numeric": torch.ones(1, 1),
        "category": torch.zeros(1, 1, dtype=torch.long),
        "trend": torch.zeros(1, 1, dtype=torch.long),
        "failure": torch.zeros(1, 1),
    }
    masks = {key: torch.tensor([[key == "numeric"]]) for key in targets}
    smooth, _ = multitask_loss(
        outputs,
        targets,
        masks,
        numeric_center_loss_weight=1.0,
        numeric_center_loss_kind="smooth_l1",
    )
    squared, _ = multitask_loss(
        outputs,
        targets,
        masks,
        numeric_center_loss_weight=1.0,
        numeric_center_loss_kind="mse",
    )
    assert smooth.item() == pytest.approx(1.0)  # pinball .5 + SmoothL1 .5
    assert squared.item() == pytest.approx(1.5)  # pinball .5 + squared error 1
    with pytest.raises(ValueError, match="numeric_center_loss_kind"):
        multitask_loss(outputs, targets, masks, numeric_center_loss_kind="gaussian_nll")


def test_history_summaries_ignore_batch_padding_and_keep_constant_value_gradients_finite():
    torch.manual_seed(26)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_history_context=True,
    ).eval()
    # Use nonzero context routes so equal outputs exercise the summary inputs,
    # rather than relying on their zero-initialized projections.
    torch.nn.init.normal_(model.numeric_context_to_forecast.weight, std=0.05)
    torch.nn.init.normal_(model.numeric_context_to_quantiles.weight, std=0.05)
    short = [value[:1].clone() for value in _example_inputs()]
    for index in (0, 1, 2, 4):
        short[index] = short[index][:, :3]
    # Make the two observed values for field 0 constant, which exercises the
    # zero-standard-deviation branch while keeping gradients connected.
    short[0][0, 2] = short[0][0, 0]
    short[0].requires_grad_()
    padded = list(short)
    for index, fill in ((0, 0.0), (1, 1), (2, 0)):
        extension = torch.full((1, 2), fill, dtype=short[index].dtype)
        padded[index] = torch.cat((short[index].detach(), extension), dim=1)
    padding_extension = torch.ones(1, 2, dtype=torch.bool)
    padded[4] = torch.cat((short[4], padding_extension), dim=1)

    summary_short = _capture_summaries(model, short)
    summary_padded = _capture_summaries(model, padded)
    assert torch.allclose(summary_short, summary_padded, atol=0, rtol=0)
    assert summary_short[0, 0, 4].item() == 0.0
    with torch.no_grad():
        outputs_short = model(*short)
        outputs_padded = model(*padded)
    for output_name in outputs_short:
        assert torch.allclose(
            outputs_short[output_name], outputs_padded[output_name], atol=1e-6
        )

    # Empty, singleton, and constant histories should not create NaN input
    # gradients through the standard-deviation calculation.
    model.zero_grad(set_to_none=True)
    gradient_inputs = list(_example_inputs())
    gradient_inputs[0] = gradient_inputs[0].clone()
    gradient_inputs[0][0, 2] = gradient_inputs[0][0, 0]
    gradient_inputs[0].requires_grad_()
    values_with_grad = gradient_inputs[0]
    outputs = model(*gradient_inputs)
    sum(value.square().mean() for value in outputs.values()).backward()
    assert values_with_grad.grad is not None
    assert torch.isfinite(values_with_grad.grad).all()


def test_history_context_keeps_the_eleven_input_dynamic_export_contract(tmp_path):
    pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")
    from apms_ai.compression import export_onnx

    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        dropout=0,
        categories=4,
        numeric_history_context=True,
    ).eval()
    torch.manual_seed(41)
    torch.nn.init.normal_(model.numeric_context_to_forecast.weight, std=0.05)
    torch.nn.init.normal_(model.numeric_context_to_quantiles.weight, std=0.05)
    report = export_onnx(model, _example_inputs(), tmp_path / "history-context.onnx")
    assert report["parity"] == "passed"
    assert len(report["inputs"]) == 11
    assert report["outputs"] == ["quantiles", "categorical", "trend", "failure"]
