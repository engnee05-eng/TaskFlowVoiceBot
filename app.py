# Import Path to work with file and folder locations.
from pathlib import Path
import json
import logging
import os
import re
import base64
import binascii
import hmac
import smtplib
import ssl
import sqlite3
import threading
import time
from datetime import datetime
from email.message import EmailMessage
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from google import genai
from google.genai import errors, types
from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="AI Voice Sales Bot")

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
STATIC_DIR = BASE_DIR / "static"
DATABASE_PATH = Path(os.getenv("CALL_HISTORY_DB", BASE_DIR / "call_history.db"))
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

PUBLIC_DEMO = os.getenv("PUBLIC_DEMO", "").strip().lower() == "true"
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
_gemini_key_lock = threading.Lock()
_gemini_next_key = 0
_gemini_key_cooldowns: dict[int, float] = {}
SALES_STATUSES = {
    "Converted",
    "Interested",
    "Follow-up Required",
    "Not Interested",
    "Demo Requested",
    "No Response",
}
MAX_RECORDING_BYTES = 15 * 1024 * 1024
GEMINI_KEY_COOLDOWN_SECONDS = 60

CHAT_RESPONSE_SCHEMA = types.Schema(
    type=types.Type.OBJECT,
    properties={
        "reply": types.Schema(type=types.Type.STRING),
        "status": types.Schema(
            type=types.Type.STRING,
            enum=sorted(SALES_STATUSES),
        ),
    },
    required=["reply", "status"],
)
SUMMARY_RESPONSE_SCHEMA = types.Schema(
    type=types.Type.OBJECT,
    properties={
        "summary": types.Schema(type=types.Type.STRING),
        "needs": types.Schema(type=types.Type.STRING),
        "objections": types.Schema(type=types.Type.STRING),
        "next_step": types.Schema(type=types.Type.STRING),
        "status": types.Schema(
            type=types.Type.STRING,
            enum=sorted(SALES_STATUSES),
        ),
    },
    required=["summary", "needs", "objections", "next_step", "status"],
)


