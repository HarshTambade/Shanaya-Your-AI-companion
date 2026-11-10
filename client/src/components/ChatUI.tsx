import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalLLM } from "@capacitor/local-llm";
import { useBrowserLLM } from "use-browser-llm";
import { useCallClient } from "@pinecall/ionic/react";
import {
  ArrowUp, Bot, Cpu, Globe2, HardDrive, LockKeyhole, Mic, Phone, PhoneOff,
  RotateCcw, Settings2, Smartphone, Sparkles, Speaker, VolumeX, X,
} from "lucide-react";
import type { ChatMessage, Emotion, InferenceMode, SpeechLanguage } from "../types";
import { useConnectivity } from "../services/connectivity";
import { requestCallMicrophonePermission } from "../services/callPermissions";
import { apiUrl } from "../services/api";
import { generateNativeReply, getNativeLLMStatus, prepareNativeLLM, type NativeLLMStatus } from "../services/nativeLLM";
import { SpeechService } from "../services/SpeechService";
import { pinecallAgentId, shanayaCallClient } from "../services/callClient";

const WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const systemPrompt = [
  "You are a friendly, emotionally aware AI companion. Keep answers concise and engaging.",
  'Respond only as a JSON object with this exact shape: {"reply":"your message","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
  "Use one allowed emotion that best matches the tone of your reply. Do not wrap the JSON in markdown.",
].join(" ");

const welcomeMessage: ChatMessage = {
  role: "assistant",
  content: "Hey, I’m Shanaya. It’s lovely to meet you. What’s on your mind?",
};

const modeDetails: Record<InferenceMode, { label: string; description: string; icon: typeof Globe2 }> = {
  cloud: { label: "Cloud AI", description: "Fast hosted responses", icon: Globe2 },
  webllm: { label: "WebLLM Local", description: "Runs in this browser with WebGPU", icon: Cpu },
  ollama: { label: "Local Ollama", description: "Uses your configured Ollama server", icon: HardDrive },
  native: { label: "On-device AI", description: "Uses Apple Intelligence or Gemini Nano", icon: Smartphone },
};

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
};

