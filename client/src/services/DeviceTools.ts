import { AppLauncher } from "@capacitor/app-launcher";
import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Network } from "@capacitor/network";
import type { DeviceTool as MobileClawTool } from "capacitor-mobile-claw";
import { SafetyGuard } from "./SafetyGuard";

export type ToolSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
};

export type ShanayaTool = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  sensitive?: "send_message" | "make_call" | "toggle_setting" | "write_file" | "delete_file";
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

const deviceTools: ShanayaTool[] = [
  {
    name: "list_app_files",
    description: "List files and directories in Shanaya's private app Documents area. This cannot access other apps or arbitrary device paths.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Optional relative folder path; omit to list the app Documents root." } },
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path, true);
      const result = await Filesystem.readdir({ path, directory: Directory.Data });
      return {
        path: path || ".",
        totalEntries: result.files.length,
        truncated: result.files.length > 200,
        files: result.files.slice(0, 200).map(({ name, type, size }) => ({ name, type, size })),
      };
    },
  },
  {
    name: "read_app_file",
    description: "Read a UTF-8 text file up to 128 KB from Shanaya's private app Documents area. Cloud-mode file contents are sent to the selected model provider.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside Shanaya's app Documents area." } },
      required: ["path"],
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path);
      const stat = await Filesystem.stat({ path, directory: Directory.Data });
      if (stat.type !== "file") throw new Error("Only files can be read.");
      if (stat.size > 128_000) throw new Error("The file exceeds the 128 KB read limit.");
      const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      const content = typeof data === "string" ? data : await data.text();
      return { path, content };
    },
  },
  {
    name: "write_app_file",
    description: "Create or replace a UTF-8 text file up to 1 MB inside Shanaya's private app Documents area. Always requires user confirmation.",
    sensitive: "write_file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside Shanaya's app Documents area." },
        content: { type: "string", description: "Exact UTF-8 text content to write." },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path);
      if (typeof args.content !== "string") throw new Error("File content must be text.");
      const bytes = new TextEncoder().encode(args.content).byteLength;
      if (bytes > 1_000_000) throw new Error("The file exceeds the 1 MB write limit.");
      await SafetyGuard.require("write_file", { path, bytes, preview: args.content });
      await Filesystem.writeFile({
        path,
        data: args.content,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      return { ok: true, path, bytesWritten: bytes };
    },
  },
  {
    name: "delete_app_file",
    description: "Delete a file from Shanaya's private app Documents area. Directories and paths outside app storage are not allowed. Always requires user confirmation.",
    sensitive: "delete_file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative file path inside Shanaya's app Documents area." } },
      required: ["path"],
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path);
      const stat = await Filesystem.stat({ path, directory: Directory.Data });
      if (stat.type !== "file") throw new Error("Directories cannot be deleted with this tool.");
      await SafetyGuard.require("delete_file", { path });
      await Filesystem.deleteFile({ path, directory: Directory.Data });
      return { ok: true, path, deleted: true };
    },
  },
  {
    name: "open_app",
    description: "Open a supported app or public web page. Use make_call for a phone number and send_message for a text draft.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", enum: ["browser", "maps", "phone", "messages", "settings"], description: "Which app or system surface to open." },
        url: { type: "string", description: "Optional public HTTPS URL; only used with app=browser." },
        query: { type: "string", description: "Optional search phrase; only used with app=maps." },
      },
      required: ["app"],
    },
    execute: async (args) => {
      const app = String(args.app ?? "");
      if (app === "browser") {
        const target = String(args.url ?? "https://www.google.com");
        const parsed = new URL(target);
        if (parsed.protocol !== "https:") throw new Error("Only HTTPS browser links are allowed.");
        await AppLauncher.openUrl({ url: parsed.toString() });
        return { ok: true, message: "Opened the requested HTTPS page." };
      }
      if (app === "settings") {
        await AppLauncher.openUrl({ url: "app-settings:" });
        return { ok: true, message: "Opened Shanaya's app settings." };
      }
      if (app === "maps") {
        const query = String(args.query ?? "").trim();
        const url = query ? `geo:0,0?q=${encodeURIComponent(query)}` : "geo:0,0";
        await AppLauncher.openUrl({ url });
        return { ok: true, message: "Opened the system maps app." };
      }
      if (app === "phone" || app === "messages") {
        throw new Error("Use the confirmed make_call or send_message tool to prepare a phone action.");
      }
      throw new Error("That app is not in Shanaya's supported app list.");
    },
  },
  {
    name: "make_call",
    description: "After confirmation, open the phone dialer with the requested number. The user must tap Call.",
    sensitive: "make_call",
    inputSchema: {
      type: "object",
      properties: { recipient: { type: "string", description: "Phone number including country code where possible." } },
      required: ["recipient"],
    },
    execute: async (args) => {
      const recipient = String(args.recipient ?? "").trim();
      if (!/^\+?[0-9 ().-]{3,24}$/.test(recipient)) throw new Error("Enter a valid phone number.");
      await SafetyGuard.require("make_call", { recipient });
      await AppLauncher.openUrl({ url: `tel:${recipient.replace(/[ ().-]/g, "")}` });
      return { ok: true, message: "Opened the phone dialer. Review the number and tap Call." };
    },
  },
  {
    name: "toggle_setting",
    description: "After explicit confirmation, toggle the flashlight. Wi-Fi and Bluetooth toggles are blocked by iOS and Android; report how the user can change them manually.",
    sensitive: "toggle_setting",
    inputSchema: {
      type: "object",
      properties: {
        setting: { type: "string", enum: ["flashlight", "wifi", "bluetooth"] },
        enabled: { type: "boolean", description: "Desired on/off state." },
      },
      required: ["setting", "enabled"],
    },
    execute: async (args) => {
      const setting = String(args.setting ?? "");
      const enabled = Boolean(args.enabled);
      if (setting === "wifi" || setting === "bluetooth") {
        return { ok: false, message: `The operating system does not let Shanaya toggle ${setting} directly. Use Control Center or Quick Settings to turn it ${enabled ? "on" : "off"}.` };
      }
      if (setting !== "flashlight") throw new Error("Unsupported setting.");
      await SafetyGuard.require("toggle_setting", { setting, enabled: enabled ? "on" : "off" });
      if (!Capacitor.isNativePlatform()) throw new Error("Flashlight control requires the iOS or Android app.");
      const { Torch } = await import("@capawesome/capacitor-torch");
      const available = await Torch.isAvailable();
      if (!available.available) throw new Error("This device does not have an available flashlight.");
      if (enabled) await Torch.enable();
      else await Torch.disable();
      return { ok: true, message: `Flashlight turned ${enabled ? "on" : "off"}.` };
    },
  },
  {
    name: "send_message",
    description: "After confirmation, open the SMS composer with the exact recipient and text. The user must tap Send.",
    sensitive: "send_message",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Phone number including country code where possible." },
        message: { type: "string", description: "Exact SMS body to prepare." },
      },
      required: ["recipient", "message"],
    },
    execute: async (args) => {
      const recipient = String(args.recipient ?? "").trim();
      const message = String(args.message ?? "").trim();
      if (!/^\+?[0-9 ().-]{3,24}$/.test(recipient)) throw new Error("Enter a valid phone number for the SMS draft.");
      if (!message || message.length > 2000) throw new Error("The message must contain 1 to 2,000 characters.");
      await SafetyGuard.require("send_message", { recipient, message });
      await AppLauncher.openUrl({ url: `sms:${recipient.replace(/[ ().-]/g, "")}?body=${encodeURIComponent(message)}` });
      return { ok: true, message: "Opened the SMS draft. Review it and tap Send in your messaging app." };
    },
  },
  {
    name: "get_device_status",
    description: "Read basic device platform, operating system, online state, and connection type. Does not access device identifiers or personal files.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const [info, network] = await Promise.all([Device.getInfo(), Network.getStatus()]);
      return {
        platform: info.platform,
        operatingSystem: info.operatingSystem,
        osVersion: info.osVersion,
        isVirtual: info.isVirtual,
        online: network.connected,
        connectionType: network.connectionType,
      };
    },
  },
  {
    name: "get_battery_status",
    description: "Read the device battery percentage and charging status.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const info = await Device.getBatteryInfo();
      return {
        batteryPercent: typeof info.batteryLevel === "number" ? Math.round(info.batteryLevel * 100) : null,
        charging: info.isCharging ?? null,
      };
    },
  },
];

function safeDocumentPath(value: unknown, allowRoot = false) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw && allowRoot) return "";
  const path = raw.replaceAll("\\", "/");
  const segments = path.split("/");
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("Use a relative path inside Shanaya's app Documents area; parent and absolute paths are blocked.");
  }
  return segments.join("/");
}

export function getDeviceTools() {
  return deviceTools;
}

export function getMobileClawTools(): MobileClawTool[] {
  return deviceTools.map(({ name, description, inputSchema, execute }) => ({
    name,
    description,
    inputSchema,
    execute: async (args) => {
      return execute(args);
    },
  }));
}
