from pathlib import Path

import pytest
import torch

from apms_ai import lifecycle


SCHEMA_NAMES = (
    "grading_system_schema.json",
    "evaluation_system_schema.json",
)


def _schemas(directory: Path, raw: dict[str, bytes]) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    result = {}
    for name in SCHEMA_NAMES:
        path = directory / name
        path.write_bytes(raw[name])
        result[name] = path
    return result


@pytest.mark.parametrize(
    ("bundle_ending", "installed_ending"),
    [(b"\r\n", b"\n"), (b"\n", b"\r\n")],
)
def test_schema_contract_accepts_only_crlf_lf_platform_conversion(
    tmp_path, monkeypatch, bundle_ending, installed_ending
):
    raw = {
        "grading_system_schema.json": b'{\n  "minimum": 0,\n  "maximum": 100\n}\n',
        "evaluation_system_schema.json": b'{\n  "required": ["score"]\n}\n',
    }
    bundle_schema_paths = _schemas(tmp_path / "bundle-source", {
        name: value.replace(b"\n", bundle_ending) for name, value in raw.items()
    })
    installed_schema_paths = _schemas(tmp_path / "installed", {
        name: value.replace(b"\n", installed_ending) for name, value in raw.items()
    })
    monkeypatch.setattr(lifecycle, "_schema_files", lambda: bundle_schema_paths)

    bundle = tmp_path / "artifact"
    lifecycle.save_bundle(
        bundle,
        state={"model": {"weight": torch.tensor([1.0])}},
        metadata={"fields": ["score"], "target_fields": ["score"]},
    )

    monkeypatch.setattr(lifecycle, "_schema_files", lambda: installed_schema_paths)
    state, metadata = lifecycle.load_bundle(bundle)
    assert state["model"]["weight"].tolist() == [1.0]
    assert metadata["schema_encoding_version"] == 2


def test_unchanged_schema_bytes_load_and_bundled_schema_raw_hash_stays_strict(
    tmp_path, monkeypatch
):
    raw = {
        "grading_system_schema.json": b'{"grading":{"minimum":0}}\r\n',
        "evaluation_system_schema.json": b'{"evaluation":{"required":[]}}\r\n',
    }
    schema_paths = _schemas(tmp_path / "schemas", raw)
    monkeypatch.setattr(lifecycle, "_schema_files", lambda: schema_paths)
    bundle = tmp_path / "artifact"
    lifecycle.save_bundle(
        bundle,
        state={"model": {"weight": torch.tensor([2.0])}},
        metadata={"fields": ["score"], "target_fields": ["score"]},
    )
    assert lifecycle.load_bundle(bundle)[0]["model"]["weight"].item() == 2.0

    bundled_schema = bundle / "schemas" / SCHEMA_NAMES[0]
    bundled_schema.write_bytes(raw[SCHEMA_NAMES[0]].replace(b"\r\n", b"\n"))
    with pytest.raises(ValueError, match="Artifact schema digest mismatch.*grading_system_schema"):
        lifecycle.load_bundle(bundle)


def test_actual_schema_constraint_change_rejects_with_helpful_digests(
    tmp_path, monkeypatch
):
    bundle_raw = {
        "grading_system_schema.json": b'{\n  "passing": 70\n}\n',
        "evaluation_system_schema.json": b'{\n  "required": ["score"]\n}\n',
    }
    source_paths = _schemas(tmp_path / "training-schema", bundle_raw)
    monkeypatch.setattr(lifecycle, "_schema_files", lambda: source_paths)
    bundle = tmp_path / "artifact"
    lifecycle.save_bundle(
        bundle,
        state={"model": {"weight": torch.tensor([3.0])}},
        metadata={"fields": ["score"], "target_fields": ["score"]},
    )

    changed = dict(bundle_raw)
    changed["grading_system_schema.json"] = b'{\r\n  "passing": 80\r\n}\r\n'
    installed_paths = _schemas(tmp_path / "installed-schema", changed)
    monkeypatch.setattr(lifecycle, "_schema_files", lambda: installed_paths)
    with pytest.raises(ValueError) as error:
        lifecycle.load_bundle(bundle)
    message = str(error.value)
    assert "grading_system_schema.json" in message
    assert "artifact SHA-256" in message and "installed SHA-256" in message
    assert "matching APMS AI schema package" in message
