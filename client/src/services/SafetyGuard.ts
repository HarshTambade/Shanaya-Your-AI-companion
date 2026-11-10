import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { getDesktopBridge } from "./DesktopBridge";

export type SensitiveAction = "send_message" | "make_call" | "make_payment" | "toggle_setting" | "delete_memory" | "desktop_action";

function describeAction(action: SensitiveAction, args: Record<string, unknown>) {
  if (action === "send_message") {
    return `Open a text message draft to ${String(args.recipient ?? "the requested recipient")} with this message:\n\n${String(args.message ?? "")}`;
  }
  if (action === "make_call") {
    return `Open the phone dialer for ${String(args.recipient ?? "the requested number")}? Shanaya will not place the call automatically.`;
  }
  if (action === "delete_memory") {
    return `Delete this saved information from Shanaya's on-device memory?\n\n${String(args.summary ?? "Matching memory entries")}`;
  }
  if (action === "toggle_setting") {
    return `Change the ${String(args.setting ?? "requested")} device setting to ${String(args.enabled ?? "the requested state")}?`;
  }
  if (action === "desktop_action") {
    return `Allow Shanaya to perform this desktop action?\n\n${String(args.summary ?? "Control the current desktop")}`;
  }
  return `Continue with this payment action?\n\n${String(args.summary ?? "No payment details were provided")}`;
}

export class SafetyGuard {
  static async confirm(action: SensitiveAction, args: Record<string, unknown>) {
    const message = describeAction(action, args);
    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Dialog.confirm({
          title: "Confirm with Shanaya",
          message,
          okButtonTitle: "Continue",
          cancelButtonTitle: "Cancel",
        });
        return result.value;
      } catch {
        // Electron/WebView builds may not have the native Dialog implementation installed.
      }
    }
    return typeof window !== "undefined" && window.confirm(message);
  }

  static async require(action: SensitiveAction, args: Record<string, unknown>) {
    if (!await SafetyGuard.confirm(action, args)) {
      throw new Error("Action cancelled. Shanaya did not make any changes.");
    }
  }

  static async authorizeDesktop(action: string, args: Record<string, unknown>) {
    const bridge = getDesktopBridge();
    const token = await bridge?.confirmAction(action, args);
    if (!token) throw new Error("Action cancelled. Shanaya did not control the desktop.");
    return token;
  }
}