@app.middleware("http")
async def protect_public_demo(request, call_next):
    if not PUBLIC_DEMO:
        return await call_next(request)

    expected_user = os.getenv("SITE_USER", "")
    expected_password = os.getenv("SITE_PASSWORD", "")
    if not expected_user or not expected_password:
        return JSONResponse(
            status_code=503,
            content={"detail": "Public demo authentication is not configured."},
        )

    authorization = request.headers.get("authorization", "")
    scheme, _, encoded_credentials = authorization.partition(" ")
    try:
        import base64

        credentials = base64.b64decode(encoded_credentials, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        credentials = ""

    supplied_user, separator, supplied_password = credentials.partition(":")
    valid_user = hmac.compare_digest(supplied_user, expected_user)
    valid_password = hmac.compare_digest(supplied_password, expected_password)
    if scheme.lower() != "basic" or not separator or not (valid_user and valid_password):
        return JSONResponse(
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="TaskFlow public demo"'},
            content={"detail": "Sign in to access the demo."},
        )
    return await call_next(request)


class ConversationTurn(BaseModel):
    speaker: Literal["Customer", "TaskFlow AI"]
    text: str = Field(min_length=1, max_length=2000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[ConversationTurn] = Field(default_factory=list, max_length=30)


class WorkspaceInviteRequest(BaseModel):
    recipient: str = Field(min_length=3, max_length=254)

    @field_validator("recipient")
    @classmethod
    def validate_recipient(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Enter a valid recipient email address.")
        return value


class SummaryRequest(BaseModel):
    transcript: list[ConversationTurn] = Field(default_factory=list, max_length=100)


class CallHistoryRequest(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    started_at: datetime
    duration_seconds: int = Field(ge=0, le=86_400)
    recording_consent: Literal[True]
    transcript: list[ConversationTurn] = Field(default_factory=list, max_length=100)
    summary: str | None = Field(default=None, max_length=2000)
    needs: str | None = Field(default=None, max_length=2000)
    objections: str | None = Field(default=None, max_length=2000)
    next_step: str | None = Field(default=None, max_length=2000)
    status: str
    recording_base64: str = Field(min_length=1, max_length=20_000_000)
    recording_mime_type: str = Field(min_length=1, max_length=100)

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        if value not in SALES_STATUSES:
            raise ValueError("Invalid sales status.")
        return value

    @field_validator("recording_mime_type")
    @classmethod
    def validate_recording_mime_type(cls, value: str) -> str:
        if value not in {
            "audio/webm",
            "audio/webm;codecs=opus",
            "audio/mp4",
            "audio/wav",
        }:
            raise ValueError("Unsupported call recording format.")
        return value


def initialize_call_history() -> None:
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                duration_seconds INTEGER,
                recording_consent INTEGER NOT NULL,
                summary TEXT,
                needs TEXT,
                objections TEXT,
                next_step TEXT,
                status TEXT NOT NULL,
                recording BLOB,
                recording_mime_type TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS call_turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_id TEXT NOT NULL REFERENCES calls(id),
                turn_number INTEGER NOT NULL,
                speaker TEXT NOT NULL,
                text TEXT NOT NULL,
                audio BLOB,
                mime_type TEXT,
                UNIQUE(call_id, turn_number)
            )
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(calls)")}
        for column, column_type in (
            ("recording", "BLOB"),
            ("recording_mime_type", "TEXT"),
        ):
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE calls ADD COLUMN {column} {column_type}"
                )


@app.get("/")
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


def get_gemini_api_keys() -> list[str]:
    configured_keys = [
        key.strip()
        for key in os.getenv("GEMINI_API_KEYS", "").split(",")
        if key.strip()
    ]
    primary_key = os.getenv("GEMINI_API_KEY", "").strip()
    if primary_key:
        configured_keys.append(primary_key)

    numbered_keys = sorted(
        (
            (int(match.group(1)), value.strip())
            for name, value in os.environ.items()
            if (match := re.fullmatch(r"GEMINI_API_KEY_?(\d+)", name))
            and value.strip()
        ),
        key=lambda item: item[0],
    )
    configured_keys.extend(key for _, key in numbered_keys)
    return list(dict.fromkeys(configured_keys))


def get_gemini_client(api_key: str) -> genai.Client:
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Gemini is not configured. Set GEMINI_API_KEYS or GEMINI_API_KEY and restart the server.",
        )
    return genai.Client(api_key=api_key)


def parse_json_object(content: str | None, provider: str) -> dict:
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(
            status_code=502,
            detail=f"{provider} returned an empty response. Please try again.",
        )
    try:
        result = json.loads(content)
    except json.JSONDecodeError as error:
        logging.warning("%s returned malformed structured output", provider)
        raise HTTPException(
            status_code=502,
            detail=f"{provider} returned an invalid structured response. Please retry the message.",
        ) from error
    if not isinstance(result, dict):
        raise HTTPException(
            status_code=502,
            detail=f"{provider} returned an invalid response format. Please retry the message.",
        )
    return result


def generate_json(
    prompt: str,
    system_instruction: str,
    max_output_tokens: int,
    response_schema: types.Schema,
) -> dict:
    api_keys = get_gemini_api_keys()
    if not api_keys:
        raise HTTPException(
            status_code=503,
            detail="Gemini is not configured. Set GEMINI_API_KEYS or GEMINI_API_KEY and restart the server.",
        )

    global _gemini_next_key
    now = time.monotonic()
    with _gemini_key_lock:
        start_index = _gemini_next_key % len(api_keys)
        ordered_key_indexes = [
            (start_index + offset) % len(api_keys) for offset in range(len(api_keys))
        ]
        for index, blocked_until in list(_gemini_key_cooldowns.items()):
            if index >= len(api_keys) or blocked_until <= now:
                _gemini_key_cooldowns.pop(index, None)
        available_key_indexes = [
            index for index in ordered_key_indexes
            if _gemini_key_cooldowns.get(index, 0) <= now
        ]
        if not available_key_indexes:
            retry_after = max(
                1,
                int(min(_gemini_key_cooldowns.values()) - now + 0.999),
            )
            raise HTTPException(
                status_code=503,
                detail=(
                    "Gemini keys were rate-limited recently. Try again in "
                    f"about {retry_after} seconds."
                ),
            )

    last_quota_error: errors.APIError | None = None
    for attempt, key_index in enumerate(available_key_indexes, start=1):
        client = get_gemini_client(api_keys[key_index])
        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    response_mime_type="application/json",
                    response_schema=response_schema,
                    temperature=0.4,
                    max_output_tokens=max_output_tokens,
                ),
            )
        except errors.APIError as error:
            if error.code == 429:
                last_quota_error = error
                with _gemini_key_lock:
                    _gemini_key_cooldowns[key_index] = (
                        time.monotonic() + GEMINI_KEY_COOLDOWN_SECONDS
                    )
                    _gemini_next_key = (key_index + 1) % len(api_keys)
                logging.warning(
                    "Gemini key %s/%s reached its quota; trying the next configured key.",
                    attempt,
                    len(api_keys),
                )
                continue

            logging.error(
                "Gemini API request failed with HTTP %s: %s",
                error.code,
                error.message,
            )
            if error.code == 400:
                detail = (
                    "Gemini rejected the request configuration. Check the model name "
                    "and response schema in the backend."
                )
            elif error.code == 401 or error.code == 403:
                detail = (
                    "Gemini rejected the API key. Check that it is valid and enabled, "
                    "then restart the backend."
                )
            elif error.code == 404:
                detail = (
                    f"Gemini model '{GEMINI_MODEL}' is unavailable to this API key. "
                    "Set GEMINI_MODEL to a model enabled for your account and restart "
                    "the backend."
                )
            elif error.code == 503:
                detail = (
                    f"Gemini model '{GEMINI_MODEL}' is temporarily overloaded. "
                    "Try again shortly or set GEMINI_MODEL to another available model "
                    "and restart the backend."
                )
            else:
                detail = (
                    f"Gemini request failed (HTTP {error.code}). Check the backend "
                    "logs and Google AI Studio status, then retry."
                )
            raise HTTPException(status_code=502, detail=detail) from error
        finally:
            client.close()

        with _gemini_key_lock:
            _gemini_next_key = (key_index + 1) % len(api_keys)
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, dict):
            return parsed
        return parse_json_object(response.text, "Gemini")

    logging.error("All %s configured Gemini API keys are rate limited.", len(api_keys))
    raise HTTPException(
        status_code=503,
        detail=(
            "Gemini quota is exhausted for all configured API keys. Wait for the quota "
            "to reset or configure a Gemini key with available quota."
        ),
    ) from last_quota_error


