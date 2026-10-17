import importlib.util
from pathlib import Path

import pytest
import torch
from fastapi.testclient import TestClient

from apms_ai import lifecycle, main


def test_api_key_file_loads_at_worker_startup_and_status_is_allowlisted(
    tmp_path: Path, monkeypatch
):
    key_file = tmp_path / "service-token"
    key_file.write_text("file-only-service-token\n", encoding="utf-8")
    monkeypatch.delenv("APMS_AI_SERVICE_API_KEY", raising=False)
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY_FILE", str(key_file))
    monkeypatch.delenv("APMS_MODEL_ARTIFACT_PATH", raising=False)

    with TestClient(main.app) as client:
        assert client.get("/v1/status").status_code == 401
        # Once lifespan starts, requests use the loaded key rather than
        # rereading a mutable secret file for every request.
        key_file.write_text("rotated-token", encoding="utf-8")
        response = client.get(
            "/v1/status",
            headers={"Authorization": "Bearer file-only-service-token"},
        )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "ready",
        "model_version",
        "artifact_id",
        "device",
        "artifact_source",
        "manifest_sha256",
        "synthetic_demo",
        "institutionally_validated",
        "limits",
        "capabilities",
    }
    assert body["ready"] is False
    assert body["artifact_id"] is None
    assert body["artifact_source"] == "unavailable"
    assert body["manifest_sha256"] is None
    assert body["synthetic_demo"] is True
    assert body["institutionally_validated"] is False
    assert set(body["limits"]) == {"max_request_bytes", "max_concurrent_requests"}


def test_status_has_worker_identity_but_no_artifact_paths_or_contract_data(monkeypatch):
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "status-secret")
    monkeypatch.delenv("APMS_AI_SERVICE_API_KEY_FILE", raising=False)
    monkeypatch.setattr(main.registry, "state", {"model": {}})
    monkeypatch.setattr(main.registry, "model", object())
    monkeypatch.setattr(main.registry, "version", "schema-transformer-v1:abcdef123456")
    monkeypatch.setattr(main.registry, "device", "cpu")
    monkeypatch.setattr(main.registry, "artifact_source", "supabase_storage")
    monkeypatch.setattr(main.registry, "manifest_sha256", "f" * 64)
    monkeypatch.setattr(
        main.registry,
        "metadata",
        {
            "artifact_id": "abcdef" * 10 + "abcd",
            "weights_sha256": "abcdef" * 10 + "abcd",
            "fields": ["private-feature-name"],
            "training": {"source_counts": {"train": 12}},
        },
    )
    result = main.status("Bearer status-secret")
    assert result["ready"] is True
    assert result["device"] == "cpu"
    assert result["artifact_source"] == "supabase_storage"
    assert result["manifest_sha256"] == "f" * 64
    assert result["synthetic_demo"] is False
    assert "private-feature-name" not in str(result)
    assert "weights_sha256" not in result
    assert "artifact_path" not in result
    assert "APMS_AI_ARTIFACT_ENDPOINT" not in str(result)


def test_key_environment_and_file_sources_cannot_be_combined(tmp_path, monkeypatch):
    key_file = tmp_path / "token"
    key_file.write_text("file-secret", encoding="utf-8")
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "environment-secret")
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY_FILE", str(key_file))
    with pytest.raises(ValueError, match="only one service key source"):
        main._read_service_key()


def test_prediction_response_headers_identify_the_serving_artifact_without_body_changes(
    monkeypatch,
):
    from apms_ai import inference

    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "response-secret\n")
    monkeypatch.delenv("APMS_AI_SERVICE_API_KEY_FILE", raising=False)
    monkeypatch.setattr(main, "_service_key_loaded", False)
    monkeypatch.setattr(main, "_service_key", None)
    monkeypatch.setattr(main.registry, "state", {"model": {}})
    monkeypatch.setattr(main.registry, "model", object())
    monkeypatch.setattr(main.registry, "version", "schema-transformer-v1:weightdigest")
    monkeypatch.setattr(
        main.registry,
        "metadata",
        {
            "artifact_id": "artifact-full-sha256-digest",
            "weights_sha256": "weightdigest",
            "inference_adapter": {"name": "apms_custom_v1", "version": 1},
        },
    )
    expected_body = {
        "record_id": "opaque-record",
        "predicted_standing": 72.5,
        "trend": "stable",
    }

    def fake_prediction(*args, **kwargs):
        return expected_body

    monkeypatch.setattr(inference, "predict_record", fake_prediction)
    response = TestClient(main.app).post(
        "/v1/predictions",
        json={
            "record_id": "opaque-record",
            "grading_system": {},
            "evaluation_criteria": {},
        },
        headers={"Authorization": "Bearer response-secret"},
    )

    assert response.status_code == 200
    assert response.json() == expected_body
    assert response.headers["X-APMS-Artifact-ID"] == "artifact-full-sha256-digest"
    assert response.headers["X-APMS-Model-Version"] == "schema-transformer-v1:weightdigest"
    assert response.headers["Cache-Control"] == "no-store"


