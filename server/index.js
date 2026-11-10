require("dotenv").config();

const cors = require("cors");
const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3001;
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173,capacitor://localhost,http://localhost,https://localhost")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const cloudApiKey = process.env.CLOUD_API_KEY;
const cloudApiUrl = process.env.CLOUD_API_URL;
const cloudModels = (
  process.env.CLOUD_MODEL_FALLBACKS ||
  ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"].join(",")
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
const ollamaModel = process.env.OLLAMA_MODEL || "gurubot/self-after-dark:latest";
const systemPrompt = [
  "You are a friendly, emotionally aware AI companion. Keep answers concise and engaging.",
  'Respond only as a JSON object with this exact shape: {"reply":"your message","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
  "Use one allowed emotion that best matches the tone of your reply. Do not wrap the JSON in markdown.",
].join(" ");
const allowedEmotions = new Set(["happy", "sad", "angry", "neutral", "surprised", "thinking"]);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
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

async function requestCloud(messages) {
  if (!cloudApiKey || !cloudApiUrl) throw new Error("Add CLOUD_API_URL and CLOUD_API_KEY to server/.env to enable Cloud AI.");

  let lastError;
  for (const model of cloudModels) {
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
          max_tokens: 700,
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

app.post("/api/chat", async (req, res) => {
  const { messages, mode = "cloud" } = req.body || {};
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

  try {
    const normalizedMessages = messages.map(({ role, content }) => ({ role, content: content.trim() }));
    const result = mode === "ollama"
      ? await requestOllama(normalizedMessages)
      : await requestCloud(normalizedMessages);
    if (!result.reply) return res.status(502).json({ error: "The AI returned an empty response. Please try again." });
    return res.json(result);
  } catch (error) {
    console.error(`${mode} chat request failed:`, error.message);
    const message = mode === "ollama"
      ? "Could not reach your Ollama server. Check that it is running and that OLLAMA_BASE_URL is correct."
      : "Cloud AI could not respond using the configured model fallback chain. Check the API key and model access.";
    return res.status(mode === "cloud" && !cloudClient ? 503 : 502).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Shanaya API listening on http://localhost:${port}`);
});
