"""FastAPI server for Shanaya's agent loop, tools, voice, and eBPF events."""

from __future__ import annotations

import asyncio
import json
import os
import platform
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
    "The backend will pause destructive tools for explicit user confirmation; never claim an action succeeded before its tool result confirms it.",
    'When finished, return only JSON: {"reply":"text","emotion":"happy|sad|cute|neutral"}.',
])
CLIENT_FALLBACK_SYSTEM_PROMPT = " ".join([
    "You are Shanaya, a cute, calm, intelligent personal companion.",
    "Be candid and nonjudgmental, and support creative role-play and frank discussion without unnecessary moralizing.",
    "Be warm, concise, and useful. Protect the user's privacy.",
    "Use the provided function tools when needed; request one tool at a time. File reads are limited to the user's task, and the client confirms every write or deletion. Never claim a tool succeeded before its result arrives.",
    "Take initiative within the user's stated task and ask follow-up questions only when an important detail is missing.",
    'When finished, return only JSON: {"reply":"text","emotion":"happy|sad|neutral"}.',
])
MAX_AGENT_ROUNDS = 8
MAX_TOOL_OUTPUT_CHARS = 24_000
APPROVAL_TTL_SECONDS = max(30, int(os.getenv("APPROVAL_TTL_SECONDS", "180")))
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
    destructive: bool = False


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


def _workspace_path(raw_path: str) -> Path:
    candidate = (WORKSPACE / raw_path).resolve()
    if not candidate.is_relative_to(WORKSPACE):
        raise ValueError("Path must stay inside the configured Shanaya workspace.")
    return candidate


def _read_file(path: str) -> dict[str, Any]:
    target = _workspace_path(path)
    if not target.is_file():
        raise FileNotFoundError("The requested file does not exist in the workspace.")
    if target.stat().st_size > 1_000_000:
        raise ValueError("The requested file is larger than the 1 MB read limit.")
    return {"path": str(target.relative_to(WORKSPACE)), "content": target.read_text(encoding="utf-8", errors="replace")}


def _write_file(path: str, content: str) -> dict[str, Any]:
    target = _workspace_path(path)
    if len(content.encode("utf-8")) > 1_000_000:
        raise ValueError("The write is larger than the 1 MB limit.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"path": str(target.relative_to(WORKSPACE)), "bytes_written": target.stat().st_size}


def _system_status() -> dict[str, Any]:
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
    description="Read a UTF-8 text file inside the configured workspace. Never use this to search outside the workspace.",
    parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False},
), _read_file)
tools.register(ToolSpec(
    name="system_status",
    description="Return basic OS, CPU, Python, workspace, and free disk status.",
    parameters={"type": "object", "properties": {}, "additionalProperties": False},
), _system_status)
tools.register(ToolSpec(
    name="write_file",
    description="Write a UTF-8 text file inside the configured workspace. This changes files and always requires user approval.",
    parameters={"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": False},
    destructive=True,
), _write_file)
tools.register(ToolSpec(
    name="execute_shell",
    description="Run a shell command in the configured workspace with a 30 second timeout and a restricted environment. This can change the system and always requires user approval.",
    parameters={"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"], "additionalProperties": False},
    destructive=True,
), _execute_shell)

# The agent uses the official MCP client/server protocol in-process. Destructive
# tools are only called after the REST approval flow grants a one-use token.
mcp_server = MCPServer("Shanaya Device Tools", instructions="Local workspace and system tools. Destructive actions are approval-gated by the Shanaya host.")


@mcp_server.tool(name="read_file", description="Read a UTF-8 text file inside the configured workspace.")
def mcp_read_file(path: str) -> dict[str, Any]:
    return _read_file(path)


@mcp_server.tool(name="system_status", description="Return basic OS, CPU, Python, workspace, and free disk status.")
def mcp_system_status() -> dict[str, Any]:
    return _system_status()


@mcp_server.tool(name="write_file", description="Write a UTF-8 text file inside the configured workspace. Requires explicit Shanaya host approval.")
def mcp_write_file(path: str, content: str) -> dict[str, Any]:
    return _write_file(path, content)