export default function ChatUI({ onEmotionChange }: ChatUIProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InferenceMode>("cloud");
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("en-US");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [nativeStatus, setNativeStatus] = useState<NativeLLMStatus>("checking");
  const [isPreparingNative, setIsPreparingNative] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isOnline = useConnectivity();
  const isNative = Capacitor.isNativePlatform();
  const effectiveMode: InferenceMode = !isOnline ? (isNative ? "native" : "webllm") : mode;
  const localLLM = useBrowserLLM(effectiveMode === "webllm" ? WEBLLM_MODEL : undefined);
  const selectedMode = modeDetails[effectiveMode];
  const call = useCallClient(shanayaCallClient);
  const isCallConnecting = call.status === "connecting";
  const isCallConnected = call.status === "connected";
  const showCallPanel = call.status !== "idle" || call.messages.length > 0;

  const refreshNativeStatus = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) {
      setNativeStatus("unavailable");
      return;
    }
    try {
      setNativeStatus(await getNativeLLMStatus());
    } catch {
      setNativeStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    void refreshNativeStatus();
    if (!isNative) return;
    let active = true;
    let listener: { remove: () => Promise<void> } | undefined;
    void LocalLLM.addListener("systemAvailabilityChange", ({ status }) => {
      if (active) setNativeStatus(status);
    }).then((handle) => {
      if (active) listener = handle;
      else void handle.remove();
    }).catch(() => undefined);
    return () => {
      active = false;
      void listener?.remove();
    };
  }, [isNative, refreshNativeStatus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, error, call.messages.length]);

  const handlePrepareNative = async () => {
    setIsPreparingNative(true);
    setError("");
    setNativeStatus("notready");
    try {
      await prepareNativeLLM();
      await refreshNativeStatus();
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "Could not prepare the on-device model.");
      await refreshNativeStatus();
    } finally {
      setIsPreparingNative(false);
    }
  };

  const submitMessage = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const content = input.trim();
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
    if (inputRef.current) inputRef.current.style.height = "auto";

    try {
      let result: { reply: string; emotion: Emotion };
      if (effectiveMode === "webllm") {
        const generated = await localLLM.generate([{ role: "system", content: systemPrompt }, ...nextMessages]);
        result = parseAIResponse(generated);
      } else if (effectiveMode === "native") {
        result = parseAIResponse(await generateNativeReply(nextMessages));
      } else {
        const response = await fetch(apiUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: effectiveMode, messages: nextMessages }),
        });
        const data: { reply?: unknown; emotion?: unknown; error?: string } = await response.json();
        if (!response.ok) throw new Error(data.error || "I couldn’t reach the companion service.");
        result = parseAIResponse(data);
      }

      setMessages([...nextMessages, { role: "assistant", content: result.reply }]);
      onEmotionChange(result.emotion);
      if (voiceEnabled) {
        void SpeechService.speak(result.reply, speechLanguage)
          .then((voiceName) => setVoiceStatus(`Speaking with ${voiceName}`))
          .catch((speechError) => setVoiceStatus(speechError instanceof Error ? speechError.message : "Offline voice unavailable."));
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
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
  };

  const nativeStatusLabel = nativeStatus === "available"
    ? "Ready on this device"
    : nativeStatus === "downloadable"
      ? "Model needs a one-time download"
      : nativeStatus === "notready" || isPreparingNative
        ? "Preparing the native model…"
        : nativeStatus === "checking"
          ? "Checking device support…"
          : "No supported native model on this device";
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

  return (
    <section className="relative mx-auto flex max-h-[48dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[26px] border border-white/10 bg-[#0b0e17]/75 shadow-[0_18px_70px_rgba(0,0,0,0.55)] backdrop-blur-2xl">
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-4 py-3 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-violet-300/20 bg-violet-400/[0.1] text-violet-200">
            <Bot size={17} />
            <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#111521] ${isOnline ? "bg-emerald-400" : "bg-amber-300"}`} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-['Manrope'] text-sm font-bold text-slate-100">Shanaya</h1>
            <p className="truncate text-[10px] text-slate-400">
              {!isOnline ? `Offline · ${selectedMode.label}` : selectedMode.label}
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
            className="rounded-xl border border-white/[0.08] p-2.5 text-slate-300 transition hover:bg-white/[0.06]"
          >
            {isSettingsOpen ? <X size={15} /> : <Settings2 size={15} />}
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
          <div className="absolute bottom-[calc(100%+0.5rem)] right-3 z-40 w-[min(380px,calc(100vw-1.5rem))] rounded-2xl border border-white/10 bg-[#111622]/95 p-4 shadow-2xl shadow-black/60 backdrop-blur-2xl md:right-[max(calc((100vw-42rem)/2),1rem)]">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-300">
              <Cpu size={14} className="text-violet-300" /> Inference mode
            </div>
            <div className="space-y-2">
              {(Object.keys(modeDetails) as InferenceMode[]).map((option) => {
                const detail = modeDetails[option];
                const Icon = detail.icon;
                const unavailableNativeOption = option === "native" && !isNative;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isLoading || unavailableNativeOption}
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
                      <span className="mt-0.5 block text-xs text-slate-500">{unavailableNativeOption ? "Available in the Capacitor app" : detail.description}</span>
                    </span>
                    {mode === option && <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />}
                  </button>
                );
              })}
            </div>

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
                    {isPreparingNative ? "Preparing…" : "Prepare offline AI"}
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

            <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/15 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-300">
                <LockKeyhole size={13} className="text-emerald-300" /> Privacy and voice
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                {!isOnline
                  ? "Offline messages are routed to the on-device model; no AI request is sent to a cloud service or Ollama. Native speech uses an installed offline system voice."
                  : "WebLLM and native inference process prompts locally. Ollama sends prompts to its configured endpoint. Cloud AI sends prompts to our configured cloud service; its provider retention policy applies. Voice calls use Pinecall over the internet. The native speech plugin uses installed OS voices; Mithi/Charvi needs a separate native model runtime."}
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

      <div ref={scrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-[580px] flex-col gap-3">
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            return (
              <div key={`${index}-${message.role}`} className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && <div className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-violet-300/15 bg-violet-400/[0.08] text-violet-200"><Sparkles size={11} /></div>}
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
                : isLoading ? "Shanaya is thinking…" : ""}
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
        <div className="mx-auto flex max-w-[580px] items-center justify-between gap-2 px-1 pb-2">
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
            onClick={() => void startVoiceCall()}
            disabled={!isOnline || isCallConnecting || isCallConnected}
            title="Voice calls use Pinecall and require internet"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.07] px-2.5 py-1.5 text-[10px] font-medium text-emerald-100 transition hover:bg-emerald-300/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Phone size={12} /> Call
          </button>
        </div>
        {voiceStatus && <p aria-live="polite" className="mx-auto mb-1 max-w-[580px] px-1 text-[10px] text-slate-500">{voiceStatus}</p>}
        <form onSubmit={(event) => void submitMessage(event)} className="mx-auto flex max-w-[580px] items-end gap-2 rounded-2xl border border-white/[0.09] bg-[#111521]/90 p-1.5 transition focus-within:border-violet-400/40">
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
            ? "Cloud AI · provider retention policy applies"
            : effectiveMode === "ollama"
              ? "Ollama · prompts go to your configured endpoint"
              : "On-device inference · messages stay on this device"}
        </p>
      </div>
    </section>
  );
}
