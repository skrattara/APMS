"""Fetch and verify a pinned inference bundle from a private artifact endpoint.

The endpoint supplies only a small manifest and short-lived signed download URLs.
The machine token is sent to the endpoint, never to object-storage URLs.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_ENVELOPE_BYTES = 256 * 1024
REQUEST_TIMEOUT_SECONDS = 30
TOTAL_DEADLINE_SECONDS = 120
# A single socket read can remain blocked up to the configured request timeout
# after the aggregate deadline. read1 limits that overrun to one socket read.
MAX_NETWORK_WALL_SECONDS = TOTAL_DEADLINE_SECONDS + REQUEST_TIMEOUT_SECONDS
MANIFEST_FORMAT = "apms-inference-manifest-v1"
REQUIRED_FILES = {
    "weights.pt",
    "metadata.json",
    "schemas/grading_system_schema.json",
    "schemas/evaluation_system_schema.json",
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Signed object URLs must not redirect credentials or content elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _opener():
    return urllib.request.build_opener(_NoRedirect)


def _read_chunk(response, maximum_bytes: int) -> bytes:
    """Read at most one underlying socket chunk where HTTPResponse supports it."""
    read_once = getattr(response, "read1", None)
    if callable(read_once):
        return read_once(maximum_bytes)
    # Lightweight test doubles may expose only read(); the real urllib response
    # implements read1(), which avoids blocking while buffering many recv calls.
    return response.read(maximum_bytes)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _is_junction(path: Path) -> bool:
    """Windows junctions behave like directory symlinks for cache trust."""
    checker = getattr(path, "is_junction", None)
    return bool(checker and checker())


def _safe_relative_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Invalid artifact manifest path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Invalid artifact manifest path")
    normalized = path.as_posix()
    if normalized != value:
        raise ValueError("Artifact manifest paths must use canonical separators")
    if normalized not in REQUIRED_FILES:
        raise ValueError("Artifact manifest contains an unsupported path")
    return normalized


def _parse_manifest(raw: bytes, expected_digest: str) -> tuple[dict[str, Any], str]:
    if len(raw) > 64 * 1024:
        raise ValueError("Artifact manifest is too large")
    expected_digest = expected_digest.strip().lower()
    if not _SHA256.fullmatch(expected_digest):
        raise ValueError("A pinned 64-character manifest SHA-256 is required")
    actual_digest = _sha256(raw)
    if actual_digest != expected_digest:
        raise ValueError("Artifact manifest digest mismatch")
    try:
        text = raw.decode("utf-8", errors="strict")
        manifest = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Artifact manifest is not valid UTF-8 JSON") from error
    if not isinstance(manifest, dict) or set(manifest) != {"format", "files"}:
        raise ValueError("Unsupported artifact manifest shape")
    if manifest["format"] != MANIFEST_FORMAT or not isinstance(manifest["files"], list):
        raise ValueError("Unsupported artifact manifest format")
    seen = set()
    total_size = 0
    for item in manifest["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "size_bytes"}:
            raise ValueError("Invalid artifact manifest file entry")
        path = _safe_relative_path(item["path"])
        size = item["size_bytes"]
        if path in seen:
            raise ValueError("Artifact manifest paths must be unique")
        if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_FILE_BYTES:
            raise ValueError("Artifact manifest file size is out of bounds")
        if not isinstance(item["sha256"], str) or not _SHA256.fullmatch(item["sha256"]):
            raise ValueError("Invalid artifact file SHA-256")
        seen.add(path)
        total_size += size
        if total_size > MAX_TOTAL_BYTES:
            raise ValueError("Artifact bundle exceeds the total size limit")
    if len(manifest["files"]) != len(REQUIRED_FILES) or seen != REQUIRED_FILES:
        raise ValueError("Artifact manifest must contain the complete inference bundle")
    return manifest, text


def _validate_endpoint(endpoint: str, token: str) -> tuple[str, str]:
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != "/functions/v1/ai-model-artifact"
    ):
        raise ValueError("Artifact endpoint must be an HTTPS URL")
    token = token.strip()
    if not 32 <= len(token) <= 512:
        raise ValueError("Artifact endpoint token length is invalid")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return origin, endpoint


def _fetch_json(endpoint: str, token: str, deadline: float) -> dict[str, Any]:
    if time.monotonic() >= deadline:
        raise ValueError("Artifact endpoint request exceeded its time limit")
    timeout = min(REQUEST_TIMEOUT_SECONDS, max(1, deadline - time.monotonic()))
    request = urllib.request.Request(
        endpoint,
        headers={"Authorization": f"Bearer {token.strip()}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with _opener().open(request, timeout=timeout) as response:
            chunks = []
            total = 0
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError("Artifact endpoint response exceeded its time limit")
                chunk = _read_chunk(response, min(8192, MAX_ENVELOPE_BYTES + 1 - total))
                if time.monotonic() >= deadline:
                    raise ValueError("Artifact endpoint response exceeded its time limit")
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ENVELOPE_BYTES:
                    raise ValueError("Artifact endpoint response is too large")
                chunks.append(chunk)
            raw = b"".join(chunks)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ValueError("Artifact endpoint request failed") from error
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Artifact endpoint returned invalid JSON") from error
    if not isinstance(result, dict) or set(result) != {"manifest_json", "downloads"}:
        raise ValueError("Artifact endpoint response has an invalid shape")
    if not isinstance(result["manifest_json"], str) or not isinstance(result["downloads"], list):
        raise ValueError("Artifact endpoint response has invalid values")
    return result


def _validated_cache(
    bundle: Path, manifest: dict[str, Any], manifest_sha256: str
) -> bool:
    try:
        if bundle.is_symlink() or not bundle.is_dir():
            return False
        expected_files = REQUIRED_FILES | {"manifest.json"}
        actual_files = set()
        for current, directories, filenames in os.walk(bundle, followlinks=False):
            current_path = Path(current)
            if any((current_path / name).is_symlink() for name in directories):
                return False
            for filename in filenames:
                file_path = current_path / filename
                if file_path.is_symlink():
                    return False
                actual_files.add(file_path.relative_to(bundle).as_posix())
        if actual_files != expected_files:
            return False
        cached_manifest = (bundle / "manifest.json").read_bytes()
        if _sha256(cached_manifest) != manifest_sha256.strip().lower():
            return False
        for item in manifest["files"]:
            relative = _safe_relative_path(item["path"])
            path = bundle.joinpath(*PurePosixPath(relative).parts)
            if path.is_symlink() or not path.is_file() or path.stat().st_size != item["size_bytes"]:
                return False
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != item["sha256"]:
                return False
        return True
    except (OSError, ValueError):
        return False


def _download_file(url: str, endpoint_origin: str, destination: Path, item: dict[str, Any], deadline: float):
    parsed = urlsplit(url)
    decoded_path = unquote(parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.netloc != urlsplit(endpoint_origin).netloc
        or not parsed.path.startswith("/storage/v1/object/sign/")
        or parsed.username
        or parsed.password
        or parsed.fragment
        or "\\" in decoded_path
        or "//" in decoded_path
        or any(part in {".", ".."} for part in decoded_path.split("/"))
        or re.search(r"%(?:2f|5c)", parsed.path, re.IGNORECASE)
    ):
        raise ValueError("Signed artifact URL is outside the configured storage origin")
    if time.monotonic() >= deadline:
        raise ValueError("Artifact download exceeded its time limit")
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity"}, method="GET")
    timeout = min(REQUEST_TIMEOUT_SECONDS, max(1, deadline - time.monotonic()))
    digest = hashlib.sha256()
    total = 0
    try:
        with _opener().open(request, timeout=timeout) as response, destination.open("xb") as output:
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError("Artifact download exceeded its time limit")
                chunk = _read_chunk(response, 1024 * 1024)
                if time.monotonic() >= deadline:
                    raise ValueError("Artifact download exceeded its time limit")
                if not chunk:
                    break
                total += len(chunk)
                if total > item["size_bytes"] or total > MAX_FILE_BYTES:
                    raise ValueError("Artifact download exceeded its declared size")
                digest.update(chunk)
                output.write(chunk)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ValueError("Artifact object download failed") from error
    if total != item["size_bytes"] or digest.hexdigest() != item["sha256"]:
        raise ValueError("Downloaded artifact file failed integrity checks")


def fetch_artifact_bundle(
    *,
    endpoint: str | None = None,
    token: str | None = None,
    manifest_sha256: str | None = None,
    cache_dir: str | Path | None = None,
) -> Path:
    """Fetch a manifest-pinned bundle once and return its verified cache path."""
    endpoint = endpoint if endpoint is not None else os.getenv("APMS_AI_ARTIFACT_ENDPOINT", "")
    token = token if token is not None else os.getenv("APMS_AI_ARTIFACT_TOKEN", "")
    manifest_sha256 = (
        manifest_sha256
        if manifest_sha256 is not None
        else os.getenv("APMS_AI_ARTIFACT_MANIFEST_SHA256", "")
    )
    cache_dir = cache_dir if cache_dir is not None else os.getenv(
        "APMS_AI_ARTIFACT_CACHE_DIR", "/tmp/apms-model-cache"
    )
    origin, endpoint = _validate_endpoint(endpoint, token)
    manifest_sha256 = manifest_sha256.strip().lower()
    if not _SHA256.fullmatch(manifest_sha256):
        raise ValueError("A pinned 64-character manifest SHA-256 is required")
    root = Path(cache_dir)
    root.mkdir(parents=True, exist_ok=True)
    absolute_root = Path(os.path.abspath(root))
    ancestors = (absolute_root, *absolute_root.parents)
    if any(path.is_symlink() or _is_junction(path) for path in ancestors):
        raise ValueError("Artifact cache directory cannot be a symlink")
    bundle = root / manifest_sha256

    # The pinned manifest is itself a cache key. A valid complete cache remains
    # usable during broker outages and avoids a network request at each restart.
    cached_manifest_path = bundle / "manifest.json"
    try:
        if not bundle.is_symlink() and not cached_manifest_path.is_symlink():
            if cached_manifest_path.stat().st_size <= 64 * 1024:
                with cached_manifest_path.open("rb") as cached_stream:
                    cached_raw = cached_stream.read(64 * 1024 + 1)
            else:
                cached_raw = b""
            if cached_raw and len(cached_raw) <= 64 * 1024:
                cached_manifest, _ = _parse_manifest(cached_raw, manifest_sha256)
                if _validated_cache(bundle, cached_manifest, manifest_sha256):
                    return bundle
    except (OSError, ValueError):
        pass

    deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
    envelope = _fetch_json(endpoint, token, deadline)
    try:
        manifest_raw = envelope["manifest_json"].encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ValueError("Artifact manifest contains invalid UTF-8") from error
    manifest, manifest_text = _parse_manifest(manifest_raw, manifest_sha256)
    if len(manifest_raw) > 64 * 1024:
        raise ValueError("Artifact manifest is too large")
    downloads = {}
    for entry in envelope["downloads"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "url"}:
            raise ValueError("Artifact download list has an invalid entry")
        path = _safe_relative_path(entry["path"])
        if path in downloads or not isinstance(entry["url"], str):
            raise ValueError("Artifact download paths must be unique")
        downloads[path] = entry["url"]
    if set(downloads) != REQUIRED_FILES:
        raise ValueError("Artifact endpoint did not provide the complete bundle")

    stage = Path(tempfile.mkdtemp(prefix=".apms-stage-", dir=root))
    try:
        for item in manifest["files"]:
            relative = _safe_relative_path(item["path"])
            destination = stage.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            _download_file(downloads[relative], origin, destination, item, deadline)
        # Preserve the exact manifest bytes used to calculate the trusted pin;
        # text-mode newline conversion differs on Windows.
        (stage / "manifest.json").write_bytes(manifest_raw)
        if not _validated_cache(stage, manifest, manifest_sha256):
            raise ValueError("Staged artifact bundle failed final integrity checks")
        backup = None
        if bundle.exists() or bundle.is_symlink():
            if _validated_cache(bundle, manifest, manifest_sha256):
                return bundle
            backup = root / (".apms-invalid-cache-" + uuid.uuid4().hex)
            os.replace(bundle, backup)
        try:
            os.replace(stage, bundle)
        except FileExistsError:
            if not _validated_cache(bundle, manifest, manifest_sha256):
                if backup is not None and not bundle.exists():
                    os.replace(backup, bundle)
                    backup = None
                raise ValueError("Concurrent artifact cache publication was invalid")
        except Exception:
            if backup is not None and not bundle.exists():
                os.replace(backup, bundle)
                backup = None
            raise
        if backup is not None:
            if backup.is_dir() and not backup.is_symlink():
                shutil.rmtree(backup, ignore_errors=True)
            else:
                backup.unlink(missing_ok=True)
        return bundle
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
