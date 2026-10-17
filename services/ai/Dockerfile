FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APMS_AI_DEVICE=cpu

WORKDIR /app
COPY services/ai /app/services/ai
COPY packages/domain/src /app/packages/domain/src
WORKDIR /app/services/ai
RUN python -m pip install --no-cache-dir '.[ml]'

RUN useradd --system --create-home --uid 10001 apms-ai
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "apms_ai.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8080"]
