import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useBrowserLLM } from "use-browser-llm";
import { useCallClient } from "@pinecall/ionic/react";
import {
  ArrowUp, Bot, Cpu, Globe2, HardDrive, KeyRound, Laptop, LockKeyhole, Mic, Phone, PhoneOff,
  RotateCcw, Settings2, Smartphone, Speaker, VolumeX, X,
} from "lucide-react";
import type { ChatMessage, Emotion, InferenceMode, SpeechLanguage } from "../types";
import { useConnectivity } from "../services/connectivity";
import {
  generateOfflineReply,
  getOfflineModelStatus,
  prepareOfflineModel,
  resolveInferenceMode,
  type OfflineModelStatus,
} from "../services/AIService";
import { requestCallMicrophonePermission } from "../services/callPermissions";
import { apiUrl } from "../services/api";
import { SpeechService } from "../services/SpeechService";
import { VoiceService } from "../services/VoiceService";
import { pinecallAgentId, shanayaCallClient } from "../services/callClient";
import { agentRules, runAgentTurn, type AgentActivity } from "../services/AgentRuntime";
import { clearMobileAgentConversation, getMobileAgentStatus, runMobileAgentTurn, setMobileAgentApiKey } from "../services/MobileAgent";
import { hasDesktopBridge, runDesktopAgentTurn } from "../services/DesktopAgent";

const WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const welcomeMessage: ChatMessage = {
  role: "assistant",
  content: "Hey, I’m Shanaya. It’s lovely to meet you. What’s on your mind?",
};

const modeDetails: Record<InferenceMode, { label: string; description: string; icon: typeof Globe2 }> = {
  cloud: { label: "Groq Cloud", description: "Groq model with device tools", icon: Globe2 },
  webllm: { label: "WebLLM Local", description: "Runs in this browser with WebGPU", icon: Cpu },
  ollama: { label: "Local Ollama", description: "Uses your configured Ollama server", icon: HardDrive },
  native: { label: "On-device AI", description: "Runs a downloaded llama.cpp model", icon: Smartphone },
  mobileclaw: { label: "MobileClaw · Anthropic", description: "Native agent using your Anthropic key", icon: Smartphone },
  desktop: { label: "Desktop Agent", description: "Uses the desktop with confirmation", icon: Laptop },
};

function modelLabel(model: string) {
  if (model === "openai/gpt-oss-120b") return "GPT-OSS 120B · Groq default";
  if (model === "openai/gpt-oss-20b") return "GPT-OSS 20B · Groq fallback";
  return model;
}

function normalizeEmotion(value: unknown): Emotion {
  return value === "happy" || value === "sad" || value === "angry" || value === "neutral" || value === "surprised" || value === "thinking"
    ? value
    : "neutral";
}

function parseAIResponse(value: unknown): { reply: string; emotion: Emotion } {
  let parsed = value;
  if (typeof value === "string") {
    const candidate = value.match(/\{[\s\S]*\}/)?.[0];
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        return { reply: value.trim(), emotion: "neutral" };
      }
    } else {
      return { reply: value.trim(), emotion: "neutral" };
    }
  }

  if (parsed && typeof parsed === "object" && "reply" in parsed) {
    const result = parsed as { reply?: unknown; emotion?: unknown };
    if (typeof result.reply === "string" && result.reply.trim()) {
      return { reply: result.reply.trim(), emotion: normalizeEmotion(result.emotion) };
    }
  }
  throw new Error("The companion returned an invalid response. Please try again.");
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

type ChatUIProps = {
  onEmotionChange: (emotion: Emotion) => void;
  panel?: boolean;
};

type ApiStatus = "checking" | "connected" | "offline" | "misconfigured";

