import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { initLlama, releaseAllLlama } from "llama-cpp-capacitor";
import type { ChatMessage } from "./LLMRouter";

export type NativeModelStatus = "available" | "downloadable" | "unavailable";
const modelPath = "models/shanaya.gguf";
type LlamaContext = Awaited<ReturnType<typeof initLlama>>;
let context: LlamaContext | undefined;
let initializing: Promise<LlamaContext> | undefined;

export function supportsNativeLLM() {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android";
}

async function modelExists() {
  try {
    await Filesystem.stat({ path: modelPath, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

export async function getNativeModelStatus(): Promise<NativeModelStatus> {
  if (!supportsNativeLLM()) return "unavailable";
  if (await modelExists()) return "available";
  return import.meta.env.VITE_OFFLINE_MODEL_URL && navigator.onLine ? "downloadable" : "unavailable";
}

export async function prepareNativeModel(onProgress?: (percent: number) => void): Promise<void> {
  if (!supportsNativeLLM()) throw new Error("llama.cpp offline inference is available in the iOS and Android apps.");
  if (await modelExists()) return;
  const url = import.meta.env.VITE_OFFLINE_MODEL_URL?.trim();
  if (!url) throw new Error("Set VITE_OFFLINE_MODEL_URL to a hosted GGUF model before downloading offline AI.");
  if (!navigator.onLine) throw new Error("Connect to the internet once to download the on-device model.");

  await Filesystem.mkdir({ path: "models", directory: Directory.Data, recursive: true });
  const stagingPath = `${modelPath}.partial`;
  await Filesystem.deleteFile({ path: stagingPath, directory: Directory.Data }).catch(() => undefined);
  const target = await Filesystem.getUri({ path: stagingPath, directory: Directory.Data });
  const listener = onProgress
    ? await FileTransfer.addListener("progress", ({ bytes, contentLength }) => {
      if (contentLength && contentLength > 0) onProgress(Math.min(100, Math.max(0, bytes / contentLength * 100)));
    })
    : undefined;
  try {
    await FileTransfer.downloadFile({ url, path: target.uri, progress: Boolean(onProgress) });
    const downloaded = await Filesystem.stat({ path: stagingPath, directory: Directory.Data });
    if (downloaded.size <= 0) throw new Error("The downloaded GGUF model is empty.");
    await Filesystem.rename({ from: stagingPath, to: modelPath, directory: Directory.Data });
    onProgress?.(100);
  } catch (error) {
    await Filesystem.deleteFile({ path: stagingPath, directory: Directory.Data }).catch(() => undefined);
    throw error;
  } finally {
    await listener?.remove();
  }
}

async function getContext() {
  if (context) return context;
  if (!initializing) {
    initializing = (async () => {
      if (!(await modelExists())) throw new Error("Download the offline model before using llama.cpp.");
      const modelUri = await Filesystem.getUri({ path: modelPath, directory: Directory.Data });
      const modelFile = decodeURIComponent(modelUri.uri.replace(/^file:\/\//, ""));
      const result = await initLlama({
        model: modelFile,
        n_ctx: 2048,
        n_threads: Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4)),
        n_gpu_layers: 99,
      });
      context = result;
      return result;
    })().finally(() => { initializing = undefined; });
  }
  return initializing;
}

export async function generateNativeReply(messages: ChatMessage[]): Promise<string> {
  if (!supportsNativeLLM()) throw new Error("Native llama.cpp is not available on this platform.");
  const llama = await getContext();
  const response = await llama.completion({
    messages: [
      { role: "system", content: 'You are Shanaya, a warm, attentive, natural-sounding AI companion. Silently infer intent, constraints, earlier-turn references, emotional cues, and language or register. Understand informal wording, typos, and mixed-language messages. Use context to answer specifically and proportionately, with natural variation; avoid canned greetings, repetition, filler, forced emojis, and habitual closing questions. Never pretend to be human or invent personal experiences. Reply only as JSON: {"reply":"text","emotion":"happy|sad|cute|neutral"}.' },
      ...messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-8),
    ],
    n_predict: 512,
    temperature: 0.3,
  });
  const content = response.content || response.text;
  if (typeof content !== "string" || !content.trim()) throw new Error("The local model returned an empty response.");
  return content;
}

export async function releaseNativeModel(): Promise<void> {
  context = undefined;
  initializing = undefined;
  await releaseAllLlama();
}
