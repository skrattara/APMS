import hashlib
import json
from pathlib import Path
import pytest

from apms_ai import artifact_store


def _fixture_bundle():
    contents = {
        "weights.pt": b"weights",
        "metadata.json": b'{"weights_sha256":"fixture"}',
        "schemas/grading_system_schema.json": b"grading schema",
        "schemas/evaluation_system_schema.json": b"evaluation schema",
    }
    files = [
        {
            "path": path,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "size_bytes": len(raw),
        }
        for path, raw in contents.items()
    ]
    manifest_text = json.dumps(
        {"format": artifact_store.MANIFEST_FORMAT, "files": files},
        indent=2,
    )
    manifest_pin = hashlib.sha256(manifest_text.encode()).hexdigest()
    envelope = {
        "manifest_json": manifest_text,
        "downloads": [
            {
                "path": path,
                "url": "https://project.supabase.co/storage/v1/object/sign/private/" + path,
            }
            for path in contents
        ],
    }
    return contents, files, manifest_text, manifest_pin, envelope


def test_fetch_verifies_downloads_and_reuses_rehashed_cache(tmp_path, monkeypatch):
    contents, files, manifest_text, pin, envelope = _fixture_bundle()
    calls = []
    endpoint_calls = []

    def fetch(*args):
        endpoint_calls.append(1)
        return envelope

    monkeypatch.setattr(artifact_store, "_fetch_json", fetch)

    def download(url, origin, destination, item, deadline):
        calls.append(url)
        relative = item["path"]
        destination.write_bytes(contents[relative])

    monkeypatch.setattr(artifact_store, "_download_file", download)
    cache = tmp_path / "cache"
    path = artifact_store.fetch_artifact_bundle(
        endpoint="https://project.supabase.co/functions/v1/ai-model-artifact",
        token="m" * 40,
        manifest_sha256=pin,
        cache_dir=cache,
    )
    assert len(calls) == len(files)
    assert len(endpoint_calls) == 1
    assert (path / "manifest.json").read_bytes() == manifest_text.encode("utf-8")
    assert {entry.name for entry in path.iterdir()} == {"weights.pt", "metadata.json", "schemas", "manifest.json"}

    # A cache hit still validates every byte but does not redownload files.
    monkeypatch.setattr(
        artifact_store,
        "_fetch_json",
        lambda *_args: (_ for _ in ()).throw(AssertionError("cache hit contacted broker")),
    )
    again = artifact_store.fetch_artifact_bundle(
        endpoint="https://project.supabase.co/functions/v1/ai-model-artifact",
        token="m" * 40,
        manifest_sha256=pin,
        cache_dir=cache,
    )
    assert again == path and len(calls) == len(files)

    (path / "weights.pt").write_bytes(b"corrupt")
    monkeypatch.setattr(artifact_store, "_fetch_json", fetch)
    refreshed = artifact_store.fetch_artifact_bundle(
        endpoint="https://project.supabase.co/functions/v1/ai-model-artifact",
        token="m" * 40,
        manifest_sha256=pin,
        cache_dir=cache,
    )
    assert refreshed == path and len(calls) == 2 * len(files)
    (path / "manifest.json").write_text("{}", encoding="utf-8")
    fetch_calls_before_tamper = len(endpoint_calls)
    artifact_store.fetch_artifact_bundle(
        endpoint="https://project.supabase.co/functions/v1/ai-model-artifact",
        token="m" * 40,
        manifest_sha256=pin,
        cache_dir=cache,
    )
    assert len(endpoint_calls) == fetch_calls_before_tamper + 1
    assert (path / "weights.pt").read_bytes() == contents["weights.pt"]


def test_endpoint_request_uses_machine_bearer_but_signed_url_has_no_auth(monkeypatch):
    observed = []

    class Response:
        def __init__(self):
            self.pending = b'{"manifest_json":"{}","downloads":[]}'

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read1(self, _limit):
            pending, self.pending = self.pending, b""
            return pending

        def read(self, _limit):
            raise AssertionError("streaming must use read1 when available")

    class Opener:
        def open(self, request, timeout):
            observed.append((request, timeout))
            return Response()

    monkeypatch.setattr(artifact_store, "_opener", lambda: Opener())
    artifact_store._fetch_json("https://project.supabase.co/functions/v1/x", "machine", 9999999999)
    endpoint_request = observed.pop()[0]
    assert endpoint_request.get_header("Authorization") == "Bearer machine"

    def reject_open(request, timeout):
        observed.append(request)
        from urllib.error import HTTPError

        raise HTTPError(request.full_url, 302, "redirect", {}, None)

    class RedirectOpener:
        def open(self, request, timeout):
            reject_open(request, timeout)

    monkeypatch.setattr(artifact_store, "_opener", lambda: RedirectOpener())
    destination = Path("temporary-object")
    with pytest.raises(ValueError, match="object download failed"):
        artifact_store._download_file(
            "https://project.supabase.co/storage/v1/object/sign/private/weights.pt",
            "https://project.supabase.co",
            destination,
            {"path": "weights.pt", "size_bytes": 1, "sha256": "0" * 64},
            9999999999,
        )
    signed_request = observed[-1]
    assert signed_request.get_header("Authorization") is None


