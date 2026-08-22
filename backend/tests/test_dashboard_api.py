"""Dashboard proxy authentication and action API regression tests."""

import base64
import os
import re
from pathlib import Path

import pytest
import requests


BASE_URL = (
    os.environ.get("REACT_APP_BACKEND_URL") or os.environ.get("DASHBOARD_BASE_URL") or ""
).rstrip("/")


@pytest.fixture(scope="session")
def credentials():
    content = Path("/app/memory/test_credentials.md").read_text(encoding="utf-8")
    user = re.search(r"(?im)^\s*[-*]\s*Username:\s*`?([^`\s]+)", content)
    pwd = re.search(r"(?im)^\s*[-*]\s*Password:\s*`?([^`\s]+)", content)
    if not user or not pwd:
        pytest.skip("credentials not found in test_credentials.md")
    return {"username": user.group(1), "password": pwd.group(1)}


@pytest.fixture
def client():
    if not BASE_URL:
        pytest.skip("REACT_APP_BACKEND_URL is not configured")
    return requests.Session()


@pytest.fixture
def authenticated_client(client, credentials):
    response = client.post(f"{BASE_URL}/api/login", json=credentials)
    assert response.status_code == 200, response.text
    assert response.json()["authenticated"] is True
    assert "wr_dashboard_session" in client.cookies
    return client


def file_payload(name="sample.txt", content=b"hello watermark"):
    return {"name": name, "file": base64.b64encode(content).decode("ascii")}


def test_invalid_login_rejected(client):
    response = client.post(
        f"{BASE_URL}/api/login",
        json={"username": "admin", "password": "wrong-password"},
    )
    assert response.status_code == 401
    assert "password" in response.json()["detail"].lower()
    assert "wr_dashboard_session" not in client.cookies


def test_session_and_logout(authenticated_client):
    session = authenticated_client.get(f"{BASE_URL}/api/session")
    assert session.status_code == 200
    assert session.json()["authenticated"] is True
    logged_out = authenticated_client.post(f"{BASE_URL}/api/logout")
    assert logged_out.status_code == 200
    assert logged_out.json()["authenticated"] is False
    assert authenticated_client.get(f"{BASE_URL}/api/session").json()["authenticated"] is False
    assert authenticated_client.post(
        f"{BASE_URL}/api/action/inspect", json={"files": [file_payload()]}
    ).status_code == 401


@pytest.mark.parametrize("action", ["clean", "inspect", "detect"])
def test_action_proxy_returns_expected_shape(authenticated_client, action):
    response = authenticated_client.post(
        f"{BASE_URL}/api/action/{action}", json={"files": [file_payload()]}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["action"] == action
    assert len(body["results"]) == 1
    result = body["results"][0]
    assert result["name"] == "sample.txt"
    assert result["ok"] is True
    assert result["kind"] == "text"
    if action == "clean":
        assert result["cleaned"]
        assert "report" in result
    elif action == "inspect":
        assert isinstance(result["suspicious"], bool)
        assert isinstance(result["report"], dict)
    else:
        assert isinstance(result["detections"], list)


def test_batch_preserves_results_and_errors(authenticated_client):
    response = authenticated_client.post(
        f"{BASE_URL}/api/action/inspect",
        json={"files": [file_payload("good.txt"), {"name": "bad.txt", "file": "%%%"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert len(results) == 2
    assert results[0]["name"] == "good.txt"
    assert results[0]["ok"] is True
    assert results[1]["name"] == "bad.txt"
    assert results[1]["ok"] is False
    assert "Invalid file data" in results[1]["error"]


def test_empty_and_unsupported_payloads(authenticated_client):
    empty = authenticated_client.post(f"{BASE_URL}/api/action/clean", json={"files": []})
    assert empty.status_code == 422
    unsupported = authenticated_client.post(
        f"{BASE_URL}/api/action/clean", json={"files": [file_payload("sample.unknown")]}
    )
    assert unsupported.status_code == 200
    assert unsupported.json()["results"][0]["ok"] is False
    assert "unrecognized file format" in unsupported.json()["results"][0]["error"]


def test_unknown_action_and_service_key_not_exposed(authenticated_client):
    response = authenticated_client.post(
        f"{BASE_URL}/api/action/nope", json={"files": [file_payload()]}
    )
    assert response.status_code == 404
    health = authenticated_client.get(f"{BASE_URL}/api/health")
    assert health.status_code == 200
    assert "WATERMARKS_SERVER_API_KEY" not in health.text
    assert "Authorization" not in health.text