def test_environment_service_key_trims_trailing_newline(monkeypatch):
    monkeypatch.setenv("APMS_AI_SERVICE_API_KEY", "secret-from-text-file\r\n")
    monkeypatch.delenv("APMS_AI_SERVICE_API_KEY_FILE", raising=False)
    assert main._read_service_key() == "secret-from-text-file"


def test_registry_uses_remote_cache_and_does_not_fallback_when_remote_fetch_fails(
    monkeypatch,
):
    from apms_ai import artifact_store, inference

    monkeypatch.setenv("APMS_AI_ARTIFACT_ENDPOINT", "https://project.supabase.co/functions/v1/artifact")
    monkeypatch.setenv("APMS_MODEL_ARTIFACT_PATH", "C:/must/not/be/used")
    monkeypatch.setenv("APMS_AI_ENABLE_SYNTHETIC_DEMO", "true")
    monkeypatch.setattr(artifact_store, "fetch_artifact_bundle", lambda: "/cache/pinned-bundle")
    loaded = []

    def load_bundle(path):
        loaded.append(path)
        return {"model": {"weight": torch.tensor([1.0])}}, {
            "fields": ["score"],
            "target_fields": ["score"],
            "training": {"source_counts": {"train": 0}},
            "weights_sha256": "a" * 64,
        }

    monkeypatch.setattr(lifecycle, "load_bundle", load_bundle)
    monkeypatch.setattr(inference, "model_from_bundle", lambda *args, **kwargs: object())
    registry = main.ModelRegistry()
    registry.load()
    assert loaded == ["/cache/pinned-bundle"]
    assert registry.available
    assert registry.metadata["weights_sha256"] == "a" * 64

    monkeypatch.setattr(
        artifact_store,
        "fetch_artifact_bundle",
        lambda: (_ for _ in ()).throw(ValueError("redacted failure")),
    )
    loaded.clear()
    failed = main.ModelRegistry()
    failed.load()
    assert loaded == []
    assert not failed.available
    assert failed.error == "ValueError"


def test_release_package_contains_only_model_weights_and_runtime_bundle_files(
    tmp_path: Path,
):
    script = Path(__file__).parents[1] / "deploy" / "package_model.py"
    spec = importlib.util.spec_from_file_location("package_model", script)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    source = tmp_path / "source"
    lifecycle.save_bundle(
        source,
        state={
            "model": {"weight": torch.tensor([1.0, 2.0])},
            "optimizer": {"state": "must not be released"},
            "rng_torch": torch.tensor([1, 2], dtype=torch.uint8),
        },
        metadata={
            "fields": ["score"],
            "target_fields": ["score"],
            "training": {
                "source_counts": {"train": 1},
                "data_fingerprint": "must-not-be-released",
                "split_group_hashes": {"train": ["hashed-learner-group"]},
            },
            "training_baselines": {"score": {"mean": 42}},
            "task_weights": {"numeric": 3},
            "distillation": {"teacher_digest": "private-lineage"},
        },
    )
    packaged = tmp_path / "release"
    module.package_model(source, packaged)

    state, metadata = lifecycle.load_bundle(packaged)
    assert set(state) == {"model"}
    assert state["model"]["weight"].tolist() == [1.0, 2.0]
    assert metadata["deployment_package"]["format"] == "inference-weights-only-v1"
    assert metadata["deployment_package"]["requires_target_runtime_smoke_test"] is True
    assert metadata["deployment_package"]["cross_version_parity_guaranteed"] is False
    assert metadata["training"] == {"source_counts": {"train": 1}}
    assert "training_baselines" not in metadata
    assert "task_weights" not in metadata and "distillation" not in metadata
    assert {path.name for path in packaged.iterdir()} == {
        "metadata.json",
        "weights.pt",
        "schemas",
    }
    manifest_path, pin = module.write_manifest(packaged)
    manifest_raw = manifest_path.read_bytes()
    import hashlib

    assert hashlib.sha256(manifest_raw).hexdigest() == pin
    manifest = __import__("json").loads(manifest_raw)
    assert manifest["format"] == "apms-inference-manifest-v1"
    assert {entry["path"] for entry in manifest["files"]} == {
        "weights.pt",
        "metadata.json",
        "schemas/grading_system_schema.json",
        "schemas/evaluation_system_schema.json",
    }