# Run this function when someone visits /api/health.
@app.get("/api/health")
def health_check():
    configured = bool(get_gemini_api_keys())
    return {
        "status": "running",
        "message": "AI Voice Sales Bot backend is working!",
        "gemini_configured": configured,
        "llm_configured": configured,
        "llm_ready": configured,
        "gemini_key_count": len(get_gemini_api_keys()),
        "provider": "gemini",
        "model": GEMINI_MODEL,
    }


@app.post("/api/chat")
def chat(request: ChatRequest):
    conversation = request.history[-10:]
    transcript = "\n".join(f"{turn.speaker}: {turn.text}" for turn in conversation)
    if transcript:
        transcript += "\n"
    transcript += f"Customer: {request.message}"
    result = generate_json(
        prompt=(
            f"Conversation:\n{transcript}\n\n"
            "Reply to the customer's latest message in one concise sentence when possible. "
            "Keep the reply under 25 words."
        ),
        system_instruction=(
            "You are TaskFlow's helpful SaaS sales assistant. TaskFlow helps teams organize "
            "projects, assign tasks, collaborate, and track deadlines. Use only these product "
            "facts; do not invent prices, integrations, or features. Answer the customer's "
            "question, ask one relevant follow-up when useful, and never pressure them. "
            "Respect requests to stop contact. Reply in the same language as the customer. "
            "Return JSON with exactly two string fields: reply, and status. status must be one "
            "of: Converted, Interested, Follow-up Required, Not Interested, Demo Requested, "
            "No Response. Choose No Response only if the customer has not responded; otherwise "
            "classify their latest intent."
        ),
        max_output_tokens=64,
        response_schema=CHAT_RESPONSE_SCHEMA,
    )
    reply = result.get("reply")
    status = result.get("status")
    if (
        not isinstance(reply, str)
        or not reply.strip()
        or not isinstance(status, str)
        or status not in SALES_STATUSES
    ):
        raise HTTPException(status_code=502, detail="AI returned an incomplete sales reply.")
    return {"reply": reply.strip(), "status": status}


