"""Seeded Optuna hyperparameter search over group-disjoint validation only."""

from __future__ import annotations

import json
from pathlib import Path

from .data import load_json, load_jsonl
from .training import train


def tune(data_path, output, *, seed=42, trials=8, epochs=5, accelerator="cpu"):
    try:
        import optuna
    except ImportError as exc:
        raise RuntimeError("Install the 'ml' extra to tune with Optuna") from exc
    path = Path(data_path)
    examples = load_json(path) if path.suffix.lower() == ".json" else load_jsonl(path)
    if trials < 1 or epochs < 1:
        raise ValueError("Tuning requires at least one trial and one epoch")
    root = Path(output)
    if root.exists():
        raise FileExistsError("Tuning output path already exists")
    root.mkdir(parents=True)
    study = optuna.create_study(
        direction="minimize", sampler=optuna.samplers.TPESampler(seed=seed)
    )

    def objective(trial):
        trial_path = root / f"trial-{trial.number}"
        width = trial.suggest_categorical("width", [32, 64, 96])
        learning_rate = trial.suggest_float("learning_rate", 1e-4, 3e-3, log=True)
        result = train(
            examples,
            trial_path,
            seed=seed,
            epochs=epochs,
            width=width,
            learning_rate=learning_rate,
            accelerator=accelerator,
        )
        return float(result["best_validation_loss"])

    study.optimize(objective, n_trials=trials)
    audit = {
        "seed": seed,
        "requested_trials": trials,
        "completed_trials": len(study.trials),
        "best_value": study.best_value,
        "best_params": study.best_params,
        "trials": [
            {
                "number": trial.number,
                "state": trial.state.name,
                "value": trial.value,
                "params": trial.params,
            }
            for trial in study.trials
        ],
    }
    audit_path = root / "study.json"
    temp_path = root / "study.json.tmp"
    temp_path.write_text(
        json.dumps(audit, indent=2, sort_keys=True, allow_nan=False), encoding="utf-8"
    )
    temp_path.replace(audit_path)
    best = root / "selected-model"
    train(
        examples,
        best,
        seed=seed,
        epochs=epochs,
        width=study.best_params["width"],
        learning_rate=study.best_params["learning_rate"],
        accelerator=accelerator,
    )
    return {
        "bundle": str(best),
        "best_value": study.best_value,
        "best_params": study.best_params,
        "trials": len(study.trials),
        "audit": str(audit_path),
    }
