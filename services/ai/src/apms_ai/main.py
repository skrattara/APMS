"""Private authenticated serving; model loading occurs at application startup."""

from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

logger = logging.getLogger("apms_ai.service")


class PredictionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_id: str = Field(min_length=1, max_length=128)
    grading_system: dict[str, Any]
    evaluation_criteria: dict[str, Any]
    evaluation_values: dict[str, Any] | None = None
    student_records: dict[str, Any] | None = None
    assessment_instances: list[dict[str, Any]] | None = None
    task_contract: dict[str, Any] | None = None


class ForecastInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_ref: str = Field(
        default_factory=lambda: "record_" + uuid.uuid4().hex,
        min_length=1,
        max_length=128,
    )
    fields: list[dict[str, Any]]
    history: list[dict[str, Any]]
    queries: list[dict[str, Any]]
    schema_context: dict[str, Any] = Field(default_factory=dict)
    assessment_instances: list[dict[str, Any]] = Field(default_factory=list)


class ModelRegistry:
    def __init__(self):
        self.state = None
        self.model = None
        self.metadata = {}
        self.version = "unavailable"
        self.error = None

    def load(self):
        """Load once per worker. Any partial-load failure leaves readiness false."""
        self.state = self.model = None
        self.metadata = {}
        self.version = "unavailable"
        path = os.getenv("APMS_MODEL_ARTIFACT_PATH", "")
        if not path:
            return
        try:
            import torch

            from .inference import model_from_bundle
            from .lifecycle import load_bundle

            state, metadata = load_bundle(path)
            real_count = (
                metadata.get("training", {}).get("source_counts", {}).get("train", 0)
            )
            if (
                not real_count
                and os.getenv("APMS_AI_ENABLE_SYNTHETIC_DEMO", "false").lower()
                != "true"
            ):
                raise ValueError(
                    "Synthetic artifacts require explicit development opt-in"
                )
            if not metadata.get("fields") or not metadata.get("target_fields"):
                raise ValueError("Artifact has no trained inference contract")
            device = os.getenv("APMS_AI_DEVICE", "cpu")
            if device == "auto":
                device = "cuda" if torch.cuda.is_available() else "cpu"
            model = model_from_bundle(state, metadata, device=device)
            self.state, self.metadata, self.model = state, metadata, model
            self.version = (
                str(metadata.get("model_version", "unversioned"))
                + ":"
                + metadata["weights_sha256"][:12]
            )
            self.error = None
            logger.info(
                json.dumps(
                    {
                        "event": "model_loaded",
                        "model_version": self.version,
                        "device": device,
                    }
                )
            )
        except Exception as error:
            self.state = self.model = None
            self.metadata = {}
            self.error = type(error).__name__
            logger.error(
                json.dumps({"event": "model_load_failed", "error_type": self.error})
            )

    @property
    def available(self):
        return self.state is not None and self.model is not None


registry = ModelRegistry()


@asynccontextmanager
async def lifespan(application):
    registry.load()
    yield
    registry.model = registry.state = None


app = FastAPI(
    title="APMS schema-conditioned forecasting", version="2.0.0", lifespan=lifespan
)
_latencies = deque(maxlen=2048)
_counts = {"requests": 0, "server_errors": 0, "rejected_requests": 0}
_capacity = threading.BoundedSemaphore(
    max(1, int(os.getenv("APMS_AI_MAX_CONCURRENT_REQUESTS", "2")))
)


def authorize(authorization: str | None):
    key = os.getenv("APMS_AI_SERVICE_API_KEY", "")
    if (
        not key
        or not authorization
        or not authorization.startswith("Bearer ")
        or not hmac.compare_digest(authorization[7:], key)
    ):
        raise HTTPException(401, "Invalid service credentials")


