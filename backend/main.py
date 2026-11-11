"""FastAPI server for Shanaya's agent loop, tools, voice, and eBPF events."""

from __future__ import annotations

import hashlib
import inspect
import ipaddress
import json
import os
import re
import secrets
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

load_dotenv()

from backend.audit_logger import audit_logger
from backend.llm_router import ALLOWED_EMOTIONS, LLMRouterError, router
from backend.tools import code_executor, gui_control, system_control, web_agent
from backend.tools.security import canonical_arguments as _canonical_arguments
from backend.tools.security import grant_tool_authority

SYSTEM_PROMPT = " ".join([
    "You are Shanaya, a helpful, calm, warm, bounded AI companion.",
    "Fulfill user requests safely, candidly, and without unnecessary moralizing.",
    "Use only the tools supplied to you. Any tool request is a proposal, never an approval.",
    "Every tool execution pauses for explicit user approval in the Shanaya app. Never bypass or imply consent, and never claim a tool succeeded before its result arrives.",
    "Call only one tool at a time. Prefer workspace-scoped files, allow-listed read-only shell commands, public web browsing, and the isolated code sandbox.",
    "For an action, make a supplied function tool call, which is the structured tool_call proposal; never treat it as approval.",
    "When finished, return only JSON: {\"reply\":\"text\",\"emotion\":\"happy|sad|cute|neutral\",\"tool_call\":null}.",
])
CLIENT_FALLBACK_SYSTEM_PROMPT = " ".join([
    "You are Shanaya, a helpful, calm, warm, bounded AI companion.",
    "Fulfill user requests safely and use only the function tools supplied by the client.",
    "A tool call is only a proposal. Device actions require the client's explicit approval flow; never bypass it or claim success before a result arrives.",
    "Call one tool at a time. When finished, return only JSON: {\"reply\":\"text\",\"emotion\":\"happy|sad|cute|neutral\",\"tool_call\":null}.",
])
MAX_AGENT_ROUNDS = 8
MAX_TOOL_OUTPUT_CHARS = 24_000
try:
    APPROVAL_TTL_SECONDS = min(900, max(30, int(os.getenv("APPROVAL_TTL_SECONDS", "180"))))
except ValueError:
    APPROVAL_TTL_SECONDS = 180
MAX_PENDING_APPROVALS = 128
WORKSPACE = Path(os.getenv("SHANAYA_WORKSPACE", ".")).expanduser().resolve()


def _local_bind_host() -> str:
    host = os.getenv("SHANAYA_HOST", "127.0.0.1").strip()
    if host.lower() == "localhost":
        return host
    try:
        if ipaddress.ip_address(host).is_loopback:
            return host
    except ValueError:
        pass
    # This service has no remote-user authentication. Binding it to a LAN or
    # public interface would let remote callers create and approve their own
    # sessions, so remote deployment must add an authenticated gateway first.
    raise RuntimeError("The Python agent may bind only to localhost or a loopback IP address.")


SHANAYA_HOST = _local_bind_host()
WORKSPACE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Project Shanaya API", version="1.0.0")
configured_origins = [origin.strip() for origin in os.getenv(
    "SHANAYA_CORS_ORIGINS",
    "http://localhost:5173,capacitor://localhost,http://localhost",
).split(",") if origin.strip()]
cors_origins = []
for origin in configured_origins:
    parsed_origin = urlparse(origin)
    if (
        origin != "*"
        and parsed_origin.scheme in {"http", "https", "capacitor", "ionic"}
        and parsed_origin.hostname
        and not parsed_origin.username
        and not parsed_origin.password
        and parsed_origin.path in {"", "/"}
        and not parsed_origin.query
        and not parsed_origin.fragment
    ):
        cors_origins.append(origin.rstrip("/"))
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


class ToolSpec(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]
    # Backend tool execution always waits for a user decision, including reads.
    requires_approval: bool = True


@dataclass
class Tool:
    spec: ToolSpec
    handler: Any


@dataclass
class PendingApproval:
    token: str
    session_id: str
    tool_name: str
    tool_call_id: str
    arguments: dict[str, Any]
    created_at: float


