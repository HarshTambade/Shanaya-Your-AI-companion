import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useBrowserLLM } from "use-browser-llm";
import {
  ArrowUp, Bot, Cpu, Globe2, HardDrive, KeyRound, Laptop, LockKeyhole, Mic, MicOff, Phone, PhoneOff,
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
import { apiUrl } from "../services/api";
import { SpeechService } from "../services/SpeechService";
import { VoiceService } from "../services/VoiceService";
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
  if (model === "openai/gpt-oss-120b") return "GPT-OSS 120B · Groq primary";
  if (model === "openai/gpt-oss-20b") return "GPT-OSS 20B · Groq fallback";
  if (model === "llama-3.3-70b-versatile") return "Llama 3.3 70B · Groq Enterprise";
  if (model === "llama-3.1-8b-instant") return "Llama 3.1 8B · Groq Enterprise";
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
  groqApiKey: string;
};

type ApiStatus = "checking" | "connected" | "offline" | "misconfigured";

export default function ChatUI({ onEmotionChange, panel = false, groqApiKey }: ChatUIProps) {
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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isVirtualCallActive, setIsVirtualCallActive] = useState(false);
  const [isCallMicEnabled, setIsCallMicEnabled] = useState(false);
  const [isCallSpeakerOn, setIsCallSpeakerOn] = useState(true);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [prepareWebFallback, setPrepareWebFallback] = useState(false);
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
  const callLogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voiceSessionRef = useRef<(() => Promise<void> | void) | null>(null);
  const startCallListeningRef = useRef<() => void>(() => undefined);
  const callActiveRef = useRef(false);
  const callMicEnabledRef = useRef(false);
  const callSpeakerRef = useRef(true);
  const voiceEnabledRef = useRef(voiceEnabled);
  const voiceInputEnabledRef = useRef(false);
  const voiceTurnPendingRef = useRef(false);
  const voiceStartPendingRef = useRef(false);
  const isSubmittingTurnRef = useRef(false);
  voiceEnabledRef.current = voiceEnabled;
  const isOnline = useConnectivity();
  const platform = Capacitor.getPlatform();
  const isNative = platform === "ios" || platform === "android";
  const desktopAvailable = hasDesktopBridge();
  const effectiveMode = resolveInferenceMode(mode, isOnline);
  const localLLM = useBrowserLLM(effectiveMode === "webllm" || prepareWebFallback ? WEBLLM_MODEL : undefined);
  const localLLMRef = useRef(localLLM);
  // Keep in-flight API fallback work connected to the hook's latest load state.
  localLLMRef.current = localLLM;
  const selectedMode = effectiveMode === "cloud"
    ? {
      ...modeDetails.cloud,
      label: cloudProvider === "Groq" ? "Groq Cloud" : `${cloudProvider} AI`,
      description: `${cloudProvider} model with device tools`,
    }
    : modeDetails[effectiveMode];
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
    voiceInputEnabledRef.current = false;
    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    void stop?.();
  }, []);

  useEffect(() => {
    const target = isVirtualCallActive ? callLogRef.current : scrollRef.current;
    target?.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, error, isVirtualCallActive]);

  useEffect(() => {
    if (!isVirtualCallActive || callStartedAt === null) return;
    const updateDuration = () => setCallDuration(Math.floor((Date.now() - callStartedAt) / 1000));
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [callStartedAt, isVirtualCallActive]);

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
    if (!content || isLoading || isSubmittingTurnRef.current || (voiceTurnPendingRef.current && transcript === undefined)) return false;
    if (effectiveMode === "webllm" && localLLM.status !== "ready") {
      setError(localLLM.status === "unsupported" ? "WebGPU is unavailable. Reconnect or use the native app for offline AI." : "The browser model is still preparing or could not load.");
      return false;
    }
    if (effectiveMode === "native" && nativeStatus !== "available") {
      setError(nativeStatus === "downloadable" ? "Prepare the offline model while online, then try again." : "This device does not have a supported on-device AI model.");
      return false;
    }

    isSubmittingTurnRef.current = true;
    const activeVoiceSession = voiceSessionRef.current;
    if (activeVoiceSession) {
      voiceSessionRef.current = null;
      voiceTurnPendingRef.current = true;
      setIsListening(false);
      try {
        await activeVoiceSession();
      } catch {
        // Continue the user-requested turn if recognition already stopped.
      }
    }

    const nextMessages = [...messages, { role: "user" as const, content }];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setIsLoading(true);
    setAgentActivity({ phase: "thinking", message: "Shanaya is thinking…" });
    if (inputRef.current) inputRef.current.style.height = "auto";

    let spokenReply: Promise<void> | null = null;
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
          groqApiKey,
          messages: nextMessages,
          generateLocal: async (prompt, routeMode) => {
            if (routeMode === "webllm") {
              setPrepareWebFallback(true);
              const messages = [{ role: "system" as const, content: agentRules }, { role: "user" as const, content: prompt }];
              const deadline = Date.now() + 180_000;
              while (Date.now() < deadline) {
                const local = localLLMRef.current;
                if (local.status === "ready") return local.generate(messages);
                if (local.status === "unsupported") throw new Error("This browser does not support WebGPU local AI. Prepare the native model in the mobile app or reconnect to Groq.");
                if (local.status === "error") throw new Error("The local WebLLM model could not load. Reconnect once to download it, then retry offline.");
                setAgentActivity({ phase: "thinking", message: local.status === "loading" ? `Preparing local AI · ${Math.round(local.progress * 100)}%` : "Starting local AI…" });
                await new Promise((resolve) => window.setTimeout(resolve, 300));
              }
              throw new Error("Local WebLLM took too long to prepare. Check WebGPU support and model download access.");
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
        setVoiceStatus("Shanaya is speaking…");
        setIsSpeaking(true);
        spokenReply = SpeechService.speak(result.reply, speechLanguage)
          .then((voiceName) => setVoiceStatus(`Speaking with ${voiceName}`))
          .catch((speechError) => setVoiceStatus(speechError instanceof Error ? speechError.message : "Offline voice unavailable."))
          .finally(() => setIsSpeaking(false));
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
      setAgentActivity(null);
      isSubmittingTurnRef.current = false;
      inputRef.current?.focus();
      const canResumeVoice = voiceInputEnabledRef.current && (!callActiveRef.current || callMicEnabledRef.current);
      const resumeListening = () => {
        voiceTurnPendingRef.current = false;
        if (voiceInputEnabledRef.current && (!callActiveRef.current || callMicEnabledRef.current)) {
          startCallListeningRef.current();
        }
      };
      if (canResumeVoice) {
        if (spokenReply) void spokenReply.then(() => window.setTimeout(resumeListening, 350));
        else window.setTimeout(resumeListening, 350);
      } else {
        voiceTurnPendingRef.current = false;
      }
    }
    return true;
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

  const startVirtualCall = async () => {
    if (isVirtualCallActive) return;
    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    try {
      if (stop) await stop();
    } catch {
      // Starting the virtual call should recover from an already-ended mic session.
    }
    setIsListening(false);
    setError("");
    callActiveRef.current = true;
    callMicEnabledRef.current = true;
    voiceInputEnabledRef.current = true;
    setIsVirtualCallActive(true);
    setIsCallMicEnabled(true);
    setCallStartedAt(Date.now());
    setCallDuration(0);
    callSpeakerRef.current = true;
    setIsCallSpeakerOn(true);
    setVoiceStatus("Virtual call connected · your microphone is live");
    startCallListeningRef.current();
  };

  const endVirtualCall = async () => {
    callActiveRef.current = false;
    callMicEnabledRef.current = false;
    voiceInputEnabledRef.current = false;
    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    try {
      if (stop) await stop();
    } catch {
      // The conversation still ends if the browser has already stopped recognition.
    }
    setIsListening(false);
    setIsCallMicEnabled(false);
    setIsSpeaking(false);
    setIsVirtualCallActive(false);
    setCallStartedAt(null);
    setCallDuration(0);
    callSpeakerRef.current = true;
    setIsCallSpeakerOn(true);
    void SpeechService.cancel().catch(() => undefined);
    setVoiceStatus("Virtual call ended");
  };

  const toggleCallSpeaker = () => {
    const enabled = !callSpeakerRef.current;
    callSpeakerRef.current = enabled;
    setIsCallSpeakerOn(enabled);
    setVoiceStatus(enabled ? "Call speaker on" : "Call speaker muted");
    if (!enabled) {
      setIsSpeaking(false);
      void SpeechService.cancel().catch(() => undefined);
    }
  };

  const startVoiceInputSession = async () => {
    if (voiceSessionRef.current || voiceStartPendingRef.current || voiceTurnPendingRef.current || !voiceInputEnabledRef.current || isLoading || isSpeaking) return;
    voiceStartPendingRef.current = true;
    setError("");
    try {
      const stop = await VoiceService.startSession(speechLanguage, (transcript, isFinal) => {
        if (voiceTurnPendingRef.current) return;
        setInput(transcript);
        if (!isFinal) return;

        // Stop the microphone before Shanaya responds so speech recognition
        // cannot mistake the synthesized reply for the next user turn.
        voiceTurnPendingRef.current = true;
        const activeSession = voiceSessionRef.current;
        voiceSessionRef.current = null;
        setIsListening(false);
        void (async () => {
          try {
            await activeSession?.();
          } catch {
            // Recognition may have ended itself after returning the final result.
          }
          if (!voiceInputEnabledRef.current || (callActiveRef.current && !callMicEnabledRef.current)) {
            voiceTurnPendingRef.current = false;
            return;
          }
          const shouldSpeakReply = callActiveRef.current ? callSpeakerRef.current : voiceEnabledRef.current;
          const accepted = await submitMessage(undefined, transcript, shouldSpeakReply);
          if (!accepted) {
            voiceTurnPendingRef.current = false;
            if (voiceInputEnabledRef.current && (!callActiveRef.current || callMicEnabledRef.current)) {
              startCallListeningRef.current();
            }
          }
        })();
      }, (message) => {
        setError(message);
        voiceInputEnabledRef.current = false;
        const stop = voiceSessionRef.current;
        voiceSessionRef.current = null;
        setIsListening(false);
        void stop?.();
        if (callActiveRef.current) {
          callMicEnabledRef.current = false;
          setIsCallMicEnabled(false);
        }
      });
      if (!voiceInputEnabledRef.current || voiceTurnPendingRef.current) {
        await stop();
        return;
      }
      voiceSessionRef.current = stop;
      setIsListening(true);
      setVoiceStatus(`Listening in ${speechLanguage} · speak to send`);
    } catch (voiceError) {
      voiceSessionRef.current = null;
      voiceInputEnabledRef.current = false;
      setIsListening(false);
      setError(voiceError instanceof Error ? voiceError.message : "Could not start voice input.");
      if (callActiveRef.current) {
        callMicEnabledRef.current = false;
        setIsCallMicEnabled(false);
      }
    } finally {
      voiceStartPendingRef.current = false;
    }
  };

  startCallListeningRef.current = () => { void startVoiceInputSession(); };

  useEffect(() => {
    if (
      voiceInputEnabledRef.current
      && !voiceSessionRef.current
      && !voiceStartPendingRef.current
      && !voiceTurnPendingRef.current
      && !isLoading
      && !isSpeaking
      && (!callActiveRef.current || callMicEnabledRef.current)
    ) {
      startCallListeningRef.current();
    }
  }, [isCallMicEnabled, isLoading, isListening, isSpeaking, isVirtualCallActive]);

  const toggleVoiceInput = async () => {
    if (!isListening) {
      voiceInputEnabledRef.current = true;
      await startVoiceInputSession();
      return;
    }
    voiceInputEnabledRef.current = false;
    try {
      await voiceSessionRef.current?.();
    } finally {
      voiceSessionRef.current = null;
      setIsListening(false);
      setVoiceStatus("Voice input stopped");
    }
  };

  const toggleCallMicrophone = () => {
    const enabled = !callMicEnabledRef.current;
    callMicEnabledRef.current = enabled;
    voiceInputEnabledRef.current = enabled;
    setIsCallMicEnabled(enabled);
    if (enabled) {
      if (!isLoading && !isSpeaking) startCallListeningRef.current();
      return;
    }

    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    setIsListening(false);
    setVoiceStatus("Call microphone muted");
    void Promise.resolve(stop?.()).catch(() => undefined);
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
              {isVirtualCallActive ? ` · virtual call ${formatDuration(callDuration)}` : ""}
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

      {isVirtualCallActive && (
        <div className="absolute inset-0 z-50 flex flex-col overflow-hidden bg-[radial-gradient(ellipse_at_50%_20%,rgba(117,94,255,0.2),transparent_48%),linear-gradient(180deg,#111523_0%,#090c15_72%)] px-4 pb-4 pt-5 sm:px-6 sm:pb-5">
          <div className="flex shrink-0 items-center justify-between">
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-violet-200/75">Shanaya · virtual call</p>
              <p className="mt-1 text-[10px] text-slate-500">In-app conversation · no phone network</p>
            </div>
            <span className="rounded-full border border-emerald-300/10 bg-emerald-300/[0.06] px-2.5 py-1 text-[9px] font-medium text-emerald-200/80">CONNECTED</span>
          </div>

          <div className="flex shrink-0 flex-col items-center pb-5 pt-6 text-center sm:pt-8">
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full border border-violet-200/20 bg-violet-300/[0.1] shadow-[0_0_70px_rgba(139,92,246,0.22)] sm:h-28 sm:w-28">
              <span className="absolute inset-0 animate-ping rounded-full border border-violet-200/15 [animation-duration:3s]" />
              <span className="absolute inset-2 rounded-full border border-white/[0.06]" />
              <Bot size={38} strokeWidth={1.35} className="text-violet-100 sm:h-11 sm:w-11" />
            </div>
            <h2 className="mt-4 font-['Manrope'] text-xl font-semibold text-white">Shanaya</h2>
            <p className="mt-1 text-xs text-slate-400">{formatDuration(callDuration)} · {isListening ? "Listening to you" : isLoading ? agentActivity?.message || "Thinking…" : isSpeaking ? "Speaking to you" : isCallMicEnabled ? "Ready to listen" : "Microphone muted"}</p>
          </div>

          <div ref={callLogRef} className="chat-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto rounded-2xl border border-white/[0.06] bg-black/15 p-3">
            {messages.filter((message) => message.role === "user" || message.role === "assistant").slice(1).slice(-6).map((message, index) => (
              <div key={`${index}-${message.role}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <p className={`max-w-[88%] rounded-2xl px-3 py-2 text-[11px] leading-relaxed ${message.role === "user" ? "rounded-br-md bg-violet-500/80 text-white" : "rounded-bl-md border border-white/[0.06] bg-white/[0.05] text-slate-200"}`}>
                  {message.content}
                </p>
              </div>
            ))}
            {messages.filter((message) => message.role === "user" || message.role === "assistant").length <= 1 && (
              <p className="py-4 text-center text-[11px] text-slate-500">{isCallMicEnabled ? "Your microphone is live. Say hello when you’re ready." : "Unmute the microphone to start talking."} Shanaya will answer out loud.</p>
            )}
            {error && <p role="alert" className="rounded-xl border border-rose-300/10 bg-rose-300/[0.05] px-3 py-2 text-[10px] text-rose-100/90">{error}</p>}
          </div>

          <div className="flex shrink-0 items-center justify-center gap-4 pt-5">
            <button
              type="button"
              onClick={toggleCallMicrophone}
              aria-label={isCallMicEnabled ? "Mute microphone" : "Unmute microphone"}
              className={`flex h-14 w-14 items-center justify-center rounded-full border transition ${isCallMicEnabled ? "border-violet-200/30 bg-violet-400/25 text-violet-50 shadow-[0_0_28px_rgba(167,139,250,0.28)]" : "border-white/10 bg-white/[0.07] text-slate-200 hover:bg-white/[0.12]"}`}
            >
              {isCallMicEnabled ? <Mic size={21} /> : <MicOff size={21} />}
            </button>
            <button
              type="button"
              onClick={toggleCallSpeaker}
              aria-label={isCallSpeakerOn ? "Mute Shanaya's voice" : "Enable Shanaya's voice"}
              className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${isCallSpeakerOn ? "border-white/10 bg-white/[0.07] text-slate-200 hover:bg-white/[0.12]" : "border-amber-200/20 bg-amber-200/10 text-amber-100"}`}
            >
              {isCallSpeakerOn ? <Speaker size={18} /> : <VolumeX size={18} />}
            </button>
            <button
              type="button"
              onClick={() => void endVirtualCall()}
              aria-label="End virtual call"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-950/35 transition hover:bg-rose-400"
            >
              <PhoneOff size={21} />
            </button>
          </div>
          <p className="mt-3 shrink-0 text-center text-[9px] text-slate-500">{isListening ? "Listening · speak naturally, then pause" : isLoading ? "Shanaya is replying…" : isSpeaking ? "Shanaya is speaking…" : isCallMicEnabled ? "Speak naturally · the microphone stays on between turns" : "Tap the microphone to unmute"}</p>
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
            onClick={() => void startVirtualCall()}
            disabled={isLoading}
            title="Start an in-app virtual voice call"
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