@app.middleware("http")
async def monitor_and_bound_request(request: Request, call_next):
    start = time.perf_counter()
    _counts["requests"] += 1
    response = None
    try:
        maximum = int(os.getenv("APMS_AI_MAX_REQUEST_BYTES", "1048576"))
        if request.method == "POST":
            # Count actual bytes too: Content-Length alone does not bound a
            # chunked or incorrectly framed request supplied by a test proxy.
            try:
                declared = int(request.headers.get("content-length", "0"))
            except ValueError:
                response = JSONResponse({"detail": "Invalid request length"}, 400)
                return response
            if declared < 0 or declared > maximum:
                response = JSONResponse({"detail": "Request too large"}, 413)
                return response
            chunks, total = [], 0
            async for chunk in request.stream():
                total += len(chunk)
                if total > maximum:
                    response = JSONResponse({"detail": "Request too large"}, 413)
                    return response
                chunks.append(chunk)
            request._body = b"".join(chunks)
        response = await call_next(request)
        return response
    finally:
        elapsed = time.perf_counter() - start
        _latencies.append(elapsed)
        status = response.status_code if response else 500
        if status >= 500:
            _counts["server_errors"] += 1
        if status >= 400:
            _counts["rejected_requests"] += 1
        # Deliberately omit bodies, record references, values, paths and tokens.
        logger.info(
            json.dumps(
                {
                    "event": "request_completed",
                    "status": status,
                    "latency_ms": round(elapsed * 1000, 2),
                }
            )
        )


def _ready():
    if not registry.available:
        raise HTTPException(503, "No valid model artifact is configured")


def _run_forecast(function, *args, **kwargs):
    _ready()
    if not _capacity.acquire(blocking=False):
        raise HTTPException(429, "Inference capacity is busy; retry shortly")
    try:
        return function(*args, **kwargs)
    except (ValueError, TypeError, KeyError) as error:
        # Validation details are kept out of HTTP errors because nested schema
        # validation errors can otherwise echo caller-supplied field values.
        logger.warning(
            json.dumps(
                {"event": "forecast_rejected", "error_type": type(error).__name__}
            )
        )
        raise HTTPException(
            422, "Request is incompatible with the schema or trained model contract"
        ) from error
    except Exception as error:
        logger.error(
            json.dumps(
                {"event": "inference_failed", "error_type": type(error).__name__}
            )
        )
        raise HTTPException(
            503, "Configured model could not produce a valid forecast"
        ) from error
    finally:
        _capacity.release()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_available": registry.available,
        "model_version": registry.version if registry.available else None,
        "institutionally_validated": False,
    }


@app.get("/ready")
def ready():
    _ready()
    if not os.getenv("APMS_AI_SERVICE_API_KEY"):
        raise HTTPException(503, "Service authentication is not configured")
    return {"status": "ready", "model_version": registry.version}


@app.get("/metrics")
def metrics(authorization: str | None = Header(default=None)):
    authorize(authorization)
    values = sorted(_latencies)
    return {
        **_counts,
        "worker_local": True,
        "latency_window_count": len(values),
        "latency_p95_ms": values[min(len(values) - 1, int(len(values) * 0.95))] * 1000
        if values
        else None,
    }


@app.post("/v1/predictions")
def predict(payload: PredictionInput, authorization: str | None = Header(default=None)):
    authorize(authorization)
    from .inference import predict_record

    return _run_forecast(
        predict_record,
        registry.state,
        registry.metadata,
        payload.model_dump(),
        registry.metadata.get("inference_adapter", {}),
        model=registry.model,
    )


@app.post("/v2/forecasts")
def forecast(payload: ForecastInput, authorization: str | None = Header(default=None)):
    authorize(authorization)
    _ready()
    from .contracts import Example, FieldSpec
    from .inference import predict_example

    def run():
        if set(payload.schema_context) - {"gradingSystem", "evaluationCriteria"}:
            raise ValueError("Unknown schema context")
        example = Example(
            payload.history,
            payload.queries,
            [FieldSpec(**field) for field in payload.fields],
            origin="real",
            schema=payload.schema_context,
        )
        result = predict_example(
            registry.state,
            registry.metadata,
            example,
            model=registry.model,
            assessment_instances=payload.assessment_instances,
        )
        return {"record_ref": payload.record_ref, **result}

    return _run_forecast(run)
