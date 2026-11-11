"""FastAPI server for Shanaya's agent loop, tools, voice, and eBPF events."""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import platform
import re
import secrets
import shutil
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from mcp import Client
from mcp.server import MCPServer
from pydantic import BaseModel, Field

from backend.llm_router import ALLOWED_EMOTIONS, LLMRouterError, router

load_dotenv()

SYSTEM_PROMPT = " ".join([
    "You are Shanaya, a cute, calm, intelligent personal companion.",
    "Be candid and nonjudgmental, and support creative role-play and frank discussion without unnecessary moralizing.",
    "Be warm, concise, and useful. Keep private information private and only use it for the user's request.",
    "Use available tools when needed. Call one tool at a time.",
    "Take initiative within the user's stated request and complete bounded multi-step tasks; ask follow-up questions only when an important detail is missing.",
    "The backend pauses every tool call for explicit user confirmation; never claim an action succeeded before its tool result confirms it.",
    'When finished, return only JSON: {"reply":"text","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
])
CLIENT_FALLBACK_SYSTEM_PROMPT = " ".join([
    "You are Shanaya, a cute, calm, intelligent personal companion.",
    "Be candid and nonjudgmental, and support creative role-play and frank discussion without unnecessary moralizing.",
    "Be warm, concise, and useful. Protect the user's privacy.",
    "Use the provided function tools when needed; request one tool at a time. Sensitive device actions use the client's confirmation flow. Never claim a tool succeeded before its result arrives.",
    "Take initiative within the user's stated task and ask follow-up questions only when an important detail is missing.",
    'When finished, return only JSON: {"reply":"text","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
])
MAX_AGENT_ROUNDS = 8
MAX_TOOL_OUTPUT_CHARS = 24_000
APPROVAL_TTL_SECONDS = max(30, int(os.getenv("APPROVAL_TTL_SECONDS", "180")))
MAX_PENDING_APPROVALS = 128
WORKSPACE = Path(os.getenv("SHANAYA_WORKSPACE", ".")).expanduser().resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Project Shanaya API", version="1.0.0")
cors_origins = [origin.strip() for origin in os.getenv(
    "SHANAYA_CORS_ORIGINS",
    "http://localhost:5173,capacitor://localhost,http://localhost",
).split(",") if origin.strip()]
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
    tool_name: str
    tool_call_id: str
    arguments: dict[str, Any]
    created_at: float


