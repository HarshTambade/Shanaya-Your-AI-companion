# Shanaya API Integration Guide

This guide explains how to run, configure, and integrate with the Shanaya Express API. The API is the server-side boundary for cloud inference, Ollama, agent tool calls, text-to-speech proxying, desktop computer use, Pinecall token exchange, and optional MCP access.

## Base URL

Local development:

```text
http://localhost:3001
```

In production, use the HTTPS API origin or the same-origin `/api` path exposed by Vercel. Never expose provider credentials in client-side `VITE_*` variables.

## Start the API

```bash
npm install --prefix server
cp server/.env.example server/.env
npm run dev:server
```

Health check:

```bash
curl http://localhost:3001/api/health
```

## Configuration

Minimum cloud configuration:

```dotenv
PORT=3001
HOST=127.0.0.1
CLIENT_ORIGIN=http://localhost:5173
GROQ_API_KEY=replace_with_your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
GROQ_MODEL_FALLBACKS=openai/gpt-oss-20b,llama-3.1-8b-instant
```

Important variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP port; defaults to `3001`. |
| `HOST` | No | Bind address; defaults to `127.0.0.1`. |
| `CLIENT_ORIGIN` | No | Comma-separated browser origins allowed by CORS. |
| `GROQ_API_KEY` | No | Server-side Groq credential. |
| `GROQ_MODEL` | No | Primary cloud model. |
| `GROQ_MODEL_FALLBACKS` | No | Comma-separated fallback models. |
| `CLOUD_API_URL` | No | OpenAI-compatible completion endpoint when not using Groq. |
| `CLOUD_API_KEY` | No | Credential for the custom cloud provider. |
| `OLLAMA_BASE_URL` | No | Ollama server URL; defaults to `http://localhost:11434`. |
| `OLLAMA_MODEL` | No | Ollama model used by `mode: "ollama"`. |
| `CLOUD_REQUEST_TIMEOUT_MS` | No | Cloud request timeout, clamped to 3–120 seconds. |
| `MITHI_TTS_URL` | No | Optional Mithi `/synthesize` service URL. |
| `PINECALL_TOKEN_URL` | No | Trusted server-side Pinecall token issuer. |
| `ANTHROPIC_API_KEY` | No | Enables Electron desktop computer use. |
| `MCP_ENABLED` | No | Enables the authenticated `/mcp` endpoint when `true`. |
| `MCP_API_TOKEN` | No | Bearer token of at least 32 characters for remote MCP. |

## Common response conventions

JSON endpoints return an object with an `error` field for failures:

```json
{
  "error": "A human-readable explanation"
}
```

Callers should handle:

- `400`: invalid request body, unsupported mode, or invalid credential format.
- `401`/`403`: rejected provider credential or missing MCP authorization.
- `502`: upstream provider, TTS, Pinecall, or MCP failure.
- `503`: a required integration is not configured.

## Endpoints

### `GET /api/health`

Returns API and provider readiness without returning credentials:

```json
{
  "status": "ok",
  "provider": "Groq",
  "ready": true
}
```

Use this for deployment checks and client status indicators. `ready: false` means the server is reachable but cloud credentials or models are not configured.

### `GET /api/models`

Lists models configured for cloud requests:

```json
{
  "provider": "Groq",
  "defaultModel": "openai/gpt-oss-120b",
  "models": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
}
```

### `POST /api/chat`

The simple conversation endpoint. `messages` must contain 1–40 user or assistant messages, each with non-empty content of at most 4,000 characters.

```bash
curl -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "cloud",
    "messages": [
      {"role": "user", "content": "Give me a short welcome."}
    ]
  }'
```

Successful response:

```json
{
  "reply": "Welcome. I am Shanaya, and I am glad you are here.",
  "emotion": "happy"
}
```

Supported modes:

- `cloud`: Groq or the configured OpenAI-compatible provider.
- `ollama`: the configured local Ollama server.
- WebLLM and native llama.cpp inference run directly in the client and do not use this endpoint.

For a private development installation, a caller may provide a temporary Groq key with `x-groq-api-key`. The server accepts that header only when the configured provider is the official Groq HTTPS API. Do not collect or transmit user keys through an untrusted public deployment; prefer a server-side secret manager.

### `POST /api/agent`

Runs one agent step and returns text and/or tool calls. The client executes approved tools and submits the result in a later step.

```json
{
  "mode": "cloud",
  "model": "openai/gpt-oss-120b",
  "messages": [
    {"role": "user", "content": "What is the weather workflow?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_status",
        "description": "Read the current application status.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": false}
      }
    }
  ]
}
```

Response shape:

```json
{
  "message": {
    "content": "I can check that.",
    "tool_calls": []
  }
}
```

Tools are bounded and validated by the client. Sensitive actions must remain confirmation-gated.

### `POST /api/tts`

Proxies validated text to Mithi and returns `audio/wav`. The supported language values are `en-US`, `hi-IN`, and `mr-IN`.

```bash
curl -X POST http://localhost:3001/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"नमस्ते, मैं शनाया हूँ।","language":"hi-IN"}' \
  --output reply.wav
```

If `MITHI_TTS_URL` is not configured, the endpoint returns `503`; the client can fall back to the installed system voice.

### `GET /api/pinecall/token`

Fetches short-lived call credentials from the trusted `PINECALL_TOKEN_URL`. The browser never receives the Pinecall API key. The issuer must return:

```json
{
  "token": "short-lived-token",
  "server": "pinecall-server.example",
  "expires_in": 3600
}
```

### `POST /api/desktop/computer`

Uses the server-side Anthropic computer tool for the Electron desktop bridge. It requires `ANTHROPIC_API_KEY`, accepts validated user/assistant messages, and should only be called by a trusted Electron client with confirmation UI.

### `POST /mcp`

Available only when `MCP_ENABLED=true`. Send:

```http
Authorization: Bearer <MCP_API_TOKEN>
```

The token must be at least 32 characters. The endpoint exposes the `shanaya_chat`, `shanaya_status`, and `shanaya_models` MCP tools. Keep it private and use HTTPS in production.

## Frontend integration

Use same-origin URLs when the client and API share a domain:

```ts
const response = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "cloud",
    messages: [{ role: "user", content: "Hello, Shanaya!" }],
  }),
});

if (!response.ok) {
  const failure = await response.json().catch(() => ({ error: "API request failed." }));
  throw new Error(failure.error || "API request failed.");
}

const result: { reply: string; emotion: string } = await response.json();
```

For a separate frontend origin, set `VITE_API_BASE_URL` and include that exact origin in `CLIENT_ORIGIN`.

## Security checklist

- Keep `server/.env` out of Git and rotate any credential that has been pasted into chat, screenshots, commits, logs, or issue comments.
- Never put `GROQ_API_KEY`, `CLOUD_API_KEY`, `ANTHROPIC_API_KEY`, `PINECALL_TOKEN_URL` credentials, or `MCP_API_TOKEN` in `VITE_*`.
- Use HTTPS for production API, MCP, token issuer, and TTS URLs.
- Restrict `CLIENT_ORIGIN` to exact trusted origins.
- Add authentication, rate limiting, quotas, and request observability before exposing the API to multiple users.
- Do not log request bodies or conversation content by default.
