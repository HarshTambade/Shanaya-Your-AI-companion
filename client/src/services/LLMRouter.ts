import { apiUrl } from "./api";
import type { ShanayaTool } from "./DeviceTools";
import type { InferenceMode } from "../types";
import { resolveInferenceMode, getNetworkStatus } from "./AIService";

export type AgentMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type AgentToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type AgentStep = { content: string; toolCalls: AgentToolCall[] };

class AgentApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentApiError";
  }
}

function normalizeStep(data: any): AgentStep {
  const message = data.message && typeof data.message === "object" ? data.message : {};
  const textContent = typeof message.content === "string" ? message.content : "";
  const providerCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const promptCalls = providerCalls.length ? [] : parsePromptToolCalls(textContent);
  const calls: any[] = providerCalls.length ? providerCalls : promptCalls.map((call: any) => ({
    id: typeof call?.id === "string" ? call.id : undefined,
    function: { name: call?.name, arguments: call?.arguments },
  }));
  return {
    content: promptCalls.length ? "" : textContent,
    toolCalls: calls.map((call: any) => {
      const fn = call?.function ?? {};
      let args: Record<string, unknown> = {};
      try {
        const parsed = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        else if (parsed !== undefined && parsed !== null) throw new Error("Arguments must be a JSON object.");
      } catch {
        throw new Error(`The model returned invalid arguments for ${String(fn.name ?? "a tool")}.`);
      }
      const id = typeof call?.id === "string" ? call.id : `tool-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      return { id, name: String(fn.name ?? ""), arguments: args };
    }),
  };
}

async function requestAgentStep(url: string, body: Record<string, unknown>): Promise<AgentStep> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "The agent service could not complete the request.";
    throw new AgentApiError(message, response.status);
  }
  if (!data.message || typeof data.message !== "object") throw new AgentApiError("The agent service returned an invalid response.");
  return normalizeStep(data);
}

function shouldUsePythonFallback(error: unknown) {
  if (!(error instanceof AgentApiError)) return true;
  return error.status === undefined || error.status === 404 || error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500;
}

function parsePromptToolCalls(content: string): unknown[] {
  const candidate = content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];
  } catch {
    return [];
  }
}

export class LLMRouter {
  static async resolveMode(preferred: InferenceMode, browserConnected: boolean) {
    const network = await getNetworkStatus().catch(() => ({ connected: browserConnected }));
    return resolveInferenceMode(preferred, browserConnected && network.connected);
  }

  static async requestStep(mode: Extract<InferenceMode, "cloud" | "ollama">, messages: AgentMessage[], tools: ShanayaTool[], model?: string): Promise<AgentStep> {
    const body = {
      mode,
      ...(mode === "cloud" && model ? { model } : {}),
      messages,
      tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", function: { name, description, parameters: inputSchema } })),
    };
    try {
      return await requestAgentStep(apiUrl("/api/agent"), body);
    } catch (primaryError) {
      if (mode !== "cloud" || !shouldUsePythonFallback(primaryError)) throw primaryError;
      const fallbackBase = import.meta.env.VITE_PYTHON_FALLBACK_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:8000";
      try {
        return await requestAgentStep(`${fallbackBase}/api/agent/step`, body);
      } catch (fallbackError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : "The primary Node API failed.";
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "The Python fallback API failed.";
        throw new Error(`${primaryMessage} Python fallback: ${fallbackMessage}`);
      }
    }
  }
}
