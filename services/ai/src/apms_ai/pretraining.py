"""Masked-observation reconstruction pretraining with Fabric."""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import asdict
from pathlib import Path

import torch

from .contracts import Example, validate_example
from .data import RobustPreprocessor, group_split
from .encoding import history_tokens, token_rows
from .lifecycle import make_fabric, save_bundle, seed_everything
from .model import SchemaForecaster


def pretrain(
    examples: list[Example],
    output: str | Path,
    *,
    seed=42,
    epochs=5,
    width=64,
    mask_rate=0.15,
    accelerator="cpu",
):
    if not 0 < mask_rate < 1:
        raise ValueError("mask_rate must be between 0 and 1")
    if epochs < 1:
        raise ValueError("Pretraining epochs must be positive")
    for example in examples:
        validate_example(example)
    if Path(output).exists():
        raise FileExistsError("Pretraining bundles are immutable")
    seed_everything(seed)
    splits = group_split(examples, seed)
    train_examples = splits["train"]
    fields = list(
        dict.fromkeys(field.name for ex in train_examples for field in ex.fields)
    )
    if len(fields) > 512:
        raise ValueError("More than 512 input fields are not supported")
    kinds = {f.name: f.kind for ex in train_examples for f in ex.fields}
    vocab = {}
    for ex in train_examples:
        for f in ex.fields:
            if f.kind == "category":
                vocab[f.name] = {v: i + 1 for i, v in enumerate(f.categories)}
    preprocessing_rows = [
        example for example in train_examples if example.origin == "real"
    ] or train_examples
    preprocessing = RobustPreprocessor().fit(preprocessing_rows).stats
    fabric = make_fabric(accelerator=accelerator, precision="32-true")
    fabric.launch()
    model = SchemaForecaster(width=width, heads=4, layers=2, max_fields=512)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)
    model, optimizer = fabric.setup(model, optimizer)
    rng = random.Random(seed)
    for _epoch in range(epochs):
        model.train()
        order = list(train_examples)
        rng.shuffle(order)
        for ex in order:
            local_vocab = dict(vocab)
            for field in ex.fields:
                if field.kind == "category":
                    local_vocab[field.name] = {
                        value: index + 1 for index, value in enumerate(field.categories)
                    }
            vals, ids, types = history_tokens(
                ex.history, fields, kinds, local_vocab, preprocessing
            )
            numeric_positions = [i for i, t in enumerate(types) if t in (0, 1)]
            if not numeric_positions:
                continue
            selected = [i for i in numeric_positions if rng.random() < mask_rate]
            if not selected:
                selected = [rng.choice(numeric_positions)]
            original = torch.tensor(vals, dtype=torch.float32, device=fabric.device)
            corrupted = original.clone()
            corrupted[selected] = 0.0
            corrupted_types = list(types)
            for index in selected:
                corrupted_types[index] = 4 if types[index] == 0 else 5
            query_fields = torch.tensor(
                [[ids[i] for i in selected]], dtype=torch.long, device=fabric.device
            )
            query_features = torch.zeros(
                (1, len(selected), 8), dtype=torch.float32, device=fabric.device
            )
            for query_index, token_index in enumerate(selected):
                query_features[0, query_index, 0] = token_index / max(1, len(vals) - 1)
                query_features[0, query_index, 1] = float(types[token_index])
            schema = token_rows(
                ex.schema.get("gradingSystem"), ex.schema.get("evaluationCriteria")
            )
            x = (
                corrupted.unsqueeze(0),
                torch.tensor([ids], dtype=torch.long, device=fabric.device),
                torch.tensor([corrupted_types], dtype=torch.long, device=fabric.device),
                torch.tensor([schema], dtype=torch.float32, device=fabric.device),
                torch.zeros((1, len(vals)), dtype=torch.bool, device=fabric.device),
                query_fields,
                torch.zeros_like(query_fields, dtype=torch.bool),
                None,
                None,
                None,
                query_features,
            )
            target = original[selected]
            optimizer.zero_grad(set_to_none=True)
            output_values = model(*x)["quantiles"][0, :, 0, 1]
            loss = torch.nn.functional.smooth_l1_loss(output_values, target)
            if not torch.isfinite(loss):
                raise FloatingPointError("Pretraining loss became non-finite")
            fabric.backward(loss)
            if any(
                parameter.grad is not None and not torch.isfinite(parameter.grad).all()
                for parameter in model.parameters()
            ):
                raise FloatingPointError("Pretraining gradient became non-finite")
            fabric.clip_gradients(model, optimizer, max_norm=1.0)
            optimizer.step()
    fingerprint = hashlib.sha256(
        json.dumps(
            [asdict(x) for x in examples],
            sort_keys=True,
            separators=(",", ":"),
            default=list,
        ).encode()
    ).hexdigest()
    group_hashes = {
        role: sorted(
            {
                hashlib.sha256(str(ex.group).encode()).hexdigest()
                for ex in part
                if ex.group is not None
            }
        )
        for role, part in splits.items()
    }
    metadata = {
        "model_version": "schema-transformer-pretrained-v1",
        "model_config": {
            "width": width,
            "heads": 4,
            "layers": 2,
            "max_fields": 512,
            "categories": 16,
        },
        "training": {
            "seed": seed,
            "data_fingerprint": fingerprint,
            "split_ratios": [0.7, 0.1, 0.1, 0.1],
            "split_group_hashes": group_hashes,
            "source_counts": {
                role: sum(ex.origin == "real" for ex in part)
                for role, part in splits.items()
            },
        },
        "pretraining": {
            "method": "masked_observation_reconstruction",
            "seed": seed,
            "epochs": epochs,
            "mask_rate": mask_rate,
            "train_examples": len(train_examples),
            "position_conditioning": "normalized source-token offset in query_features[0]; target numeric kind is changed to its missing-value token",
        },
        "fields": fields,
        "field_kinds": kinds,
        "vocabulary": vocab,
        "preprocessing": preprocessing,
        "institutionally_validated": False,
    }
    save_bundle(
        output,
        state={"model": {k: v.detach().cpu() for k, v in model.state_dict().items()}},
        metadata=metadata,
    )
    return {"bundle": str(output), "epochs": epochs, "examples": len(train_examples)}
