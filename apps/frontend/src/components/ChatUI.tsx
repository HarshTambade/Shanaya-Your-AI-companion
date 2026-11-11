import { FormEvent, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useBrowserLLM } from "use-browser-llm";
import { ArrowUp, Check, ChevronDown, Cpu, Globe2, KeyRound, LockKeyhole, Mic, RotateCcw, Settings2, Volume2, X } from "lucide-react";
import type { Emotion } from "../services/LLMRouter";
import {
  getModelCatalog,
  parseStructuredReply,
  resolveApproval,
  routeAgent,
  type Approval,
  type ChatMessage,
  type ModelCatalog,
} from "../services/LLMRouter";
import { VoiceService, type SpeechLanguage } from "../services/VoiceService";
import { generateNativeReply, getNativeModelStatus, prepareNativeModel, supportsNativeLLM, type NativeModelStatus } from "../services/NativeLLM";

const WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const welcome = "Hey, I’m Shanaya. It’s lovely to meet you. What’s on your mind?";
type VisibleMessage = { role: "user" | "assistant" | "system"; content: string };
type PendingTurn = { approvals: Approval[]; messages: ChatMessage[] };
type LocalWaiter = { resolve: () => void; reject: (error: Error) => void; timeout: number };

function flattenModels(catalog: ModelCatalog | null) {
  if (!catalog?.tiers) return [];
  return [
    ...(catalog.tiers.groq || []),
    ...(catalog.tiers.secondary || []),
  ];
}

