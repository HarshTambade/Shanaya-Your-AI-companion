export type Emotion = "happy" | "sad" | "cute" | "neutral";
export type ChatRole = "system" | "user" | "assistant" | "tool";
export type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type ModelCatalog = {
  provider: string;
  defaultModel: string;
  tiers: Record<string, Array<{ provider: string; model: string }>>;
};

export type Approval = {
  token: string;
  tool_call_id: string;
  name: string;
  description: string;
  arguments: Record<string, unknown>;
};

export type AgentResult =
  | { status: "complete"; reply: string; emotion: Emotion; provider?: string; model?: string; messages?: ChatMessage[]; local?: boolean }
  | { status: "approval_required"; approvals: Approval[]; provider?: string; model?: string; messages: ChatMessage[] };

const baseUrl = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "";
const endpoint = (path: string) => `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
const allowedEmotions = new Set<Emotion>(["happy", "sad", "cute", "neutral"]);

function parseStructuredReply(content: unknown): { reply: string; emotion: Emotion } {
  if (typeof content !== "string") throw new Error("The model returned an empty response.");
  const trimmed = content.trim().replace(/^```(?:[a-z0-9_-]+)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown = trimmed;
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          value = JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          continue;
        }
        break;
      }
    }
    if (value !== trimmed) break;
  }
  if (value && typeof value === "object" && "reply" in value) {
    const parsed = value as { reply?: unknown; emotion?: unknown };
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      const emotion = typeof parsed.emotion === "string" && allowedEmotions.has(parsed.emotion as Emotion)
        ? parsed.emotion as Emotion
        : "neutral";
      return { reply: parsed.reply.trim(), emotion };
    }
  }
  if (typeof value === "string" && value) return { reply: value, emotion: "neutral" };
  throw new Error("The model returned an invalid structured response.");
}

async function readJson(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : "The agent service is unavailable.";
    throw new Error(detail);
  }
  return body;
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const response = await fetch(endpoint("/api/models"), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  return readJson(response) as Promise<ModelCatalog>;
}

export async function routeAgent(
  messages: ChatMessage[],
  preferredModel: string | undefined,
  generateLocal?: () => Promise<string>,
  localProvider = "WebLLM",
  localModel = "Llama-3.2-1B-Instruct-q4f16_1-MLC",
): Promise<AgentResult> {
  try {
    const response = await fetch(endpoint("/api/agent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: preferredModel }),
      // Bound network waits so the local model can take over when the API is unreachable.
      signal: AbortSignal.timeout(15_000),
    });
    const result = await readJson(response);
    if (result.status === "approval_required" && Array.isArray(result.approvals)) {
      return result as AgentResult;
    }
    const parsed = parseStructuredReply(JSON.stringify({ reply: result.reply, emotion: result.emotion }));
    return { ...result, ...parsed, status: "complete" } as AgentResult;
  } catch (backendError) {
    if (!generateLocal) throw backendError;
    try {
      const local = parseStructuredReply(await generateLocal());
      return { status: "complete", ...local, provider: localProvider, model: localModel, local: true };
    } catch (localError) {
      const backendMessage = backendError instanceof Error ? backendError.message : "Cloud routing failed.";
      const localMessage = localError instanceof Error ? localError.message : "WebLLM is not ready.";
      throw new Error(`${backendMessage} Local fallback: ${localMessage}`);
    }
  }
}

export async function resolveApproval(token: string, approved: boolean): Promise<{ approved: boolean; tool_call_id: string; result: unknown }> {
  // Keep one-use approval tokens out of URL/access logs.
  const response = await fetch(endpoint("/api/approvals"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, approved }),
    signal: AbortSignal.timeout(15_000),
  });
  return readJson(response);
}

export { parseStructuredReply };
