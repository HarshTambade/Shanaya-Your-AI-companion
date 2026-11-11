"""Configurable multi-provider model router with strict provider-tier fallback."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

logger = logging.getLogger("shanaya.llm")
ALLOWED_EMOTIONS = {"happy", "sad", "cute", "neutral"}
DEFAULT_GROQ_MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    # Graceful model-ID fallback for accounts where the requested Llama IDs
    # have been retired or are unavailable on their Groq plan.
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
]
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
OPENAI_BASE_URL = "https://api.openai.com/v1"
GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
# Keep failed cloud attempts short so an offline device can reach local inference.
NETWORK_TIMEOUT = httpx.Timeout(15.0, connect=2.5, read=15.0, write=5.0, pool=3.0)


def _csv(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


@dataclass(frozen=True)
class Candidate:
    tier: int
    provider: str
    model: str
    api_key: str = ""
    base_url: str = ""


@dataclass
class ModelResponse:
    content: str
    tool_calls: list[dict[str, Any]]
    provider: str
    model: str


class LLMRouterError(RuntimeError):
    """Raised after every configured provider/model has failed."""


class LLMRouter:
    """Routes a request through Groq, optional global APIs, then local inference."""

    def __init__(self) -> None:
        self._llama: Any | None = None
        self._llama_lock = asyncio.Lock()

    def candidates(self) -> list[Candidate]:
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        openai_key = os.getenv("OPENAI_API_KEY", "").strip()
        anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        candidates: list[Candidate] = []

        if groq_key:
            # The requested Llama pair always stays first and in order. Any
            # operator-specific models follow the built-in modern fallbacks.
            configured_models = _csv("GROQ_MODELS")
            groq_models = list(dict.fromkeys([*DEFAULT_GROQ_MODELS, *configured_models]))
            candidates.extend(Candidate(1, "Groq", model, groq_key, GROQ_BASE_URL) for model in groq_models)

        if openai_key:
            candidates.extend(Candidate(2, "OpenAI", model, openai_key, OPENAI_BASE_URL) for model in _csv("OPENAI_MODELS", "gpt-4o"))
        if anthropic_key:
            candidates.extend(Candidate(2, "Anthropic", model, anthropic_key) for model in _csv("ANTHROPIC_MODELS", "claude-sonnet-5"))
        if gemini_key:
            candidates.extend(Candidate(2, "Gemini", model, gemini_key, GEMINI_OPENAI_BASE_URL) for model in _csv("GEMINI_MODELS", "gemini-3.8-flash"))

        local_path = os.getenv("LLAMA_CPP_MODEL_PATH", "").strip()
        if local_path:
            candidates.append(Candidate(3, "llama.cpp", os.path.basename(local_path)))

        local_base_url = os.getenv("LOCAL_LLM_BASE_URL", "").strip()
        if local_base_url:
            local_model = os.getenv("LOCAL_LLM_MODEL", "local-model").strip()
            candidates.append(Candidate(3, "Local OpenAI-compatible", local_model, os.getenv("LOCAL_LLM_API_KEY", "not-needed"), local_base_url))

        return candidates

    def public_models(self) -> dict[str, Any]:
        candidates = self.candidates()
        tiers: dict[str, list[dict[str, str]]] = {"groq": [], "secondary": [], "local": []}
        for candidate in candidates:
            key = "groq" if candidate.tier == 1 else "secondary" if candidate.tier == 2 else "local"
            tiers[key].append({"provider": candidate.provider, "model": candidate.model})
        return {
            "provider": candidates[0].provider if candidates else "Local WebLLM",
            "defaultModel": candidates[0].model if candidates else "WebLLM",
            "tiers": tiers,
        }

    def _ordered_candidates(self, preferred_model: str | None) -> list[Candidate]:
        candidates = self.candidates()
        if not preferred_model:
            return candidates
        # The configured Groq sequence is strict. A UI selection can only
        # change order inside the optional secondary tier.
        for tier in (2,):
            tier_candidates = [item for item in candidates if item.tier == tier]
            selected = [item for item in tier_candidates if item.model == preferred_model]
            if selected:
                remaining = [item for item in tier_candidates if item.model != preferred_model]
                before = [item for item in candidates if item.tier < tier]
                after = [item for item in candidates if item.tier > tier]
                return before + selected + remaining + after
        return candidates

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        preferred_model: str | None = None,
    ) -> ModelResponse:
        errors: list[str] = []
        cloud_unreachable = False
        for candidate in self._ordered_candidates(preferred_model):
            # A broken network path should not make every cloud model wait for
            # its own timeout. Try the first local candidate immediately.
            if cloud_unreachable and candidate.tier < 3:
                continue
            try:
                result = await self._call(candidate, messages, tools or [])
                return self._normalize(result, candidate)
            except Exception as exc:  # Provider errors intentionally trigger the next candidate.
                error_name = type(exc).__name__
                errors.append(f"{candidate.provider}/{candidate.model}: {error_name}")
                if getattr(exc, "status_code", None) == 429:
                    logger.warning("Model request was rate limited for %s/%s; trying the next route", candidate.provider, candidate.model)
                else:
                    logger.warning("Model request failed for %s/%s (%s)", candidate.provider, candidate.model, error_name)
                if candidate.tier < 3 and self._is_transport_failure(exc):
                    cloud_unreachable = True
        details = "; ".join(errors) if errors else "no API keys or local model are configured"
        raise LLMRouterError(f"All configured model routes failed: {details}")

    async def _call(self, candidate: Candidate, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
        if candidate.provider == "Anthropic":
            return await self._call_anthropic(candidate, messages, tools)
        if candidate.provider == "llama.cpp":
            return await self._call_llama_cpp(messages, tools)

        client = AsyncOpenAI(
            api_key=candidate.api_key,
            base_url=candidate.base_url,
            timeout=NETWORK_TIMEOUT,
            max_retries=0,
        )
        try:
            params: dict[str, Any] = {
                "model": candidate.model,
                "messages": messages,
                "temperature": 0.4,
                "max_tokens": 1400 if tools else 800,
            }
            if tools:
                params["tools"] = tools
                params["tool_choice"] = "auto"
            else:
                params["response_format"] = {"type": "json_object"}
            return await client.chat.completions.create(**params)
        finally:
            await client.close()

    async def _call_anthropic(self, candidate: Candidate, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
        system_parts = [str(message.get("content", "")) for message in messages if message.get("role") == "system"]
        anthropic_messages: list[dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            if role == "system":
                continue
            if role == "tool":
                result = {"type": "tool_result", "tool_use_id": message.get("tool_call_id", ""), "content": str(message.get("content", ""))}
                if anthropic_messages and anthropic_messages[-1]["role"] == "user" and isinstance(anthropic_messages[-1]["content"], list):
                    anthropic_messages[-1]["content"].append(result)
                else:
                    anthropic_messages.append({"role": "user", "content": [result]})
                continue
            content: Any = str(message.get("content", ""))
            if role == "assistant" and message.get("tool_calls"):
                blocks: list[dict[str, Any]] = []
                if content:
                    blocks.append({"type": "text", "text": content})
                for call in message["tool_calls"]:
                    function = call.get("function", {})
                    arguments = function.get("arguments", {})
                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments)
                        except json.JSONDecodeError:
                            arguments = {}
                    blocks.append({"type": "tool_use", "id": call.get("id", ""), "name": function.get("name", ""), "input": arguments})
                content = blocks
            anthropic_messages.append({"role": "assistant" if role == "assistant" else "user", "content": content})

        converted_tools = []
        for tool in tools:
            function = tool.get("function", {})
            converted_tools.append({
                "name": function.get("name", ""),
                "description": function.get("description", ""),
                "input_schema": function.get("parameters", {"type": "object", "properties": {}}),
            })
        client = AsyncAnthropic(api_key=candidate.api_key, timeout=NETWORK_TIMEOUT, max_retries=0)
        try:
            params: dict[str, Any] = {
                "model": candidate.model,
                "max_tokens": 1400,
                "system": "\n".join(system_parts),
                "messages": anthropic_messages,
            }
            if converted_tools:
                params["tools"] = converted_tools
            return await client.messages.create(**params)
        finally:
            await client.close()

    async def _call_llama_cpp(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
        async with self._llama_lock:
            if self._llama is None:
                from llama_cpp import Llama

                self._llama = await asyncio.to_thread(
                    Llama,
                    model_path=os.environ["LLAMA_CPP_MODEL_PATH"],
                    n_ctx=int(os.getenv("LLAMA_CPP_N_CTX", "4096")),
                    n_threads=int(os.getenv("LLAMA_CPP_N_THREADS", "4")),
                    verbose=False,
                )
        params: dict[str, Any] = {"messages": messages, "temperature": 0.4, "max_tokens": 1400 if tools else 800}
        if tools:
            params["tools"] = tools
            params["tool_choice"] = "auto"
        else:
            params["response_format"] = {"type": "json_object"}
        return await asyncio.to_thread(self._llama.create_chat_completion, **params)

    def _normalize(self, response: Any, candidate: Candidate) -> ModelResponse:
        if candidate.provider == "Anthropic":
            blocks = getattr(response, "content", []) or []
            text = "\n".join(block.text for block in blocks if getattr(block, "type", "") == "text")
            tool_calls = [
                {
                    "id": block.id,
                    "type": "function",
                    "function": {"name": block.name, "arguments": json.dumps(block.input, separators=(",", ":"))},
                }
                for block in blocks if getattr(block, "type", "") == "tool_use"
            ]
            return ModelResponse(text, tool_calls, candidate.provider, candidate.model)

        if isinstance(response, dict):
            message = response.get("choices", [{}])[0].get("message", {})
        else:
            message = response.choices[0].message
        content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
        raw_calls = message.get("tool_calls", []) if isinstance(message, dict) else getattr(message, "tool_calls", [])
        tool_calls = []
        for call in raw_calls or []:
            if isinstance(call, dict):
                tool_calls.append(call)
            else:
                function = call.function
                arguments = function.arguments
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments or {})
                tool_calls.append({"id": call.id, "type": "function", "function": {"name": function.name, "arguments": arguments}})
        text = str(content or "").strip()
        if not tool_calls:
            text = self._structured_json(text)
        return ModelResponse(text, tool_calls, candidate.provider, candidate.model)

    @staticmethod
    def _structured_json(content: str) -> str:
        candidate_text = content.strip().lstrip("\ufeff")
        candidate_text = re.sub(r"^\s*```(?:[a-z0-9_-]+)?\s*|\s*```\s*$", "", candidate_text, flags=re.IGNORECASE).strip()
        decoder = json.JSONDecoder()
        parsed: Any = None
        for start, character in enumerate(candidate_text):
            if character != "{":
                continue
            try:
                value, _end = decoder.raw_decode(candidate_text[start:])
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                parsed = value
                break
        if parsed is None:
            parsed = {"reply": candidate_text, "emotion": "neutral"}
        reply = parsed.get("reply") if isinstance(parsed, dict) else None
        emotion = parsed.get("emotion") if isinstance(parsed, dict) else None
        if not isinstance(reply, str) or not reply.strip():
            reply = candidate_text or "I couldn't form a response. Please try again."
        # Validate the type before set membership; malformed model JSON may use an array/object here.
        if not isinstance(emotion, str) or emotion not in ALLOWED_EMOTIONS:
            emotion = "neutral"
        return json.dumps({"reply": reply.strip(), "emotion": emotion}, ensure_ascii=False)

    @staticmethod
    def _is_transport_failure(error: Exception) -> bool:
        if isinstance(error, httpx.TransportError):
            return True
        # SDK connection and timeout wrappers preserve only the exception class
        # at this boundary; do not inspect or log messages that could contain
        # request headers or user data.
        return type(error).__name__ in {
            "APIConnectionError",
            "APITimeoutError",
            "ConnectionError",
            "TimeoutError",
        }


router = LLMRouter()
