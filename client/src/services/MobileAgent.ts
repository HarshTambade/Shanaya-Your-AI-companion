import { Capacitor } from "@capacitor/core";
import { MobileClawEngine, type DeviceTool as MobileClawTool } from "capacitor-mobile-claw";
import { MemoryManager } from "capacitor-lancedb";
import { MobileCron } from "capacitor-mobilecron";
import { getMobileClawTools } from "./DeviceTools";
import { SafetyGuard } from "./SafetyGuard";

const engine = new MobileClawEngine();
const memory = new MemoryManager();
let initialization: Promise<void> | undefined;

function getProtectedMemoryTools() {
  return memory.getTools().map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      if (tool.name.includes("forget") || tool.name.includes("clear")) {
        await SafetyGuard.require("delete_memory", { summary: JSON.stringify(args) });
      }
      return tool.execute(args);
    },
  }));
}

function initialize() {
  if (!Capacitor.isNativePlatform()) throw new Error("The MobileClaw agent runs in the iOS and Android app.");
  if (!initialization) {
    initialization = (async () => {
      await memory.init({
        dbPath: "shanaya-agent-memory",
        agentId: "shanaya",
        autoRecall: true,
        autoCapture: true,
      });
      const memoryTools = getProtectedMemoryTools() as unknown as MobileClawTool[];
      const tools: MobileClawTool[] = [...getMobileClawTools(), ...memoryTools];
      const ready = await engine.init({ tools, mobileCron: MobileCron });
      if (!engine.available || !ready.openclawRoot) {
        throw new Error(engine.error || "Could not initialize the native agent runtime.");
      }
      const allowedToolNames = new Set(tools.map((tool) => tool.name));
      engine.addListener("toolPreExecute", (event) => {
        if (!("toolCallId" in event) || typeof event.toolCallId !== "string") return;
        const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : "";
        const args = "args" in event && event.args && typeof event.args === "object" && !Array.isArray(event.args)
          ? event.args as Record<string, unknown>
          : {};
        const allowed = allowedToolNames.has(toolName);
        void engine.respondToPreExecute(
          event.toolCallId,
          args,
          !allowed,
          allowed ? undefined : "This tool is not allowlisted for Shanaya.",
        ).catch(() => undefined);
      });
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

export async function setMobileAgentApiKey(apiKey: string) {
  const value = apiKey.trim();
  if (!value) throw new Error("Enter an Anthropic API key.");
  await initialize();
  await engine.setAuthKey(value, "anthropic", "api_key");
}

export async function getNativeMemoryTools() {
  await initialize();
  return getProtectedMemoryTools();
}

export async function getMobileAgentStatus() {
  if (!Capacitor.isNativePlatform()) return { available: false, initialized: false, hasApiKey: false };
  try {
    await initialize();
    const auth = await engine.getAuthStatus("anthropic");
    return { available: true, initialized: engine.ready, hasApiKey: auth.hasKey };
  } catch {
    return { available: false, initialized: false, hasApiKey: false };
  }
}

export async function runMobileAgentTurn(prompt: string, onActivity: (message: string, acting?: boolean) => void) {
  await initialize();
  const auth = await engine.getAuthStatus("anthropic");
  if (!auth.hasKey) throw new Error("Add an Anthropic API key in Settings to use the native MobileClaw agent.");

  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completedHandler: { remove: () => void } | undefined;
  let errorHandler: { remove: () => void } | undefined;
  let eventHandler: { remove: () => void } | undefined;

  const completion = new Promise<void>((resolve, reject) => {
    completedHandler = engine.addListener("agentCompleted", () => resolve());
    errorHandler = engine.addListener("agentError", (event) => reject(new Error("error" in event ? String(event.error) : "The native agent failed.")));
    eventHandler = engine.addListener("agentEvent", (event) => {
      if (!("eventType" in event)) return;
      const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
      if (event.eventType === "text_delta") output += String(data.text ?? "");
      if (event.eventType === "tool_use") onActivity(`Using ${String(data.name ?? data.tool_name ?? data.toolName ?? "a device tool")}…`, true);
      if (event.eventType === "tool_result") {
        const result = data.result ?? data;
        onActivity(typeof result === "string" ? result : JSON.stringify(result) ?? "Device action finished.", false);
      }
      if (event.eventType === "thinking") onActivity("Shanaya is thinking…", false);
    });
    timer = setTimeout(() => reject(new Error("The native agent timed out. Check the connection and try again.")), 180_000);
  });

  try {
    const memoryTools = getProtectedMemoryTools() as unknown as MobileClawTool[];
    const tools: MobileClawTool[] = [...getMobileClawTools(), ...memoryTools];
    await engine.startSkill("shanaya-assistant", {
      kickoff: `${prompt}\n\nRespond only as JSON with {"reply":"text","emotion":"happy|sad|angry|neutral|surprised|thinking"}. Use an available tool only when it helps. Never claim an action succeeded unless its tool result confirms it.`,
      systemPrompt: "You are Shanaya, a warm, candid, nonjudgmental companion and capable assistant. Take initiative within the user's request and use only the tools listed for the task. Every message, call, setting change, file write or deletion, and memory deletion must use its confirmation flow. Protect privacy, never claim an action succeeded before its result, and return the final answer as JSON with reply and emotion.",
      maxTurns: 10,
      model: import.meta.env.VITE_SHANAYA_ANTHROPIC_MODEL || "claude-sonnet-5-5",
      tools,
    }, "anthropic");
    await completion;
    const candidate = output.match(/\{[\s\S]*\}/)?.[0];
    if (!candidate) return output.trim();
    return candidate;
  } finally {
    if (timer) clearTimeout(timer);
    completedHandler?.remove();
    errorHandler?.remove();
    eventHandler?.remove();
    await engine.endSkill("shanaya-assistant").catch(() => undefined);
  }
}

export async function clearMobileAgentConversation() {
  if (engine.ready) await engine.clearConversation();
}
