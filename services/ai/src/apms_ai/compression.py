"""Portable tensor export and measured compression, with fail-closed gates."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import numpy as np
import torch

INPUT_NAMES = (
    "values",
    "field_ids",
    "kinds",
    "schema_tokens",
    "history_mask",
    "query_ids",
    "query_mask",
    "legal_category_mask",
    "schema_mask",
    "numeric_bounds",
    "query_features",
)
OUTPUT_NAMES = ("quantiles", "categorical", "trend", "failure")


def distillation_loss(student_logits, teacher_logits, temperature=2.0):
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("Distillation temperature must be finite and positive")
    return (
        torch.nn.functional.kl_div(
            torch.nn.functional.log_softmax(student_logits / temperature, dim=-1),
            torch.nn.functional.softmax(teacher_logits.detach() / temperature, dim=-1),
            reduction="batchmean",
        )
        * temperature**2
    )


class _ExportCore(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, *inputs):
        outputs = self.model(*inputs)
        return tuple(outputs[name] for name in OUTPUT_NAMES)


class _PortableAttention(torch.nn.MultiheadAttention):
    """Same trained weights with explicit dynamic Q/K/V tensor operations.

    The legacy PyTorch MHA exporter captures some reshape sequence lengths as
    constants. This export-only decomposition avoids those captured lengths;
    its agreement with the ordinary training module is checked below.
    """

    def forward(
        self,
        query,
        key,
        value,
        key_padding_mask=None,
        need_weights=True,
        attn_mask=None,
        average_attn_weights=True,
        is_causal=False,
    ):
        if (
            not self.batch_first
            or not self._qkv_same_embed_dim
            or is_causal
            or attn_mask is not None
        ):
            raise ValueError(
                "Portable attention requires batch-first noncausal model attention"
            )
        weights = self.in_proj_weight.chunk(3, dim=0)
        biases = (
            self.in_proj_bias.chunk(3, dim=0)
            if self.in_proj_bias is not None
            else (None,) * 3
        )
        projected = []
        for tensor, weight, bias in zip((query, key, value), weights, biases):
            tensor = torch.nn.functional.linear(tensor, weight, bias)
            projected.append(
                tensor.reshape(
                    tensor.shape[0], tensor.shape[1], self.num_heads, self.head_dim
                ).transpose(1, 2)
            )
        q, k, v = projected
        logits = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        if key_padding_mask is not None:
            mask = key_padding_mask[:, None, None, :]
            if mask.dtype == torch.bool:
                logits = logits.masked_fill(mask, float("-inf"))
            else:
                logits = logits + mask
        attention = torch.softmax(logits, dim=-1)
        attended = torch.matmul(attention, v).transpose(1, 2)
        attended = attended.reshape(query.shape[0], query.shape[1], self.embed_dim)
        return self.out_proj(attended), attention.mean(1) if need_weights else None


def _resize(inputs, history, queries, schemas, batch):
    """Create genuinely different shapes for export conformance checks."""
    history_columns = {"values", "field_ids", "kinds", "history_mask"}
    schema_columns = {"schema_tokens", "schema_mask"}
    result = []
    for name, value in zip(INPUT_NAMES, inputs):
        length = (
            history
            if name in history_columns
            else schemas
            if name in schema_columns
            else queries
        )
        index = torch.arange(length, device=value.device) % value.shape[1]
        candidate = value.index_select(1, index)
        batch_index = torch.arange(batch, device=value.device) % candidate.shape[0]
        candidate = candidate.index_select(0, batch_index)
        if name in {"history_mask", "query_mask", "schema_mask"}:
            candidate = torch.zeros_like(candidate)
        result.append(candidate)
    return tuple(result)


def export_onnx(model, example_inputs, output: str | Path, *, tolerance=1e-4):
    """Export masks/constraints and verify batch/history/query/schema axes.

    Select the legacy exporter explicitly for its stable standard attention
    operator decomposition. Disable inference fusion temporarily to avoid
    proprietary fused attention operators. Python input validation remains
    part of the portable preprocessing contract, outside the tensor graph.
    """
    import onnx
    import onnxruntime as ort

    if len(example_inputs) != len(INPUT_NAMES):
        raise ValueError(
            "ONNX export requires all eleven tensors, including query descriptors, constraints and masks"
        )
    path = Path(output)
    if path.exists():
        raise FileExistsError("Export artifacts are immutable; select a new path")
    path.parent.mkdir(parents=True, exist_ok=True)
    model = model.cpu().eval()
    inputs = tuple(value.detach().cpu() for value in example_inputs)
    portable = copy.deepcopy(model)
    for module in portable.modules():
        if isinstance(module, torch.nn.MultiheadAttention):
            module.__class__ = _PortableAttention
    core = _ExportCore(portable).eval()
    dynamic = {}
    for name in INPUT_NAMES:
        axis = (
            "history"
            if name in {"values", "field_ids", "kinds", "history_mask"}
            else "schema"
            if name in {"schema_tokens", "schema_mask"}
            else "queries"
        )
        dynamic[name] = {0: "batch", 1: axis}
    dynamic.update({name: {0: "batch", 1: "queries"} for name in OUTPUT_NAMES})
    fastpath = torch.backends.mha.get_fastpath_enabled()
    cases = []
    try:
        torch.backends.mha.set_fastpath_enabled(False)
        with torch.inference_mode():
            original = model(*inputs)
            decomposed = core(*inputs)
            if any(
                not torch.allclose(
                    original[name], value, atol=tolerance, rtol=tolerance
                )
                for name, value in zip(OUTPUT_NAMES, decomposed)
            ):
                raise ValueError(
                    "Portable attention differs from the trained PyTorch model"
                )
        with torch.inference_mode():
            torch.onnx.export(
                core,
                inputs,
                str(path),
                input_names=list(INPUT_NAMES),
                output_names=list(OUTPUT_NAMES),
                dynamic_axes=dynamic,
                opset_version=17,
                dynamo=False,
            )
        onnx.checker.check_model(onnx.load(str(path)))
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        if {item.name for item in session.get_inputs()} != set(INPUT_NAMES):
            raise ValueError("Export dropped a required constraint or padding input")
        variants = [inputs]
        variants += [
            _resize(inputs, h, q, s, b)
            for h, q, s, b in (
                (1, 1, 1, 1),
                (3, 2, 2, 2),
                (inputs[0].shape[1] + 1, 3, 3, 1),
            )
            if h <= model.max_history and q <= model.max_queries
        ]
        for args in variants:
            with torch.inference_mode():
                expected = core(*args)
            feed = {name: value.numpy() for name, value in zip(INPUT_NAMES, args)}
            actual = session.run(list(OUTPUT_NAMES), feed)
            for reference, candidate in zip(expected, actual):
                if not np.isfinite(candidate).all() or not np.allclose(
                    reference.numpy(), candidate, atol=tolerance, rtol=tolerance
                ):
                    raise ValueError("ONNX dynamic-shape parity check failed")
            cases.append(
                {
                    "batch": args[0].shape[0],
                    "history": args[0].shape[1],
                    "queries": args[5].shape[1],
                    "schema": args[3].shape[1],
                }
            )
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        torch.backends.mha.set_fastpath_enabled(fastpath)
    report = {
        "path": str(path),
        "inputs": list(INPUT_NAMES),
        "outputs": list(OUTPUT_NAMES),
        "dynamic_axes": dynamic,
        "parity": "passed",
        "cases": cases,
        "maximum_absolute_tolerance": tolerance,
    }
    path.with_suffix(".contract.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    return report


def _quality_metrics(outputs, labels):
    numeric_squared_errors = []
    errors = {
        "numeric_mae": [],
        "category_error": [],
        "trend_error": [],
        "failure_brier": [],
    }
    for values, label in zip(outputs, labels):
        raw = dict(zip(OUTPUT_NAMES, values))
        targets, masks = label["targets"], label["masks"]
        for task in ("numeric", "category", "trend", "failure"):
            mask = np.asarray(masks[task], dtype=bool)
            if not mask.any():
                continue
            target = np.asarray(targets[task])
            if task == "numeric":
                prediction = raw["quantiles"][..., 0, raw["quantiles"].shape[-1] // 2]
                if target.ndim == prediction.ndim + 1:
                    target = target[..., 0]
                residual = prediction[mask] - target[mask]
                errors["numeric_mae"].extend(np.abs(residual).tolist())
                numeric_squared_errors.extend(np.square(residual).tolist())
            elif task in {"category", "trend"}:
                prediction = raw[
                    "categorical" if task == "category" else "trend"
                ].argmax(-1)
                errors[f"{task}_error"].extend(
                    (prediction[mask] != target[mask]).astype(float).tolist()
                )
            else:
                probability = 1 / (1 + np.exp(-np.clip(raw["failure"], -80, 80)))
                errors["failure_brier"].extend(
                    ((probability[mask] - target[mask]) ** 2).tolist()
                )
    report = {key: float(np.mean(values)) for key, values in errors.items() if values}
    if numeric_squared_errors:
        # Pool squared residuals across observed labels before the square root;
        # averaging per-batch RMSE would overweight small/partially labeled batches.
        report["numeric_rmse"] = math.sqrt(float(np.mean(numeric_squared_errors)))
    return report


def quantize_dynamic_onnx(
    source: str | Path,
    destination: str | Path,
    *,
    validation_inputs=None,
    validation_labels=None,
    absolute_tolerance=0.15,
    quality_tolerance=0.02,
):
    """Check tensor parity AND labeled task degradation before publishing INT8.

    MAE uses persisted normalized target units; classification error and Brier
    are dimensionless. The caller supplies disjoint held-out validation data.
    These checks establish compression quality relative to the original model,
    not the suitability of either model for actual academic decisions.
    """
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic

    if (
        not validation_inputs
        or not validation_labels
        or len(validation_inputs) != len(validation_labels)
    ):
        raise ValueError(
            "INT8 acceptance requires aligned held-out inputs and labeled target masks"
        )
    if any(
        not math.isfinite(x) or x < 0 for x in (absolute_tolerance, quality_tolerance)
    ):
        raise ValueError("Compression tolerances must be finite and nonnegative")
    source, destination = Path(source), Path(destination)
    if destination.exists():
        raise FileExistsError("Quantized artifacts are immutable; select a new path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    original, compressed, maximum_error = [], [], 0.0
    try:
        # Quantize weight MatMuls; retain portable floating-point attention
        # activations instead of relying on device-specific integer kernels.
        graph = onnx.load(str(source))
        # Preserve attention projections and small constrained output heads in
        # FP32. Quantizing the larger feed-forward matrices gives a useful size
        # reduction with substantially less sensitivity to rare input outliers.
        quantized_nodes = [
            node.name
            for node in graph.graph.node
            if node.op_type == "MatMul"
            and any(
                part in node.name for part in ("/linear1/", "/linear2/", "/cross_ff/")
            )
        ]
        if not quantized_nodes:
            raise ValueError(
                "No eligible feed-forward matrices were found for compression"
            )
        quantize_dynamic(
            str(source),
            str(destination),
            weight_type=QuantType.QInt8,
            op_types_to_quantize=["MatMul"],
            per_channel=True,
            nodes_to_quantize=quantized_nodes,
            extra_options={"MatMulConstBOnly": True, "WeightSymmetric": True},
        )
        source_session = ort.InferenceSession(
            str(source), providers=["CPUExecutionProvider"]
        )
        candidate_session = ort.InferenceSession(
            str(destination), providers=["CPUExecutionProvider"]
        )
        for feed, label in zip(validation_inputs, validation_labels):
            expected = source_session.run(list(OUTPUT_NAMES), feed)
            actual = candidate_session.run(list(OUTPUT_NAMES), feed)
            for name, baseline, candidate in zip(OUTPUT_NAMES, expected, actual):
                task = {
                    "quantiles": "numeric",
                    "categorical": "category",
                    "trend": "trend",
                    "failure": "failure",
                }[name]
                observed = np.asarray(label["masks"][task], dtype=bool)
                if not observed.any():
                    continue
                # A typed query uses only its corresponding head. Comparing
                # unused numeric outputs for a categorical query is not a
                # deployment parity criterion. For classification compare
                # probabilities, which are invariant to a logit offset.
                baseline, candidate = baseline[observed], candidate[observed]
                if name in {"categorical", "trend"}:

                    def probabilities(value):
                        exponent = np.exp(value - value.max(-1, keepdims=True))
                        return exponent / exponent.sum(-1, keepdims=True)

                    baseline, candidate = (
                        probabilities(baseline),
                        probabilities(candidate),
                    )
                elif name == "failure":
                    baseline = 1 / (1 + np.exp(-np.clip(baseline, -80, 80)))
                    candidate = 1 / (1 + np.exp(-np.clip(candidate, -80, 80)))
                maximum_error = max(
                    maximum_error, float(np.max(np.abs(baseline - candidate)))
                )
                if not np.isfinite(candidate).all() or not np.allclose(
                    baseline,
                    candidate,
                    atol=absolute_tolerance,
                    rtol=absolute_tolerance,
                ):
                    raise ValueError(
                        f"INT8 held-out tensor parity gate failed for {name}; maximum error {maximum_error:.6g}"
                    )
            original.append(expected)
            compressed.append(actual)
        before, after = (
            _quality_metrics(original, validation_labels),
            _quality_metrics(compressed, validation_labels),
        )
        if not before or set(before) != set(after):
            raise ValueError("INT8 quality gate has no usable labeled validation tasks")
        if any(
            not math.isfinite(after[key]) or after[key] > value + quality_tolerance
            for key, value in before.items()
        ):
            raise ValueError("INT8 held-out task quality gate failed")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    report = {
        "path": str(destination),
        "validation_examples": len(validation_inputs),
        "gate": "passed",
        "original_metrics": before,
        "int8_metrics": after,
        "maximum_tensor_error": maximum_error,
        "quality_tolerance": quality_tolerance,
        "numeric_metric_units": "training-normalized target units",
        "quantized_matrices": len(quantized_nodes),
        "original_bytes": source.stat().st_size,
        "int8_bytes": destination.stat().st_size,
        "device_validation": "CPU ONNX Runtime; mobile hardware not measured",
    }
    destination.with_suffix(".quantization.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    return report
