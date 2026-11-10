import { Capacitor } from "@capacitor/core";
import { LocalLLM } from "@capacitor/local-llm";
import type { ChatMessage } from "../types";

export type NativeLLMStatus = "available" | "downloadable" | "notready" | "unavailable" | "checking";

const nativeSystemPrompt = [
  "You are Shanaya, a friendly and emotionally aware AI companion. Keep replies concise and warm.",
  'Return only a JSON object: {"reply":"text","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
].join(" ");

export async function getNativeLLMStatus(): Promise<NativeLLMStatus> {
  if (!Capacitor.isNativePlatform()) return "unavailable";
  const { status } = await LocalLLM.systemAvailability();
  return status;
}

export async function prepareNativeLLM(): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error("On-device native AI is available inside the iOS or Android app.");

  let status = await getNativeLLMStatus();
  if (status === "downloadable") {
    if (!navigator.onLine) throw new Error("Connect to the internet once to download the on-device model.");
    await LocalLLM.download();
    status = "notready";
  }

  for (let attempt = 0; status === "notready" && attempt < 120; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    status = await getNativeLLMStatus();
  }

  if (status !== "available") {
    throw new Error("This device does not currently have a supported on-device language model.");
  }
}

export async function generateNativeReply(messages: ChatMessage[]): Promise<string> {
  const status = await getNativeLLMStatus();
  if (status !== "available") {
    if (status === "downloadable") throw new Error("The on-device model is not downloaded yet. Connect online and choose Prepare offline AI in settings.");
    if (status === "notready") throw new Error("The on-device model is still preparing. Try again shortly.");
    throw new Error("This device does not support the native offline model. Use WebLLM on a supported browser or reconnect.");
  }

  const prompt = messages.slice(-16).map((message) => {
    const role = message.role === "assistant" ? "Shanaya" : "User";
    return `${role}: ${message.content.slice(0, 1600)}`;
  }).join("\n\n");

  const response = await LocalLLM.prompt({
    instructions: nativeSystemPrompt,
    prompt: `${prompt}\n\nShanaya:`,
    options: { temperature: 0.7, maximumOutputTokens: 220 },
  });
  return response.text;
}
