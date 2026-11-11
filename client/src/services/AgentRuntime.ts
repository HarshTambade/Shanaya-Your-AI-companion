import type { ChatMessage, Emotion, InferenceMode } from "../types";
import { getDeviceTools, type ShanayaTool } from "./DeviceTools";
import { LLMRouter, type AgentMessage, type AgentToolCall } from "./LLMRouter";
import { getNativeMemoryTools } from "./MobileAgent";

const emotionNames = new Set<Emotion>(["happy", "sad", "angry", "neutral", "surprised", "thinking"]);
const maxToolTurns = 8;

export type AgentPhase = "thinking" | "acting" | "tool-result";
export type AgentActivity = { phase: AgentPhase; message: string };
export type AgentReply = { reply: string; emotion: Emotion };

const agentRules = [
  "You are Shanaya, a warm, candid, nonjudgmental companion and capable personal assistant. Be open to creative role-play and frank discussion without unnecessary moralizing.",
  "Take initiative within the user's stated request and use available tools to complete bounded multi-step tasks. Ask a follow-up only when an important detail is missing.",
  "Sending messages, changing settings, spending money, writing or deleting files, and controlling a computer require the tool's confirmation flow. Read only app-private files needed for the user's request, and never claim an action succeeded unless its result confirms it.",
  'When a tool is needed, return only JSON: {"toolCalls":[{"name":"tool_name","arguments":{}}]}.',
  'When finished, return only JSON: {"reply":"text","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
].join(" ");

function extractObject(text: string): Record<string, unknown> | null {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const result = JSON.parse(candidate);
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

function parseReply(text: string): AgentReply {
  const parsed = extractObject(text);
  const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : text.trim();
  const emotion = parsed?.emotion;
  if (!reply) throw new Error("The agent returned an empty reply.");
  return { reply, emotion: typeof emotion === "string" && emotionNames.has(emotion as Emotion) ? emotion as Emotion : "neutral" };
}

function parseLocalStep(text: string): { reply?: AgentReply; toolCalls: AgentToolCall[] } {
  const parsed = extractObject(text);
  if (!parsed) return { reply: parseReply(text), toolCalls: [] };
  if (Array.isArray(parsed.toolCalls)) {
    const calls = parsed.toolCalls.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error("The local model returned an invalid tool request.");
      const call = item as Record<string, unknown>;
      const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown>
        : {};
      return { id: `local-${Date.now()}-${index}`, name: String(call.name ?? ""), arguments: args };
    });
    if (calls.length > 0) return { toolCalls: calls };
    if (typeof parsed.reply === "string" && parsed.reply.trim()) return { reply: parseReply(text), toolCalls: [] };
    throw new Error("The local model returned neither a reply nor a tool request.");
  }
  return { reply: parseReply(text), toolCalls: [] };
}

function createLocalPrompt(messages: AgentMessage[], tools: ShanayaTool[]) {
  const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema }));
  const context = messages.slice(-8).map((message) => `${message.role}: ${message.content.slice(0, 1200)}`).join("\n");
  return `${agentRules}\nAvailable tools (JSON schema): ${JSON.stringify(definitions)}\n\nConversation and tool results:\n${context}`.slice(-7000);
}

function formatToolName(name: string) {
  return name.replaceAll("_", " ");
}

function toolOutputText(output: unknown) {
  if (output && typeof output === "object" && "message" in output && typeof output.message === "string") return output.message;
  return typeof output === "string" ? output : JSON.stringify(output) ?? String(output);
}

function trimConversation(messages: AgentMessage[]) {
  if (messages.length <= 24) return;
  let start = messages.length - 24;
  if (messages[start]?.role === "tool" && messages[start - 1]?.role === "assistant" && messages[start - 1]?.tool_calls) start -= 1;
  messages.splice(0, start);
}

export async function runAgentTurn(options: {
  mode: InferenceMode;
  model?: string;
  messages: ChatMessage[];
  generateLocal: (prompt: string, mode: InferenceMode) => Promise<string>;
  onActivity?: (activity: AgentActivity) => void;
}): Promise<AgentReply> {
  const tools = [...getDeviceTools()];
  let memoryToolsLoaded = false;
  const conversation: AgentMessage[] = options.messages
    .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map(({ role, content }) => ({ role, content }));

  for (let turn = 0; turn < maxToolTurns; turn += 1) {
    const mode = await LLMRouter.resolveMode(options.mode, typeof navigator === "undefined" || navigator.onLine);
    if (mode === "native" && !memoryToolsLoaded) {
      memoryToolsLoaded = true;
      try {
        const memoryTools = await getNativeMemoryTools();
        tools.push(...memoryTools as unknown as ShanayaTool[]);
      } catch {
        // Local inference remains available when a memory plugin is unsupported.
      }
    }
    options.onActivity?.({ phase: "thinking", message: "Shanaya is thinking…" });
    let content = "";
    let toolCalls: AgentToolCall[] = [];
    if (mode === "cloud" || mode === "ollama") {
      trimConversation(conversation);
      const step = await LLMRouter.requestStep(mode, conversation, tools, options.model);
      content = step.content;
      if (step.toolCalls.length > 8) throw new Error("The model requested too many tools at once.");
      toolCalls = step.toolCalls;
    } else {
      const localText = await options.generateLocal(createLocalPrompt(conversation, tools), mode);
      const step = parseLocalStep(localText);
      if (step.reply) return step.reply;
      toolCalls = step.toolCalls;
    }

    if (toolCalls.length === 0) return parseReply(content);
    if (toolCalls.length > 8) throw new Error("The local model requested too many tools at once.");
    conversation.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    });

    for (const call of toolCalls) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) throw new Error(`Shanaya does not have a tool named “${call.name}”.`);
      options.onActivity?.({ phase: "acting", message: `Using ${formatToolName(tool.name)}…` });
      let result: unknown;
      try {
        result = await tool.execute(call.arguments);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : "The action failed." };
      }
      const resultText = toolOutputText(result);
      options.onActivity?.({ phase: "tool-result", message: resultText });
      conversation.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }
  throw new Error("The agent reached its multi-step limit. Ask it to continue with the remaining part of the task.");
}

export { agentRules };