class ToolRegistry:
    """Tracks local tool metadata alongside tools discovered through MCP."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, spec: ToolSpec, handler: Any) -> None:
        self._tools[spec.name] = Tool(spec, handler)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def openai_schemas(self, mcp_definitions: list[Any] | None = None) -> list[dict[str, Any]]:
        if mcp_definitions is not None:
            schemas = []
            for definition in mcp_definitions:
                registered = self.get(definition.name)
                if registered is None:
                    continue
                schemas.append({
                    "type": "function",
                    "function": {
                        "name": definition.name,
                        "description": definition.description or registered.spec.description,
                        "parameters": definition.input_schema,
                    },
                })
            return schemas
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
sense_events: deque[dict[str, Any]] = deque(maxlen=500)
# MCP dispatch runs inside the same request context. Destructive handlers check
# this capability independently, so a future call path cannot skip HITL.
_tool_authority: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "shanaya_tool_authority", default=None
)


def _canonical_arguments(arguments: dict[str, Any]) -> str:
    return json.dumps(arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _require_tool_authority(name: str, arguments: dict[str, Any]) -> None:
    if _tool_authority.get() != (name, _canonical_arguments(arguments)):
        raise PermissionError(f"The {name} tool requires a matching, explicit user approval.")


def _workspace_path(raw_path: str) -> Path:
    candidate = (WORKSPACE / raw_path).resolve()
    if not candidate.is_relative_to(WORKSPACE):
        raise ValueError("Path must stay inside the configured Shanaya workspace.")
    return candidate


def _read_file(path: str) -> dict[str, Any]:
    # Keep the capability check at the side-effect boundary, not only at the agent dispatcher.
    _require_tool_authority("read_file", {"path": path})
    target = _workspace_path(path)
    if not target.is_file():
        raise FileNotFoundError("The requested file does not exist in the workspace.")
    if target.stat().st_size > 1_000_000:
        raise ValueError("The requested file is larger than the 1 MB read limit.")
    return {"path": str(target.relative_to(WORKSPACE)), "content": target.read_text(encoding="utf-8", errors="replace")}


def _write_file(path: str, content: str) -> dict[str, Any]:
    _require_tool_authority("write_file", {"path": path, "content": content})
    target = _workspace_path(path)
    if len(content.encode("utf-8")) > 1_000_000:
        raise ValueError("The write is larger than the 1 MB limit.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"path": str(target.relative_to(WORKSPACE)), "bytes_written": target.stat().st_size}


def _system_status() -> dict[str, Any]:
    _require_tool_authority("system_status", {})
    disk = shutil.disk_usage(WORKSPACE)
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "workspace": str(WORKSPACE),
        "disk_free_bytes": disk.free,
        "disk_total_bytes": disk.total,
    }


async def _execute_shell(command: str) -> dict[str, Any]:
    _require_tool_authority("execute_shell", {"command": command})
    if not command.strip() or len(command) > 4000:
        raise ValueError("Provide a shell command up to 4,000 characters.")
    env_names = {"PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "PATHEXT"}
    safe_env = {key: value for key, value in os.environ.items() if key.upper() in env_names}
    process = await asyncio.create_subprocess_shell(
        command,
        cwd=str(WORKSPACE),
        env=safe_env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise TimeoutError("The shell command exceeded the 30 second limit.")
    return {
        "exit_code": process.returncode,
        "stdout": stdout.decode("utf-8", errors="replace")[-MAX_TOOL_OUTPUT_CHARS:],
        "stderr": stderr.decode("utf-8", errors="replace")[-MAX_TOOL_OUTPUT_CHARS:],
    }


tools.register(ToolSpec(
    name="read_file",
    description="After explicit confirmation, read a UTF-8 text file inside the configured workspace. Never use this to search outside the workspace; contents are sent to the selected model provider.",
    parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False},
), _read_file)
tools.register(ToolSpec(
    name="system_status",
    description="After explicit confirmation, return basic OS, CPU, Python, workspace, and free disk status.",
    parameters={"type": "object", "properties": {}, "additionalProperties": False},
), _system_status)
tools.register(ToolSpec(
    name="write_file",
    description="Write a UTF-8 text file inside the configured workspace. This changes files and always requires user approval.",
    parameters={"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": False},
    requires_approval=True,
), _write_file)
tools.register(ToolSpec(
    name="execute_shell",
    description="Run a shell command in the configured workspace with a 30 second timeout and a restricted environment. This can change the system and always requires user approval.",
    parameters={"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"], "additionalProperties": False},
    requires_approval=True,
), _execute_shell)

# The agent uses the official MCP client/server protocol in-process. Each tool
# call is dispatched only after the REST approval flow grants a one-use token.
mcp_server = MCPServer("Shanaya Device Tools", instructions="Local workspace and system tools. The Shanaya host requires explicit approval before every tool executes.")


@mcp_server.tool(name="read_file", description="After explicit user approval, read a UTF-8 text file inside the configured workspace; its contents are sent to the selected model provider.")
def mcp_read_file(path: str) -> dict[str, Any]:
    _require_tool_authority("read_file", {"path": path})
    return _read_file(path)


@mcp_server.tool(name="system_status", description="After explicit user approval, return basic OS, CPU, Python, workspace, and free disk status.")
def mcp_system_status() -> dict[str, Any]:
    _require_tool_authority("system_status", {})
    return _system_status()


@mcp_server.tool(name="write_file", description="Write a UTF-8 text file inside the configured workspace. Requires explicit Shanaya host approval.")
def mcp_write_file(path: str, content: str) -> dict[str, Any]:
    _require_tool_authority("write_file", {"path": path, "content": content})
    return _write_file(path, content)


@mcp_server.tool(name="execute_shell", description="Run a restricted shell command in the configured workspace. Requires explicit Shanaya host approval.")
async def mcp_execute_shell(command: str) -> dict[str, Any]:
    _require_tool_authority("execute_shell", {"command": command})
    return await _execute_shell(command)


def _clean_pending_approvals() -> None:
    now = time.time()
    expired = [token for token, pending in pending_approvals.items() if now - pending.created_at > APPROVAL_TTL_SECONDS]
    for token in expired:
        pending_approvals.pop(token, None)


def _register_pending_approval(name: str, call_id: str, arguments: dict[str, Any]) -> PendingApproval:
    _clean_pending_approvals()
    if len(pending_approvals) >= MAX_PENDING_APPROVALS:
        raise HTTPException(status_code=429, detail="Too many actions are awaiting confirmation. Resolve one before requesting another.")
    token = secrets.token_urlsafe(32)
    pending = PendingApproval(token, name, call_id, arguments, time.time())
    pending_approvals[token] = pending
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
    mcp_client: Any | None = None,
    approval: PendingApproval | None = None,
) -> Any:
    tool = tools.get(name)
    if tool is None:
        raise ValueError(f"Unknown tool: {name}")
    authorized = None
    if tool.spec.requires_approval and (
        approval is None
        or approval.tool_name != name
        or _canonical_arguments(approval.arguments) != _canonical_arguments(arguments)
        or time.time() - approval.created_at > APPROVAL_TTL_SECONDS
    ):
        raise PermissionError(f"The {name} tool requires a matching, unexpired user approval.")
    if tool.spec.requires_approval:
        authorized = (name, _canonical_arguments(arguments))

    authority_token = _tool_authority.set(authorized)
    try:
        if mcp_client is None:
            async with Client(mcp_server) as client:
                return await _call_mcp_tool(client, name, arguments)
        return await _call_mcp_tool(mcp_client, name, arguments)
    finally:
        _tool_authority.reset(authority_token)


async def _call_mcp_tool(mcp_client: Any, name: str, arguments: dict[str, Any]) -> Any:
    result = await mcp_client.call_tool(name, arguments)
    if result.is_error:
        detail = " ".join(getattr(block, "text", "") for block in result.content).strip()
        raise ValueError(detail or f"MCP tool {name} failed.")
    if result.structured_content is not None:
        return result.structured_content
    return "\n".join(getattr(block, "text", "") for block in result.content)


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
        if role not in allowed_roles:
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
                if len(_canonical_arguments(arguments)) > 16_000:
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
    function = call.get("function", {})
    return {
        "id": str(call.get("id") or secrets.token_hex(12)),
        "type": "function",
        "function": {
            "name": str(function.get("name", "")),
            "arguments": function.get("arguments", "{}") if isinstance(function.get("arguments", "{}"), str) else json.dumps(function.get("arguments", {})),
        },
    }


async def _run_agent(messages: list[dict[str, Any]], preferred_model: str | None) -> dict[str, Any]:
    history = _safe_messages(
        messages,
        SYSTEM_PROMPT,
        {"user", "assistant", "tool"},
        allow_tool_calls=True,
        known_tool_names={spec["name"] for spec in tools.public_schemas()},
    )
    last_provider = ""
    last_model = ""

    async with Client(mcp_server) as mcp_client:
        listing = await mcp_client.list_tools()
        schemas = tools.openai_schemas(listing.tools)

        for _ in range(MAX_AGENT_ROUNDS):
            response = await router.complete(history, tools=schemas, preferred_model=preferred_model)
            last_provider, last_model = response.provider, response.model
            if not response.tool_calls:
                reply, emotion = _parse_reply(response.content)
                return {"status": "complete", "reply": reply, "emotion": emotion, "provider": last_provider, "model": last_model, "messages": history}

            normalized_calls = [_tool_call_for_history(call) for call in response.tool_calls]
            history.append({"role": "assistant", "content": response.content or "", "tool_calls": normalized_calls})
            approvals: list[dict[str, Any]] = []
            for call in normalized_calls:
                function = call["function"]
                tool = tools.get(function["name"])
                try:
                    arguments = _parse_tool_arguments(function["arguments"])
                except (ValueError, json.JSONDecodeError) as exc:
                    history.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"error": str(exc)})})
                    continue
                if tool is None:
                    history.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"error": f"Unknown tool: {function['name']}"})})
                    continue
                if tool.spec.requires_approval:
                    pending = _register_pending_approval(tool.spec.name, call["id"], arguments)
                    approvals.append({
                        "token": pending.token,
                        "tool_call_id": call["id"],
                        "name": tool.spec.name,
                        "description": tool.spec.description,
                        "arguments": arguments,
                    })
                    continue
                try:
                    result = await _execute_registered_tool(tool.spec.name, arguments, mcp_client)
                    output = json.dumps(result, ensure_ascii=False, default=str)
                except Exception as exc:
                    output = json.dumps({"error": str(exc)}, ensure_ascii=False)
                history.append({"role": "tool", "tool_call_id": call["id"], "content": output[:MAX_TOOL_OUTPUT_CHARS]})

            if approvals:
                _clean_pending_approvals()
                return {
                    "status": "approval_required",
                    "approvals": approvals,
                    "provider": last_provider,
                    "model": last_model,
                    "messages": history,
                }

    raise HTTPException(status_code=502, detail="The agent reached its tool-call limit. Ask it to continue with a shorter task.")


class AgentRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=40)
    model: str | None = None


class AgentStepRequest(BaseModel):
    """One model step for the client-side agent runtime; tools stay in the client."""

    messages: list[dict[str, Any]] = Field(min_length=1, max_length=40)
    tools: list[dict[str, Any]] = Field(default_factory=list, max_length=32)
    model: str | None = None


class ApprovalRequest(BaseModel):
    token: str = Field(min_length=32, max_length=128)
    approved: bool


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language: Literal["en-US", "hi-IN", "mr-IN"]
    voice: str = "Charvi"


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
    try:
        return await _run_agent(payload.messages, payload.model)
    except LLMRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/approvals")
async def resolve_approval(payload: ApprovalRequest) -> dict[str, Any]:
    _clean_pending_approvals()
    # Tokens stay in the request body so ordinary access logs never capture them.
    pending = pending_approvals.pop(payload.token, None)
    if pending is None:
        raise HTTPException(status_code=404, detail="This confirmation is missing, expired, or already used.")
    if not payload.approved:
        return {"approved": False, "tool_call_id": pending.tool_call_id, "result": {"error": "The user denied this action."}}
    try:
        result = await _execute_registered_tool(pending.tool_name, pending.arguments, approval=pending)
        return {"approved": True, "tool_call_id": pending.tool_call_id, "result": result}
    except Exception as exc:
        return {"approved": True, "tool_call_id": pending.tool_call_id, "result": {"error": str(exc)}}


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
        async with httpx.AsyncClient(timeout=120.0) as client:
            result = await client.post(
                f"{endpoint}/synthesize",
                json={"text": payload.text, "language": {"en-US": "en", "hi-IN": "hi", "mr-IN": "mr"}[payload.language], "voice": "charvi"},
                headers=headers,
            )
        if result.status_code >= 400:
            raise HTTPException(status_code=502, detail="Mithi TTS rejected the request.")
        return Response(content=result.content, media_type=result.headers.get("content-type", "audio/wav"), headers={"Cache-Control": "no-store"})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach the configured Mithi TTS service.") from exc


@app.post("/api/senses/events")
async def receive_sense_event(request: Request) -> dict[str, Any]:
    event = await request.json()
    if not isinstance(event, dict) or len(json.dumps(event, ensure_ascii=False)) > 4096:
        raise HTTPException(status_code=400, detail="The eBPF event is invalid or too large.")
    sense_events.append({**event, "received_at": time.time()})
    return {"accepted": True, "buffered": len(sense_events)}


@app.get("/api/senses/events")
async def get_sense_events(limit: int = 100) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 500))
    return list(sense_events)[-bounded_limit:]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("SHANAYA_HOST", "127.0.0.1"), port=int(os.getenv("SHANAYA_PORT", "8000")))
