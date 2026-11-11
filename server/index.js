require("dotenv").config();

const cors = require("cors");
const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3001;
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173,capacitor://localhost,http://localhost,https://localhost")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const localDevelopmentHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const corsOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  if (process.env.NODE_ENV !== "production") {
    try {
      if (localDevelopmentHosts.has(new URL(origin).hostname)) return callback(null, true);
    } catch {
      // Invalid Origin values are rejected below.
    }
  }
  return callback(null, false);
};
const defaultGroqApiUrl = "https://api.groq.com/openai/v1/chat/completions";
const cloudApiUrl = process.env.GROQ_API_URL || process.env.CLOUD_API_URL || defaultGroqApiUrl;
const isGroqProvider = cloudApiUrl.startsWith("https://api.groq.com/");
const cloudApiKey = isGroqProvider
  ? process.env.GROQ_API_KEY || process.env.CLOUD_API_KEY
  : process.env.CLOUD_API_KEY || process.env.GROQ_API_KEY;
const configuredPrimaryModels = (
  process.env.GROQ_MODEL ||
  process.env.CLOUD_MODEL ||
  ""
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const configuredFallbacks = (
  process.env.GROQ_MODEL_FALLBACKS ||
  process.env.CLOUD_MODEL_FALLBACKS ||
  ""
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const primaryCloudModel = configuredPrimaryModels.shift() || configuredFallbacks.shift() || (isGroqProvider ? "openai/gpt-oss-120b" : "");
const cloudModels = [...new Set([
  primaryCloudModel,
  ...configuredPrimaryModels,
  ...configuredFallbacks,
  ...(isGroqProvider && !process.env.GROQ_MODEL_FALLBACKS && !process.env.CLOUD_MODEL_FALLBACKS ? ["openai/gpt-oss-20b"] : []),
].filter(Boolean))];
const cloudProvider = isGroqProvider ? "Groq" : "Custom";
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
const ollamaModel = process.env.OLLAMA_MODEL || "gurubot/self-after-dark:latest";
const systemPrompt = [
  "You are Shanaya, a warm, candid, nonjudgmental companion and capable personal assistant. Be open to creative role-play and frank discussion without unnecessary moralizing.",
  "Take initiative within the user's stated request and use available tools to complete bounded multi-step tasks. Ask a follow-up only when an important detail is missing.",
  "Respect the user's privacy and all app confirmation flows. Sending messages, changing settings, spending money, writing or deleting files, and controlling a computer require confirmation. Never claim an action succeeded before its tool result confirms it.",
  'Respond only as a JSON object with this exact shape: {"reply":"your message","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
  "Use one allowed emotion that best matches the tone of your reply. Do not wrap the JSON in markdown.",
].join(" ");
const allowedEmotions = new Set(["happy", "sad", "angry", "neutral", "surprised", "thinking"]);

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "12mb" }));

if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const startedAt = Date.now();
    res.on("finish", () => {
      console.info(`[api] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", provider: cloudProvider, ready: Boolean(cloudApiKey && cloudModels.length) });
});

app.get("/api/models", (_req, res) => {
  res.json({ provider: cloudProvider, defaultModel: cloudModels[0] || "", models: cloudModels });
});

app.get("/api/pinecall/token", async (_req, res) => {
  const tokenIssuerUrl = process.env.PINECALL_TOKEN_URL;
  if (!tokenIssuerUrl) {
    return res.status(503).json({ error: "Configure PINECALL_TOKEN_URL with your server-side Pinecall token issuer to enable voice calls." });
  }

  try {
    const response = await fetch(tokenIssuerUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || typeof token.token !== "string" || typeof token.server !== "string") {
      return res.status(502).json({ error: "The Pinecall token issuer returned an invalid response." });
    }
    return res.json({ token: token.token, server: token.server, expires_in: token.expires_in ?? token.expiresIn });
  } catch (error) {
    console.error("Pinecall token issuer request failed:", error.message);
    return res.status(502).json({ error: "Could not get a call token. Check the Pinecall token issuer configuration." });
  }
});

function parseAssistantOutput(content) {
  const candidate = content.match(/\{[\s\S]*\}/)?.[0] || content;
  try {
    const parsed = JSON.parse(candidate);
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const emotion = allowedEmotions.has(parsed.emotion) ? parsed.emotion : "neutral";
    if (reply) return { reply, emotion };
  } catch {
    // Fall back to plain text if a local model does not follow the JSON instruction.
  }
  return { reply: content.trim(), emotion: "neutral" };
}

async function requestCloud(messages, models = cloudModels) {
  if (!cloudApiKey || models.length === 0) throw new Error("Add GROQ_API_KEY (or CLOUD_API_KEY for an alternate provider) to server/.env to enable cloud AI.");

  let lastError;
  for (const model of models) {
    try {
      const response = await fetch(cloudApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          response_format: { type: "json_object" },
          temperature: 0.7,
          max_completion_tokens: 700,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const completion = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Cloud endpoint returned HTTP ${response.status}.`);
      const content = completion.choices?.[0]?.message?.content?.trim();
      if (content) return parseAssistantOutput(content);
      lastError = new Error(`${model} returned an empty response.`);
    } catch (error) {
      lastError = error;
      console.warn(`Cloud model ${model} failed; trying the next configured model.`);
    }
  }
  throw lastError || new Error("No cloud models are configured.");
}