export default function ChatUI({ onEmotionChange, panel = false }: ChatUIProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InferenceMode>("cloud");
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [cloudModel, setCloudModel] = useState("");
  const [cloudProvider, setCloudProvider] = useState("Groq");
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("en-US");
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    try {
      const saved = window.localStorage.getItem("shanaya.voiceEnabled");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [voiceStatus, setVoiceStatus] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [nativeStatus, setNativeStatus] = useState<OfflineModelStatus>("checking");
  const [isPreparingNative, setIsPreparingNative] = useState(false);
  const [nativeAgentStatus, setNativeAgentStatus] = useState({ available: false, initialized: false, hasApiKey: false });
  const [mobileApiKey, setMobileApiKey] = useState("");
  const [isSavingMobileApiKey, setIsSavingMobileApiKey] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivity | null>(null);
  const [modelDownloadProgress, setModelDownloadProgress] = useState(0);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voiceSessionRef = useRef<(() => Promise<void> | void) | null>(null);
  const isOnline = useConnectivity();
  const platform = Capacitor.getPlatform();
  const isNative = platform === "ios" || platform === "android";
  const desktopAvailable = hasDesktopBridge();
  const effectiveMode = resolveInferenceMode(mode, isOnline);
  const localLLM = useBrowserLLM(effectiveMode === "webllm" ? WEBLLM_MODEL : undefined);
  const selectedMode = effectiveMode === "cloud"
    ? {
      ...modeDetails.cloud,
      label: cloudProvider === "Groq" ? "Groq Cloud" : `${cloudProvider} AI`,
      description: `${cloudProvider} model with device tools`,
    }
    : modeDetails[effectiveMode];
  const call = useCallClient(shanayaCallClient);
  const isCallConnecting = call.status === "connecting";
  const isCallConnected = call.status === "connected";
  const showCallPanel = call.status !== "idle" || call.messages.length > 0;

  useEffect(() => {
    let active = true;
    const loadApiStatus = async () => {
      try {
        const response = await fetch(apiUrl("/api/models"), { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`API returned HTTP ${response.status}.`);
        const data = await response.json();
        if (!active || !Array.isArray(data.models)) return;

        const models = data.models.filter((model: unknown): model is string => typeof model === "string" && model.length > 0);
        setApiStatus(models.length ? "connected" : "misconfigured");
        setCloudModels(models);
        if (typeof data.provider === "string" && data.provider) setCloudProvider(data.provider);
        let storedModel: string | null = null;
        try {
          storedModel = window.localStorage.getItem("shanaya.cloudModel");
        } catch {
          storedModel = null;
        }
        setCloudModel((currentModel) => models.includes(currentModel)
          ? currentModel
          : models.includes(storedModel || "")
            ? storedModel!
            : models.includes(data.defaultModel) ? data.defaultModel : models[0] || "");
      } catch {
        if (active) setApiStatus("offline");
      }
    };

    void loadApiStatus();
    const retryTimer = window.setInterval(() => void loadApiStatus(), 10_000);
    return () => {
      active = false;
      window.clearInterval(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (!cloudModel) return;
    try {
      window.localStorage.setItem("shanaya.cloudModel", cloudModel);
    } catch {
      // The server still supplies its default if storage is unavailable.
    }
  }, [cloudModel]);

  useEffect(() => {
    try {
      window.localStorage.setItem("shanaya.voiceEnabled", String(voiceEnabled));
    } catch {
      // Voice preference remains available for this session if storage is disabled.
    }
  }, [voiceEnabled]);

  const refreshNativeStatus = useCallback(async () => {
    if (!isNative) {
      setNativeStatus("unavailable");
      return;
    }
    try {
      setNativeStatus(await getOfflineModelStatus());
    } catch {
      setNativeStatus("unavailable");
    }
  }, [isNative]);

  useEffect(() => {
    void refreshNativeStatus();
  }, [isOnline, refreshNativeStatus]);

  useEffect(() => {
    if (isNative) void getMobileAgentStatus().then(setNativeAgentStatus);
  }, [isNative]);

  useEffect(() => () => {
    void voiceSessionRef.current?.();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, error, call.messages.length]);

  const handlePrepareNative = async () => {
    setIsPreparingNative(true);
    setError("");
    setNativeStatus("notready");
    setModelDownloadProgress(0);
    try {
      await prepareOfflineModel(setModelDownloadProgress);
      await refreshNativeStatus();
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "Could not download the on-device model.");
      await refreshNativeStatus();
    } finally {
      setIsPreparingNative(false);
    }
  };

  const submitMessage = async (event?: FormEvent<HTMLFormElement>, transcript?: string, speakReply = voiceEnabled) => {
    event?.preventDefault();
    const content = (transcript ?? input).trim();
    if (!content || isLoading) return;
    if (effectiveMode === "webllm" && localLLM.status !== "ready") {
      setError(localLLM.status === "unsupported" ? "WebGPU is unavailable. Reconnect or use the native app for offline AI." : "The browser model is still preparing or could not load.");
      return;
    }
    if (effectiveMode === "native" && nativeStatus !== "available") {
      setError(nativeStatus === "downloadable" ? "Prepare the offline model while online, then try again." : "This device does not have a supported on-device AI model.");
      return;
    }

    const nextMessages = [...messages, { role: "user" as const, content }];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setIsLoading(true);
    setAgentActivity({ phase: "thinking", message: "Shanaya is thinking…" });
    if (inputRef.current) inputRef.current.style.height = "auto";

    try {
      let result: { reply: string; emotion: Emotion };
      const publishActivity = (message: string, acting = false) => {
        setAgentActivity({ phase: acting ? "acting" : "thinking", message });
        if (!acting && message && !message.toLowerCase().includes("thinking") && !message.toLowerCase().includes("examining") && !message.toLowerCase().includes("screenshot")) {
          setMessages((current) => [...current, { role: "system", content: message }]);
        }
      };

      if (effectiveMode === "desktop") {
        const reply = await runDesktopAgentTurn(content, publishActivity);
        result = parseAIResponse(reply);
      } else if (effectiveMode === "mobileclaw" && isNative && isOnline && nativeAgentStatus.hasApiKey) {
        const response = await runMobileAgentTurn(content, publishActivity);
        result = parseAIResponse(response);
      } else {
        result = await runAgentTurn({
          mode: effectiveMode,
          model: cloudModel || undefined,
          messages: nextMessages,
          generateLocal: async (prompt, routeMode) => {
            if (routeMode === "webllm") {
              return localLLM.generate([{ role: "system", content: agentRules }, { role: "user", content: prompt }]);
            }
            if (routeMode === "native") return generateOfflineReply([{ role: "user", content: prompt }]);
            throw new Error("The selected agent mode is unavailable.");
          },
          onActivity: (activity) => {
            setAgentActivity(activity);
            if (activity.phase === "tool-result") setMessages((current) => [...current, { role: "system", content: activity.message }]);
          },
        });
      }

      setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
      onEmotionChange(result.emotion);
      if (speakReply) {
        void SpeechService.speak(result.reply, speechLanguage)
          .then((voiceName) => setVoiceStatus(`Speaking with ${voiceName}`))
          .catch((speechError) => setVoiceStatus(speechError instanceof Error ? speechError.message : "Offline voice unavailable."));
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
      setAgentActivity(null);
      inputRef.current?.focus();
    }
  };

  const saveMobileAgentKey = async () => {
    setIsSavingMobileApiKey(true);
    setError("");
    try {
      await setMobileAgentApiKey(mobileApiKey);
      setMobileApiKey("");
      setNativeAgentStatus({ available: true, initialized: true, hasApiKey: true });
      setVoiceStatus("MobileClaw connected. Select it in inference settings; Groq stays the default.");
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "Could not save the native agent key.");
    } finally {
      setIsSavingMobileApiKey(false);
    }
  };

  const startVoiceCall = async () => {
    setError("");
    if (!isOnline) {
      setError("Voice calls need an internet connection. Offline chat and native speech remain available.");
      return;
    }
    if (!pinecallAgentId) {
      setError("Configure VITE_PINECALL_AGENT_ID and PINECALL_TOKEN_URL to start calls.");
      return;
    }
    try {
      if (!await requestCallMicrophonePermission()) {
        setError("Allow microphone access in device settings to start a voice call.");
        return;
      }
      await call.startCall({
        agentId: pinecallAgentId,
        callerName: "You",
        handle: "Shanaya voice call",
        tokenUrl: apiUrl("/api/pinecall/token"),
      });
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : "Could not start the voice call.");
    }
  };

  const toggleVoiceInput = async () => {
    if (isListening) {
      try {
        await voiceSessionRef.current?.();
      } finally {
        voiceSessionRef.current = null;
        setIsListening(false);
        setVoiceStatus("Voice input stopped");
      }
      return;
    }

    setError("");
    try {
      voiceSessionRef.current = await VoiceService.startSession(speechLanguage, (transcript, isFinal) => {
        setInput(transcript);
        if (isFinal) {
          const stop = voiceSessionRef.current;
          voiceSessionRef.current = null;
          setIsListening(false);
          void stop?.();
          void submitMessage(undefined, transcript, true);
        }
      }, (message) => {
        setError(message);
        const stop = voiceSessionRef.current;
        voiceSessionRef.current = null;
        setIsListening(false);
        void stop?.();
      });
      setIsListening(true);
      setVoiceStatus(`Listening in ${speechLanguage} · speak to send`);
    } catch (voiceError) {
      voiceSessionRef.current = null;
      setIsListening(false);
      setError(voiceError instanceof Error ? voiceError.message : "Could not start voice input.");
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  const resetConversation = () => {
    if (isLoading) return;
    setMessages([welcomeMessage]);
    setError("");
    setInput("");
    setVoiceStatus("");
    onEmotionChange("neutral");
    void clearMobileAgentConversation().catch(() => undefined);
  };

  const nativeStatusLabel = nativeStatus === "available"
    ? "GGUF model ready on this device"
    : nativeStatus === "downloadable"
      ? "Model needs a one-time download"
      : nativeStatus === "notready" || isPreparingNative
        ? "Preparing the on-device model…"
        : nativeStatus === "checking"
          ? "Checking device support…"
          : import.meta.env.VITE_OFFLINE_MODEL_URL
            ? "llama.cpp is available in the iOS and Android app"
            : "Set VITE_OFFLINE_MODEL_URL to enable model download";
  const webStatusLabel = localLLM.status === "loading"
    ? `Preparing browser model · ${Math.round(localLLM.progress * 100)}%`
    : localLLM.status === "ready"
      ? "Browser model ready"
      : localLLM.status === "unsupported"
        ? "WebGPU is unavailable in this browser"
        : localLLM.status === "error"
          ? "Could not load the browser model"
          : "Model loads when selected";
  const canSend = effectiveMode === "webllm"
    ? localLLM.status === "ready"
    : effectiveMode === "native"
      ? nativeStatus === "available"
      : true;
  const settingsPosition = panel
    ? "absolute inset-x-2 top-14 bottom-[7.5rem] z-40 overflow-y-auto rounded-2xl border border-white/10 bg-[#111622]/[0.98] p-4 shadow-2xl shadow-black/60 backdrop-blur-2xl"
    : "absolute bottom-[calc(100%+0.5rem)] right-3 z-40 max-h-[min(75dvh,42rem)] w-[min(380px,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-white/10 bg-[#111622]/95 p-4 shadow-2xl shadow-black/60 backdrop-blur-2xl md:right-[max(calc((100vw-42rem)/2),1rem)]";

  return (
    <section className={panel
      ? "relative mx-auto flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden rounded-[22px] border border-white/[0.09] bg-[#0b0e17]/90 shadow-[0_18px_70px_rgba(0,0,0,0.38)] backdrop-blur-2xl sm:rounded-[26px]"
      : "relative mx-auto flex max-h-[48dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[26px] border border-white/10 bg-[#0b0e17]/75 shadow-[0_18px_70px_rgba(0,0,0,0.55)] backdrop-blur-2xl"}>
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-4 py-3 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-violet-300/20 bg-violet-400/[0.1] text-violet-200">
            <Bot size={17} />
            <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#111521] ${isOnline && (effectiveMode !== "cloud" || apiStatus === "connected") ? "bg-emerald-400" : "bg-amber-300"}`} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-['Manrope'] text-sm font-bold text-slate-100">Shanaya</h1>
            <p className="truncate text-[10px] text-slate-400">
              {!isOnline
                ? `Offline · ${selectedMode.label}`
                : effectiveMode === "cloud" && apiStatus === "offline"
                  ? "API server unavailable"
                  : effectiveMode === "cloud" && apiStatus === "misconfigured"
                    ? "Add a Groq API key on the server"
                    : effectiveMode === "cloud" && apiStatus === "checking"
                      ? "Connecting to the API…"
                      : selectedMode.label}
              {isCallConnected ? ` · call ${formatDuration(call.duration)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsSettingsOpen((open) => !open)}
            aria-expanded={isSettingsOpen}
            aria-label="Inference and privacy settings"
            className="flex items-center gap-2 rounded-xl border border-white/[0.08] p-2.5 text-slate-300 transition hover:bg-white/[0.06]"
          >
            {isSettingsOpen ? <X size={15} /> : <Settings2 size={15} />}
            {panel && <span className="hidden text-[10px] font-medium sm:inline">{isSettingsOpen ? "Close" : "Settings"}</span>}
          </button>
          <button
            type="button"
            onClick={resetConversation}
            disabled={isLoading}
            aria-label="Start a new conversation"
            className="rounded-xl border border-white/[0.08] p-2.5 text-slate-300 transition hover:bg-white/[0.06] disabled:opacity-40"
          >
            <RotateCcw size={15} />
          </button>
        </div>

        {isSettingsOpen && (
          <div className={settingsPosition}>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-300">
              <Cpu size={14} className="text-violet-300" /> Inference mode
            </div>
            <div className="space-y-2">
              {(Object.keys(modeDetails) as InferenceMode[]).filter((option) =>
                (option !== "desktop" || desktopAvailable) && (option !== "mobileclaw" || isNative)
              ).map((option) => {
                const detail = option === "cloud" ? selectedMode : modeDetails[option];
                const Icon = detail.icon;
                const unavailableNativeOption = option === "native" && !isNative;
                const unavailableMobileClaw = option === "mobileclaw" && !nativeAgentStatus.hasApiKey;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isLoading || unavailableNativeOption || unavailableMobileClaw}
                    onClick={() => {
                      setMode(option);
                      setError("");
                      setIsSettingsOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${mode === option ? "border-violet-400/30 bg-violet-400/[0.08]" : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.13]"}`}
                  >
                    <Icon size={16} className={mode === option ? "text-violet-200" : "text-slate-500"} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-200">{detail.label}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {unavailableNativeOption
                          ? "Available in the Capacitor app"
                          : unavailableMobileClaw
                            ? "Add an Anthropic key below to enable"
                            : detail.description}
                      </span>
                    </span>
                    {mode === option && <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />}
                  </button>
                );
              })}
            </div>

            {effectiveMode === "cloud" && (
              <div className="mt-3 rounded-xl border border-violet-300/10 bg-violet-300/[0.035] p-3">
                <label htmlFor="cloud-model" className="mb-1.5 block text-xs font-semibold text-slate-300">{cloudProvider} model</label>
                <select
                  id="cloud-model"
                  value={cloudModel}
                  onChange={(event) => setCloudModel(event.target.value)}
                  disabled={isLoading || cloudModels.length === 0}
                  className="w-full rounded-lg border border-white/[0.08] bg-[#111521] px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-violet-300/30 disabled:opacity-50"
                >
                  {cloudModels.length === 0
                    ? <option value="">Waiting for server model settings…</option>
                    : cloudModels.map((model) => <option key={model} value={model}>{modelLabel(model)}</option>)}
                </select>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{cloudProvider === "Groq" ? "Groq is the default." : `${cloudProvider} is configured on the server.`} If a selected model is unavailable, the server tries the remaining configured models.</p>
              </div>
            )}

            {effectiveMode === "native" && (
              <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs text-slate-400">
                {nativeStatusLabel}
                {isOnline && nativeStatus === "downloadable" && (
                  <button
                    type="button"
                    onClick={() => void handlePrepareNative()}
                    disabled={isPreparingNative}
                    className="mt-2 block w-full rounded-lg bg-violet-500/20 px-3 py-2 font-medium text-violet-100 transition hover:bg-violet-500/30 disabled:opacity-50"
                  >
                    {isPreparingNative ? `Downloading · ${Math.round(modelDownloadProgress)}%` : "Download offline model"}
                  </button>
                )}
              </div>
            )}
            {effectiveMode === "webllm" && (
              <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs text-slate-400">
                {webStatusLabel}. Download once while online; the browser can then use its local cache offline.
              </p>
            )}
            {effectiveMode === "ollama" && (
              <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs leading-relaxed text-slate-400">
                Configure <code className="text-violet-200">OLLAMA_BASE_URL</code> and <code className="text-violet-200">OLLAMA_MODEL</code> in <code className="text-violet-200">server/.env</code>.
              </p>
            )}

            {isNative && (
              <div className="mt-3 rounded-xl border border-violet-300/10 bg-violet-300/[0.035] p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-300">
                  <KeyRound size={13} className="text-violet-200" /> Native agent runtime
                  <span className={`ml-auto h-1.5 w-1.5 rounded-full ${nativeAgentStatus.hasApiKey ? "bg-emerald-400" : "bg-slate-600"}`} />
                </div>
                {nativeAgentStatus.hasApiKey ? (
                  <p className="text-[11px] leading-relaxed text-slate-400">MobileClaw is ready with on-device vector memory. Select MobileClaw · Anthropic above to use it; Groq remains the default cloud model.</p>
                ) : (
                  <>
                    <p className="mb-2 text-[11px] leading-relaxed text-slate-500">Add an Anthropic API key to use the native Rust agent and its on-device LanceDB memory. The key is stored by the native agent plugin.</p>
                    <div className="flex gap-2">
                      <input type="password" value={mobileApiKey} onChange={(event) => setMobileApiKey(event.target.value)} placeholder="Anthropic API key" aria-label="Anthropic API key" autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-violet-300/30" />
                      <button type="button" onClick={() => void saveMobileAgentKey()} disabled={!mobileApiKey.trim() || isSavingMobileApiKey} className="rounded-lg bg-violet-400/15 px-3 text-xs font-medium text-violet-100 disabled:opacity-40">{isSavingMobileApiKey ? "Saving…" : "Connect"}</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {effectiveMode === "desktop" && (
              <div className="mt-3 rounded-lg border border-amber-200/10 bg-amber-200/[0.04] px-3 py-2 text-xs leading-relaxed text-amber-100/75">
                Desktop screenshots and task instructions are sent to the configured Anthropic API. Shanaya asks before each keyboard or mouse action.
              </div>
            )}

            <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/15 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-300">
                <LockKeyhole size={13} className="text-emerald-300" /> Privacy and voice
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                {!isOnline
                  ? "Offline messages use WebLLM in browsers and a downloaded llama.cpp model in the iOS or Android app. Those prompts stay on this device. Speech input uses the platform recognizer, whose offline support varies."
                  : `WebLLM and llama.cpp process prompts locally. Ollama sends prompts to its configured endpoint. ${cloudProvider} Cloud sends prompts and tool requests to its configured provider. MobileClaw sends prompts directly to Anthropic only when selected. If Mithi TTS is configured, reply text is sent to that service; otherwise installed system voices are used. Voice calls use Pinecall over the internet.`}
              </p>
            </div>
          </div>
        )}
      </header>

      {!isOnline && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200/10 bg-amber-200/[0.05] px-4 py-2 text-[10px] font-medium text-amber-100/80">
          <LockKeyhole size={12} /> Offline mode · AI requests stay on this device
        </div>
      )}

      {effectiveMode === "cloud" && apiStatus === "offline" && (
        <div role="alert" className="shrink-0 border-b border-rose-300/10 bg-rose-300/[0.05] px-4 py-2 text-[10px] leading-relaxed text-rose-100/80">
          Shanaya’s API server is not reachable. From the project root, run <code className="text-rose-100">npm run dev</code> to start the API and client together. The app will retry automatically.
        </div>
      )}
      {effectiveMode === "cloud" && apiStatus === "misconfigured" && (
        <div role="alert" className="shrink-0 border-b border-amber-200/10 bg-amber-200/[0.05] px-4 py-2 text-[10px] leading-relaxed text-amber-100/80">
          The API server is online, but no cloud models are configured. Add <code className="text-amber-100">GROQ_API_KEY</code> to <code className="text-amber-100">server/.env</code> and restart the server.
        </div>
      )}

      <div ref={scrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isSystem = message.role === "system";
            if (isSystem) return <div key={`${index}-system`} role="status" className="mx-8 rounded-xl border border-emerald-300/10 bg-emerald-300/[0.035] px-3 py-2 text-[10px] leading-relaxed text-emerald-100/70">{message.content}</div>;
            return (
              <div key={`${index}-${message.role}`} className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && <div className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-violet-300/15 bg-violet-400/[0.08] text-violet-200"><Bot size={11} /></div>}
                <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[12px] leading-relaxed ${isUser ? "rounded-br-md bg-gradient-to-br from-indigo-500 to-violet-600 text-white" : "rounded-bl-md border border-white/[0.05] bg-[#171b28]/85 text-slate-200"}`}>
                  {message.content}
                </div>
              </div>
            );
          })}

          {(isLoading || (effectiveMode === "webllm" && localLLM.status === "loading")) && (
            <div className="flex items-center gap-2 pl-8 text-xs text-slate-400">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />
              {effectiveMode === "webllm" && localLLM.status === "loading"
                ? `Loading local model · ${Math.round(localLLM.progress * 100)}%`
                : isLoading ? agentActivity?.message || "Shanaya is thinking…" : ""}
            </div>
          )}

          {effectiveMode === "webllm" && localLLM.status === "unsupported" && (
            <p className="pl-8 text-xs text-amber-200/80">WebGPU is unavailable. Reconnect or use the Capacitor app for native offline AI.</p>
          )}
          {error && <div role="alert" className="ml-8 rounded-xl border border-rose-400/15 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-100/90">{error}</div>}
        </div>
      </div>

      {showCallPanel && (isCallConnecting || isCallConnected || call.messages.length > 0 || call.error) && (
        <div className="mx-3 mb-2 rounded-2xl border border-violet-300/15 bg-violet-400/[0.06] px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-medium text-violet-100">
              <Phone size={13} />
              {isCallConnected ? `Connected · ${formatDuration(call.duration)}` : isCallConnecting ? "Connecting to Shanaya…" : "Voice call"}
            </div>
            <div className="flex items-center gap-1.5">
              {isCallConnected && <button type="button" onClick={() => void call.toggleMute()} aria-label="Toggle microphone" className="rounded-lg border border-white/10 p-2 text-slate-200"><Mic size={14} /></button>}
              {isCallConnected && <button type="button" onClick={() => void call.toggleSpeaker()} aria-label="Toggle speaker" className="rounded-lg border border-white/10 p-2 text-slate-200"><Speaker size={14} /></button>}
              {call.status !== "idle" && <button type="button" onClick={() => void call.endCall()} aria-label="End voice call" className="rounded-lg bg-rose-500/20 p-2 text-rose-100"><PhoneOff size={14} /></button>}
            </div>
          </div>
          {call.messages.length > 0 && (
            <div className="chat-scrollbar mt-2 max-h-20 space-y-1 overflow-y-auto text-[10px] leading-relaxed text-slate-400">
              {call.messages.slice(-4).map((message) => <p key={message.id}><span className="text-violet-200">{message.role === "bot" ? "Shanaya" : "You"}:</span> {message.text}</p>)}
            </div>
          )}
          {call.error && <p className="mt-1 text-[10px] text-rose-200">{call.error}</p>}
        </div>
      )}

      <div className="shrink-0 border-t border-white/[0.07] p-2.5 md:p-3">
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-2 px-1 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <select
              value={speechLanguage}
              onChange={(event) => setSpeechLanguage(event.target.value as SpeechLanguage)}
              aria-label="Voice language"
              className="max-w-32 rounded-lg border border-white/[0.08] bg-[#111521] px-2 py-1.5 text-[10px] text-slate-300 outline-none"
            >
              <option value="en-US">English</option>
              <option value="hi-IN">हिन्दी</option>
              <option value="mr-IN">मराठी</option>
            </select>
            <button
              type="button"
              onClick={() => {
                setVoiceEnabled((enabled) => !enabled);
                setVoiceStatus(voiceEnabled ? "Voice replies off" : "Voice replies on · offline device voice preferred");
              }}
              aria-label={voiceEnabled ? "Turn voice replies off" : "Turn voice replies on"}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] transition ${voiceEnabled ? "border-violet-300/25 bg-violet-400/10 text-violet-100" : "border-white/[0.08] text-slate-400 hover:bg-white/[0.05]"}`}
            >
              {voiceEnabled ? <Speaker size={12} /> : <VolumeX size={12} />}
              <span>Voice</span>
            </button>
            {!isOnline && <span className="hidden truncate text-[10px] text-slate-500 sm:inline">On-device mode</span>}
          </div>
          <button
            type="button"
            onClick={() => void toggleVoiceInput()}
            aria-label={isListening ? "Stop voice input" : "Start voice input"}
            title={isListening ? "Stop listening" : "Speak to Shanaya"}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-medium transition ${isListening ? "border-rose-300/20 bg-rose-300/[0.1] text-rose-100" : "border-violet-300/15 bg-violet-300/[0.06] text-violet-100 hover:bg-violet-300/[0.12]"}`}
          >
            <Mic size={12} /> {isListening ? "Listening" : "Speak"}
          </button>
          <button
            type="button"
            onClick={() => void startVoiceCall()}
            disabled={!isOnline || isCallConnecting || isCallConnected}
            title="Voice calls use Pinecall and require internet"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.07] px-2.5 py-1.5 text-[10px] font-medium text-emerald-100 transition hover:bg-emerald-300/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Phone size={12} /> Call
          </button>
        </div>
        {voiceStatus && <p aria-live="polite" className="mx-auto mb-1 max-w-[720px] px-1 text-[10px] text-slate-500">{voiceStatus}</p>}
        <form onSubmit={(event) => void submitMessage(event)} className="mx-auto flex max-w-[720px] items-end gap-2 rounded-2xl border border-white/[0.09] bg-[#111521]/90 p-1.5 transition focus-within:border-violet-400/40">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value.slice(0, 4000));
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 96)}px`;
            }}
            onKeyDown={handleKeyDown}
            placeholder={!isOnline ? "Message Shanaya offline…" : "Message Shanaya…"}
            aria-label="Message Shanaya"
            rows={1}
            maxLength={4000}
            className="max-h-24 min-h-10 flex-1 resize-none bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading || !canSend}
            aria-label="Send message"
            className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-950/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </form>
        <p className="mt-1.5 text-center text-[9px] text-slate-500">
          {effectiveMode === "cloud"
            ? `${cloudProvider} · ${modelLabel(cloudModel || cloudModels[0] || "")}`
            : effectiveMode === "ollama"
              ? "Ollama · prompts go to your configured endpoint"
              : effectiveMode === "mobileclaw"
                ? "MobileClaw · Anthropic retention policy applies"
              : effectiveMode === "desktop"
                ? "Desktop agent · screenshots go to Anthropic; actions need confirmation"
              : "On-device inference · messages stay on this device"}
        </p>
      </div>
    </section>
  );
}
