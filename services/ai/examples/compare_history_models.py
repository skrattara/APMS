"""Reproducible architecture comparison; no student data or test-driven tuning.

Run from the repository root after installing the AI package. The four stages
are deliberately separate: generate once, train each declared model, select on
validation, then evaluate once on test and calibrate on the calibration role.
All outputs stay in the explicitly supplied workspace artifact directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_new(path, value):
    # Exclusive creation protects the experimental record from accidental
    # replacement after its outcomes become known.
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)


def score_summary(report):
    rows = [
        row
        for row in report["by_query"].values()
        if row["field"] == "current_standing" and "regression" in row
    ]
    return {
        "mean_rmse": sum(row["regression"]["rmse"] for row in rows) / len(rows),
        "mean_mae": sum(row["regression"]["mae"] for row in rows) / len(rows),
        "failure_brier": report["failure_brier"],
        "independent_groups": report["independent_group_count"],
        "score_queries": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["prepare", "train", "select", "final"])
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--name", choices=["absolute", "residual_control", "history_context"]
    )
    args = parser.parse_args()
    folder = Path(args.output)
    source = Path(__file__).resolve().parent
    if args.stage == "prepare":
        from apms_ai.contracts import validate_example
        from apms_ai.synthetic import SyntheticConfig, generate

        folder.mkdir(parents=True, exist_ok=False)
        protocol = read(source / "history-comparison.json")
        profile = read(source / protocol["dataset"]["profile"])
        profile.update(
            count=protocol["dataset"]["count"], seed=protocol["dataset"]["seed"]
        )
        examples = generate(
            profile["count"],
            profile["seed"],
            config=SyntheticConfig(**profile["config"]),
        )
        with (folder / "data.jsonl").open("x", encoding="utf-8") as stream:
            for example in examples:
                validate_example(example)
                stream.write(json.dumps(asdict(example), allow_nan=False) + "\n")
        write_new(folder / "generator.json", profile)
        write_new(folder / "protocol.json", protocol)
        write_new(
            folder / "data-digest.json",
            {
                "sha256": hashlib.sha256(
                    (folder / "data.jsonl").read_bytes()
                ).hexdigest()
            },
        )
        print(
            json.dumps(
                {
                    "windows": len(examples),
                    "groups": len({row.group for row in examples}),
                }
            )
        )
        return

    from apms_ai.data import load_jsonl
    from apms_ai.evaluation import score_bundle

    protocol = read(folder / "protocol.json")
    expected = read(folder / "data-digest.json")["sha256"]
    if hashlib.sha256((folder / "data.jsonl").read_bytes()).hexdigest() != expected:
        raise ValueError("Comparison dataset changed after protocol freeze")
    examples = load_jsonl(folder / "data.jsonl")
    if args.stage == "train":
        import apms_ai
        from apms_ai.training import train

        if args.name is None:
            parser.error("train requires --name")
        if (folder / "selection.json").exists():
            raise ValueError("Selection is frozen; start a new declared comparison")
        # Refuse comparisons where the implementation changed between runs.
        # Copies allow an archived experiment to retain the exact source even
        # if the working tree has not been committed yet.
        package = Path(apms_ai.__file__).resolve().parent
        sources = {path.name: path.read_bytes() for path in package.glob("*.py")}
        digests = {
            name: hashlib.sha256(raw).hexdigest() for name, raw in sources.items()
        }
        digest_path = folder / "source-digests.json"
        if digest_path.exists():
            if read(digest_path) != digests:
                raise ValueError("AI source changed between comparison runs")
        else:
            snapshot = folder / "source-snapshot"
            snapshot.mkdir()
            for name, raw in sources.items():
                (snapshot / name).write_bytes(raw)
            write_new(digest_path, digests)
        settings = {**protocol["training"], **protocol["models"][args.name]}
        result = train(examples, folder / args.name, **settings)
        write_new(folder / f"{args.name}-training.json", result)
        report = score_bundle(folder / args.name, examples, role="validation")
        write_new(folder / f"{args.name}-validation.json", report)
        print(json.dumps({"model": args.name, **score_summary(report)}))
    elif args.stage == "select":
        metrics = {
            name: score_summary(read(folder / f"{name}-validation.json"))
            for name in protocol["models"]
        }
        incumbent = metrics["absolute"]
        tolerance = protocol["selection"]["failure_brier_tolerance"]
        eligible = [
            name
            for name, row in metrics.items()
            if row["failure_brier"] is not None
            and row["failure_brier"] <= incumbent["failure_brier"] + tolerance
            and row["mean_mae"] <= incumbent["mean_mae"]
        ]
        selected = min(eligible, key=lambda name: metrics[name]["mean_rmse"])
        write_new(
            folder / "selection.json",
            {
                "selected": selected,
                "validation": metrics,
                "test_unopened_at_selection": True,
            },
        )
        print(
            json.dumps(
                {
                    "selected": selected,
                    "validation": {
                        name: {k: v for k, v in row.items() if k != "score_queries"}
                        for name, row in metrics.items()
                    },
                }
            )
        )
    else:
        from apms_ai.calibration import calibrate_bundle

        if (folder / "final-started.json").exists():
            raise FileExistsError(
                "Final evaluation already started; do not retune on test"
            )
        selection = read(folder / "selection.json")
        write_new(folder / "final-started.json", {"selection": selection["selected"]})
        reports = {}
        for name in dict.fromkeys(["absolute", selection["selected"]]):
            report = score_bundle(folder / name, examples, role="test")
            write_new(folder / f"{name}-test.json", report)
            reports[name] = score_summary(report)
        calibration = calibrate_bundle(
            folder / selection["selected"],
            examples,
            output=folder / "selected-calibrated",
            coverage=0.9,
        )
        report = score_bundle(folder / "selected-calibrated", examples, role="test")
        write_new(folder / "selected-calibrated-test.json", report)
        write_new(
            folder / "final-report.json",
            {
                "selection": selection,
                "test": reports,
                "calibration": calibration,
                "synthetic_only": True,
            },
        )
        print(json.dumps({"selected": selection["selected"], "test": reports}))


if __name__ == "__main__":
    main()