def test_manifest_pin_paths_limits_and_storage_origin_fail_closed(tmp_path, monkeypatch):
    contents, _files, _text, pin, envelope = _fixture_bundle()
    monkeypatch.setattr(artifact_store, "_fetch_json", lambda *args: envelope)
    with pytest.raises(ValueError, match="manifest digest mismatch"):
        artifact_store.fetch_artifact_bundle(
            endpoint="https://project.supabase.co/functions/v1/ai-model-artifact",
            token="m" * 40,
            manifest_sha256="a" * 64,
            cache_dir=tmp_path / "badpin",
        )

    invalid = dict(envelope)
    invalid["downloads"] = [dict(item) for item in envelope["downloads"]]
    invalid["downloads"][0]["url"] = "https://attacker.example/storage/v1/object/sign/x"
    monkeypatch.setattr(artifact_store, "_fetch_json", lambda *args: invalid)
    with pytest.raises(ValueError, match="outside the configured storage origin"):
        artifact_store.fetch_artifact_bundle(
            endpoint="https://project.supabase.co/functions/v1/ai-model-artifact",
            token="m" * 40,
            manifest_sha256=pin,
            cache_dir=tmp_path / "badorigin",
        )


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://project.supabase.co/functions/v1/ai-model-artifact",
        "https://user:password@project.supabase.co/functions/v1/ai-model-artifact",
        "https://project.supabase.co/functions/v1/ai-model-artifact?token=secret",
        "https://project.supabase.co/functions/v1/ai-model-artifact#fragment",
        "https://project.supabase.co/functions/v1/other",
    ],
)
def test_endpoint_must_be_canonical_trusted_https_function_url(endpoint):
    with pytest.raises(ValueError, match="HTTPS URL"):
        artifact_store._validate_endpoint(endpoint, "machine-token")


def test_stream_download_checks_exact_size_digest_and_accepts_valid_file(tmp_path, monkeypatch):
    body = b"verified object bytes"

    class Response:
        def __init__(self):
            self.chunks = [body[:5], body[5:], b""]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read1(self, _size):
            return self.chunks.pop(0)

        def read(self, _size):
            raise AssertionError("streaming must use read1 when available")

    class Opener:
        def open(self, _request, timeout):
            return Response()

    monkeypatch.setattr(artifact_store, "_opener", lambda: Opener())
    expected = {
        "path": "weights.pt",
        "size_bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
    }
    destination = tmp_path / "weights.pt"
    artifact_store._download_file(
        "https://project.supabase.co/storage/v1/object/sign/bucket/weights.pt?token=short",
        "https://project.supabase.co",
        destination,
        expected,
        9999999999,
    )
    assert destination.read_bytes() == body

    oversized = tmp_path / "oversized.pt"
    with pytest.raises(ValueError, match="declared size"):
        artifact_store._download_file(
            "https://project.supabase.co/storage/v1/object/sign/bucket/weights.pt?token=short",
            "https://project.supabase.co",
            oversized,
            {**expected, "size_bytes": len(body) - 1},
            9999999999,
        )
    wrong_digest = tmp_path / "wrong-digest.pt"
    with pytest.raises(ValueError, match="integrity checks"):
        artifact_store._download_file(
            "https://project.supabase.co/storage/v1/object/sign/bucket/weights.pt?token=short",
            "https://project.supabase.co",
            wrong_digest,
            {**expected, "sha256": "0" * 64},
            9999999999,
        )
    with pytest.raises(ValueError, match="outside the configured storage origin"):
        artifact_store._download_file(
            "https://project.supabase.co/storage/v1/object/sign/a/%2e%2e%2fweights.pt?token=x",
            "https://project.supabase.co",
            tmp_path / "traversal.pt",
            expected,
            9999999999,
        )