class ToolRegistry:
    """The only callable tools exposed to the model."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, spec: ToolSpec, handler: Any) -> None:
        self._tools[spec.name] = Tool(spec, handler)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def openai_schemas(self) -> list[dict[str, Any]]:
        return [{
            "type": "function",
            "function": {
                "name": tool.spec.name,
                "description": tool.spec.description,
                "parameters": tool.spec.parameters,
            },
        } for tool in self._tools.values()]

    def public_schemas(self) -> list[dict[str, Any]]:
        return [tool.spec.model_dump() for tool in self._tools.values()]


tools = ToolRegistry()
pending_approvals: dict[str, PendingApproval] = {}
approval_sockets: dict[str, WebSocket] = {}
sense_events: deque[dict[str, Any]] = deque(maxlen=500)


def _tool_read_file(path: str) -> dict[str, Any]:
    return system_control.read_workspace_file(path, WORKSPACE)


def _tool_write_file(path: str, content: str) -> dict[str, Any]:
    return system_control.write_workspace_file(path, content, WORKSPACE)


def _tool_status() -> dict[str, Any]:
    return system_control.system_status(WORKSPACE)


def _tool_shell(command: str) -> dict[str, Any]:
    return system_control.run_allowlisted_command(command, WORKSPACE)


def _tool_gui_screenshot(path: str) -> dict[str, Any]:
    return gui_control.screenshot(path, WORKSPACE)


async def _tool_web_navigate(url: str) -> dict[str, Any]:
    return await web_agent.navigate_and_extract(url)


async def _tool_web_submit_form(url: str, fields: dict[str, str], submit_selector: str) -> dict[str, Any]:
    return await web_agent.submit_form(url, fields, submit_selector)


def _register_tools() -> None:
    """Explicit tool allow-list. Every entry requires WebSocket approval."""
    specs_and_handlers = [
        ("read_file", "Read a UTF-8 text file inside the configured workspace. Credential files are blocked; approved contents go to the selected model.", {"type": "object", "properties": {"path": {"type": "string", "maxLength": 2048}}, "required": ["path"], "additionalProperties": False}, _tool_read_file),
        ("write_file", "Write a UTF-8 file inside the configured workspace. Credential and repository metadata paths are blocked.", {"type": "object", "properties": {"path": {"type": "string", "maxLength": 2048}, "content": {"type": "string", "maxLength": 64000}}, "required": ["path", "content"], "additionalProperties": False}, _tool_write_file),
        ("system_status", "Return basic platform, Python, CPU, workspace, and disk status.", {"type": "object", "properties": {}, "additionalProperties": False}, _tool_status),
        ("execute_shell", "Run only one of: pwd, ls [-la] [workspace-path], cat workspace-file, systemctl status SERVICE. No shell, pipes, redirection, or mutations.", {"type": "object", "properties": {"command": {"type": "string", "maxLength": 1000}}, "required": ["command"], "additionalProperties": False}, _tool_shell),
        ("gui_click", "Click a visible screen coordinate. Always show and require approval for the exact coordinates.", {"type": "object", "properties": {"x": {"type": "integer", "minimum": 0}, "y": {"type": "integer", "minimum": 0}}, "required": ["x", "y"], "additionalProperties": False}, gui_control.click),
        ("gui_type_text", "Type up to 500 characters into the currently focused field. The proposal shows the text; sensitive values are redacted from the audit log.", {"type": "object", "properties": {"text": {"type": "string", "maxLength": 500}}, "required": ["text"], "additionalProperties": False}, gui_control.type_text),
        ("gui_press_key", "Press one allow-listed navigation key; key chords and system shortcuts are disabled.", {"type": "object", "properties": {"key": {"type": "string", "enum": ["enter", "esc", "tab", "space", "backspace", "delete", "left", "right", "up", "down", "home", "end"]}}, "required": ["key"], "additionalProperties": False}, gui_control.press_key),
        ("gui_screenshot", "Save a screenshot inside the configured workspace.", {"type": "object", "properties": {"path": {"type": "string", "maxLength": 2048}}, "required": ["path"], "additionalProperties": False}, _tool_gui_screenshot),
        ("web_navigate", "Visit a public HTTP(S) URL and extract page text. Local/private network addresses and downloads are blocked.", {"type": "object", "properties": {"url": {"type": "string", "maxLength": 2048}}, "required": ["url"], "additionalProperties": False}, _tool_web_navigate),
        ("web_submit_form", "Fill and submit a web form. The exact destination, fields, values, and submit selector are shown for approval before submission.", {"type": "object", "properties": {"url": {"type": "string", "maxLength": 2048}, "fields": {"type": "object", "maxProperties": 12, "additionalProperties": {"type": "string", "maxLength": 2000}}, "submit_selector": {"type": "string", "maxLength": 300}}, "required": ["url", "fields", "submit_selector"], "additionalProperties": False}, _tool_web_submit_form),
        ("run_sandboxed_code", "Run Python, Node.js, or POSIX shell code in a disposable Docker container with no network, host mounts, or elevated capabilities.", {"type": "object", "properties": {"language": {"type": "string", "enum": ["python", "node", "shell"]}, "code": {"type": "string", "maxLength": 64000}, "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 30}}, "required": ["language", "code", "timeout_seconds"], "additionalProperties": False}, code_executor.execute_code),
    ]
    for name, description, parameters, handler in specs_and_handlers:
        tools.register(ToolSpec(name=name, description=description, parameters=parameters, requires_approval=True), handler)


_register_tools()


def _clean_pending_approvals() -> None:
    now = time.time()
    expired = [token for token, pending in pending_approvals.items() if now - pending.created_at > APPROVAL_TTL_SECONDS]
    for token in expired:
        pending = pending_approvals.pop(token, None)
        if pending:
            audit_logger.log("tool_expired", tool=pending.tool_name, status="approval_timed_out", details={"arguments": pending.arguments})


def _register_pending_approval(name: str, call_id: str, arguments: dict[str, Any], session_id: str) -> PendingApproval:
    _clean_pending_approvals()
    if len(pending_approvals) >= MAX_PENDING_APPROVALS:
        raise HTTPException(status_code=429, detail="Too many actions are awaiting confirmation. Resolve one before requesting another.")
    token = secrets.token_urlsafe(32)
    pending = PendingApproval(token, session_id, name, call_id, arguments, time.time())
    pending_approvals[token] = pending
    audit_logger.log("tool_proposed", tool=name, status="awaiting_user_approval", details={"session_id": session_id, "arguments": arguments})
    return pending


def _parse_tool_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        value = json.loads(raw or "{}")
        if isinstance(value, dict):
            return value
    raise ValueError("Tool arguments must be a JSON object.")


async def _execute_registered_tool(
    name: str,
    arguments: dict[str, Any],
    approval: PendingApproval | None = None,
) -> Any:
    tool = tools.get(name)
    if tool is None:
        raise ValueError(f"Unknown tool: {name}")
    if (
        approval is None
        or approval.tool_name != name
        or _canonical_arguments(approval.arguments) != _canonical_arguments(arguments)
        or time.time() - approval.created_at > APPROVAL_TTL_SECONDS
    ):
        raise PermissionError(f"The {name} tool requires a matching, unexpired user approval.")
    with grant_tool_authority(name, arguments):
        result = tool.handler(**arguments)
        if inspect.isawaitable(result):
            result = await result
    return result


def _parse_reply(content: str) -> tuple[str, str]:
    candidate = content.strip()
    parsed = _extract_json_object(candidate)
    if parsed is None:
        # Normalize any Markdown fence variant so malformed JSON never leaks markup into chat.
        candidate = re.sub(r"^\s*```(?:[a-z0-9_-]+)?\s*|\s*```\s*$", "", candidate, flags=re.IGNORECASE).strip()
        parsed = {"reply": candidate, "emotion": "neutral"}
    reply = parsed.get("reply") if isinstance(parsed, dict) else None
    emotion = parsed.get("emotion") if isinstance(parsed, dict) else None
    if not isinstance(reply, str) or not reply.strip():
        reply = candidate or "I couldn't form a response. Please try again."
    # Model JSON can contain any type; avoid a TypeError for arrays/objects.
    if not isinstance(emotion, str) or emotion not in ALLOWED_EMOTIONS:
        emotion = "neutral"
    return reply.strip(), emotion


def _extract_json_object(content: str) -> dict[str, Any] | None:
    candidate = content.strip().lstrip("\ufeff")
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[-1]
        if candidate.endswith("```"):
            candidate = candidate[:-3].strip()
    decoder = json.JSONDecoder()
    for start, character in enumerate(candidate):
        if character != "{":
            continue
        try:
            value, _end = decoder.raw_decode(candidate[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _safe_messages(
    messages: list[dict[str, Any]],
    system_prompt: str,
    allowed_roles: set[str],
    *,
    allow_tool_calls: bool = False,
    known_tool_names: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Discard caller supplied system prompts and retain only bounded message fields."""
    safe: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for message in messages:
        if not isinstance(message, dict):
            raise HTTPException(status_code=400, detail="A conversation message is invalid.")
        role = message.get("role")
        if role == "system":
            continue
        if not isinstance(role, str) or role not in allowed_roles:
            raise HTTPException(status_code=400, detail="Message role is invalid.")
        content = message.get("content", "")
        if not isinstance(content, (str, list, dict)) or len(json.dumps(content, ensure_ascii=False)) > 32_000:
            raise HTTPException(status_code=413, detail="A conversation message is too large or invalid.")
        clean: dict[str, Any] = {"role": role, "content": content}
        if role == "tool":
            call_id = message.get("tool_call_id")
            if not isinstance(call_id, str) or not call_id or len(call_id) > 128:
                raise HTTPException(status_code=400, detail="A tool result is missing its call identifier.")
            clean["tool_call_id"] = call_id
        if "tool_calls" in message:
            if role != "assistant" or not allow_tool_calls:
                raise HTTPException(status_code=400, detail="Tool-call history is not allowed for this request.")
            tool_calls = message["tool_calls"]
            if not isinstance(tool_calls, list) or len(tool_calls) > 8:
                raise HTTPException(status_code=400, detail="Assistant tool-call history is invalid.")
            safe_calls: list[dict[str, Any]] = []
            for call in tool_calls:
                function = call.get("function") if isinstance(call, dict) else None
                name = function.get("name") if isinstance(function, dict) else None
                call_id = call.get("id") if isinstance(call, dict) else None
                if (
                    not isinstance(call_id, str)
                    or not call_id
                    or len(call_id) > 128
                    or not isinstance(name, str)
                    or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", name) is None
                    or (known_tool_names is not None and name not in known_tool_names)
                ):
                    raise HTTPException(status_code=400, detail="Assistant tool-call history is invalid.")
                try:
                    arguments = _parse_tool_arguments(function.get("arguments", "{}"))
                except (ValueError, json.JSONDecodeError) as exc:
                    raise HTTPException(status_code=400, detail="Assistant tool-call arguments are invalid.") from exc
                if len(_canonical_arguments(arguments)) > 128_000:
                    raise HTTPException(status_code=413, detail="Assistant tool-call arguments are too large.")
                safe_calls.append({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": _canonical_arguments(arguments)},
                })
            clean["tool_calls"] = safe_calls
        safe.append(clean)
    return safe


