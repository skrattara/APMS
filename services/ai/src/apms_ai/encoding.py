"""Shared training and serving encoders for typed histories and schema graphs."""

from __future__ import annotations

from typing import Any

from .contracts import compile_schema_context


def token_rows(
    grading: dict[str, Any] | None, evaluation: dict[str, Any] | None
) -> list[list[float]]:
    """Schema AST v2: preserve each edge/value; scale discrete descriptors.

    Padding receives a separate attention mask in the shared batch encoder.
    A valid empty-context token prevents all-masked attention for schema-free
    development examples. No opaque ID or display/category text enters tensors.
    """
    divisors = (8.0, 4096.0, 512.0, 512.0, 1.0, 512.0, 8.0, 512.0) + (1.0,) * 8
    return [
        [value / scale for value, scale in zip(token["values"], divisors)]
        for token in compile_schema_context(grading, evaluation)
    ] or [[0.0] * 16]


def history_tokens(
    history: list[dict[str, Any]],
    fields: list[str],
    kinds: dict[str, str],
    vocab: dict[str, dict[str, int]],
    preprocessing: dict[str, Any],
    *,
    maximum: int = 512,
):
    values = []
    field_ids = []
    type_ids = []
    for record in history:
        for name in fields:
            # Omitted fields emit no token; an explicit null below emits a
            # typed missing token. Both differ from an observed numeric zero.
            if name not in record:
                continue
            value = record[name]
            kind = kinds.get(name, "float")
            if value is None:
                numeric = 0.0
                type_id = {"float": 4, "integer": 5, "boolean": 6, "category": 7}.get(
                    kind, 4
                )
            elif kind in ("float", "integer"):
                center, scale = preprocessing.get(name, [0.0, 1.0])
                numeric = (float(value) - float(center)) / max(float(scale), 1e-6)
                type_id = 0 if kind == "float" else 1
            elif kind == "boolean":
                numeric = float(bool(value))
                type_id = 2
            else:
                # Local ordinals preserve consistent per-request category
                # aliases without using their spelling as a predictive signal.
                numeric = float(vocab.get(name, {}).get(value, 0))
                type_id = 3
            values.append(numeric)
            field_ids.append(fields.index(name))
            type_ids.append(type_id)
    if not values:
        values = [0.0]
        field_ids = [0]
        type_ids = [4]
    if len(values) > maximum:
        raise ValueError("History token limit exceeded")
    return values, field_ids, type_ids
