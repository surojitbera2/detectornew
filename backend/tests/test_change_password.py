"""Change-password endpoint tests (POST /api/change-password) with credential revert."""

import os
import re
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values


def _base_url() -> str:
    frontend_env = dotenv_values("/app/frontend/.env") if Path("/app/frontend/.env").exists() else {}
    url = (
        os.environ.get("REACT_APP_BACKEND_URL")
        or frontend_env.get("REACT_APP_BACKEND_URL")
        or os.environ.get("DASHBOARD_BASE_URL")
    )
    if not url:
        pytest.skip("REACT_APP_BACKEND_URL / DASHBOARD_BASE_URL not configured")
    return url.rstrip("/")


BASE_URL = (
    os.environ.get("REACT_APP_BACKEND_URL")
    or os.environ.get("DASHBOARD_BASE_URL")
    or ""
).rstrip("/")

NEW_PASSWORD = "TEST_rotate_9182"


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
    base = _base_url()
    session = requests.Session()
    session.base = base
    return session


@pytest.fixture
def authed(client, credentials):
    response = client.post(f"{client.base}/api/login", json=credentials)
    if response.status_code != 200:
        pytest.fail(f"login failed {response.status_code}: {response.text[:300]}")
    assert response.json()["authenticated"] is True
    return client


# --- validation / auth guards ---

def test_change_password_requires_session(client):
    response = client.post(
        f"{client.base}/api/change-password",
        json={"current_password": "whatever", "new_password": "whatever12"},
    )
    assert response.status_code == 401


def test_wrong_current_password_rejected(authed):
    response = authed.post(
        f"{authed.base}/api/change-password",
        json={"current_password": "definitely-wrong", "new_password": "another-valid-1"},
    )
    assert response.status_code == 401
    assert "current password" in response.json()["detail"].lower()


def test_same_password_rejected(authed, credentials):
    response = authed.post(
        f"{authed.base}/api/change-password",
        json={"current_password": credentials["password"], "new_password": credentials["password"]},
    )
    assert response.status_code == 400
    assert "different" in response.json()["detail"].lower()


def test_short_new_password_rejected(authed, credentials):
    response = authed.post(
        f"{authed.base}/api/change-password",
        json={"current_password": credentials["password"], "new_password": "short1"},
    )
    assert response.status_code == 422


# --- happy path with revert ---

def test_password_rotation_persists_and_reverts(authed, credentials):
    base = authed.base
    change = authed.post(
        f"{base}/api/change-password",
        json={"current_password": credentials["password"], "new_password": NEW_PASSWORD},
    )
    assert change.status_code == 200, change.text
    assert change.json() == {"ok": True}

    try:
        # session still valid after rotation
        assert authed.get(f"{base}/api/session").json()["authenticated"] is True

        # old password no longer works
        fresh = requests.Session()
        old = fresh.post(f"{base}/api/login", json=credentials)
        assert old.status_code == 401

        # new password works and yields a usable session
        new_login = fresh.post(
            f"{base}/api/login",
            json={"username": credentials["username"], "password": NEW_PASSWORD},
        )
        assert new_login.status_code == 200, new_login.text
        assert new_login.json()["authenticated"] is True
        assert fresh.get(f"{base}/api/session").json()["authenticated"] is True
    finally:
        revert = requests.Session()
        login = revert.post(
            f"{base}/api/login",
            json={"username": credentials["username"], "password": NEW_PASSWORD},
        )
        if login.status_code == 200:
            reverted = revert.post(
                f"{base}/api/change-password",
                json={"current_password": NEW_PASSWORD, "new_password": credentials["password"]},
            )
            assert reverted.status_code == 200, reverted.text

    # original credentials restored
    final = requests.Session().post(f"{base}/api/login", json=credentials)
    assert final.status_code == 200