def _tool_call_for_history(call: dict[str, Any]) -> dict[str, Any]:
    raw_function = call.get("function", {})
    function = raw_function if isinstance(raw_function, dict) else {}
    raw_arguments = function.get("arguments", "{}")
    if not isinstance(raw_arguments, (str, dict)):
        raw_arguments = "{}"
    return {
        "id": str(call.get("id") or secrets.token_hex(12)),
        "type": "function",
        "function": {
            "name": function.get("name", "") if isinstance(function.get("name"), str) else "",
            "arguments": raw_arguments if isinstance(raw_arguments, str) else json.dumps(raw_arguments, ensure_ascii=False),
        },
    }


async def _run_agent(messages: list[dict[str, Any]], preferred_model: str | None, session_id: str) -> dict[str, Any]:
    history = _safe_messages(
        messages,
        SYSTEM_PROMPT,
        {"user", "assistant", "tool"},
        allow_tool_calls=True,
        known_tool_names={spec["name"] for spec in tools.public_schemas()},
    )
    last_provider = ""
    last_model = ""
    if session_id not in approval_sockets:
        raise HTTPException(status_code=409, detail="Connect the approval WebSocket before starting an agent turn.")

    schemas = tools.openai_schemas()
    for _ in range(MAX_AGENT_ROUNDS):
        response = await router.complete(history, tools=schemas, preferred_model=preferred_model)
        last_provider, last_model = response.provider, response.model
        if not response.tool_calls:
            reply, emotion = _parse_reply(response.content)
            return {"status": "complete", "reply": reply, "emotion": emotion, "provider": last_provider, "model": last_model, "messages": history}

        normalized_calls = [_tool_call_for_history(call) for call in response.tool_calls]
        history.append({"role": "assistant", "content": response.content or "", "tool_calls": normalized_calls})
        if len(normalized_calls) > 1:
            # Do not batch approvals or execute parallel tool calls. Ask the model
            # to issue a single, inspectable action on its next turn.
            for call in normalized_calls:
                audit_logger.log(
                    "tool_rejected",
                    tool=call["function"].get("name"),
                    status="parallel_tool_calls_disabled",
                    details={"tool_call_id": call["id"], "session_id": session_id},
                )
                history.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"error": "Parallel tool calls are disabled. Propose one action at a time."})})
            continue

        call = normalized_calls[0]
        function = call["function"]
        tool = tools.get(function["name"])
        try:
            arguments = _parse_tool_arguments(function["arguments"])
        except (ValueError, json.JSONDecodeError) as exc:
            audit_logger.log("tool_rejected", tool=function.get("name"), status="invalid_arguments", details={"tool_call_id": call["id"], "error_type": type(exc).__name__})
            history.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"error": str(exc)})})
            continue
        if tool is None:
            audit_logger.log("tool_rejected", tool=function.get("name"), status="tool_not_allowlisted", details={"tool_call_id": call["id"], "session_id": session_id})
            history.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"error": "This tool is not in Shanaya's allow-list."})})
            continue

        pending = _register_pending_approval(tool.spec.name, call["id"], arguments, session_id)
        proposal = {
            "token": pending.token,
            "tool_call_id": call["id"],
            "name": tool.spec.name,
            "description": tool.spec.description,
            "arguments": arguments,
        }
        socket = approval_sockets.get(session_id)
        if socket is None:
            pending_approvals.pop(pending.token, None)
            audit_logger.log("tool_rejected", tool=tool.spec.name, status="approval_channel_missing")
            raise HTTPException(status_code=409, detail="The approval channel closed before the action could be reviewed.")
        try:
            await socket.send_json({"type": "approval_request", "approval": proposal})
        except Exception as exc:
            pending_approvals.pop(pending.token, None)
            audit_logger.log("tool_rejected", tool=tool.spec.name, status="approval_channel_send_failed")
            raise HTTPException(status_code=409, detail="The approval request could not be delivered.") from exc
        return {
            "status": "approval_required",
            "approvals": [proposal],
            "provider": last_provider,
            "model": last_model,
            "messages": history,
        }

    raise HTTPException(status_code=502, detail="The agent reached its tool-call limit. Ask it to continue with a shorter task.")


class AgentRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=40)
    model: str | None = Field(default=None, max_length=120)
    session_id: str | None = Field(default=None, min_length=32, max_length=128)


class AgentStepRequest(BaseModel):
    """One model step for the client-side agent runtime; tools stay in the client."""

    messages: list[dict[str, Any]] = Field(min_length=1, max_length=40)
    tools: list[dict[str, Any]] = Field(default_factory=list, max_length=32)
    model: str | None = Field(default=None, max_length=120)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language: Literal["en-US", "hi-IN", "mr-IN"]
    voice: Literal["Charvi"] = "Charvi"


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/models")
async def models() -> dict[str, Any]:
    return router.public_models()


@app.get("/api/tools")
async def list_tools() -> list[dict[str, Any]]:
    return tools.public_schemas()


@app.post("/api/chat")
async def chat(payload: AgentRequest) -> dict[str, Any]:
    messages = _safe_messages(payload.messages, SYSTEM_PROMPT, {"user", "assistant"})
    try:
        response = await router.complete(messages, preferred_model=payload.model)
    except LLMRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    reply, emotion = _parse_reply(response.content)
    return {"reply": reply, "emotion": emotion, "provider": response.provider, "model": response.model}


@app.post("/api/agent/step")
async def agent_step(payload: AgentStepRequest) -> dict[str, Any]:
    """Return a model step for the primary Node/client agent when it is unavailable.

    This endpoint never executes tools. The client validates returned calls and
    runs its own device tools and confirmation flows as usual.
    """
    messages = _safe_messages(
        payload.messages,
        CLIENT_FALLBACK_SYSTEM_PROMPT,
        {"user", "assistant", "tool"},
        allow_tool_calls=True,
    )

    schemas: list[dict[str, Any]] = []
    for tool in payload.tools:
        if not isinstance(tool, dict):
            raise HTTPException(status_code=400, detail="A client tool schema is invalid.")
        function = tool.get("function")
        if (
            tool.get("type") != "function"
            or not isinstance(function, dict)
            or not isinstance(function.get("name"), str)
            or not function["name"].strip()
            or not isinstance(function.get("parameters"), dict)
            or len(json.dumps(tool, ensure_ascii=False)) > 32_000
        ):
            raise HTTPException(status_code=400, detail="A client tool schema is invalid.")
        schemas.append({
            "type": "function",
            "function": {
                "name": function["name"],
                "description": str(function.get("description", ""))[:2000],
                "parameters": function["parameters"],
            },
        })

    try:
        response = await router.complete(messages, tools=schemas, preferred_model=payload.model)
    except LLMRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"message": {"content": response.content, "tool_calls": response.tool_calls}}


