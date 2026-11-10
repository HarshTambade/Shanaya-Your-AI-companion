import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { Network } from "@capacitor/network";
import { initLlama, releaseAllLlama } from "llama-cpp-capacitor";
import type { ChatMessage, InferenceMode } from "../types";

export type OfflineModelStatus = "available" | "downloadable" | "notready" | "unavailable" | "checking";

const modelRelativePath = "models/shanaya.gguf";
const offlineSystemPrompt = [
  "You are Shanaya, a helpful personal assistant. Keep replies concise and conversational.",
  'When the user prompt includes JSON schemas for tools and you need one, return only {"toolCalls":[{"name":"tool_name","arguments":{}}]}.',
  'When finished, return only JSON: {"reply":"text","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
  "Never claim a device action succeeded unless its result confirms it.",
].join(" ");

type LlamaContext = Awaited<ReturnType<typeof initLlama>>;
let llamaContext: LlamaContext | undefined;
let llamaInitialization: Promise<LlamaContext> | undefined;

function supportsNativeLlama() {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android";
}

export async function getNetworkStatus() {
  const status = await Network.getStatus();
  return { ...status, connected: status.connected && (typeof navigator === "undefined" || navigator.onLine) };
}

export function addNetworkStatusListener(listener: (connected: boolean) => void) {
  return Network.addListener("networkStatusChange", ({ connected }) => {
    listener(connected && (typeof navigator === "undefined" || navigator.onLine));
  });
}

export function resolveInferenceMode(requested: InferenceMode, connected: boolean): InferenceMode {
  if (connected) return requested;
  return supportsNativeLlama() ? "native" : "webllm";
}

async function modelExists() {
  try {
    await Filesystem.stat({ path: modelRelativePath, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

export async function getOfflineModelStatus(): Promise<OfflineModelStatus> {
  if (!supportsNativeLlama()) return "unavailable";
  if (await modelExists()) return "available";
  const modelUrl = import.meta.env.VITE_OFFLINE_MODEL_URL?.trim();
  return modelUrl && navigator.onLine ? "downloadable" : "unavailable";
}

export async function prepareOfflineModel(onProgress?: (progress: number) => void) {
  if (!supportsNativeLlama()) {
    throw new Error("llama.cpp offline inference is available in the iOS and Android apps.");
  }
  if (await modelExists()) return;

  const modelUrl = import.meta.env.VITE_OFFLINE_MODEL_URL?.trim();
  if (!modelUrl) throw new Error("Set VITE_OFFLINE_MODEL_URL to a hosted GGUF model before preparing offline AI.");
  if (!navigator.onLine) throw new Error("Connect to the internet once to download the on-device model.");

  await Filesystem.mkdir({ path: "models", directory: Directory.Data, recursive: true });
  const stagingPath = `${modelRelativePath}.partial`;
  await Filesystem.deleteFile({ path: stagingPath, directory: Directory.Data }).catch(() => undefined);
  const destination = await Filesystem.getUri({ path: stagingPath, directory: Directory.Data });
  const progressListener = onProgress
    ? await FileTransfer.addListener("progress", ({ bytes, contentLength }) => {
      if (contentLength && contentLength > 0) onProgress(Math.max(0, Math.min(100, (bytes / contentLength) * 100)));
    })
    : undefined;
  try {
    await FileTransfer.downloadFile({
      url: modelUrl,
      path: destination.uri,
      progress: Boolean(onProgress),
    });
    const downloaded = await Filesystem.stat({ path: stagingPath, directory: Directory.Data });
    if (downloaded.size <= 0) throw new Error("The downloaded model file is empty.");
    await Filesystem.rename({ from: stagingPath, to: modelRelativePath, directory: Directory.Data });
    onProgress?.(100);
  } catch (error) {
    await Filesystem.deleteFile({ path: stagingPath, directory: Directory.Data }).catch(() => undefined);
    throw error;
  } finally {
    await progressListener?.remove();
  }
}

async function getModelPath() {
  const { uri } = await Filesystem.getUri({ path: modelRelativePath, directory: Directory.Data });
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

async function getLlamaContext() {
  if (llamaContext) return llamaContext;
  if (!llamaInitialization) {
    llamaInitialization = (async () => {
      if (!(await modelExists())) throw new Error("The on-device model is not ready. Prepare offline AI while online first.");
      const model = await getModelPath();
      const context = await initLlama({
        model,
        n_ctx: 2048,
        n_threads: Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4)),
        n_gpu_layers: 99,
      });
      llamaContext = context;
      return context;
    })().finally(() => {
      llamaInitialization = undefined;
    });
  }
  return llamaInitialization;
}

export async function generateOfflineReply(messages: ChatMessage[]) {
  if (!supportsNativeLlama()) throw new Error("This device does not support the native llama.cpp runtime.");
  const context = await getLlamaContext();
  const result = await context.completion({
    messages: [
      { role: "system", content: offlineSystemPrompt },
      ...messages.slice(-8).filter(({ role }) => role !== "system").map(({ role, content }) => ({ role, content: content.slice(0, 7000) })),
    ],
    n_predict: 512,
    temperature: 0.3,
  });
  const text = "content" in result ? result.content : result.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("The on-device model returned an empty response.");
  return text;
}

export async function releaseOfflineModel() {
  llamaContext = undefined;
  llamaInitialization = undefined;
  await releaseAllLlama();
}
