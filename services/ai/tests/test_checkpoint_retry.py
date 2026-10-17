from pathlib import Path

import pytest
import torch
from apms_ai import lifecycle


def _save(path: Path, value: int, *, overwrite=False):
    return lifecycle.save_bundle(
        path,
        state={"value": torch.tensor([value])},
        metadata={"purpose": "retry-test"},
        overwrite=overwrite,
    )


def test_backup_rename_retries_permission_errors_and_publishes_atomically(
    tmp_path: Path, monkeypatch
):
    bundle = tmp_path / "bundle"
    _save(bundle, 1)
    real_replace = lifecycle.os.replace
    backup_failures = 0

    def flaky_replace(source, destination):
        nonlocal backup_failures
        if ".backup-" in str(destination) and backup_failures < 2:
            backup_failures += 1
            raise PermissionError("temporary scanner lock")
        return real_replace(source, destination)

    monkeypatch.setattr(lifecycle.os, "replace", flaky_replace)
    _save(bundle, 2, overwrite=True)

    state, metadata = lifecycle.load_bundle(bundle)
    assert backup_failures == 2
    assert state["value"].item() == 2
    assert metadata["purpose"] == "retry-test"
    assert not list(tmp_path.glob("bundle.stage-*"))
    assert not list(tmp_path.glob("bundle.backup-*"))


def test_permanent_backup_rename_failure_preserves_original_and_cleans_stage(
    tmp_path: Path, monkeypatch
):
    bundle = tmp_path / "bundle"
    _save(bundle, 7)
    real_replace = lifecycle.os.replace

    def locked_backup(source, destination):
        if ".backup-" in str(destination):
            raise PermissionError("permanent scanner lock")
        return real_replace(source, destination)

    monkeypatch.setattr(lifecycle.os, "replace", locked_backup)
    with pytest.raises(PermissionError, match="permanent scanner lock"):
        _save(bundle, 9, overwrite=True)

    state, _ = lifecycle.load_bundle(bundle)
    assert state["value"].item() == 7
    assert not list(tmp_path.glob("bundle.stage-*"))
    assert not list(tmp_path.glob("bundle.backup-*"))


def test_failed_publication_retries_rollback_to_original_bundle(
    tmp_path: Path, monkeypatch
):
    bundle = tmp_path / "bundle"
    _save(bundle, 11)
    real_replace = lifecycle.os.replace
    publication_failures = 0
    rollback_failures = 0

    def flaky_publish_and_rollback(source, destination):
        nonlocal publication_failures, rollback_failures
        source_text = str(source)
        if ".stage-" in source_text and publication_failures < 7:
            publication_failures += 1
            raise PermissionError("publication locked")
        if ".backup-" in source_text and rollback_failures < 2:
            rollback_failures += 1
            raise PermissionError("rollback temporarily locked")
        return real_replace(source, destination)

    monkeypatch.setattr(lifecycle.os, "replace", flaky_publish_and_rollback)
    with pytest.raises(PermissionError, match="publication locked"):
        _save(bundle, 12, overwrite=True)

    state, _ = lifecycle.load_bundle(bundle)
    assert rollback_failures == 2
    assert state["value"].item() == 11
    assert not list(tmp_path.glob("bundle.stage-*"))
    assert not list(tmp_path.glob("bundle.backup-*"))
