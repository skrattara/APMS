"""Real ONNX Runtime checks; automatically skipped without export extras."""

import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("onnx")
pytest.importorskip("onnxruntime")

from apms_ai.compression import INPUT_NAMES, export_onnx, quantize_dynamic_onnx
from apms_ai.model import SchemaForecaster


def test_compression_rmse_ignores_unobserved_labels():
    import numpy as np
    from apms_ai.compression import _quality_metrics

    quantiles = np.array([[[[1.0, 1.0, 1.0]], [[3.0, 3.0, 3.0]], [[float("nan")] * 3]]])
    output = [quantiles, np.zeros((1, 3, 4)), np.zeros((1, 3, 3)), np.zeros((1, 3))]
    targets = {
        "numeric": np.array([[0.0, 0.0, float("nan")]]),
        "category": np.zeros((1, 3)),
        "trend": np.zeros((1, 3)),
        "failure": np.zeros((1, 3)),
    }
    masks = {key: np.zeros((1, 3), dtype=bool) for key in targets}
    masks["numeric"][0, :2] = True
    report = _quality_metrics([output], [{"targets": targets, "masks": masks}])
    assert report["numeric_mae"] == 2.0
    assert report["numeric_rmse"] == pytest.approx(5.0**0.5)


def test_export_dynamic_shapes_and_int8_labeled_gate(tmp_path):
    torch.manual_seed(7)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        categories=4,
        max_history=32,
        max_queries=16,
        dropout=0,
    ).eval()
    batch, history, queries = 2, 5, 2
    bounds = torch.tensor([-2.0, 2.0]).expand(batch, queries, 1, 2).clone()
    inputs = (
        torch.randn(batch, history),
        torch.zeros(batch, history, dtype=torch.long),
        torch.zeros(batch, history, dtype=torch.long),
        torch.randn(batch, 3, 16),
        torch.zeros(batch, history, dtype=torch.bool),
        torch.zeros(batch, queries, dtype=torch.long),
        torch.zeros(batch, queries, dtype=torch.bool),
        torch.ones(batch, queries, 4, dtype=torch.bool),
        torch.zeros(batch, 3, dtype=torch.bool),
        bounds,
        torch.randn(batch, queries, 8),
    )
    report = export_onnx(model, inputs, tmp_path / "model.onnx")
    assert report["parity"] == "passed" and len(report["cases"]) >= 3
    assert {case["batch"] for case in report["cases"]} == {1, 2}
    feed = {name: value.numpy() for name, value in zip(INPUT_NAMES, inputs)}
    target = {
        "numeric": torch.zeros(batch, queries).numpy(),
        "category": torch.zeros(batch, queries, dtype=torch.long).numpy(),
        "trend": torch.zeros(batch, queries, dtype=torch.long).numpy(),
        "failure": torch.zeros(batch, queries).numpy(),
    }
    labels = [
        {
            "targets": target,
            "masks": {
                name: torch.ones(batch, queries, dtype=torch.bool).numpy()
                for name in target
            },
        }
    ]
    # An untrained random model is not a quality fixture. Check that a strict
    # gate rejects measurable compression changes and removes the candidate;
    # the lifecycle smoke run evaluates acceptance on actual held-out labels.
    with pytest.raises(ValueError, match="gate failed"):
        quantize_dynamic_onnx(
            tmp_path / "model.onnx",
            tmp_path / "model.int8.onnx",
            validation_inputs=[feed],
            validation_labels=labels,
            absolute_tolerance=1e-10,
        )
    assert not (tmp_path / "model.int8.onnx").exists()
    with pytest.raises(ValueError, match="labeled"):
        quantize_dynamic_onnx(
            tmp_path / "model.onnx", tmp_path / "bad.onnx", validation_inputs=[feed]
        )


def test_v1_export_keeps_nonzero_assessment_context_projection(tmp_path):
    """The exported graph must retain the newly learned assessment features."""
    torch.manual_seed(117)
    model = SchemaForecaster(
        width=16,
        heads=2,
        layers=1,
        categories=4,
        max_history=16,
        max_queries=4,
        dropout=0,
        assessment_context_version=1,
    ).eval()
    # A nonzero projection makes this a useful export regression: a dropped
    # context branch would otherwise still pass parity at zero initialization.
    with torch.no_grad():
        model.assessment_context_projection.weight.fill_(0.04)

    batch, history, queries, schemas = 1, 2, 2, 3
    inputs = (
        torch.tensor([[0.25, -0.5]]),
        torch.tensor([[0, 1]]),
        torch.tensor([[0, 0]]),
        torch.randn(batch, schemas, 16),
        torch.zeros(batch, history, dtype=torch.bool),
        torch.tensor([[0, 1]]),
        torch.zeros(batch, queries, dtype=torch.bool),
        torch.ones(batch, queries, 4, dtype=torch.bool),
        torch.zeros(batch, schemas, dtype=torch.bool),
        torch.tensor([[[[-2.0, 2.0]], [[-1.0, 1.0]]]]),
        torch.zeros(batch, queries, 42),
    )
    contextual = list(inputs)
    contextual[-1] = contextual[-1].clone()
    contextual[-1][..., 8:] = 0.5
    with torch.inference_mode():
        expected = model(*contextual)
        without_assessment = model(*inputs)
    assert any(
        not torch.allclose(expected[name], without_assessment[name])
        for name in expected
    )

    report = export_onnx(model, tuple(contextual), tmp_path / "assessment.onnx")
    assert report["parity"] == "passed"
    import onnxruntime as ort

    session = ort.InferenceSession(
        str(tmp_path / "assessment.onnx"), providers=["CPUExecutionProvider"]
    )
    feed = {name: value.numpy() for name, value in zip(INPUT_NAMES, contextual)}
    actual = session.run(None, feed)
    with torch.inference_mode():
        reference = model(*contextual)
    for candidate, name in zip(actual, ("quantiles", "categorical", "trend", "failure")):
        assert torch.allclose(
            torch.from_numpy(candidate), reference[name], atol=1e-4, rtol=1e-4
        )
