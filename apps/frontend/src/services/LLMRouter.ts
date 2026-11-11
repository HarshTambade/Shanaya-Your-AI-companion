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

type ApprovalResult = { approved: boolean; tool_call_id: string; result: unknown };

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
  sessionId?: string,
): Promise<AgentResult> {
  if (!sessionId) throw new Error("The approval channel is not ready. Reconnect before sending a tool-enabled request.");
  try {
    const result = await fetchAgent(messages, preferredModel, sessionId);
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

async function fetchAgent(messages: ChatMessage[], preferredModel: string | undefined, sessionId: string) {
    const response = await fetch(endpoint("/api/agent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: preferredModel, session_id: sessionId }),
      // Bound network waits so the local model can take over when the API is unreachable.
      // Allow the backend to try configured provider fallbacks after a rate
      // limit; a disconnected network still takes the local route after the
      // router's short connect timeout.
      signal: AbortSignal.timeout(60_000),
    });
    return readJson(response);
}

function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ApprovalChannel {
  readonly sessionId = newSessionId();
  private socket: WebSocket | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private decisionWaiters = new Map<string, { resolve: (result: ApprovalResult) => void; reject: (error: Error) => void }>();

  constructor(private readonly onApproval: (approval: Approval) => void) {}

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && !this.readyPromise) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.resolveReady = null;
        this.rejectReady = null;
        this.readyPromise = null;
        if (error) reject(error);
        else resolve();
      };
      this.resolveReady = () => finish();
      this.rejectReady = (error) => finish(error);
      let socket: WebSocket;
      try {
        const url = new URL(endpoint(`/api/ws/approvals/${this.sessionId}`), window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
      } catch {
        finish(new Error("Could not create the approval WebSocket."));
        return;
      }
      this.socket = socket;
      timeout = window.setTimeout(() => {
        finish(new Error("Timed out connecting to the approval channel."));
        socket.close();
      }, 5000);
      socket.onmessage = (event) => {
        let message: any;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.type === "ready") {
          window.clearTimeout(timeout);
          const ready = this.resolveReady;
          this.resolveReady = null;
          this.rejectReady = null;
          this.readyPromise = null;
          ready?.();
          return;
        }
        if (
          message?.type === "approval_request"
          && message.approval
          && typeof message.approval.token === "string"
          && typeof message.approval.tool_call_id === "string"
          && typeof message.approval.name === "string"
          && typeof message.approval.description === "string"
          && message.approval.arguments
          && typeof message.approval.arguments === "object"
          && !Array.isArray(message.approval.arguments)
        ) {
          this.onApproval(message.approval as Approval);
          return;
        }
        if (message?.type === "approval_result" && typeof message.token === "string") {
          const waiter = this.decisionWaiters.get(message.token);
          if (!waiter) return;
          this.decisionWaiters.delete(message.token);
          if (typeof message.tool_call_id === "string" && "result" in message) {
            waiter.resolve({ approved: message.approved === true, tool_call_id: message.tool_call_id, result: message.result });
          } else {
            waiter.reject(new Error(typeof message.error === "string" ? message.error : "The approval request could not be resolved."));
          }
          return;
        }
        if (message?.type === "error") this.rejectAll(new Error(String(message.error || "Approval channel error.")));
      };
      socket.onerror = () => {
        finish(new Error("Could not connect to the approval WebSocket."));
        socket.close();
      };
      socket.onclose = () => {
        finish(new Error("The approval WebSocket disconnected."));
        this.rejectAll(new Error("The approval WebSocket disconnected. No pending tool can execute without it."));
        if (this.socket === socket) this.socket = null;
      };
    });
    return this.readyPromise;
  }

  async resolve(token: string, approved: boolean): Promise<ApprovalResult> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("The approval channel is not connected.");
    return new Promise<ApprovalResult>((resolve, reject) => {
      this.decisionWaiters.set(token, { resolve, reject });
      try {
        this.socket!.send(JSON.stringify({ type: "approval_response", token, decision: approved ? "APPROVE" : "REJECT" }));
      } catch {
        this.decisionWaiters.delete(token);
        reject(new Error("Could not send the approval decision."));
      }
    });
  }

  close() {
    this.socket?.close(1000, "Chat closed");
    this.socket = null;
    this.rejectAll(new Error("The approval channel was closed."));
  }

  private rejectAll(error: Error) {
    for (const waiter of this.decisionWaiters.values()) waiter.reject(error);
    this.decisionWaiters.clear();
  }
}

export { parseStructuredReply };
