require("dotenv").config();

const cors = require("cors");
const express = require("express");
const Groq = require("groq-sdk");

const app = express();
const port = Number(process.env.PORT) || 3001;
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const groqModels = (
  process.env.GROQ_MODEL_FALLBACKS ||
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

async function requestGroq(messages) {
  if (!groq) throw new Error("Add GROQ_API_KEY to server/.env to use Groq Cloud.");

  let lastError;
  for (const model of groqModels) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: 700,
      });
      const content = completion.choices[0]?.message?.content?.trim();
      if (content) return parseAssistantOutput(content);
      lastError = new Error(`${model} returned an empty response.`);
    } catch (error) {
      lastError = error;
      console.warn(`Groq model ${model} failed; trying the next configured model.`);
    }
  }
  throw lastError || new Error("No Groq models are configured.");
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
  const { messages, mode = "groq" } = req.body || {};
  if (mode !== "groq" && mode !== "ollama") {
    return res.status(400).json({ error: "mode must be either groq or ollama; WebLLM runs directly in the browser." });
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
      : await requestGroq(normalizedMessages);
    if (!result.reply) return res.status(502).json({ error: "The AI returned an empty response. Please try again." });
    return res.json(result);
  } catch (error) {
    console.error(`${mode} chat request failed:`, error.message);
    const message = mode === "ollama"
      ? "Could not reach your Ollama server. Check that it is running and that OLLAMA_BASE_URL is correct."
      : "Groq could not respond using the configured model fallback chain. Check the API key and model access.";
    return res.status(mode === "groq" && !groq ? 503 : 502).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Shanaya API listening on http://localhost:${port}`);
});
