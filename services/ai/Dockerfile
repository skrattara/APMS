ARG PYTHON_IMAGE=python:3.12-slim
ARG TORCH_CPU_VERSION=2.7.1+cpu
FROM ${PYTHON_IMAGE} AS build

ARG TORCH_CPU_VERSION
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN python -m venv /opt/venv \
    && pip install --index-url https://download.pytorch.org/whl/cpu \
       --extra-index-url https://pypi.org/simple "torch==${TORCH_CPU_VERSION}"

WORKDIR /build
COPY services/ai/pyproject.toml /build/pyproject.toml
COPY services/ai/src /build/src
RUN pip install ".[serving]"

FROM ${PYTHON_IMAGE} AS runtime

ARG TORCH_CPU_VERSION

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APMS_AI_DEVICE=cpu \
    APMS_MODEL_ARTIFACT_PATH=/models/active \
    APMS_AI_ARTIFACT_CACHE_DIR=/tmp/apms-model-cache \
    PATH=/opt/venv/bin:$PATH
LABEL org.apms.ai.torch-cpu-version="${TORCH_CPU_VERSION}"

COPY --from=build /opt/venv /opt/venv
RUN useradd --system --no-create-home --uid 10001 apms-ai \
    && mkdir -p /models/active /tmp/apms-model-cache \
    && chown -R 10001:10001 /models/active /tmp/apms-model-cache
VOLUME ["/tmp"]

USER 10001:10001
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ready', timeout=3)" || exit 1
CMD ["python", "-m", "uvicorn", "apms_ai.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