@app.post("/api/agent")
async def agent(payload: AgentRequest) -> dict[str, Any]:
    session_id = payload.session_id
    if not session_id or re.fullmatch(r"[A-Za-z0-9_-]{32,128}", session_id) is None:
        raise HTTPException(status_code=400, detail="A valid approval WebSocket session is required.")
    try:
        return await _run_agent(payload.messages, payload.model, session_id)
    except LLMRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _allowed_websocket_origin(origin: str | None) -> bool:
    if not origin:
        return False
    if origin in cors_origins:
        return True
    if os.getenv("NODE_ENV") == "production":
        return False
    try:
        parsed_origin = urlparse(origin)
        if parsed_origin.scheme not in {"http", "https"} or parsed_origin.username or parsed_origin.password:
            return False
        hostname = parsed_origin.hostname
    except ValueError:
        return False
    return hostname in {"localhost", "127.0.0.1", "::1"}


async def _bounded_tool_result(result: Any) -> Any:
    encoded = json.dumps(result, ensure_ascii=False, default=str)
    if len(encoded) <= MAX_TOOL_OUTPUT_CHARS:
        return result
    if isinstance(result, dict):
        bounded = dict(result)
        for key, value in bounded.items():
            if isinstance(value, str) and len(value) > MAX_TOOL_OUTPUT_CHARS // 2:
                bounded[key] = value[:MAX_TOOL_OUTPUT_CHARS // 2] + "\n[output truncated]"
        return bounded
    return encoded[:MAX_TOOL_OUTPUT_CHARS] + "[output truncated]"


@app.websocket("/api/ws/approvals/{session_id}")
async def approval_socket(websocket: WebSocket, session_id: str) -> None:
    origin = websocket.headers.get("origin")
    if re.fullmatch(r"[A-Za-z0-9_-]{32,128}", session_id) is None or not _allowed_websocket_origin(origin):
        await websocket.close(code=1008)
        return
    if session_id in approval_sockets:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    approval_sockets[session_id] = websocket
    try:
        await websocket.send_json({"type": "ready"})
        while True:
            try:
                message = await websocket.receive_json()
            except ValueError:
                await websocket.send_json({"type": "error", "error": "WebSocket messages must be JSON objects."})
                continue
            if not isinstance(message, dict):
                await websocket.send_json({"type": "error", "error": "WebSocket messages must be JSON objects."})
                continue
            if message.get("type") == "ping":
                if set(message) != {"type"}:
                    await websocket.send_json({"type": "error", "error": "Invalid approval-channel ping."})
                    continue
                await websocket.send_json({"type": "pong"})
                continue
            token = message.get("token")
            decision = message.get("decision")
            if set(message) != {"type", "token", "decision"} or message.get("type") != "approval_response" or not isinstance(token, str) or len(token) > 128 or decision not in {"APPROVE", "REJECT"}:
                await websocket.send_json({"type": "error", "error": "Invalid approval response."})
                continue

            _clean_pending_approvals()
            pending = pending_approvals.get(token)
            if pending is None or pending.session_id != session_id:
                await websocket.send_json({"type": "approval_result", "token": token, "approved": False, "error": "The request expired, belongs to another session, or was already resolved."})
                continue
            pending_approvals.pop(token, None)
            if decision == "REJECT":
                audit_logger.log("tool_rejected", tool=pending.tool_name, status="user_rejected", details={"arguments": pending.arguments})
                await websocket.send_json({"type": "approval_result", "token": token, "approved": False, "tool_call_id": pending.tool_call_id, "result": {"error": "The user rejected this action."}})
                continue

            audit_logger.log("tool_approved", tool=pending.tool_name, status="user_approved", details={"arguments": pending.arguments})
            try:
                result = await _execute_registered_tool(pending.tool_name, pending.arguments, approval=pending)
                bounded_result = await _bounded_tool_result(result)
                serialized_result = json.dumps(bounded_result, ensure_ascii=False, default=str)
                audit_logger.log(
                    "tool_result",
                    tool=pending.tool_name,
                    status="success",
                    details={"output_characters": len(serialized_result), "output_sha256": hashlib.sha256(serialized_result.encode("utf-8")).hexdigest()},
                )
                await websocket.send_json({"type": "approval_result", "token": token, "approved": True, "tool_call_id": pending.tool_call_id, "result": bounded_result})
            except Exception as exc:
                # Do not serialize arbitrary exception details or provider headers.
                audit_logger.log("tool_result", tool=pending.tool_name, status="error", details={"error_type": type(exc).__name__})
                await websocket.send_json({"type": "approval_result", "token": token, "approved": True, "tool_call_id": pending.tool_call_id, "result": {"error": f"The approved tool failed ({type(exc).__name__})."}})
    except WebSocketDisconnect:
        pass
    finally:
        if approval_sockets.get(session_id) is websocket:
            approval_sockets.pop(session_id, None)
        abandoned = [token for token, pending in pending_approvals.items() if pending.session_id == session_id]
        for token in abandoned:
            pending = pending_approvals.pop(token, None)
            if pending:
                audit_logger.log("tool_rejected", tool=pending.tool_name, status="approval_channel_disconnected")


@app.post("/api/tts")
async def synthesize_voice(payload: TTSRequest) -> Response:
    endpoint = os.getenv("MITHI_TTS_URL", "").strip().rstrip("/")
    if not endpoint:
        raise HTTPException(status_code=503, detail="Mithi TTS is not configured on this server.")
    import httpx

    headers = {"Accept": "audio/wav"}
    key = os.getenv("MITHI_TTS_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=5.0), follow_redirects=False) as client:
            async with client.stream(
                "POST",
                f"{endpoint}/synthesize",
                json={"text": payload.text, "language": {"en-US": "en", "hi-IN": "hi", "mr-IN": "mr"}[payload.language], "voice": "charvi"},
                headers=headers,
            ) as result:
                if result.status_code >= 400:
                    raise HTTPException(status_code=502, detail="Mithi TTS rejected the request.")
                audio = bytearray()
                async for chunk in result.aiter_bytes():
                    audio.extend(chunk)
                    if len(audio) > 20 * 1024 * 1024:
                        raise HTTPException(status_code=502, detail="Mithi TTS returned audio larger than the 20 MB limit.")
                if not audio:
                    raise HTTPException(status_code=502, detail="Mithi TTS returned an empty audio response.")
                media_type = result.headers.get("content-type", "audio/wav").split(";", 1)[0]
                if not media_type.startswith("audio/"):
                    raise HTTPException(status_code=502, detail="Mithi TTS returned a non-audio response.")
                return Response(content=bytes(audio), media_type=media_type, headers={"Cache-Control": "no-store"})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach the configured Mithi TTS service.") from exc


@app.post("/api/senses/events")
async def receive_sense_event(request: Request) -> dict[str, Any]:
    if not _is_loopback_client(request):
        raise HTTPException(status_code=403, detail="Kernel event ingestion is loopback-only.")
    try:
        event = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="The eBPF event must be valid JSON.") from exc
    if (
        not isinstance(event, dict)
        or set(event) != {"type", "pid", "uid", "flags", "process"}
        or event.get("type") != "openat"
        or any(isinstance(event.get(key), bool) or not isinstance(event.get(key), int) or event[key] < 0 for key in ("pid", "uid", "flags"))
        or not isinstance(event.get("process"), str)
        or len(event["process"]) > 32
        or len(json.dumps(event, ensure_ascii=False)) > 4096
    ):
        raise HTTPException(status_code=400, detail="The eBPF event is invalid or too large.")
    sense_events.append({**event, "received_at": time.time()})
    return {"accepted": True, "buffered": len(sense_events)}


def _is_loopback_client(request: Request) -> bool:
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower() == "localhost"


@app.get("/api/senses/events")
async def get_sense_events(request: Request, limit: int = 100) -> list[dict[str, Any]]:
    if not _is_loopback_client(request):
        raise HTTPException(status_code=403, detail="Kernel event data is loopback-only.")
    bounded_limit = max(1, min(limit, 500))
    return list(sense_events)[-bounded_limit:]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=SHANAYA_HOST, port=int(os.getenv("SHANAYA_PORT", "8000")))
