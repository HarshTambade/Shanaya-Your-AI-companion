import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const apiBaseUrl = (process.env.SHANAYA_API_URL || `http://127.0.0.1:${process.env.PORT || "3001"}`)
  .trim()
  .replace(/\/+$/, "");
const emotions = ["happy", "sad", "angry", "neutral", "surprised", "thinking"];

async function requestApi(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Shanaya API returned HTTP ${response.status}.`);
  }
  return data;
}

function toolError(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : "Shanaya could not complete this request." }],
    isError: true,
  };
}

export function createShanayaMcpServer() {
  const server = new McpServer({
    name: "shanaya",
    version: "1.0.0",
    instructions: "Shanaya is a conversational AI companion exposed over MCP. Use shanaya_chat for responses, shanaya_status to check service readiness, and shanaya_models to inspect configured models. This MCP server has no access to the host application's files, accounts, or device controls. Do not claim it has performed actions in another application.",
  });

  server.registerTool(
    "shanaya_chat",
    {
      title: "Chat with Shanaya",
      description: "Send a prompt to Shanaya and receive her reply and emotion. Optional recent user/assistant history can preserve context. This calls the configured AI provider and may incur provider usage.",
      inputSchema: z.object({
        prompt: z.string().trim().min(1).max(4000).describe("The message to send to Shanaya."),
        history: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(2000),
        })).max(12).optional().describe("Optional recent conversation context. Keep it relevant and omit secrets."),
        mode: z.enum(["cloud", "ollama"]).default("cloud").describe("Use the configured cloud router or the configured Ollama server."),
        model: z.string().trim().min(1).max(120).optional().describe("Optional model ID already configured on the Shanaya server."),
      }),
      outputSchema: z.object({
        reply: z.string(),
        emotion: z.enum(emotions),
      }),
    },
    async ({ prompt, history = [], mode, model }) => {
      try {
        const historySize = history.reduce((size, item) => size + item.content.length, 0);
        if (historySize + prompt.length > 16_000) {
          return toolError(new Error("Conversation context is too large. Keep the prompt and history below 16,000 characters."));
        }
        const messages = [...history, { role: "user", content: prompt }];
        const answer = await requestApi("/api/chat", {
          method: "POST",
          body: JSON.stringify({ mode, messages, ...(model ? { model } : {}) }),
        });
        const output = {
          reply: typeof answer.reply === "string" ? answer.reply : "",
          emotion: emotions.includes(answer.emotion) ? answer.emotion : "neutral",
        };
        if (!output.reply) return toolError(new Error("Shanaya returned an empty reply."));
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "shanaya_status",
    {
      title: "Check Shanaya status",
      description: "Check whether the Shanaya API and its configured cloud model are ready. Does not expose API keys.",
      inputSchema: z.object({}),
      outputSchema: z.object({ status: z.string(), provider: z.string(), ready: z.boolean() }),
    },
    async () => {
      try {
        const status = await requestApi("/api/health");
        const output = {
          status: typeof status.status === "string" ? status.status : "unknown",
          provider: typeof status.provider === "string" ? status.provider : "unknown",
          ready: status.ready === true,
        };
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "shanaya_models",
    {
      title: "List Shanaya models",
      description: "List the model IDs configured on the Shanaya server. API keys are never returned.",
      inputSchema: z.object({}),
      outputSchema: z.object({ provider: z.string(), defaultModel: z.string(), models: z.array(z.string()) }),
    },
    async () => {
      try {
        const models = await requestApi("/api/models");
        const output = {
          provider: typeof models.provider === "string" ? models.provider : "unknown",
          defaultModel: typeof models.defaultModel === "string" ? models.defaultModel : "",
          models: Array.isArray(models.models) ? models.models.filter((model) => typeof model === "string") : [],
        };
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