export default function ChatUI({ onEmotionChange }: { onEmotionChange: (emotion: Emotion) => void }) {
  const [visibleMessages, setVisibleMessages] = useState<VisibleMessage[]>([{ role: "assistant", content: welcome }]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [fallbackRequested, setFallbackRequested] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [language, setLanguage] = useState<SpeechLanguage>("en-US");
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    try {
      const saved = window.localStorage.getItem("shanaya.voiceEnabled");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState("");
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [nativeModelStatus, setNativeModelStatus] = useState<NativeModelStatus>("unavailable");
  const [isPreparingNativeModel, setIsPreparingNativeModel] = useState(false);
  const [nativeDownloadProgress, setNativeDownloadProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNative = supportsNativeLLM() && (Capacitor.getPlatform() === "ios" || Capacitor.getPlatform() === "android");
  const effectiveLocalMode = mode === "local" || !online;
  const localLLM = useBrowserLLM((effectiveLocalMode || fallbackRequested) && !isNative ? WEBLLM_MODEL : undefined);
  const localStatusRef = useRef<string>(localLLM.status as string);

  useEffect(() => {
    try {
      window.localStorage.setItem("shanaya.voiceEnabled", String(voiceEnabled));
    } catch {
      // Keep the voice preference for this session if storage is disabled.
    }
  }, [voiceEnabled]);
  const localWaiters = useRef<LocalWaiter[]>([]);
  const localModelReady = isNative ? nativeModelStatus === "available" : localLLM.status === "ready";
  const models = flattenModels(catalog);

  useEffect(() => {
    const status = localLLM.status as string;
    localStatusRef.current = status;
    if (status !== "ready" && status !== "unsupported" && status !== "error") return;
    const waiters = localWaiters.current.splice(0);
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeout);
      if (status === "ready") waiter.resolve();
      else waiter.reject(new Error(status === "unsupported" ? "WebGPU is unavailable for local inference." : "WebLLM could not prepare the offline model."));
    }
  }, [localLLM.status]);

  useEffect(() => () => {
    for (const waiter of localWaiters.current.splice(0)) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error("The local model request was interrupted."));
    }
  }, []);

  useEffect(() => {
    const setConnection = () => setOnline(navigator.onLine);
    window.addEventListener("online", setConnection);
    window.addEventListener("offline", setConnection);
    return () => {
      window.removeEventListener("online", setConnection);
      window.removeEventListener("offline", setConnection);
    };
  }, []);

  const waitForBrowserModel = () => new Promise<void>((resolve, reject) => {
    const status = localStatusRef.current as string;
    if (status === "ready") { resolve(); return; }
    if (status === "unsupported") { reject(new Error("WebGPU is unavailable for local inference.")); return; }
    const timeout = window.setTimeout(() => {
      localWaiters.current = localWaiters.current.filter((waiter) => waiter.timeout !== timeout);
      reject(new Error("The WebLLM download is taking too long. Select Local WebLLM in settings and try again."));
    }, 300_000);
    localWaiters.current.push({ resolve, reject, timeout });
  });

  useEffect(() => {
    let active = true;
    if (!isNative) {
      setNativeModelStatus("unavailable");
      return () => { active = false; };
    }
    void getNativeModelStatus()
      .then((status) => { if (active) setNativeModelStatus(status); })
      .catch(() => { if (active) setNativeModelStatus("unavailable"); });
    return () => { active = false; };
  }, [isNative, online]);

  useEffect(() => {
    let mounted = true;
    getModelCatalog().then((result) => {
      if (!mounted) return;
      setCatalog(result);
      const options = flattenModels(result);
      const saved = window.localStorage.getItem("shanaya.model");
      setSelectedModel(options.some((item) => item.model === saved) ? saved! : result.defaultModel || options[0]?.model || "");
    }).catch(() => {
      if (mounted) setCatalog({ provider: "Groq", defaultModel: "openai/gpt-oss-120b", tiers: { groq: [], secondary: [], local: [] } });
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (selectedModel) window.localStorage.setItem("shanaya.model", selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleMessages, activity, pendingTurn]);

  const generateLocal = async (messages: ChatMessage[]) => {
    if (isNative) {
      if (nativeModelStatus !== "available") {
        throw new Error(nativeModelStatus === "downloadable"
          ? "Download the llama.cpp model from inference settings to use offline AI."
          : "Set VITE_OFFLINE_MODEL_URL and download a GGUF model before using native offline AI.");
      }
      return generateNativeReply(messages);
    }
    if (localLLM.status !== "ready") {
      if (localLLM.status === "unsupported") throw new Error("WebGPU is unavailable for local inference.");
      if ((localLLM.status as string) === "error") throw new Error("WebLLM could not prepare the offline model.");
      setActivity("Cloud routes unavailable · preparing local WebLLM fallback…");
      setFallbackRequested(true);
      await waitForBrowserModel();
    }
    const promptMessages: Array<{ role: "user" | "assistant"; content: string }> = messages
      .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
      .slice(-10)
      .map(({ role, content }) => ({ role, content }));
    const raw = await localLLM.generate([
      { role: "system", content: 'You are Shanaya, a cute, calm companion. Reply only as JSON: {"reply":"text","emotion":"happy|sad|cute|neutral"}.' },
      ...promptMessages,
    ]);
    return typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  };

  const applyCompletedTurn = (result: Awaited<ReturnType<typeof routeAgent>>, previousMessages: ChatMessage[]) => {
    if (result.status === "approval_required") {
      setHistory(result.messages);
      setPendingTurn({ approvals: result.approvals, messages: result.messages });
      setActivity("A device action is waiting for your approval.");
      return;
    }
    const updatedHistory = [...(result.messages || previousMessages), {
      role: "assistant" as const,
      content: JSON.stringify({ reply: result.reply, emotion: result.emotion }),
    }];
    setHistory(updatedHistory);
    setVisibleMessages((current) => [...current, { role: "assistant", content: result.reply }]);
    setActivity(result.local ? "Answered with WebLLM on this device." : `${result.provider || "Shanaya"} · ${result.model || ""}`);
    onEmotionChange(result.emotion);
    if (voiceEnabled) void VoiceService.speak(result.reply, language).catch((voiceError) => {
      setError(voiceError instanceof Error ? voiceError.message : "Voice playback failed.");
    });
  };

  const runCloudTurn = async (messages: ChatMessage[]) => {
    const result = await routeAgent(
      messages,
      selectedModel || undefined,
      () => generateLocal(messages),
      isNative ? "llama.cpp" : "WebLLM",
      isNative ? "shanaya.gguf" : WEBLLM_MODEL,
    );
    applyCompletedTurn(result, messages);
  };

  const downloadNativeModel = async () => {
    setIsPreparingNativeModel(true);
    setError("");
    setNativeDownloadProgress(0);
    try {
      await prepareNativeModel(setNativeDownloadProgress);
      setNativeModelStatus("available");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Could not download the native model.");
      setNativeModelStatus(await getNativeModelStatus().catch(() => "unavailable" as const));
    } finally {
      setIsPreparingNativeModel(false);
    }
  };

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || loading || pendingTurn) return;
    const userMessage: ChatMessage = { role: "user", content: text };
    const nextHistory = [...history, userMessage];
    setHistory(nextHistory);
    setVisibleMessages((current) => [...current, { role: "user", content: text }]);
    setInput("");
    setError("");
    setActivity("Shanaya is thinking…");
    setLoading(true);
    try {
      if (effectiveLocalMode) {
        const parsed = parseStructuredReply(await generateLocal(nextHistory));
        applyCompletedTurn({ status: "complete", ...parsed, provider: isNative ? "llama.cpp" : "WebLLM", model: isNative ? "shanaya.gguf" : WEBLLM_MODEL, local: true }, nextHistory);
      } else {
        await runCloudTurn(nextHistory);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Shanaya could not complete the request.");
      setActivity("");
    } finally {
      setLoading(false);
    }
  };

  const resolvePendingTurn = async (approved: boolean) => {
    if (!pendingTurn || loading) return;
    setLoading(true);
    setError("");
    setActivity(approved ? "Applying the approved action…" : "Recording your decision…");
    try {
      const results = await Promise.all(pendingTurn.approvals.map((approval) => resolveApproval(approval.token, approved)));
      let continuation = [...pendingTurn.messages];
      for (const result of results) {
        continuation.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          content: JSON.stringify(result.result),
        });
      }
      setPendingTurn(null);
      setActivity("Shanaya is continuing…");
      await runCloudTurn(continuation);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "Could not resolve the approval request.");
      setActivity("");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    if (loading || pendingTurn) return;
    setHistory([]);
    setVisibleMessages([{ role: "assistant", content: welcome }]);
    setError("");
    setActivity("");
    onEmotionChange("neutral");
  };

  const providerLabel = catalog?.provider || "Groq";
  const localStatus = isNative
    ? nativeModelStatus === "available" ? "llama.cpp model ready on this device"
      : nativeModelStatus === "downloadable" ? "GGUF model ready to download"
        : "Set VITE_OFFLINE_MODEL_URL to enable native offline AI"
    : localLLM.status === "loading"
      ? `Preparing WebLLM · ${Math.round(localLLM.progress * 100)}%`
      : localLLM.status === "ready" ? "WebLLM ready on this device"
        : localLLM.status === "unsupported" ? "WebGPU is unavailable"
          : (localLLM.status as string) === "error" ? "WebLLM could not prepare the model"
          : "Local model loads when selected";

  return (
    <section className="relative mx-auto flex max-h-[52dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[26px] border border-white/10 bg-[#0b0e17]/80 shadow-[0_18px_70px_rgba(0,0,0,0.55)] backdrop-blur-2xl">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold text-white">Shanaya</h1>
          <p className="truncate text-[10px] text-slate-400">{!online ? `Offline · ${isNative ? "llama.cpp" : "WebLLM"}` : effectiveLocalMode ? isNative ? "llama.cpp Native" : "WebLLM Local" : `${providerLabel} · cloud fallback router`}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Inference settings" aria-expanded={settingsOpen} className="rounded-xl border border-white/[0.08] p-2.5 text-slate-300 hover:bg-white/[0.06]">{settingsOpen ? <X size={15} /> : <Settings2 size={15} />}</button>
          <button type="button" onClick={reset} disabled={loading || Boolean(pendingTurn)} aria-label="New conversation" className="rounded-xl border border-white/[0.08] p-2.5 text-slate-300 hover:bg-white/[0.06] disabled:opacity-40"><RotateCcw size={15} /></button>
        </div>
      </header>

      {settingsOpen && (
        <div className="absolute bottom-[calc(100%+0.5rem)] right-2 z-40 max-h-[min(75dvh,40rem)] w-[min(360px,calc(100vw-1rem))] overflow-y-auto rounded-2xl border border-white/10 bg-[#111622]/95 p-4 shadow-2xl backdrop-blur-2xl sm:right-3">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-300"><Globe2 size={14} className="text-violet-300" /> Model routing</div>
          <label className="mb-1 block text-[11px] text-slate-400" htmlFor="provider-mode">Preferred route</label>
          <div className="relative">
            <select id="provider-mode" value={mode} onChange={(event) => setMode(event.target.value as "cloud" | "local")} className="w-full appearance-none rounded-lg border border-white/[0.08] bg-[#111521] px-3 py-2.5 pr-9 text-xs text-slate-200 outline-none focus:border-violet-300/30">
              <option value="cloud">Groq first · API fallbacks · WebLLM</option>
              <option value="local">{isNative ? "llama.cpp native · private" : "WebLLM local · private"}</option>
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-3 top-3 text-slate-500" />
          </div>
          {!effectiveLocalMode && (
            <>
              <label className="mb-1 mt-3 block text-[11px] text-slate-400" htmlFor="model-choice">Preferred cloud model</label>
              <select id="model-choice" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!models.length} className="w-full rounded-lg border border-white/[0.08] bg-[#111521] px-3 py-2.5 text-xs text-slate-200 outline-none disabled:opacity-50">
                {models.length
                  ? models.map((item) => <option key={`${item.provider}:${item.model}`} value={item.model}>{item.provider} · {item.model}</option>)
                  : <option value="">Waiting for backend model settings…</option>}
              </select>
            </>
          )}
          <p className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[10px] leading-relaxed text-slate-500">
            <KeyRound size={12} className="mr-1 inline text-violet-300" />{effectiveLocalMode ? localStatus : "Groq models run first in configured order, then OpenAI, Anthropic, Gemini, and local WebLLM."}
          </p>
          {isNative && (
            <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] p-3">
              <p className="text-[10px] leading-relaxed text-slate-400">{localStatus}</p>
              {online && nativeModelStatus === "downloadable" && (
                <button type="button" onClick={() => void downloadNativeModel()} disabled={isPreparingNativeModel} className="mt-2 w-full rounded-lg bg-violet-500/20 px-3 py-2 text-xs font-medium text-violet-100 disabled:opacity-50">
                  {isPreparingNativeModel ? `Downloading · ${Math.round(nativeDownloadProgress)}%` : "Download offline GGUF model"}
                </button>
              )}
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-[10px] text-slate-400" htmlFor="voice-language">Voice language</label>
            <select id="voice-language" value={language} onChange={(event) => setLanguage(event.target.value as SpeechLanguage)} className="rounded-lg border border-white/[0.08] bg-[#111521] px-2 py-1.5 text-[10px] text-slate-200">
              <option value="en-US">English</option><option value="hi-IN">हिन्दी</option><option value="mr-IN">मराठी</option>
            </select>
          </div>
        </div>
      )}

      {!online && <div className="flex shrink-0 items-center gap-2 border-b border-amber-200/10 bg-amber-200/[0.05] px-4 py-2 text-[10px] text-amber-100/80"><LockKeyhole size={12} />Offline mode · prompts stay on this device</div>}

      <div ref={scrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-[580px] flex-col gap-3">
          {visibleMessages.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`flex items-end gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              {message.role !== "user" && <span className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-violet-300/15 bg-violet-400/[0.08] text-violet-200"><Cpu size={11} /></span>}
              <p className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[12px] leading-relaxed ${message.role === "user" ? "rounded-br-md bg-gradient-to-br from-indigo-500 to-violet-600 text-white" : message.role === "system" ? "border border-amber-300/10 bg-amber-300/[0.04] text-amber-100/80" : "rounded-bl-md border border-white/[0.05] bg-[#171b28]/85 text-slate-200"}`}>{message.content}</p>
            </div>
          ))}

          {pendingTurn && (
            <div className="ml-8 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3" role="alertdialog" aria-label="Action approval required">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-amber-100"><LockKeyhole size={13} /> Shanaya needs your approval</div>
              <ul className="mb-3 space-y-2">
                {pendingTurn.approvals.map((approval) => (
                  <li key={approval.token} className="rounded-lg bg-black/20 p-2">
                    <p className="text-xs font-medium text-slate-100">{approval.name.replaceAll("_", " ")}</p>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-slate-400">{JSON.stringify(approval.arguments, null, 2)}</pre>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button type="button" onClick={() => void resolvePendingTurn(true)} disabled={loading} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-400/15 px-3 py-2 text-xs font-medium text-emerald-100 disabled:opacity-50"><Check size={13} />Approve all</button>
                <button type="button" onClick={() => void resolvePendingTurn(false)} disabled={loading} className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 disabled:opacity-50">Deny all</button>
              </div>
            </div>
          )}

          {activity && <div className="flex items-center gap-2 pl-8 text-[10px] text-slate-500"><span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />{activity}</div>}
          {error && <div role="alert" className="ml-8 rounded-xl border border-rose-400/15 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-100/90">{error}</div>}
        </div>
      </div>

      <div className="shrink-0 border-t border-white/[0.07] p-2.5 md:p-3">
        <div className="mx-auto flex max-w-[580px] items-center justify-between gap-2 px-1 pb-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setVoiceEnabled((enabled) => !enabled)} aria-pressed={voiceEnabled} aria-label="Toggle voice replies" className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] ${voiceEnabled ? "border-violet-300/25 bg-violet-400/10 text-violet-100" : "border-white/[0.08] text-slate-400"}`}><Volume2 size={12} />Voice</button>
            <span className="hidden text-[10px] text-slate-600 sm:inline">{effectiveLocalMode ? localStatus : `${providerLabel} · ${selectedModel || "loading model list"}`}</span>
          </div>
          <span className="flex items-center gap-1 text-[9px] text-emerald-200/70"><Mic size={11} />EN · हिन्दी · मराठी</span>
        </div>
        <form onSubmit={(event) => void submit(event)} className="mx-auto flex max-w-[580px] items-end gap-2 rounded-2xl border border-white/[0.09] bg-[#111521]/90 p-1.5 focus-within:border-violet-400/40">
          <textarea value={input} onChange={(event) => setInput(event.target.value.slice(0, 4000))} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          }} placeholder={effectiveLocalMode ? "Message Shanaya locally…" : "Message Shanaya…"} aria-label="Message Shanaya" rows={1} maxLength={4000} className="max-h-24 min-h-10 flex-1 resize-none bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500" />
          <button type="submit" disabled={!input.trim() || loading || Boolean(pendingTurn) || (effectiveLocalMode && !localModelReady)} aria-label="Send message" className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white disabled:cursor-not-allowed disabled:opacity-35"><ArrowUp size={17} /></button>
        </form>
      </div>
    </section>
  );
}
