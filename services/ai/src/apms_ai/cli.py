"""Explicit CLI for reproducible training, assessment, and deployment artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch


def _write_json(path, value):
    Path(path).write_text(
        json.dumps(value, indent=2, sort_keys=True, allow_nan=False), encoding="utf-8"
    )


def _generate(path, count, seed):
    from dataclasses import asdict

    from .synthetic import generate

    with Path(path).open("w", encoding="utf-8") as stream:
        stream.writelines(
            json.dumps(asdict(example), allow_nan=False) + "\n"
            for example in generate(count, seed)
        )


def _generate_configured(path, count, seed, config_values):
    from dataclasses import asdict

    from .synthetic import SyntheticConfig, generate

    if not isinstance(config_values, dict):
        raise TypeError("Generator config must be a JSON object")
    allowed = set(SyntheticConfig.__dataclass_fields__)
    unknown = set(config_values) - allowed
    if unknown:
        raise ValueError(f"Unknown synthetic config keys: {sorted(unknown)}")
    config = SyntheticConfig(**config_values)
    with Path(path).open("w", encoding="utf-8") as stream:
        stream.writelines(
            json.dumps(asdict(example), allow_nan=False) + "\n"
            for example in generate(count, seed, config=config)
        )


def _examples(path):
    from .data import load_json, load_jsonl

    return load_json(path) if Path(path).suffix.lower() == ".json" else load_jsonl(path)


def _pretrain(args):
    from .pretraining import pretrain

    print(
        json.dumps(
            pretrain(
                _examples(args.data),
                args.output,
                seed=args.seed,
                epochs=args.epochs,
                width=args.width,
                accelerator=args.accelerator,
            )
        )
    )


def _train(args):
    from .training import train

    print(
        json.dumps(
            train(
                _examples(args.data),
                args.output,
                seed=args.seed,
                epochs=args.epochs,
                batch_size=args.batch_size,
                width=args.width,
                learning_rate=args.learning_rate,
                patience=args.patience,
                resume=args.resume,
                init_from=args.init_from,
                accelerator=args.accelerator,
                max_fields=args.max_fields,
                max_queries=args.max_queries,
                max_history=args.max_history,
                categories=args.categories,
                layers=args.layers,
                heads=args.heads,
                dropout=args.dropout,
                weight_decay=args.weight_decay,
                precision=args.precision,
                teacher_bundle=args.teacher_bundle,
                distill_weight=args.distill_weight,
                task_weights=args.task_weights,
                metrics_path=args.metrics_path,
                real_fraction=args.real_fraction,
                min_delta=args.min_delta,
                numeric_residual=args.numeric_residual,
                residual_link=args.residual_link,
                numeric_center_loss_weight=args.numeric_center_loss_weight,
                numeric_center_loss_kind=args.numeric_center_loss_kind,
                input_dropout=args.input_dropout,
                numeric_history_context=args.numeric_history_context,
                selection_metric=args.selection_metric,
            )
        )
    )


def _tune(args):
    from .tuning import tune

    print(
        json.dumps(
            tune(
                args.data,
                args.output,
                seed=args.seed,
                trials=args.trials,
                epochs=args.epochs,
                accelerator=args.accelerator,
            )
        )
    )


def _evaluate(args):
    from .evaluation import score_bundle

    report = score_bundle(
        args.bundle,
        _examples(args.data),
        role=args.role,
        external=args.external,
    )
    _write_json(args.output, report)
    print(json.dumps(report))


def _calibrate(args):
    from .calibration import calibrate_bundle

    report = calibrate_bundle(
        args.bundle, _examples(args.data), coverage=args.coverage, output=args.output
    )
    print(json.dumps(report))


def _explain(args):
    import numpy as np

    from .data import group_split
    from .evaluation import dataset_fingerprint
    from .explain import explain_numeric
    from .lifecycle import load_bundle
    from .model import SchemaForecaster
    from .training import _prepare

    state, metadata = load_bundle(args.bundle)
    model = SchemaForecaster(**metadata["model_config"])
    model.load_state_dict(state["model"])
    model.eval()
    examples = _examples(args.data)
    if not examples:
        raise ValueError("Explanation dataset is empty")
    if dataset_fingerprint(examples) != metadata.get("training", {}).get(
        "data_fingerprint"
    ):
        raise ValueError("Explanation data must match the saved split fingerprint")
    ratios = metadata["training"].get("split_ratios", (0.7, 0.1, 0.1, 0.1))
    training_rows = group_split(examples, metadata["training"]["seed"], ratios)["train"]
    real = [example for example in training_rows if example.origin == "real"]
    if real:
        training_rows = real
    target_example = examples[-1]
    base, _, _ = _prepare(
        [target_example],
        metadata["fields"],
        metadata.get("vocabulary", {}),
        metadata.get("preprocessing", {}),
        torch.device("cpu"),
        model_config=metadata["model_config"],
    )
    specs = {field.name: field for field in target_example.fields}
    priority = [
        name for name in ("current_standing", "attendance_rate") if name in specs
    ]
    numeric_fields = [
        name for name, spec in specs.items() if spec.kind in {"float", "integer"}
    ]
    selected_fields = (
        priority + [name for name in numeric_fields if name not in priority]
    )[:2]
    history = target_example.history
    token_coordinates = []
    for row_index, row in enumerate(history):
        for name in metadata["fields"]:
            if name in row:
                token_coordinates.append((row_index, name, row[name]))
    coordinate_to_token = {
        (row_index, name): index
        for index, (row_index, name, _) in enumerate(token_coordinates)
    }
    selected = []
    for row_index in range(max(0, len(history) - 4), len(history)):
        for name in selected_fields:
            token_index = coordinate_to_token.get((row_index, name))
            if (
                token_index is not None
                and history[row_index][name] is not None
                and base[2][0, token_index].item() in (0, 1)
            ):
                selected.append((row_index - len(history), name, token_index))
    if not selected:
        raise ValueError(
            "Target record has no observed numeric history tokens to explain"
        )
    selected = selected[-8:]
    rows = []
    for example in training_rows:
        _candidate, _, _ = _prepare(
            [example],
            metadata["fields"],
            metadata.get("vocabulary", {}),
            metadata.get("preprocessing", {}),
            torch.device("cpu"),
            model_config=metadata["model_config"],
        )
        candidate_map = {}
        candidate_specs = {field.name: field for field in example.fields}
        for row_index, row in enumerate(example.history):
            for name in metadata["fields"]:
                if (
                    name in row
                    and row[name] is not None
                    and candidate_specs.get(name)
                    and candidate_specs[name].kind in {"float", "integer"}
                ):
                    candidate_map[(row_index - len(example.history), name)] = row[name]
        if all((relative, name) in candidate_map for relative, name, _ in selected):
            encoded = []
            for relative, name, _ in selected:
                center, scale = metadata.get("preprocessing", {}).get(name, [0.0, 1.0])
                encoded.append(
                    (float(candidate_map[(relative, name)]) - float(center))
                    / max(float(scale), 1e-6)
                )
            rows.append(encoded)
        if len(rows) >= 32:
            break
    if len(rows) < 2:
        raise ValueError(
            "At least two train-role records with the same typed history layout are required for SHAP"
        )
    rows = np.asarray(rows, dtype=float)
    target = np.asarray(
        [float(base[0][0, token].item()) for _, _, token in selected], dtype=float
    )
    target_name = metadata.get("target_field")
    center, scale = metadata.get("preprocessing", {}).get(target_name, [0.0, 1.0])
    query_index = next(
        (
            i
            for i, q in enumerate(target_example.queries)
            if target_name in q and isinstance(q[target_name], dict)
        ),
        0,
    )

    def predict(row):
        inputs = list(base)
        values = base[0].clone()
        for value, (_, _, token) in zip(row, selected):
            values[0, token] = float(value)
        inputs[0] = values
        with torch.inference_mode():
            quantiles = model(*inputs)["quantiles"]
            return float(
                quantiles[0, query_index, 0, quantiles.shape[-1] // 2]
            ) * float(scale) + float(center)

    result = explain_numeric(
        predict, rows, target.reshape(1, -1), max_evaluations=args.max_evaluations
    )
    result["features"] = [
        {"field": name, "relative_history_position": relative}
        for relative, name, _ in selected
    ]
    result["explained_field"] = target_name
    result["horizon"] = float(target_example.queries[query_index].get("horizon", 1))
    result["output_units"] = "raw target units"
    result["interpretation"] = (
        "Attributions describe the selected observed numeric history values for this fixed schema, query, mask, and record context; all other inputs were held fixed. They are not full-model or causal attributions."
    )
    _write_json(args.output, result)
    print(
        json.dumps(
            {
                "output": args.output,
                "feature_count": result["feature_count"],
                "interpretation": result["interpretation"],
            }
        )
    )


def _ingest_csv(args):
    from dataclasses import asdict

    from .data import load_csv

    examples = load_csv(
        args.input,
        group_column=args.group_column,
        target_column=args.target_column,
        field_columns=args.fields.split(","),
    )
    with Path(args.output).open("w", encoding="utf-8") as stream:
        stream.writelines(
            json.dumps(asdict(example), allow_nan=False) + "\n" for example in examples
        )
    print(json.dumps({"records": len(examples), "output": args.output}))


def _online(args):
    import math

    from .evaluation import score_bundle, select_partition
    from .lifecycle import bounded_replay, candidate_passes, load_bundle
    from .training import train

    if not math.isfinite(args.rmse_tolerance) or args.rmse_tolerance < 0:
        raise ValueError("rmse_tolerance must be finite and non-negative")
    new = _examples(args.new_data)
    replay = _examples(args.replay_data)
    guard = _examples(args.guard_data)
    if any(example.origin != "real" for example in new):
        raise ValueError("Online candidate observations must be marked real")
    if any(example.origin != "real" for example in guard):
        raise ValueError(
            "The held-out online guard must contain real observations only"
        )
    if any(not example.group for example in new + guard):
        raise ValueError("Online candidate and guard records require stable group keys")
    _incumbent_state, incumbent_metadata = load_bundle(args.incumbent)
    # Fail before training unless every guard group is novel relative to all
    # incumbent train, validation, calibration, and test groups.
    select_partition(guard, incumbent_metadata, "test", external=True)
    train_groups = {x.group for x in new + replay if x.group}
    guard_groups = {x.group for x in guard if x.group}
    if train_groups & guard_groups:
        raise ValueError("Candidate training and held-out guard groups overlap")
    candidate_data = bounded_replay(
        new,
        replay,
        maximum=args.max_replay,
        real_fraction=args.real_fraction,
        seed=args.seed,
    )
    candidate = train(
        candidate_data,
        args.output,
        seed=args.seed,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        accelerator=args.accelerator,
        init_from=args.incumbent,
        **incumbent_metadata["model_config"],
    )
    incumbent_metrics = score_bundle(args.incumbent, guard, external=True)
    candidate_metrics = score_bundle(candidate["bundle"], guard, external=True)
    before = {
        "standing_mae": incumbent_metrics["standing"]["mae"],
        "standing_rmse": incumbent_metrics["standing"]["rmse"],
        "failure_brier": incumbent_metrics["failure_brier"],
    }
    after = {
        "standing_mae": candidate_metrics["standing"]["mae"],
        "standing_rmse": candidate_metrics["standing"]["rmse"],
        "failure_brier": candidate_metrics["failure_brier"],
    }
    metrics_available = all(
        isinstance(value, (int, float)) and math.isfinite(value)
        for value in (*before.values(), *after.values())
    )
    accepted = metrics_available and candidate_passes(
        before,
        after,
        {
            "standing_mae": args.mae_tolerance,
            "standing_rmse": args.rmse_tolerance,
            "failure_brier": args.brier_tolerance,
        },
    )
    report = {
        "candidate_bundle": candidate["bundle"],
        "heldout_before": before,
        "heldout_after": after,
        "non_regression_passed": accepted,
        "promoted": False,
        "candidate_only": True,
        "calibration_required": True,
    }
    _write_json(args.report, report)
    print(json.dumps(report))
    if not accepted:
        raise SystemExit(2)


def _export(args):
    from .compression import INPUT_NAMES, OUTPUT_NAMES, export_onnx
    from .contracts import _schema_symbols
    from .lifecycle import load_bundle
    from .model import SchemaForecaster

    state, meta = load_bundle(args.bundle)
    config = meta["model_config"]
    model = SchemaForecaster(**config)
    model.load_state_dict(state["model"])
    model.eval()
    examples = _examples(args.data)
    example = examples[0]
    from .training import _prepare

    fields = meta["fields"]
    inputs, _, _ = _prepare(
        [example],
        fields,
        meta.get("vocabulary", {}),
        meta.get("preprocessing", {}),
        torch.device("cpu"),
        model_config=meta["model_config"],
    )
    sample = tuple(inputs)
    fixture_path = Path(args.output).with_suffix(".conformance.npz")
    metadata_path = Path(args.output).with_suffix(".metadata.json")
    if Path(args.output).exists() or fixture_path.exists() or metadata_path.exists():
        raise FileExistsError("ONNX sidecars are immutable; choose a new export path")
    report = export_onnx(model, sample, args.output)
    safe_inputs = list(sample)
    safe_inputs[0] = torch.zeros_like(safe_inputs[0])
    with torch.inference_mode():
        expected = model(*safe_inputs)
    import numpy as np

    arrays = {
        f"input_{name}": value.detach().cpu().numpy()
        for name, value in zip(INPUT_NAMES, safe_inputs)
    }
    arrays.update(
        {
            f"output_{name}": expected[name].detach().cpu().numpy()
            for name in OUTPUT_NAMES
        }
    )
    np.savez_compressed(fixture_path, **arrays)
    conformance = {
        "onnx_path": str(Path(args.output).resolve().name),
        "input_names": list(INPUT_NAMES),
        "output_names": list(OUTPUT_NAMES),
        "model_config": config,
        "schema_encoding_version": meta["schema_encoding_version"],
        "schema_sha256": meta["schema_sha256"],
        "schema_symbols": _schema_symbols(),
        "fields": meta["fields"],
        "field_kinds": meta["field_kinds"],
        "field_specs": meta.get("field_specs", {}),
        "target_fields": meta.get("target_fields", []),
        "vocabulary": meta.get("vocabulary", {}),
        "preprocessing": meta.get("preprocessing", {}),
        "calibration": meta.get("calibration", {}),
        "fixture": fixture_path.name,
        "fixture_inputs_are_centered_zero_observations": True,
        "decode": {
            "numeric_quantile_index": config.get("quantiles", 3) // 2,
            "numeric_target_field": meta.get("target_field"),
            "numeric_center_scale": meta.get("preprocessing", {}).get(
                meta.get("target_field"), [0.0, 1.0]
            ),
        },
        "institutionally_validated": False,
    }
    metadata_path.write_text(
        json.dumps(conformance, indent=2, sort_keys=True, allow_nan=False),
        encoding="utf-8",
    )
    report.update(
        {
            "conformance_fixture": str(fixture_path),
            "mobile_metadata": str(metadata_path),
        }
    )
    print(json.dumps(report))


def _quantize(args):
    from .compression import INPUT_NAMES, quantize_dynamic_onnx
    from .evaluation import select_partition
    from .lifecycle import load_bundle
    from .training import _prepare

    _, meta = load_bundle(args.bundle)
    data = select_partition(_examples(args.data), meta, "validation")
    feeds = []
    labels = []
    names = INPUT_NAMES
    for example in data:
        inputs, targets, masks = _prepare(
            [example],
            meta["fields"],
            meta.get("vocabulary", {}),
            meta.get("preprocessing", {}),
            torch.device("cpu"),
            model_config=meta["model_config"],
        )
        feeds.append({name: t.detach().cpu().numpy() for name, t in zip(names, inputs)})
        labels.append(
            {
                "targets": {k: v.detach().cpu().numpy() for k, v in targets.items()},
                "masks": {k: v.detach().cpu().numpy() for k, v in masks.items()},
            }
        )
    print(
        json.dumps(
            quantize_dynamic_onnx(
                args.onnx,
                args.output,
                validation_inputs=feeds,
                validation_labels=labels,
            )
        )
    )


def _debug(args):
    from .diagnostics import diagnose_bundle

    report = diagnose_bundle(
        args.bundle, _examples(args.data), backward_check=args.backward_check
    )
    _write_json(args.output, report)
    print(json.dumps({"output": args.output, "diagnostics": report}))


def build_parser():
    parser = argparse.ArgumentParser(
        prog="apms-ai", description="APMS advisory Transformer training and evaluation"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    gen = commands.add_parser("generate")
    gen.add_argument("--output", required=True)
    gen.add_argument("--count", type=int, default=400)
    gen.add_argument("--seed", type=int, default=42)
    gen.add_argument("--config")
    gen.set_defaults(func=lambda a: _generate(a.output, a.count, a.seed))
    ingest = commands.add_parser("ingest-csv")
    ingest.add_argument("--input", required=True)
    ingest.add_argument("--output", required=True)
    ingest.add_argument("--group-column", required=True)
    ingest.add_argument("--target-column", required=True)
    ingest.add_argument("--fields", required=True)
    ingest.set_defaults(func=_ingest_csv)
    for command in ("train", "finetune", "pretrain", "distill"):
        sub = commands.add_parser(command)
        sub.add_argument("--config")
        sub.add_argument("--data", required=True)
        sub.add_argument("--output", required=True)
        sub.add_argument("--seed", type=int, default=42)
        sub.add_argument("--epochs", type=int, default=8)
        sub.add_argument("--width", type=int, default=64)
        sub.add_argument("--accelerator", default="cpu")
        if command not in {"pretrain"}:
            sub.add_argument("--batch-size", type=int, default=16)
            sub.add_argument("--learning-rate", type=float, default=1e-3)
            sub.add_argument("--patience", type=int, default=3)
            sub.add_argument("--max-fields", type=int, default=512)
            sub.add_argument("--max-queries", type=int, default=128)
            sub.add_argument("--max-history", type=int, default=512)
            sub.add_argument("--categories", type=int, default=16)
            sub.add_argument("--layers", type=int, default=2)
            sub.add_argument("--heads", type=int, default=4)
            sub.add_argument("--dropout", type=float, default=0.1)
            sub.add_argument("--weight-decay", type=float, default=0.01)
            sub.add_argument("--precision", default="32-true")
            sub.add_argument("--task-weights", type=json.loads, default=None)
            sub.add_argument("--metrics-path")
            sub.add_argument("--real-fraction", type=float, default=0.7)
            sub.add_argument("--min-delta", type=float, default=None)
            sub.add_argument("--numeric-center-loss-weight", type=float, default=None)
            sub.add_argument(
                "--numeric-center-loss-kind", choices=("smooth_l1", "mse"), default=None
            )
            sub.add_argument("--input-dropout", type=float, default=None)
            sub.add_argument(
                "--numeric-history-context",
                action=argparse.BooleanOptionalAction,
                default=None,
            )
            sub.add_argument(
                "--selection-metric",
                choices=("weighted_loss", "numeric_rmse"),
                default=None,
            )
            sub.add_argument(
                "--numeric-residual",
                action=argparse.BooleanOptionalAction,
                default=None,
            )
            sub.add_argument(
                "--residual-link", choices=("logit", "additive"), default=None
            )
            sub.set_defaults(
                resume=None, init_from=None, teacher_bundle=None, distill_weight=0.5
            )
            if command == "train":
                sub.add_argument("--resume")
                sub.add_argument("--init-from")
            if command == "finetune":
                sub.add_argument("--init-from", required=True)
            if command == "distill":
                sub.add_argument("--teacher-bundle", required=True)
                sub.add_argument("--distill-weight", type=float, default=0.5)
            sub.set_defaults(func=_train)
        else:
            sub.set_defaults(func=_pretrain)
    tune_parser = commands.add_parser("tune")
    tune_parser.add_argument("--data", required=True)
    tune_parser.add_argument("--output", required=True)
    tune_parser.add_argument("--seed", type=int, default=42)
    tune_parser.add_argument("--trials", type=int, default=8)
    tune_parser.add_argument("--epochs", type=int, default=5)
    tune_parser.add_argument("--accelerator", default="cpu")
    tune_parser.set_defaults(func=_tune)
    for name, handler in (("evaluate", _evaluate), ("calibrate", _calibrate)):
        sub = commands.add_parser(name)
        sub.add_argument("--bundle", required=True)
        sub.add_argument("--data", required=True)
        sub.add_argument("--output", required=True)
        if name == "evaluate":
            sub.add_argument(
                "--role", choices=("validation", "calibration", "test"), default="test"
            )
            sub.add_argument("--external", action="store_true")
        else:
            sub.add_argument("--coverage", type=float, default=0.9)
        sub.set_defaults(func=handler)
    online = commands.add_parser("online-update")
    online.add_argument("--incumbent", required=True)
    online.add_argument("--new-data", required=True)
    online.add_argument("--replay-data", required=True)
    online.add_argument("--guard-data", required=True)
    online.add_argument("--output", required=True)
    online.add_argument("--report", required=True)
    online.add_argument("--max-replay", type=int, default=1000)
    online.add_argument("--real-fraction", type=float, default=0.7)
    online.add_argument("--seed", type=int, default=42)
    online.add_argument("--epochs", type=int, default=5)
    online.add_argument("--learning-rate", type=float, default=1e-4)
    online.add_argument("--mae-tolerance", type=float, default=0.0)
    online.add_argument("--rmse-tolerance", type=float, default=0.0)
    online.add_argument("--brier-tolerance", type=float, default=0.0)
    online.add_argument("--accelerator", default="cpu")
    online.set_defaults(func=_online)
    export = commands.add_parser("export-onnx")
    export.add_argument("--bundle", required=True)
    export.add_argument("--data", required=True)
    export.add_argument("--output", required=True)
    export.set_defaults(func=_export)
    quant = commands.add_parser("quantize-int8")
    quant.add_argument("--bundle", required=True)
    quant.add_argument("--onnx", required=True)
    quant.add_argument("--data", required=True)
    quant.add_argument("--output", required=True)
    quant.set_defaults(func=_quantize)
    explain = commands.add_parser("explain")
    explain.add_argument("--bundle", required=True)
    explain.add_argument("--data", required=True)
    explain.add_argument("--output", required=True)
    explain.add_argument("--max-evaluations", type=int, default=128)
    explain.set_defaults(func=_explain)
    debug = commands.add_parser("debug")
    debug.add_argument("--bundle", required=True)
    debug.add_argument("--data", required=True)
    debug.add_argument("--output", required=True)
    debug.add_argument("--backward-check", action="store_true")
    debug.set_defaults(func=_debug)
    return parser


def main():
    args = build_parser().parse_args()
    if getattr(args, "config", None):
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ValueError("Config must be a JSON object")
        if args.command == "generate":
            generator_config = config.pop("config", {})
            count = config.pop("count", args.count)
            seed = config.pop("seed", args.seed)
            if config:
                raise ValueError(f"Unknown generator config keys: {sorted(config)}")
            _generate_configured(args.output, count, seed, generator_config)
            return
        unknown = set(config) - set(vars(args))
        if unknown:
            raise ValueError(f"Unknown config keys: {sorted(unknown)}")
        for key, value in config.items():
            if key not in {"config", "func"}:
                setattr(args, key, value)
    args.func(args)


if __name__ == "__main__":
    main()
