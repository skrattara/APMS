"""Seeded group-safe lifecycle utilities and immutable artifact bundle support."""

from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import time
import uuid
from pathlib import Path
from typing import Any


def _schema_files():
    from .contracts import SCHEMAS

    return {
        "grading_system_schema.json": SCHEMAS
        / "grading"
        / "grading_system_schema.json",
        "evaluation_system_schema.json": SCHEMAS
        / "evaluation"
        / "evaluation_system_schema.json",
    }


def _newline_normalized_schema(raw: bytes) -> bytes:
    """Normalize only CRLF to LF; preserve all other schema bytes exactly."""
    return raw.replace(b"\r\n", b"\n")


def seed_everything(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed)
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


def _replace_with_retry(source: Path, destination: Path, *, attempts: int = 7) -> None:
    """Retry atomic renames when Windows briefly denies access to a bundle."""
    delay = 0.02
    for attempt in range(attempts):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt + 1 == attempts:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.4)


def save_bundle(
    directory: str | Path,
    *,
    state: dict[str, Any],
    metadata: dict[str, Any],
    overwrite=False,
) -> Path:
    import torch

    dest = Path(directory)
    if dest.exists() and not overwrite:
        raise FileExistsError(f"Immutable artifact bundle already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    stage = dest.parent / (dest.name + ".stage-" + uuid.uuid4().hex)
    stage.mkdir()
    weights = stage / "weights.pt"
    torch.save(state, weights)
    meta = dict(metadata)
    meta["weights_sha256"] = hashlib.sha256(weights.read_bytes()).hexdigest()
    meta["artifact_id"] = meta["weights_sha256"]
    meta.setdefault("bundle_version", 1)
    import platform
    from importlib.metadata import PackageNotFoundError, version

    runtime = {"python": platform.python_version()}
    for dependency in ("torch", "lightning-fabric", "numpy", "jsonschema"):
        try:
            runtime[dependency] = version(dependency)
        except PackageNotFoundError:
            pass
    # Preserve the training runtime when repackaging calibration metadata.
    meta.setdefault("runtime_versions", runtime)
    schema_dir = stage / "schemas"
    schema_dir.mkdir()
    hashes = {}
    for name, source in _schema_files().items():
        raw = source.read_bytes()
        (schema_dir / name).write_bytes(raw)
        hashes[name] = hashlib.sha256(raw).hexdigest()
    meta["schema_encoding_version"] = 2
    meta["schema_sha256"] = hashes
    (stage / "metadata.json").write_text(
        json.dumps(meta, sort_keys=True, indent=2, allow_nan=False), encoding="utf-8"
    )
    backup = None
    try:
        if dest.exists():
            backup = dest.parent / (dest.name + ".backup-" + uuid.uuid4().hex)
            _replace_with_retry(dest, backup)
        # Windows scanners can briefly hold a freshly closed weights file or
        # directory while inspecting it. Both renames remain atomic; never fall
        # back to copying a partially visible bundle into place.
        _replace_with_retry(stage, dest)
        if backup is not None:
            shutil.rmtree(backup)
    except Exception:
        if backup is not None and backup.exists() and not dest.exists():
            _replace_with_retry(backup, dest)
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        raise
    return dest


def load_bundle(directory: str | Path) -> tuple[dict[str, Any], dict[str, Any]]:
    import torch

    path = Path(directory)
    meta = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    weights = (path / "weights.pt").read_bytes()
    if hashlib.sha256(weights).hexdigest() != meta.get("weights_sha256"):
        raise ValueError("Artifact digest mismatch")
    if meta.get("schema_encoding_version") != 2:
        raise ValueError("Unsupported artifact schema encoding version")
    for name, source in _schema_files().items():
        expected = meta.get("schema_sha256", {}).get(name)
        bundled = path / "schemas" / name
        if not expected or not bundled.is_file():
            raise ValueError(
                f"Artifact schema digest mismatch for {name}: expected bundled "
                f"SHA-256 {expected or '<missing>'}; the bundle is incomplete or corrupt."
            )

        # First verify the bundled bytes against the exact digest recorded when
        # the artifact was created. This remains strict even when platform
        # line endings could otherwise normalize to the same content.
        bundled_raw = bundled.read_bytes()
        bundled_digest = hashlib.sha256(bundled_raw).hexdigest()
        if bundled_digest != expected:
            raise ValueError(
                f"Artifact schema digest mismatch for {name}: expected bundled "
                f"SHA-256 {expected}, got {bundled_digest}; the bundle may be corrupt."
            )

        installed_raw = source.read_bytes()
        installed_digest = hashlib.sha256(installed_raw).hexdigest()
        if installed_digest == expected:
            continue

        # Windows commonly stores JSON schemas with CRLF while Linux wheels
        # contain the same bytes with LF. Accept only that byte-level newline
        # conversion; JSON-equivalent content or other whitespace is not enough.
        if _newline_normalized_schema(installed_raw) != _newline_normalized_schema(
            bundled_raw
        ):
            raise ValueError(
                f"Installed schema contract differs from the trained artifact for {name}: "
                f"artifact SHA-256 {expected}, installed SHA-256 {installed_digest}. "
                "Use the matching APMS AI schema package or retrain and repackage "
                "after an intentional schema change."
            )
    return torch.load(path / "weights.pt", map_location="cpu", weights_only=True), meta


def candidate_passes(
    incumbent: dict[str, float],
    candidate: dict[str, float],
    tolerances: dict[str, float],
) -> bool:
    """Metric convention: lower is better. Missing metrics fail closed."""
    import math

    if not incumbent or set(incumbent) != set(candidate):
        return False

    def finite_number(value):
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        )

    # Sparse guard labels can make RMSE or Brier unavailable. Missing evidence
    # rejects a candidate; it must never become an implicit zero-error score.
    return all(
        finite_number(candidate[k])
        and finite_number(value)
        and finite_number(tolerances.get(k, 0.0))
        and tolerances.get(k, 0.0) >= 0
        and candidate[k] <= value + tolerances.get(k, 0.0)
        for k, value in incumbent.items()
    )


def bounded_replay(
    real: list[Any],
    replay: list[Any],
    *,
    maximum: int,
    real_fraction: float = 0.7,
    seed: int = 42,
) -> list[Any]:
    if not 0 < real_fraction <= 1 or maximum < 0:
        raise ValueError("Invalid replay policy")
    if not real and replay:
        raise ValueError("Replay cannot substitute for real candidate observations")
    rng = random.Random(seed)
    real_cap = min(len(real), maximum)
    real_rows = list(real) if len(real) <= maximum else rng.sample(real, real_cap)
    total_cap = (
        min(maximum, max(real_cap, int(real_cap / real_fraction)))
        if real_fraction
        else maximum
    )
    replay_cap = max(0, total_cap - len(real_rows))
    return real_rows + rng.sample(replay, min(len(replay), replay_cap))


def finetune_optimizer(
    model, *, learning_rate: float = 1e-4, weight_decay: float = 0.01
):
    """Fresh optimizer is an explicit fine-tuning/calibration lifecycle boundary."""
    import torch

    return torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=weight_decay
    )


def make_fabric(accelerator="auto", precision="32-true"):
    try:
        from lightning_fabric import Fabric
    except ImportError as exc:
        raise RuntimeError("Install the 'ml' extra to use Fabric training") from exc
    return Fabric(accelerator=accelerator, devices=1, precision=precision)