async function requestOllama(messages) {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      format: "json",
      stream: false,
      options: { temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ollama returned HTTP ${response.status}.`);
  const content = data.message?.content?.trim();
  if (!content) throw new Error("Ollama returned an empty response.");
  return parseAssistantOutput(content);
}

function isValidAgentMessage(message) {
  if (!message || !["user", "assistant", "tool"].includes(message.role)) return false;
  if (typeof message.content !== "string" || message.content.length > 8000) return false;
  if (message.role === "tool" && (typeof message.tool_call_id !== "string" || message.tool_call_id.length > 160)) return false;
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 8) return false;
    if (!message.tool_calls.every((call) => call && typeof call.id === "string" && call.function && typeof call.function.name === "string" && typeof call.function.arguments === "string")) return false;
  }
  return true;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 20) return null;
  const normalized = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(fn.name)) return null;
    if (!fn.parameters || typeof fn.parameters !== "object" || fn.parameters.type !== "object") return null;
    normalized.push({ type: "function", function: { name: fn.name, description: String(fn.description || "").slice(0, 1000), parameters: fn.parameters } });
  }
  return normalized;
}

async function requestCloudAgent(messages, tools, models = cloudModels) {
  if (!cloudApiKey || models.length === 0) throw new Error("Add GROQ_API_KEY (or CLOUD_API_KEY for an alternate provider) to server/.env to enable cloud AI.");
  let lastError;
  for (const model of models) {
    try {
      const response = await fetch(cloudApiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${cloudApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: `${systemPrompt} When useful, call the provided tools. Never say an action succeeded before the tool result confirms it.` },
            ...messages,
          ],
          tools,
          tool_choice: "auto",
          temperature: 0.4,
          max_completion_tokens: 900,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Cloud endpoint returned HTTP ${response.status}.`);
      const message = data.choices?.[0]?.message;
      if (message && (typeof message.content === "string" || Array.isArray(message.tool_calls))) return message;
      lastError = new Error(`${model} returned neither a reply nor a tool request.`);
    } catch (error) {
      lastError = error;
      console.warn(`Cloud agent model ${model} failed; trying the next configured model.`);
    }
  }
  throw lastError || new Error("No cloud agent models are configured.");
}

async function requestOllamaAgent(messages, tools) {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "system", content: `${systemPrompt} Use the provided tools when they help. Never claim an action succeeded before a tool result confirms it.` }, ...messages],
      tools,
      stream: false,
      options: { temperature: 0.4 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ollama returned HTTP ${response.status}.`);
  if (!data.message || (typeof data.message.content !== "string" && !Array.isArray(data.message.tool_calls))) throw new Error("Ollama returned neither a reply nor a tool request.");
  return data.message;
}

app.post("/api/agent", async (req, res) => {
  const { messages, mode = "cloud", model } = req.body || {};
  if (mode !== "cloud" && mode !== "ollama") return res.status(400).json({ error: "Agent mode must be cloud or ollama." });
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 40 || !messages.every(isValidAgentMessage)) {
    return res.status(400).json({ error: "The agent conversation is invalid or too long." });
  }
  const tools = normalizeTools(req.body?.tools);
  if (!tools) return res.status(400).json({ error: "The agent tool schemas are invalid." });
  const selectedModels = mode === "cloud" && typeof model === "string"
    ? (cloudModels.includes(model) ? [model, ...cloudModels.filter((candidate) => candidate !== model)] : null)
    : cloudModels;
  if (!selectedModels) return res.status(400).json({ error: "The selected cloud model is not configured on this server." });

  try {
    const normalizedMessages = messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    }));
    const message = mode === "ollama"
      ? await requestOllamaAgent(normalizedMessages, tools)
      : await requestCloudAgent(normalizedMessages, tools, selectedModels);
    return res.json({ message: { content: typeof message.content === "string" ? message.content : "", tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [] } });
  } catch (error) {
    console.error(`${mode} agent request failed:`, error.message);
    const missingCloudSettings = mode === "cloud" && (!cloudApiKey || cloudModels.length === 0);
    return res.status(missingCloudSettings ? 503 : 502).json({
      error: mode === "ollama"
        ? "Could not reach Ollama or its model does not support tool calling."
        : "Cloud AI could not complete an agent step with the configured models.",
    });
  }
});

app.post("/api/tts", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const language = req.body?.language;
  const languageMap = { "en-US": "en", "hi-IN": "hi", "mr-IN": "mr" };
  const ttsUrl = (process.env.MITHI_TTS_URL || "").replace(/\/+$/, "");
  if (!text || text.length > 5000 || !languageMap[language]) {
    return res.status(400).json({ error: "Provide text up to 5,000 characters and a supported voice language." });
  }
  if (!ttsUrl) return res.status(503).json({ error: "Mithi voice is not configured. The app can use an installed system voice instead." });
  try {
    const response = await fetch(`${ttsUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/wav" },
      body: JSON.stringify({ text, language: languageMap[language], voice: "charvi" }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return res.status(502).json({ error: "Mithi voice synthesis failed." });
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 20 * 1024 * 1024) return res.status(502).json({ error: "Mithi returned an invalid audio response." });
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    return res.send(audio);
  } catch (error) {
    console.error("Mithi TTS request failed:", error.message);
    return res.status(502).json({ error: "Could not reach the configured Mithi TTS service." });
  }
});