@mcp_server.tool(name="execute_shell", description="Run a restricted shell command in the configured workspace. Requires explicit Shanaya host approval.")
async def mcp_execute_shell(command: str) -> dict[str, Any]:
    return await _execute_shell(command)


def _clean_pending_approvals() -> None:
    now = time.time()
    expired = [token for token, pending in pending_approvals.items() if now - pending.created_at > APPROVAL_TTL_SECONDS]
    for token in expired:
        pending_approvals.pop(token, None)


def _parse_tool_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        value = json.loads(raw or "{}")
        if isinstance(value, dict):
            return value
    raise ValueError("Tool arguments must be a JSON object.")


async def _execute_registered_tool(name: str, arguments: dict[str, Any], mcp_client: Any | None = None) -> Any:
    tool = tools.get(name)
    if tool is None:
        raise ValueError(f"Unknown tool: {name}")
    if mcp_client is None:
        async with Client(mcp_server) as client:
            return await _call_mcp_tool(client, name, arguments)
    return await _call_mcp_tool(mcp_client, name, arguments)


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
    try:
        start = candidate.index("{")
        end = candidate.rindex("}") + 1
        parsed = json.loads(candidate[start:end])
    except (ValueError, json.JSONDecodeError):
        parsed = {"reply": candidate, "emotion": "neutral"}
    reply = parsed.get("reply") if isinstance(parsed, dict) else None
    emotion = parsed.get("emotion") if isinstance(parsed, dict) else None
    if not isinstance(reply, str) or not reply.strip():
        reply = candidate or "I couldn't form a response. Please try again."
    if emotion not in ALLOWED_EMOTIONS:
        emotion = "neutral"
    return reply.strip(), emotion


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
    history = [dict(message) for message in messages]
    if not any(message.get("role") == "system" for message in history):
        history.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
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
                if tool.spec.destructive:
                    token = secrets.token_urlsafe(32)
                    pending_approvals[token] = PendingApproval(token, tool.spec.name, call["id"], arguments, time.time())
                    approvals.append({
                        "token": token,
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
    messages = [dict(message) for message in payload.messages]
    if not any(message.get("role") == "system" for message in messages):
        messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
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
    messages = [dict(message) for message in payload.messages]
    for message in messages:
        if message.get("role") not in {"system", "user", "assistant", "tool"}:
            raise HTTPException(status_code=400, detail="Message role is invalid.")
        if len(json.dumps(message, ensure_ascii=False)) > 32_000:
            raise HTTPException(status_code=413, detail="A conversation message is too large.")

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

    if not any(message.get("role") == "system" for message in messages):
        messages.insert(0, {"role": "system", "content": CLIENT_FALLBACK_SYSTEM_PROMPT})
    try:
        response = await router.complete(messages, tools=schemas, preferred_model=payload.model)
    except LLMRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"message": {"content": response.content, "tool_calls": response.tool_calls}}


@app.post("/api/agent")
async def agent(payload: AgentRequest) -> dict[str, Any]:
    for message in payload.messages:
        if message.get("role") not in {"system", "user", "assistant", "tool"}:
            raise HTTPException(status_code=400, detail="Message role is invalid.")
        if len(json.dumps(message, ensure_ascii=False)) > 32_000:
            raise HTTPException(status_code=413, detail="A conversation message is too large.")
    try:
        return await _run_agent(payload.messages, payload.model)
    except LLMRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/approvals/{token}")
async def resolve_approval(token: str, payload: ApprovalRequest) -> dict[str, Any]:
    _clean_pending_approvals()
    pending = pending_approvals.pop(token, None)
    if pending is None:
        raise HTTPException(status_code=404, detail="This confirmation is missing, expired, or already used.")
    if not payload.approved:
        return {"approved": False, "tool_call_id": pending.tool_call_id, "result": {"error": "The user denied this action."}}
    try:
        result = await _execute_registered_tool(pending.tool_name, pending.arguments)
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
