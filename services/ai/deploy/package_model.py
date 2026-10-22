"""Export only trusted inference weights and metadata into a portable bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


def package_model(source: str | Path, output: str | Path) -> Path:
    """Verify a bundle, then omit optimizer/RNG checkpoint state from release."""
    package_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(package_root / "src"))
    from apms_ai.lifecycle import load_bundle, save_bundle

    state, metadata = load_bundle(source)
    if "model" not in state or not metadata.get("fields"):
        raise ValueError("Input is not a trained inference bundle")
    destination = Path(output)
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite packaged bundle: {destination}")
    metadata = dict(metadata)
    source_training = metadata.get("training", {})
    metadata["training"] = {
        "source_counts": source_training.get("source_counts", {})
    }
    if metadata.get("assessment_context_version", 0) == 1:
        # Readiness must attest to learned assessment conditioning after
        # packaging too. Preserve this aggregate count, never learner hashes,
        # labels, optimizer state or the full training resume contract.
        assessment_count = source_training.get("assessment_query_counts", {}).get("train", 0)
        if isinstance(assessment_count, bool) or not isinstance(assessment_count, int) or assessment_count < 0:
            raise ValueError("Assessment training count must be a nonnegative integer")
        metadata["training"]["assessment_query_counts"] = {"train": assessment_count}
    # These training-only summaries and fingerprints are not used by serving
    # and could expose lineage about the dataset or a separately trained model.
    metadata.pop("training_baselines", None)
    metadata.pop("task_weights", None)
    metadata.pop("distillation", None)
    source_runtime = metadata.get("runtime_versions", {})
    metadata["deployment_package"] = {
        "format": "inference-weights-only-v1",
        "source_artifact_id": metadata.get("artifact_id"),
        "source_torch_version": source_runtime.get("torch"),
        "requires_target_runtime_smoke_test": True,
        "cross_version_parity_guaranteed": False,
    }
    save_bundle(
        destination,
        state={"model": state["model"]},
        metadata=metadata,
    )
    return destination


def write_manifest(bundle: str | Path, output: str | Path | None = None) -> tuple[Path, str]:
    """Write the exact UTF-8 manifest text and return its pinned SHA-256."""
    root = Path(bundle)
    paths = (
        "weights.pt",
        "metadata.json",
        "schemas/grading_system_schema.json",
        "schemas/evaluation_system_schema.json",
    )
    files = []
    for relative in paths:
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Packaged bundle is missing a regular file: {relative}")
        raw = path.read_bytes()
        files.append(
            {"path": relative, "sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw)}
        )
    # Keep serialization deterministic: the machine pin hashes these exact bytes.
    text = json.dumps(
        {"format": "apms-inference-manifest-v1", "files": files},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if not text:
        raise ValueError("Manifest serialization failed")
    manifest_path = Path(output) if output is not None else root / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(text, encoding="utf-8", newline="")
    return manifest_path, hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="Verified trained bundle")
    parser.add_argument("--output", required=True, help="New package directory")
    parser.add_argument(
        "--manifest",
        action="store_true",
        help="Write manifest.json in the package and print its SHA-256 pin",
    )
    args = parser.parse_args()
    packaged = package_model(args.bundle, args.output)
    print(packaged)
    if args.manifest:
        manifest_path, digest = write_manifest(packaged)
        print(f"manifest={manifest_path}")
        print(f"manifest_sha256={digest}")


if __name__ == "__main__":
    main()
