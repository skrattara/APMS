"""Train and validate an advisory model with leakage-safe checkpoints.

``train`` learns from examples; it is separate from prediction APIs and never
fits transforms on incoming inference requests. Group splits keep a learner's
windows together so an evaluation window cannot resemble a training window
from the same learner.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import asdict
from pathlib import Path

import torch

from .contracts import Example, validate_example
from .data import RobustPreprocessor, group_split
from .encoding import token_rows
from .lifecycle import load_bundle, make_fabric, save_bundle, seed_everything
from .model import SchemaForecaster, multitask_loss


def _query_field(query, specs):
    if isinstance(query, dict):
        if isinstance(query.get("field"), str):
            return query["field"]
        candidates = [key for key in query if key in specs]
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            raise ValueError("Queries must identify one scalar field each")
    return None


def _prepare(
    examples,
    fields,
    vocab,
    preprocessing,
    device,
    *,
    model_config=None,
    input_dropout=0.0,
):
    from .encoding import history_tokens

    model_config = model_config or {}
    max_history = int(model_config.get("max_history", 512))
    max_queries = int(model_config.get("max_queries", 128))
    max_categories = int(model_config.get("categories", 16))

    encoded = []
    q_count = 1
    schema_sets = []
    for example in examples:
        kinds = {field.name: field.kind for field in example.fields}
        # Categorical IDs are local ordinals from the supplied typed schema.
        # Gateway privacy projection may consistently rename category tokens;
        # stable manifest/global vocabulary IDs would then leak token spelling
        # and disagree with the per-query legal-choice mask.
        local_vocab = dict(vocab)
        for field in example.fields:
            if field.kind == "category":
                local_vocab[field.name] = {
                    category: index + 1
                    for index, category in enumerate(field.categories)
                }
        history = history_tokens(
            example.history,
            fields,
            kinds,
            local_vocab,
            preprocessing,
            maximum=max_history,
        )
        specs = {field.name: field for field in example.fields}
        queries = list(example.queries)
        labels = list(example.labels)
        if not queries:
            target_fields = list(labels[-1]) if labels else []
            queries = [{"field": name} for name in target_fields]
        if not labels:
            labels = [{} for _ in queries]
        q_rows = []
        for index, query in enumerate(queries):
            name = _query_field(query, specs)
            if name is None or name not in fields:
                raise ValueError("Each output query must identify a declared field")
            target_row = labels[index] if index < len(labels) else {}
            value = target_row.get(name)
            spec = specs[name]
            kind = spec.kind
            choices = query.get("choices", []) if isinstance(query, dict) else []
            if choices:
                kind = "mapped"
            q_rows.append(
                (
                    fields.index(name),
                    name,
                    kind,
                    value,
                    choices,
                    target_row,
                    query,
                    spec.categories,
                )
            )
        q_count = max(q_count, len(q_rows))
        if q_count > max_queries:
            raise ValueError("Output query limit exceeded")
        schema = example.schema or {}
        schema_sets.append(
            token_rows(schema.get("gradingSystem"), schema.get("evaluationCriteria"))
        )
        encoded.append((history, q_rows))

    batch = len(examples)
    history_len = max(len(item[0][0]) for item in encoded)
    schema_len = max(map(len, schema_sets))
    values = torch.zeros(batch, history_len, device=device)
    field_ids = torch.zeros(batch, history_len, dtype=torch.long, device=device)
    kinds = torch.zeros_like(field_ids)
    history_mask = torch.ones(batch, history_len, dtype=torch.bool, device=device)
    schema_tokens = torch.zeros(batch, schema_len, 16, device=device)
    schema_mask = torch.ones(batch, schema_len, dtype=torch.bool, device=device)
    query_ids = torch.zeros(batch, q_count, dtype=torch.long, device=device)
    query_mask = torch.ones(batch, q_count, dtype=torch.bool, device=device)
    legal = torch.zeros(batch, q_count, max_categories, dtype=torch.bool, device=device)
    numeric_bounds = torch.full((batch, q_count, 1, 2), float("inf"), device=device)
    numeric_bounds[..., 0] = float("-inf")
    query_features = torch.zeros(batch, q_count, 8, device=device)
    targets = {
        "numeric": torch.zeros(batch, q_count, device=device),
        "category": torch.zeros(batch, q_count, dtype=torch.long, device=device),
        "trend": torch.zeros(batch, q_count, dtype=torch.long, device=device),
        "failure": torch.zeros(batch, q_count, device=device),
    }
    masks = {
        key: torch.zeros(batch, q_count, dtype=torch.bool, device=device)
        for key in targets
    }
    for i, ((v, f, k), q_rows) in enumerate(encoded):
        length = len(v)
        values[i, :length] = torch.tensor(v, device=device)
        field_ids[i, :length] = torch.tensor(f, device=device)
        kinds[i, :length] = torch.tensor(k, device=device)
        history_mask[i, :length] = False
        schema = schema_sets[i]
        schema_tokens[i, : len(schema)] = torch.tensor(schema, device=device)
        schema_mask[i, : len(schema)] = False
        for j, (
            field_id,
            name,
            kind,
            value,
            choices,
            label,
            query,
            categories,
        ) in enumerate(q_rows):
            query_ids[i, j] = field_id
            query_mask[i, j] = False
            spec = next(field for field in examples[i].fields if field.name == name)
            center, scale = preprocessing.get(name, [0.0, 1.0])
            scale = max(float(scale), 1e-6)
            lower = (
                query.get("minimum")
                if query.get("minimum") is not None
                else spec.minimum
            )
            upper = (
                query.get("maximum")
                if query.get("maximum") is not None
                else spec.maximum
            )
            if kind in ("float", "integer", "mapped"):
                if lower is not None:
                    numeric_bounds[i, j, 0, 0] = (float(lower) - float(center)) / scale
                if upper is not None:
                    numeric_bounds[i, j, 0, 1] = (float(upper) - float(center)) / scale
            query_features[i, j, 0] = min(
                1.0,
                __import__("math").log1p(float(query.get("horizon", 1)))
                / __import__("math").log(129.0),
            )
            query_features[i, j, 1] = {
                "float": 0.0,
                "integer": 1.0,
                "boolean": 2.0,
                "category": 3.0,
                "mapped": 4.0,
            }.get(kind, 0.0)
            query_features[i, j, 2] = float(lower is not None)
            query_features[i, j, 3] = float(upper is not None)
            if lower is not None:
                query_features[i, j, 4] = (
                    max(-10.0, min(10.0, (float(lower) - float(center)) / scale)) / 10.0
                )
            if upper is not None:
                query_features[i, j, 5] = (
                    max(-10.0, min(10.0, (float(upper) - float(center)) / scale)) / 10.0
                )
            legal_choices = choices or (
                list(categories)
                if kind == "category"
                else [False, True]
                if kind == "boolean"
                else []
            )
            if legal_choices:
                if len(legal_choices) > max_categories:
                    raise ValueError("Output query exceeds configured category limit")
                legal[i, j, : len(legal_choices)] = True
            query_features[i, j, 6] = len(legal_choices) / max_categories
            query_features[i, j, 7] = float(
                bool(
                    examples[i].schema.get("gradingSystem")
                    or examples[i].schema.get("evaluationCriteria")
                )
            )
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and kind in ("float", "integer")
            ):
                center, scale = preprocessing.get(name, [0.0, 1.0])
                targets["numeric"][i, j] = (float(value) - float(center)) / max(
                    float(scale), 1e-6
                )
                masks["numeric"][i, j] = True
            elif kind == "category" and value is not None:
                if value not in categories:
                    raise ValueError(f"Unknown target category for {name}")
                targets["category"][i, j] = list(categories).index(value)
                masks["category"][i, j] = True
            elif kind == "boolean" and isinstance(value, bool):
                targets["category"][i, j] = int(value)
                masks["category"][i, j] = True
            elif kind == "mapped" and value is not None:
                if value not in choices or len(choices) > max_categories:
                    raise ValueError(f"Target is outside allowed choices for {name}")
                targets["category"][i, j] = choices.index(value)
                masks["category"][i, j] = True
            trend = label.get("trend")
            if isinstance(trend, str):
                criteria = examples[i].schema.get("evaluationCriteria", {})
                factor = next(
                    (
                        item
                        for item in criteria.get("factors", [])
                        if item.get("source") in {"trend", "recent_trend"}
                    ),
                    {},
                )
                categories = factor.get(
                    "categories", ["improving", "stable", "declining"]
                )
                trend = categories.index(trend) if trend in categories else None
            if trend in (0, 1, 2):
                targets["trend"][i, j] = trend
                masks["trend"][i, j] = True
            failure = label.get("failure")
            if failure in (0, 1, False, True):
                targets["failure"][i, j] = float(failure)
                masks["failure"][i, j] = True
    inputs = (
        values,
        field_ids,
        kinds,
        schema_tokens,
        history_mask,
        query_ids,
        query_mask,
        legal,
        schema_mask,
        numeric_bounds,
        query_features,
    )
    if input_dropout:
        if not 0.0 <= input_dropout < 1.0:
            raise ValueError("input_dropout must be in [0, 1)")
        # Drop only observed feature tokens. Keep the token and its time/field
        # position, but expose the kind-specific missing marker to the model.
        observed_feature = (~history_mask) & (kinds < 4)
        dropped = (torch.rand_like(values) < input_dropout) & observed_feature
        inputs = list(inputs)
        values = values.masked_fill(dropped, 0.0)
        kinds = torch.where(dropped, kinds + 4, kinds)
        inputs[0] = values
        inputs[2] = kinds
        inputs = tuple(inputs)
    return inputs, targets, masks


def _distillation_loss(
    student,
    teacher,
    query_mask,
    *,
    numeric_scale=None,
    numeric_offset=None,
    numeric_mask=None,
    temperature=2.0,
):
    """Distill central numeric forecasts and task distributions on valid queries."""
    import torch.nn.functional as F

    valid = ~query_mask
    if not valid.any():
        return student["failure"].sum() * 0
    student_center = student["quantiles"][..., student["quantiles"].shape[-1] // 2]
    teacher_center = teacher["quantiles"][..., teacher["quantiles"].shape[-1] // 2]
    numeric_valid = valid if numeric_mask is None else (valid & numeric_mask)
    losses = []
    if numeric_valid.any():
        if numeric_scale is not None and numeric_offset is not None:
            if (
                numeric_scale.shape != query_mask.shape
                or numeric_offset.shape != query_mask.shape
            ):
                raise ValueError(
                    "Distillation transforms must align with batch/query dimensions"
                )
            # Preserve the output axis: [B,Q] can broadcast across learners
            # against [B,Q,1], silently mixing labels when B == Q.
            teacher_center = teacher_center * numeric_scale.unsqueeze(
                -1
            ) + numeric_offset.unsqueeze(-1)
        losses.append(
            F.smooth_l1_loss(
                student_center[numeric_valid], teacher_center[numeric_valid]
            )
        )
    temperature = float(temperature)
    for key in ("categorical", "trend"):
        student_logits = student[key][valid]
        teacher_logits = teacher[key][valid]
        width = min(student_logits.shape[-1], teacher_logits.shape[-1])
        losses.append(
            F.kl_div(
                F.log_softmax(student_logits[:, :width] / temperature, dim=-1),
                F.softmax(teacher_logits[:, :width] / temperature, dim=-1),
                reduction="batchmean",
            )
            * temperature**2
        )
    losses.append(
        F.binary_cross_entropy_with_logits(
            student["failure"][valid], torch.sigmoid(teacher["failure"][valid])
        )
    )
    return torch.stack(losses).mean()


def _selection_score(
    selection_metric, weighted_loss, numeric_squared_error_sum, numeric_label_count
):
    """Return the declared validation score without mixing raw field units."""
    if selection_metric == "weighted_loss":
        return float(weighted_loss)
    if selection_metric == "numeric_rmse":
        if numeric_label_count <= 0:
            raise ValueError(
                "numeric_rmse selection requires labeled numeric validation targets"
            )
        # _prepare normalizes each target using its train-only field scale. Pool
        # squared errors by label count before taking sqrt, so a small batch or
        # a long query list cannot receive an artificial equal weight.
        return math.sqrt(float(numeric_squared_error_sum) / int(numeric_label_count))
    raise ValueError("selection_metric must be 'weighted_loss' or 'numeric_rmse'")


def train(
    examples: list[Example],
    output: str | Path,
    *,
    seed=42,
    epochs=8,
    batch_size=16,
    width=64,
    learning_rate=1e-3,
    patience=3,
    resume: str | Path | None = None,
    accelerator="cpu",
    ratios=(0.7, 0.1, 0.1, 0.1),
    init_from: str | Path | None = None,
    real_fraction=0.7,
    max_fields=512,
    max_queries=128,
    max_history=512,
    categories=16,
    layers=2,
    heads=4,
    dropout=0.1,
    weight_decay=0.01,
    precision="32-true",
    teacher_bundle: str | Path | None = None,
    distill_weight=0.5,
    task_weights=None,
    metrics_path: str | Path | None = None,
    numeric_residual: bool | None = None,
    residual_link: str | None = None,
    numeric_center_loss_weight=None,
    input_dropout=None,
    min_delta=None,
    numeric_history_context: bool | None = None,
    numeric_center_loss_kind: str | None = None,
    selection_metric: str | None = None,
):
    if epochs < 1 or batch_size < 1:
        raise ValueError("epochs and batch size must be positive")
    for example in examples:
        # Notebook/programmatic callers receive the same ingestion guarantees
        # as CLI callers; an in-memory dataclass is not a validation boundary.
        validate_example(
            example,
            limits={
                "fields": max_fields,
                "history": max_history,
                "queries": max_queries,
            },
        )
    if not 1 <= categories <= 4096:
        raise ValueError(
            "categories must be between 1 and the operational maximum of 4096"
        )
    if not 0 < real_fraction <= 1:
        raise ValueError("real_fraction must be between zero and one")
    if not 0 <= distill_weight <= 1:
        raise ValueError("distill_weight must be between zero and one")
    task_weights = {
        "numeric": 3.0,
        "category": 1.0,
        "trend": 0.5,
        "failure": 1.0,
        **(task_weights or {}),
    }
    if (
        set(task_weights) != {"numeric", "category", "trend", "failure"}
        or any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value < 0
            for value in task_weights.values()
        )
        or not any(task_weights.values())
    ):
        raise ValueError(
            "Task weights must be finite non-negative numeric, category, trend, and failure values"
        )
    if resume and init_from:
        raise ValueError(
            "Exact resume and fine-tuning are distinct lifecycle operations"
        )
    output = Path(output)
    if output.exists():
        raise FileExistsError(
            "Final artifact bundles are immutable; choose a new output path"
        )
    metrics_file = (
        Path(metrics_path) if metrics_path else Path(str(output) + ".metrics.jsonl")
    )
    seed_everything(seed)
    # Split whole learners first. All preprocessing and optimization below use
    # only the train role; validation chooses the checkpoint, while calibration
    # and test stay untouched until their separate lifecycle stages.
    splits = group_split(examples, seed, ratios)
    if not splits["validation"]:
        raise ValueError("Group-disjoint validation partition is empty")
    real_validation = [
        example for example in splits["validation"] if example.origin == "real"
    ]
    model_selection = real_validation or splits["validation"]
    fields = list(
        dict.fromkeys(
            field.name for example in splits["train"] for field in example.fields
        )
    )
    if len(fields) > max_fields:
        raise ValueError("Schema has more than the configured field limit")
    kinds = {
        field.name: field.kind
        for example in splits["train"]
        for field in example.fields
    }
    vocab = {}
    for example in splits["train"]:
        for field in example.fields:
            if field.kind == "category":
                vocab.setdefault(field.name, {})
            if field.kind == "category":
                if len(field.categories) > categories:
                    raise ValueError(
                        "A categorical field exceeds configured supported choices"
                    )
                vocab[field.name].update(
                    {value: index + 1 for index, value in enumerate(field.categories)}
                )
    # When real train rows exist, their observed values define scale. Synthetic
    # values fill in only when there is no real training data at all.
    preprocessing_rows = [
        example for example in splits["train"] if example.origin == "real"
    ] or splits["train"]
    fitted_preprocessing = RobustPreprocessor().fit(preprocessing_rows).stats
    initial_state = initial_metadata = None
    resumed_state = resumed_metadata = None
    reset_numeric_head_after_pretraining = False
    if resume:
        resumed_state, resumed_metadata = load_bundle(resume)
        saved_config = resumed_metadata.get("model_config", {})
        saved_resume_contract = resumed_metadata.get("training", {}).get(
            "resume_contract", {}
        )
        if numeric_history_context is None:
            numeric_history_context = bool(
                saved_config.get("numeric_history_context", False)
            )
        elif bool(numeric_history_context) != bool(
            saved_config.get("numeric_history_context", False)
        ):
            raise ValueError("Resume cannot change numeric_history_context")
        if numeric_center_loss_kind is None:
            numeric_center_loss_kind = saved_resume_contract.get(
                "numeric_center_loss_kind", "smooth_l1"
            )
        if selection_metric is None:
            selection_metric = saved_resume_contract.get(
                "selection_metric", "weighted_loss"
            )
        # Older model bundles did not have residual learning. Preserve their
        # exact forward behavior when the caller leaves the mode unspecified.
        if numeric_residual is None:
            numeric_residual = bool(saved_config.get("numeric_residual", False))
        if residual_link is None:
            residual_link = saved_config.get("residual_link", "logit")
        # New regularization/loss knobs default to the old behavior for an old
        # checkpoint. Newer checkpoints restore their recorded values exactly.
        if numeric_center_loss_weight is None:
            numeric_center_loss_weight = saved_resume_contract.get(
                "numeric_center_loss_weight", 0.0
            )
        if input_dropout is None:
            input_dropout = saved_resume_contract.get("input_dropout", 0.0)
        if min_delta is None:
            min_delta = saved_resume_contract.get("min_delta", 0.0)
        saved_fields = list(resumed_metadata.get("fields", []))
        if set(saved_fields) != set(fields):
            raise ValueError("Resume field set differs from the checkpoint")
        fields = saved_fields
        kinds = dict(resumed_metadata.get("field_kinds", {}))
        vocab = dict(resumed_metadata.get("vocabulary", {}))
        preprocessing = dict(resumed_metadata.get("preprocessing", {}))
    elif init_from:
        initial_state, initial_metadata = load_bundle(init_from)
        incumbent_residual = bool(
            initial_metadata.get("model_config", {}).get("numeric_residual", False)
        )
        incumbent_residual_link = initial_metadata.get("model_config", {}).get(
            "residual_link", "logit"
        )
        is_masked_pretraining_bundle = bool(initial_metadata.get("pretraining"))
        initial_numeric_context = bool(
            initial_metadata.get("model_config", {}).get(
                "numeric_history_context", False
            )
        )
        if numeric_history_context is None:
            numeric_history_context = initial_numeric_context
        elif (
            bool(numeric_history_context) != initial_numeric_context
            and not is_masked_pretraining_bundle
        ):
            raise ValueError("Fine-tuning cannot change numeric_history_context")
        if numeric_center_loss_kind is None:
            numeric_center_loss_kind = (
                initial_metadata.get("training", {})
                .get("resume_contract", {})
                .get("numeric_center_loss_kind", "smooth_l1")
            )
        if selection_metric is None:
            selection_metric = (
                initial_metadata.get("training", {})
                .get("resume_contract", {})
                .get("selection_metric", "weighted_loss")
            )
        if numeric_residual is None:
            numeric_residual = incumbent_residual
        elif bool(numeric_residual) != incumbent_residual:
            if not is_masked_pretraining_bundle:
                raise ValueError(
                    "Fine-tuning cannot change numeric_residual because that changes head semantics"
                )
            # Masked-observation pretraining uses an absolute reconstruction
            # target. Its numeric head weights have different semantics from
            # residual forecasting, so retain the shared encoder and reset
            # only that head when crossing this explicit lifecycle boundary.
            reset_numeric_head_after_pretraining = True
        if residual_link is None and not is_masked_pretraining_bundle:
            residual_link = incumbent_residual_link
        elif residual_link is not None and residual_link != incumbent_residual_link:
            if not is_masked_pretraining_bundle:
                raise ValueError(
                    "Fine-tuning cannot change residual_link because that changes head semantics"
                )
            reset_numeric_head_after_pretraining = True
        old_fields = list(initial_metadata.get("fields", []))
        old_kinds = initial_metadata.get("field_kinds", {})
        if any(name not in fields for name in old_fields):
            raise ValueError("Fine-tuning data must retain every incumbent field")
        current_kinds = kinds
        if any(current_kinds.get(name) != old_kinds.get(name) for name in old_fields):
            raise ValueError("Fine-tuning cannot change an incumbent field type")
        fields = old_fields + [name for name in fields if name not in old_fields]
        kinds = {
            name: (old_kinds[name] if name in old_kinds else current_kinds[name])
            for name in fields
        }
        old_vocab = initial_metadata.get("vocabulary", {})
        for name, values in old_vocab.items():
            merged = dict(values)
            for value in vocab.get(name, {}):
                if value not in merged:
                    merged[value] = max(merged.values(), default=0) + 1
            if len(merged) > categories:
                raise ValueError(
                    "Fine-tuning category expansion exceeds model capacity"
                )
            vocab[name] = merged
        preprocessing = dict(fitted_preprocessing)
        for name, value in initial_metadata.get("preprocessing", {}).items():
            if name in fields:
                preprocessing[name] = value
    else:
        preprocessing = fitted_preprocessing
    if numeric_center_loss_weight is None:
        numeric_center_loss_weight = 0.25
    if input_dropout is None:
        input_dropout = 0.05
    if min_delta is None:
        min_delta = 0.0
    if numeric_residual is None:
        numeric_residual = True
    if numeric_history_context is None:
        numeric_history_context = False
    if numeric_center_loss_kind is None:
        numeric_center_loss_kind = "smooth_l1"
    if selection_metric is None:
        selection_metric = "weighted_loss"
    if numeric_center_loss_kind not in {"smooth_l1", "mse"}:
        raise ValueError("numeric_center_loss_kind must be 'smooth_l1' or 'mse'")
    if selection_metric not in {"weighted_loss", "numeric_rmse"}:
        raise ValueError("selection_metric must be 'weighted_loss' or 'numeric_rmse'")
    if residual_link is None:
        residual_link = "additive" if numeric_residual else "logit"
    if residual_link not in {"logit", "additive"}:
        raise ValueError("residual_link must be 'logit' or 'additive'")
    if numeric_center_loss_weight < 0 or not math.isfinite(numeric_center_loss_weight):
        raise ValueError("numeric_center_loss_weight must be finite and non-negative")
    if not 0.0 <= input_dropout < 1.0:
        raise ValueError("input_dropout must be in [0, 1)")
    if min_delta < 0 or not math.isfinite(min_delta):
        raise ValueError("min_delta must be finite and non-negative")
    # The numeric-history context is an optional learned reading of the
    # observed numeric sequence. False preserves the pre-context architecture.
    fabric = make_fabric(accelerator=accelerator, precision=precision)
    fabric.launch()
    model_config = {
        "width": width,
        "heads": heads,
        "layers": layers,
        "dropout": dropout,
        "max_fields": max_fields,
        "max_queries": max_queries,
        "max_history": max_history,
        "categories": categories,
        "numeric_residual": bool(numeric_residual),
        "residual_link": residual_link,
        "numeric_history_context": bool(numeric_history_context),
    }
    resume_contract = {
        "learning_rate": learning_rate,
        "weight_decay": weight_decay,
        "batch_size": batch_size,
        "precision": precision,
        "accelerator": accelerator,
        "real_fraction": real_fraction,
        "ratios": list(ratios),
        "model_config": model_config,
        "task_weights": task_weights,
        "numeric_center_loss_weight": numeric_center_loss_weight,
        "input_dropout": input_dropout,
        "min_delta": min_delta,
        "numeric_center_loss_kind": numeric_center_loss_kind,
        "selection_metric": selection_metric,
    }
    model = SchemaForecaster(**model_config)
    # AdamW updates parameters from their gradients. The learning rate sets the
    # update size; weight decay gently discourages unnecessarily large weights.
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=weight_decay
    )
    teacher_model = teacher_metadata = None
    if teacher_bundle:
        teacher_state, teacher_metadata = load_bundle(teacher_bundle)
        if any(name not in teacher_metadata.get("fields", []) for name in fields):
            raise ValueError(
                "Distillation data contains fields not supported by the teacher"
            )
        teacher_model = SchemaForecaster(**teacher_metadata["model_config"])
        teacher_model.load_state_dict(teacher_state["model"])
        teacher_model.eval()
    resume_contract.update(
        {
            "teacher_digest": teacher_metadata.get("weights_sha256")
            if teacher_metadata
            else None,
            "distill_weight": distill_weight,
        }
    )
    best = float("inf")
    # `best` is the selected criterion; this loss is the weighted task loss
    # measured at the same checkpoint, for backwards-compatible reporting.
    best_validation_loss = float("inf")
    best_state = None
    start_epoch = 0
    stale = 0
    fingerprint = hashlib.sha256(
        json.dumps(
            [asdict(x) for x in examples],
            sort_keys=True,
            separators=(",", ":"),
            default=list,
        ).encode()
    ).hexdigest()
    if resume:
        resume_state, metadata = resumed_state, resumed_metadata
        model.load_state_dict(resume_state.get("resume_model", resume_state["model"]))
        optimizer.load_state_dict(resume_state["optimizer"])
        if metadata.get("fields") != fields or metadata.get("field_kinds") != kinds:
            raise ValueError("Resume data field contract differs from the checkpoint")
        if metadata.get("training", {}).get("data_fingerprint") != fingerprint:
            raise ValueError("Resume data fingerprint differs from the checkpoint")
        if metadata.get("training", {}).get("seed") != seed:
            raise ValueError("Resume seed differs from the checkpoint")
        saved_contract = metadata.get("training", {}).get("resume_contract", {})
        # New knobs may be absent from a legacy checkpoint. Compare the exact
        # historical contract in that case while still checking old model mode.
        comparable_contract = {
            key: value
            for key, value in resume_contract.items()
            if key in saved_contract
        }
        normalized_saved = dict(saved_contract)
        if "model_config" in normalized_saved:
            normalized_model_config = dict(normalized_saved["model_config"])
            normalized_model_config.setdefault("numeric_residual", False)
            normalized_model_config.setdefault("residual_link", "logit")
            normalized_model_config.setdefault("numeric_history_context", False)
            normalized_saved["model_config"] = normalized_model_config
        if normalized_saved != comparable_contract:
            raise ValueError(
                "Resume training configuration differs from the checkpoint"
            )
        start_epoch = int(resume_state.get("epoch", 0))
        best = float(
            resume_state.get("best_selection_score", resume_state.get("best", best))
        )
        best_validation_loss = float(resume_state.get("best_validation_loss", best))
        best_state = {
            k: v.detach().cpu().clone() for k, v in resume_state["model"].items()
        }
        stale = int(resume_state.get("stale", 0))
        if "rng_loader" in resume_state:
            generator_state = resume_state["rng_loader"]
        else:
            generator_state = None
        if "rng_python" in resume_state:
            random.setstate(resume_state["rng_python"])
        if "rng_torch" in resume_state:
            # Restoring RNG state supports repeatable CPU continuation; GPU
            # kernels may still be nondeterministic on some hardware.
            torch.set_rng_state(resume_state["rng_torch"])
        if torch.cuda.is_available() and "rng_cuda" in resume_state:
            torch.cuda.set_rng_state_all(resume_state["rng_cuda"])
        if "rng_numpy" in resume_state:
            import numpy as np

            rng = resume_state["rng_numpy"]
            np.random.set_state(
                (rng[0], np.asarray(rng[1], dtype=np.uint32), rng[2], rng[3], rng[4])
            )
    elif init_from:
        pretrained_weights = initial_state.get("model", initial_state)
        if initial_metadata.get("pretraining"):
            # A masked-pretraining bundle may predate the optional numeric
            # history context modules. Keep strict checks for all shared layers
            # and allow only those three owned modules to initialize afresh.
            incompatible = model.load_state_dict(pretrained_weights, strict=False)
            context_prefixes = (
                "numeric_context_encoder.",
                "numeric_context_to_forecast.",
                "numeric_context_to_quantiles.",
            )
            disallowed_missing = [
                key
                for key in incompatible.missing_keys
                if not any(key.startswith(prefix) for prefix in context_prefixes)
            ]
            if disallowed_missing or incompatible.unexpected_keys:
                raise ValueError(
                    "Pretraining transfer state mismatch; only numeric-history context keys may be newly initialized"
                )
        else:
            model.load_state_dict(pretrained_weights)
        if reset_numeric_head_after_pretraining:
            torch.nn.init.zeros_(model.numeric.weight)
            torch.nn.init.constant_(model.numeric.bias, -2.0)
            with torch.no_grad():
                model.numeric.bias.view(model.numeric_outputs, model.quantile_count)[
                    :, model.quantile_count // 2
                ].zero_()
    model, optimizer = fabric.setup(model, optimizer)
    if teacher_model is not None:
        teacher_model.to(fabric.device)
    generator = random.Random(seed)
    if resume:
        generator.setstate(generator_state) if generator_state is not None else None
    for epoch in range(start_epoch, epochs):
        # Training mode enables dropout and input masking. These corrupt only
        # observed training features so the model does not rely on one perfect
        # pattern of evidence.
        model.train()
        train_task_totals = {key: 0.0 for key in task_weights}
        train_task_counts = {key: 0 for key in task_weights}
        real = [example for example in splits["train"] if example.origin == "real"]
        synthetic = [example for example in splits["train"] if example.origin != "real"]
        if real and synthetic and real_fraction < 1:
            # This sampler balances only the training role. It never moves or
            # mixes validation, calibration, or test learners into training.
            real_count = min(
                len(splits["train"]),
                max(1, round(len(splits["train"]) * real_fraction)),
            )
            synthetic_count = len(splits["train"]) - real_count
            order = [generator.choice(real) for _ in range(real_count)] + [
                generator.choice(synthetic) for _ in range(synthetic_count)
            ]
        else:
            order = list(real or synthetic)
        generator.shuffle(order)
        for offset in range(0, len(order), batch_size):
            batch = order[offset : offset + batch_size]
            inputs, targets, masks = _prepare(
                batch,
                fields,
                vocab,
                preprocessing,
                fabric.device,
                model_config=model_config,
                input_dropout=input_dropout,
            )
            # Clear gradients from the previous batch before calculating this
            # batch's prediction and loss.
            optimizer.zero_grad(set_to_none=True)
            # The forward pass predicts; the loss measures errors only for
            # labels that are present in the batch.
            outputs = model(*inputs)
            # Masks say which task labels actually exist in each row. The loss
            # ignores missing labels instead of treating them as zero targets.
            loss, task_losses = multitask_loss(
                outputs,
                targets,
                masks,
                weights=task_weights,
                numeric_center_loss_weight=numeric_center_loss_weight,
                numeric_center_loss_kind=numeric_center_loss_kind,
            )
            for key, value in task_losses.items():
                count = int(masks[key].sum().item())
                if count:
                    train_task_totals[key] += float(value.detach().item()) * count
                    train_task_counts[key] += count
            if teacher_model is not None and distill_weight:
                teacher_inputs, _, _ = _prepare(
                    batch,
                    teacher_metadata["fields"],
                    teacher_metadata.get("vocabulary", {}),
                    teacher_metadata.get("preprocessing", {}),
                    fabric.device,
                    model_config=teacher_metadata["model_config"],
                )
                with torch.no_grad():
                    teacher_outputs = teacher_model(*teacher_inputs)
                scale = torch.ones_like(inputs[6], dtype=torch.float32)
                offset = torch.zeros_like(scale)
                numeric_mask = torch.zeros_like(inputs[6])
                for row_index, example in enumerate(batch):
                    specs = {field.name: field for field in example.fields}
                    for query_index, query in enumerate(example.queries):
                        name = _query_field(query, specs)
                        if (
                            name is None
                            or name not in specs
                            or specs[name].kind not in {"float", "integer"}
                            or query.get("choices")
                        ):
                            continue
                        teacher_center, teacher_iqr = teacher_metadata.get(
                            "preprocessing", {}
                        ).get(name, [0.0, 1.0])
                        student_center, student_iqr = preprocessing.get(
                            name, [0.0, 1.0]
                        )
                        student_iqr = max(float(student_iqr), 1e-6)
                        scale[row_index, query_index] = float(teacher_iqr) / student_iqr
                        offset[row_index, query_index] = (
                            float(teacher_center) - float(student_center)
                        ) / student_iqr
                        numeric_mask[row_index, query_index] = True
                soft_loss = _distillation_loss(
                    outputs,
                    teacher_outputs,
                    inputs[6],
                    numeric_scale=scale,
                    numeric_offset=offset,
                    numeric_mask=numeric_mask,
                )
                loss = (1.0 - distill_weight) * loss + distill_weight * soft_loss
            if not torch.isfinite(loss):
                raise FloatingPointError("Training loss became non-finite")
            # Backward computes how each parameter should change to lower the
            # loss. Clipping caps the whole gradient vector's length, not the
            # model's predictions.
            fabric.backward(loss)
            if any(
                parameter.grad is not None and not torch.isfinite(parameter.grad).all()
                for parameter in model.parameters()
            ):
                raise FloatingPointError("Training gradient became non-finite")
            fabric.clip_gradients(model, optimizer, max_norm=1.0)
            # Apply the gradient-based parameter changes for this batch.
            optimizer.step()
        # Evaluation mode disables dropout; early stopping uses validation
        # predictions only, never training batches or calibration/test labels.
        model.eval()
        validation_task_totals = {key: 0.0 for key in task_weights}
        validation_task_counts = {key: 0 for key in task_weights}
        numeric_squared_errors = {}
        numeric_squared_error_sum = 0.0
        numeric_label_count = 0
        with torch.inference_mode():
            for offset in range(0, len(model_selection), batch_size):
                batch = model_selection[offset : offset + batch_size]
                inputs, targets, masks = _prepare(
                    batch,
                    fields,
                    vocab,
                    preprocessing,
                    fabric.device,
                    model_config=model_config,
                )
                outputs = model(*inputs)
                _, task_losses = multitask_loss(
                    outputs,
                    targets,
                    masks,
                    weights=task_weights,
                    numeric_center_loss_weight=numeric_center_loss_weight,
                    numeric_center_loss_kind=numeric_center_loss_kind,
                )
                for key, value in task_losses.items():
                    count = int(masks[key].sum().item())
                    if count:
                        validation_task_totals[key] += (
                            float(value.detach().item()) * count
                        )
                        validation_task_counts[key] += count
                center = outputs["quantiles"][..., outputs["quantiles"].shape[-1] // 2]
                # Every numeric label is compared in its train-normalized
                # units. Pooling errors this way makes RMSE usable across
                # queried fields that have different raw units or scales.
                normalized_errors = (center[..., 0] - targets["numeric"]) ** 2
                numeric_squared_error_sum += float(
                    normalized_errors[masks["numeric"]].sum().item()
                )
                numeric_label_count += int(masks["numeric"].sum().item())
                for row_index, example in enumerate(batch):
                    specs = {field.name: field for field in example.fields}
                    labels = list(example.labels) or [{} for _ in example.queries]
                    for query_index, query in enumerate(example.queries):
                        name = _query_field(query, specs)
                        if name is None or not masks["numeric"][row_index, query_index]:
                            continue
                        horizon = query.get("horizon", 1)
                        key = f"{name}|{horizon}"
                        field_center, field_scale = preprocessing.get(name, [0.0, 1.0])
                        prediction = float(
                            center[row_index, query_index, 0].item()
                        ) * max(float(field_scale), 1e-6) + float(field_center)
                        target = float(labels[query_index].get(name))
                        squared_error = (prediction - target) ** 2
                        stats = numeric_squared_errors.setdefault(
                            key,
                            {
                                "field": name,
                                "horizon": horizon,
                                "sum_squared_error": 0.0,
                                "count": 0,
                            },
                        )
                        stats["sum_squared_error"] += squared_error
                        stats["count"] += 1
        if not any(validation_task_counts.values()):
            raise ValueError("Validation has no labeled targets")
        # Validation task means are formed from all observed labels, not from
        # equally weighted batches. The stopping score is therefore invariant
        # to the chosen batch size when masks are sparse or uneven.
        weighted_validation_loss = sum(
            task_weights[key]
            * validation_task_totals[key]
            / validation_task_counts[key]
            for key in task_weights
            if validation_task_counts[key]
        )
        score = _selection_score(
            selection_metric,
            weighted_validation_loss,
            numeric_squared_error_sum,
            numeric_label_count,
        )
        metric = {
            "epoch": epoch + 1,
            "seed": seed,
            "learning_rate": learning_rate,
            "train_loss_by_task": {
                key: (
                    train_task_totals[key] / train_task_counts[key]
                    if train_task_counts[key]
                    else None
                )
                for key in task_weights
            },
            "validation_loss_by_task": {
                key: (
                    validation_task_totals[key] / validation_task_counts[key]
                    if validation_task_counts[key]
                    else None
                )
                for key in task_weights
            },
            "validation_weighted_loss": weighted_validation_loss,
            "selection_metric": selection_metric,
            "validation_selection_score": score,
            "validation_numeric_rmse_normalized_pooled": (
                math.sqrt(numeric_squared_error_sum / numeric_label_count)
                if numeric_label_count
                else None
            ),
            "validation_numeric_rmse_raw_by_field_horizon": {
                key: {
                    "field": value["field"],
                    "horizon": value["horizon"],
                    "count": value["count"],
                    "rmse": math.sqrt(value["sum_squared_error"] / value["count"]),
                    "units": "raw field units",
                }
                for key, value in numeric_squared_errors.items()
            },
        }
        metrics_file.parent.mkdir(parents=True, exist_ok=True)
        with metrics_file.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(metric, sort_keys=True, allow_nan=False) + "\n")
        if score < best - min_delta:
            best = score
            best_validation_loss = weighted_validation_loss
            # Reset the no-improvement counter after enough validation progress.
            stale = 0
            # Clone the best weights so later optimizer steps cannot mutate the
            # version selected for publication.
            best_state = {
                k: v.detach().cpu().clone() for k, v in model.state_dict().items()
            }
        else:
            # Patience counts consecutive epochs without sufficient progress.
            stale += 1
        if best_state is None:
            raise ValueError("Validation has no labeled targets")
        # The published bundle uses the best validation model. The checkpoint
        # also stores the latest model and optimizer so resume continues exactly
        # where training stopped rather than restarting from the best epoch.
        state = {
            "model": best_state,
            "resume_model": {
                k: v.detach().cpu().clone() for k, v in model.state_dict().items()
            },
            "optimizer": optimizer.state_dict(),
            "epoch": epoch + 1,
            "best": best,
            "best_selection_score": best,
            "best_validation_loss": best_validation_loss,
            "stale": stale,
            "rng_python": random.getstate(),
            "rng_torch": torch.get_rng_state(),
            "rng_cuda": torch.cuda.get_rng_state_all()
            if torch.cuda.is_available()
            else [],
            "rng_loader": generator.getstate(),
        }
        try:
            import numpy as np

            rng = np.random.get_state()
            state["rng_numpy"] = (rng[0], rng[1].tolist(), rng[2], rng[3], rng[4])
        except ImportError:
            pass
        target_fields = list(
            dict.fromkeys(
                _query_field(query, {f.name: f for f in e.fields})
                for e in splits["train"]
                for query in e.queries
            )
        )
        target_fields = [name for name in target_fields if name is not None]
        mapped_target_fields = list(
            dict.fromkeys(
                _query_field(query, {f.name: f for f in e.fields})
                for e in splits["train"]
                for query in e.queries
                if query.get("choices")
            )
        )
        mapped_target_fields = [
            name for name in mapped_target_fields if name is not None
        ]
        category_target_fields = [
            field.name
            for field in splits["train"][0].fields
            if field.kind in {"category", "boolean"}
        ]
        field_specs = {}
        for example in splits["train"]:
            for spec in example.fields:
                field_specs.setdefault(spec.name, asdict(spec))
        split_group_hashes = {
            role: sorted(
                {
                    hashlib.sha256(str(ex.group).encode()).hexdigest()
                    for ex in part
                    if ex.group is not None
                }
            )
            for role, part in splits.items()
        }
        # Persist a train-only raw-unit baseline for evaluation on later
        # independent cohorts. Fit separately per typed domain and horizon,
        # preferring real labels for each query when available.
        from .evaluation import query_identity

        baseline_rows = {}
        for example in splits["train"]:
            specs = {field.name: field for field in example.fields}
            for query_index, query in enumerate(example.queries):
                name = _query_field(query, specs)
                if (
                    name is None
                    or query.get("choices")
                    or query_index >= len(example.labels)
                ):
                    continue
                value = example.labels[query_index].get(name)
                if (
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(float(value))
                ):
                    continue
                key, field_name, horizon, domain = query_identity(example, query_index)
                source = "real" if example.origin == "real" else "synthetic"
                row = baseline_rows.setdefault(
                    key,
                    {
                        "field": field_name,
                        "horizon": horizon,
                        "domain": domain,
                        "real": [],
                        "synthetic": [],
                    },
                )
                row[source].append(float(value))
        training_baselines = {}
        for key, row in baseline_rows.items():
            selected = row["real"] or row["synthetic"]
            if selected:
                training_baselines[key] = {
                    "field": row["field"],
                    "horizon": row["horizon"],
                    "domain": row["domain"],
                    "count": len(selected),
                    "mean": sum(selected) / len(selected),
                    "source": "real_train" if row["real"] else "synthetic_train",
                }
        metadata = {
            "model_version": "schema-transformer-v1",
            "model_config": model_config,
            "task_weights": task_weights,
            "training": {
                "seed": seed,
                "epochs_completed": epoch + 1,
                "best_validation_loss": best_validation_loss,
                "best_validation_score": best,
                "selection_metric": selection_metric,
                "data_fingerprint": fingerprint,
                "split_ratios": list(ratios),
                "split_group_hashes": split_group_hashes,
                "resume_contract": resume_contract,
                "metrics_log": metrics_file.name,
                "source_counts": {
                    role: sum(ex.origin == "real" for ex in part)
                    for role, part in splits.items()
                },
            },
            "fields": fields,
            "field_kinds": kinds,
            "field_specs": field_specs,
            "target_fields": target_fields,
            "target_field": target_fields[0] if target_fields else None,
            "mapped_target_fields": mapped_target_fields,
            "category_target_fields": category_target_fields,
            "assessment_numeric_target": next(
                (
                    name
                    for name in target_fields
                    if name in {"current_standing", "predicted_standing"}
                ),
                None,
            ),
            "assessment_mapped_target": next(
                (name for name in mapped_target_fields if name == "mapped_score"), None
            ),
            "assessment_category_target": next(
                (name for name in target_fields if name == "categorical_score"), None
            ),
            "distillation": {
                "enabled": teacher_metadata is not None,
                "teacher_digest": teacher_metadata.get("weights_sha256")
                if teacher_metadata
                else None,
                "weight": distill_weight if teacher_metadata else 0.0,
            },
            "vocabulary": vocab,
            "preprocessing": preprocessing,
            "training_baselines": training_baselines,
            "inference_adapter": {"name": "apms_custom_v1", "version": 1},
            "institutionally_validated": False,
        }
        save_bundle(
            str(output) + ".checkpoint", state=state, metadata=metadata, overwrite=True
        )
        if stale >= patience:
            # Early stopping saves time after validation has stopped improving.
            break
    save_bundle(output, state=state, metadata=metadata)
    return {
        "bundle": str(output),
        "best_validation_loss": best_validation_loss,
        "best_validation_score": best,
        "selection_metric": selection_metric,
        "epochs_completed": epoch + 1,
        "splits": {key: len(value) for key, value in splits.items()},
    }
