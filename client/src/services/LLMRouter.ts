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

  static async requestStep(mode: Extract<InferenceMode, "cloud" | "ollama">, messages: AgentMessage[], tools: ShanayaTool[]): Promise<AgentStep> {
    const response = await fetch(apiUrl("/api/agent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        messages,
        tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", function: { name, description, parameters: inputSchema } })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The agent service could not complete the request.");
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
}