@app.post("/api/invites")
def send_workspace_invite(request: WorkspaceInviteRequest) -> dict[str, str]:
    workspace_url = os.getenv("TASKFLOW_WORKSPACE_URL", "").strip()
    parsed_url = urlparse(workspace_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        raise HTTPException(
            status_code=503,
            detail="Set TASKFLOW_WORKSPACE_URL to your real HTTPS workspace invitation link.",
        )

    smtp_host = os.getenv("SMTP_HOST", "").strip()
    smtp_username = os.getenv("SMTP_USERNAME", "").strip()
    smtp_password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM", "").strip() or smtp_username
    if not smtp_host or not sender:
        raise HTTPException(
            status_code=503,
            detail="Email is not configured. Set SMTP_HOST and SMTP_FROM in the private .env file.",
        )
    try:
        smtp_port = int(os.getenv("SMTP_PORT", "587"))
    except ValueError as error:
        raise HTTPException(
            status_code=503,
            detail="SMTP_PORT must be a valid port number.",
        ) from error
    if not 1 <= smtp_port <= 65535:
        raise HTTPException(status_code=503, detail="SMTP_PORT is out of range.")

    message = EmailMessage()
    message["Subject"] = "Your invitation to TaskFlow"
    message["From"] = sender
    message["To"] = request.recipient
    message.set_content(
        "Hi,\n\n"
        "You are invited to join TaskFlow and organize projects, assign tasks, "
        "collaborate with your team, and track deadlines.\n\n"
        f"Accept your invitation here: {workspace_url}\n\n"
        "We look forward to working with you!\n"
        "The TaskFlow team"
    )

    try:
        if smtp_port == 465:
            with smtplib.SMTP_SSL(
                smtp_host,
                smtp_port,
                timeout=15,
                context=ssl.create_default_context(),
            ) as smtp:
                if smtp_username:
                    smtp.login(smtp_username, smtp_password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as smtp:
                smtp.ehlo()
                if os.getenv("SMTP_USE_TLS", "true").strip().lower() == "true":
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                if smtp_username:
                    smtp.login(smtp_username, smtp_password)
                smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        logging.error("Could not send TaskFlow workspace invitation: %s", type(error).__name__)
        raise HTTPException(
            status_code=502,
            detail="The invitation email could not be sent. Check SMTP settings and try again.",
        ) from error

    return {"message": f"Workspace invitation sent to {request.recipient}."}


@app.post("/api/summarize")
def summarize(request: SummaryRequest):
    transcript = "\n".join(
        f"{turn.speaker}: {turn.text}" for turn in request.transcript
    ) or "No conversation was captured."
    result = generate_json(
        prompt=(
            f"Analyze this sales conversation transcript:\n{transcript}\n\n"
            "Return a short, factual post-call analysis."
        ),
        system_instruction=(
            "Summarize only facts stated in the transcript using short, concise fields. "
            "Do not invent customer needs, objections, commitments, or follow-up dates. "
            "Return JSON with exactly five string "
            "fields: summary, needs, objections, next_step, status. status must be one of: "
            "Converted, Interested, Follow-up Required, Not Interested, Demo Requested, "
            "No Response. If no customer message appears, use No Response. Respect an explicit "
            "request not to be contacted."
        ),
        max_output_tokens=260,
        response_schema=SUMMARY_RESPONSE_SCHEMA,
    )
    if any(
        not isinstance(result.get(field), str) or not result[field].strip()
        for field in ("summary", "next_step")
    ) or any(not isinstance(result.get(field), str) for field in ("needs", "objections")):
        raise HTTPException(status_code=502, detail="AI returned an incomplete call summary.")
    if not isinstance(result.get("status"), str) or result["status"] not in SALES_STATUSES:
        raise HTTPException(status_code=502, detail="AI returned an invalid sales status.")
    return {
        "summary": result["summary"].strip(),
        "needs": result["needs"].strip() or "No specific requirements identified.",
        "objections": result["objections"].strip() or "No objections identified.",
        "nextStep": result["next_step"].strip(),
        "status": result["status"],
    }


@app.get("/api/calls")
def list_calls() -> list[dict]:
    initialize_call_history()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.row_factory = sqlite3.Row
        calls = connection.execute(
            """
            SELECT id, started_at, duration_seconds, summary, needs, objections,
                   next_step, status
            FROM calls
            WHERE ended_at IS NOT NULL AND recording IS NOT NULL
            ORDER BY started_at DESC
            LIMIT 50
            """
        ).fetchall()
        results = []
        for call in calls:
            item = dict(call)
            item["transcript"] = [
                dict(turn)
                for turn in connection.execute(
                    """
                    SELECT speaker, text FROM call_turns
                    WHERE call_id = ? ORDER BY turn_number
                    """,
                    (call["id"],),
                ).fetchall()
            ]
            results.append(item)
        return results


@app.post("/api/calls")
def save_call(request: CallHistoryRequest) -> dict[str, str]:
    try:
        recording = base64.b64decode(request.recording_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail="Invalid call recording data.") from error
    if not recording:
        raise HTTPException(status_code=422, detail="Call recording is empty.")
    if len(recording) > MAX_RECORDING_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Call recording exceeds the 15 MB storage limit.",
        )

    initialize_call_history()
    ended_at = datetime.now().astimezone().isoformat()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            connection.execute(
                """
                INSERT INTO calls (
                    id, started_at, ended_at, duration_seconds, recording_consent,
                    summary, needs, objections, next_step, status,
                    recording, recording_mime_type
                ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request.id,
                    request.started_at.isoformat(),
                    ended_at,
                    request.duration_seconds,
                    request.summary,
                    request.needs,
                    request.objections,
                    request.next_step,
                    request.status,
                    recording,
                    request.recording_mime_type,
                ),
            )
            connection.executemany(
                """
                INSERT INTO call_turns (call_id, turn_number, speaker, text)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (request.id, index, turn.speaker, turn.text)
                    for index, turn in enumerate(request.transcript)
                ],
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(
                status_code=409,
                detail="This call was already saved or its transcript is invalid.",
            ) from error
    return {"id": request.id, "message": "Call history saved."}


@app.delete("/api/calls")
def delete_all_calls() -> dict[str, int]:
    initialize_call_history()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        deleted_count = connection.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
        connection.execute("DELETE FROM call_turns")
        connection.execute("DELETE FROM calls")
    return {"deleted_count": deleted_count}


@app.delete("/api/calls/{call_id}")
def delete_call(call_id: str) -> dict[str, str]:
    initialize_call_history()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("DELETE FROM call_turns WHERE call_id = ?", (call_id,))
        cursor = connection.execute("DELETE FROM calls WHERE id = ?", (call_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Call was not found.")
    return {"id": call_id, "message": "Call deleted."}


@app.get("/api/calls/{call_id}/recording")
def get_call_recording(call_id: str) -> Response:
    initialize_call_history()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            "SELECT recording, recording_mime_type FROM calls WHERE id = ?",
            (call_id,),
        ).fetchone()
    if row is None or row[0] is None:
        raise HTTPException(status_code=404, detail="Call recording was not found.")
    return Response(content=row[0], media_type=row[1] or "audio/webm")
