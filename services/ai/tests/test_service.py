from apms_ai.main import app, registry
from fastapi.testclient import TestClient

client = TestClient(app)


def test_import_does_not_train_or_enable_model():
    assert registry.state is None
    response = client.get("/health")
    assert response.status_code == 200 and response.json()["model_available"] is False
    assert client.get("/ready").status_code == 503


def test_authentication_and_fail_closed_artifact():
    payload = {
        "record_id": "fresh-opaque-ref",
        "grading_system": {},
        "evaluation_criteria": {},
    }
    assert client.post("/v1/predictions", json=payload).status_code == 401
    import os

    os.environ["APMS_AI_SERVICE_API_KEY"] = "test-secret"
    response = client.post(
        "/v1/predictions", json=payload, headers={"Authorization": "Bearer test-secret"}
    )
    assert response.status_code == 503
    assert (
        client.post(
            "/v1/predictions", json=payload, headers={"Authorization": "test-secret"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/v1/predictions",
            json={**payload, "unexpected": "ignored"},
            headers={"Authorization": "Bearer test-secret"},
        ).status_code
        == 422
    )
    del os.environ["APMS_AI_SERVICE_API_KEY"]