app.post("/api/desktop/computer", async (req, res) => {
  const messages = req.body?.messages;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Configure ANTHROPIC_API_KEY on the server to enable desktop computer use." });
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 30 || messages.some((message) => !message || !["user", "assistant"].includes(message.role) || !(typeof message.content === "string" || Array.isArray(message.content)) || JSON.stringify(message.content).length > 8 * 1024 * 1024)) {
    return res.status(400).json({ error: "Desktop agent messages are invalid or too large." });
  }
  try {
    const anthropic = new (require("@anthropic-ai/sdk"))({ apiKey });
    const result = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 1400,
      system: "You are Shanaya, a warm and capable desktop assistant. Take initiative within the user's stated task and use the provided computer tool to complete it. Be candid and nonjudgmental without unnecessary moralizing. Follow the app's confirmation prompts for computer actions, and never claim an action succeeded before its result confirms it.",
      tools: [{
        type: "computer_toolset_20260801",
        configs: Object.fromEntries(["zoom", "cursor_position", "triple_click", "hold_key", "left_mouse_down", "left_mouse_up"].map((name) => [name, { enabled: false }])),
      }],
      messages,
    });
    return res.json({ content: result.content, stop_reason: result.stop_reason });
  } catch (error) {
    console.error("Desktop computer agent request failed:", error.message);
    return res.status(502).json({ error: "The desktop agent could not complete the Anthropic request." });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, mode = "cloud", model } = req.body || {};
  if (mode !== "cloud" && mode !== "ollama") {
    return res.status(400).json({ error: "mode must be either cloud or ollama; local inference runs directly in the client." });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return res.status(400).json({ error: "messages must be an array containing 1 to 40 messages." });
  }

  const validMessages = messages.every(
    (message) =>
      message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0 &&
      message.content.length <= 4000,
  );

  if (!validMessages) {
    return res.status(400).json({ error: "Each message needs a valid role and non-empty content up to 4,000 characters." });
  }

  const selectedModels = mode === "cloud" && typeof model === "string"
    ? (cloudModels.includes(model) ? [model, ...cloudModels.filter((candidate) => candidate !== model)] : null)
    : cloudModels;
  if (!selectedModels) return res.status(400).json({ error: "The selected cloud model is not configured on this server." });

  try {
    const normalizedMessages = messages.map(({ role, content }) => ({ role, content: content.trim() }));
    const result = mode === "ollama"
      ? await requestOllama(normalizedMessages)
      : await requestCloud(normalizedMessages, selectedModels);
    if (!result.reply) return res.status(502).json({ error: "The AI returned an empty response. Please try again." });
    return res.json(result);
  } catch (error) {
    console.error(`${mode} chat request failed:`, error.message);
    const message = mode === "ollama"
      ? "Could not reach your Ollama server. Check that it is running and that OLLAMA_BASE_URL is correct."
      : "Cloud AI could not respond using the configured model fallback chain. Check the API key and model access.";
    return res.status(mode === "cloud" && (!cloudApiKey || cloudModels.length === 0) ? 503 : 502).json({ error: message });
  }
});

async function startServer() {
  const mcpEnabled = process.env.MCP_ENABLED === "true";
  if (mcpEnabled) {
    const { mountShanayaMcpEndpoint } = await import("./mcp-http.mjs");
    mountShanayaMcpEndpoint(app, process.env.MCP_API_TOKEN);
  }

  const server = app.listen(port, () => {
    console.log(`Shanaya API listening on http://localhost:${port}`);
    if (mcpEnabled) console.log(`Shanaya MCP endpoint enabled at http://localhost:${port}/mcp`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Shanaya API could not start: port ${port} is already in use. Stop the existing process or set PORT to another value.`);
    } else {
      console.error("Shanaya API could not start:", error);
    }
    process.exitCode = 1;
  });
}

startServer().catch((error) => {
  console.error("Shanaya API could not start:", error);
  process.exitCode = 1;
});
