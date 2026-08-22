import base64
import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path
from typing import Any

import bcrypt
import httpx
from fastapi import Cookie, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


SERVICE_URL = os.environ.get("WATERMARKS_SERVICE_URL", "http://127.0.0.1:8765").rstrip("/")
SERVICE_API_KEY = os.environ.get("WATERMARKS_SERVER_API_KEY", "")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "local-development-only-secret")
CREDENTIALS_PATH = Path(os.environ.get("ADMIN_CREDENTIALS_PATH", "/app/data/admin.json"))
COOKIE_NAME = "wr_dashboard_session"


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _load_credentials() -> dict[str, str]:
    if CREDENTIALS_PATH.exists():
        try:
            data = json.loads(CREDENTIALS_PATH.read_text())
            if "username" in data and "password_hash" in data:
                return data
        except (json.JSONDecodeError, OSError):
            pass
    creds = {"username": ADMIN_USERNAME, "password_hash": _hash_password(ADMIN_PASSWORD)}
    _save_credentials(creds)
    return creds


def _save_credentials(creds: dict[str, str]) -> None:
    CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_PATH.write_text(json.dumps(creds))


CREDENTIALS = _load_credentials()

app = FastAPI(title="Watermarks Dashboard API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("DASHBOARD_ORIGIN", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


class UploadedFile(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    file: str


class ActionRequest(BaseModel):
    files: list[UploadedFile] = Field(min_length=1, max_length=50)


def make_session(username: str) -> str:
    nonce = secrets.token_urlsafe(24)
    value = f"{username}:{nonce}"
    signature = hmac.new(SESSION_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()
    return f"{value}:{signature}"


def session_user(cookie: str | None) -> str:
    if not cookie:
        raise HTTPException(status_code=401, detail="Please sign in")
    parts = cookie.split(":")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="Invalid session")
    username, nonce, signature = parts
    value = f"{username}:{nonce}"
    expected = hmac.new(SESSION_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected) or username != CREDENTIALS["username"]:
        raise HTTPException(status_code=401, detail="Invalid session")
    return username


def auth_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if SERVICE_API_KEY:
        headers["Authorization"] = f"Bearer {SERVICE_API_KEY}"
    return headers


async def call_service(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(
                f"{SERVICE_URL}{path}", headers=auth_headers(), json=payload
            )
        if response.status_code >= 400:
            try:
                detail = response.json().get("error", response.text)
            except ValueError:
                detail = response.text
            raise HTTPException(status_code=response.status_code, detail=detail)
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Cleaning service unavailable: {exc}") from exc


def service_file(item: UploadedFile) -> dict[str, str]:
    try:
        base64.b64decode(item.file, validate=True)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"Invalid file data: {item.name}")
    return {"file": item.file, "name": item.name}


@app.get("/api/session")
async def get_session(wr_dashboard_session: str | None = Cookie(default=None)) -> dict[str, Any]:
    return {"authenticated": bool(wr_dashboard_session and _valid_session(wr_dashboard_session))}


def _valid_session(cookie: str) -> bool:
    try:
        session_user(cookie)
        return True
    except HTTPException:
        return False


@app.post("/api/login")
async def login(payload: LoginRequest, response: Response) -> dict[str, Any]:
    valid_user = hmac.compare_digest(payload.username, CREDENTIALS["username"])
    valid_password = valid_user and bcrypt.checkpw(
        payload.password.encode(), CREDENTIALS["password_hash"].encode()
    )
    if not valid_user or not valid_password:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    response.set_cookie(
        COOKIE_NAME,
        make_session(CREDENTIALS["username"]),
        httponly=True,
        secure=os.environ.get("COOKIE_SECURE", "0") == "1",
        samesite="lax",
        max_age=60 * 60 * 12,
    )
    return {"authenticated": True, "username": CREDENTIALS["username"]}


@app.post("/api/logout")
async def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(COOKIE_NAME)
    return {"authenticated": False}


@app.post("/api/change-password")
async def change_password(
    payload: PasswordChangeRequest,
    response: Response,
    wr_dashboard_session: str | None = Cookie(default=None),
) -> dict[str, Any]:
    session_user(wr_dashboard_session)
    if not bcrypt.checkpw(payload.current_password.encode(), CREDENTIALS["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=400, detail="New password must be different from the current one")
    CREDENTIALS["password_hash"] = _hash_password(payload.new_password)
    try:
        _save_credentials(CREDENTIALS)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Unable to persist new password. Please check server storage.") from exc
    response.set_cookie(
        COOKIE_NAME,
        make_session(CREDENTIALS["username"]),
        httponly=True,
        secure=os.environ.get("COOKIE_SECURE", "0") == "1",
        samesite="lax",
        max_age=60 * 60 * 12,
    )
    return {"ok": True}


@app.get("/api/health")
async def dashboard_health(wr_dashboard_session: str | None = Cookie(default=None)) -> dict[str, Any]:
    session_user(wr_dashboard_session)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            result = await client.get(f"{SERVICE_URL}/health", headers=auth_headers())
        return {"dashboard": True, "service": result.json()}
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Cleaning service unavailable: {exc}") from exc


@app.post("/api/action/{action}")
async def action(
    action: str,
    payload: ActionRequest,
    wr_dashboard_session: str | None = Cookie(default=None),
) -> dict[str, Any]:
    session_user(wr_dashboard_session)
    if action not in {"clean", "inspect", "detect"}:
        raise HTTPException(status_code=404, detail="Unknown action")

    results = []
    for item in payload.files:
        try:
            file_payload = service_file(item)
            result = await call_service(f"/{action}", file_payload)
            output = {"name": item.name, "ok": result.get("ok", False), "kind": result.get("kind")}
            if action == "clean":
                output["cleaned"] = result.get("cleaned")
                output["report"] = result.get("report", {})
            elif action == "inspect":
                output["suspicious"] = result.get("suspicious", False)
                output["report"] = result.get("report", {})
            else:
                output["detections"] = result.get("detections", [])
        except HTTPException as exc:
            output = {"name": item.name, "ok": False, "error": str(exc.detail)}
        results.append(output)
    return {"action": action, "results": results}
