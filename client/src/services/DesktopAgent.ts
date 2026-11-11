import { apiUrl } from "./api";
import { SafetyGuard } from "./SafetyGuard";
import { getDesktopBridge } from "./DesktopBridge";

function summarizeAction(name: string, input: Record<string, unknown>) {
  if (name === "type") return `Type this exact text: “${String(input.text ?? "")}”`;
  if (name === "key") return `Press ${String(input.text ?? "the requested")} ${Number(input.repeat) > 1 ? `${Number(input.repeat)} times` : ""}.`;
  if (name === "left_click_drag") return `Drag from ${JSON.stringify(input.start_coordinate ?? "the current pointer position")} to ${JSON.stringify(input.coordinate ?? "the requested position")}.`;
  if (name.includes("click")) return `${name.replaceAll("_", " ")} at ${JSON.stringify(input.coordinate ?? input.start_coordinate ?? "the shown position")}`;
  if (name === "scroll") return `Scroll ${String(input.scroll_direction ?? "the screen")} by ${String(input.scroll_amount ?? 3)} clicks on the desktop.`;
  if (name === "wait") return `Wait ${String(input.duration ?? 0.5)} seconds.`;
  if (name === "mouse_move") return `Move the pointer to ${JSON.stringify(input.coordinate ?? "the requested position")}.`;
  return `Perform ${name.replaceAll("_", " ")} on the desktop.`;
}

export async function runDesktopAgentTurn(task: string, onActivity: (message: string, acting?: boolean) => void) {
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Desktop computer use needs an internet connection.");
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("Desktop control is unavailable until the Electron preload bridge is installed.");
  await SafetyGuard.authorizeDesktop("session", {
    input: { task },
    summary: `Start a computer session. Screenshots and this task will be sent to the configured Anthropic API.\n\nTask: ${task.slice(0, 1000)}`,
  });

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: task }];
  let actionCount = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    onActivity("Shanaya is examining the desktop…", false);
    const response = await fetch(apiUrl("/api/desktop/computer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Desktop agent request failed.");
    const content = Array.isArray(data.content) ? data.content : [];
    messages.push({ role: "assistant", content });

    const toolUses = content.filter((block: any) => block?.type === "tool_use" && block?.toolset_name === "computer");
    if (!toolUses.length) {
      const answer = content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text ?? "")).join("\n").trim();
      return answer || "I finished the desktop turn.";
    }

    const results = [];
    for (const tool of toolUses) {
      actionCount += 1;
      if (actionCount > 16) throw new Error("The desktop agent reached its action limit. Ask it to continue with a smaller task.");
      const action = String(tool.name ?? "");
      const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {};
      const approvalToken = await SafetyGuard.authorizeDesktop(action, {
        input: action === "screenshot" ? {} : input,
        summary: action === "screenshot" ? "Share a screenshot of the desktop with the configured Anthropic API." : summarizeAction(action, input),
      });
      onActivity(action === "screenshot" ? "Taking a desktop screenshot…" : `Acting: ${action.replaceAll("_", " ")}…`, action !== "screenshot");
      try {
        if (action === "screenshot") {
          const screenshot = await bridge.screenshot(approvalToken);
          results.push({
            type: "tool_result",
            tool_use_id: tool.id,
            toolset_name: "computer",
            content: [{ type: "image", source: { type: "base64", media_type: screenshot.mediaType, data: screenshot.base64 } }],
          });
        } else {
          await bridge.perform(action, input, approvalToken);
          results.push({ type: "tool_result", tool_use_id: tool.id, toolset_name: "computer", content: "Action completed." });
          onActivity(`${action.replaceAll("_", " ")} completed.`, false);
        }
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: tool.id,
          toolset_name: "computer",
          is_error: true,
          content: error instanceof Error ? error.message : "Desktop action failed.",
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("The desktop agent reached its action limit. Ask it to continue with a smaller task.");
}

export function hasDesktopBridge() {
  const bridge = getDesktopBridge();
  if (!bridge) return false;
  return typeof bridge.confirmAction === "function"
    && typeof bridge.screenshot === "function"
    && typeof bridge.perform === "function";
}
