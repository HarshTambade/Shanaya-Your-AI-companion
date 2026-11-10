import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useBrowserLLM } from "use-browser-llm";
import { ArrowUp, Bot, Cpu, Globe2, HardDrive, LockKeyhole, RotateCcw, Settings2, Sparkles, UserRound, X } from "lucide-react";
import type { ChatMessage, Emotion, InferenceMode } from "../types";

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
  groq: { label: "Groq Cloud", description: "Fast hosted inference", icon: Globe2 },
  webllm: { label: "WebLLM Local", description: "Runs in this browser with WebGPU", icon: Cpu },
  ollama: { label: "Local Ollama", description: "Uses your local Ollama server", icon: HardDrive },
};

const privacyCopy: Record<InferenceMode, string> = {
  groq: "Messages are sent to Groq. Retention follows your Groq account settings; verify Zero Data Retention is enabled in the Groq Console.",
  webllm: "Prompts run in this browser and are not sent to the chat backend. Model files download on first use and are cached by your browser.",
  ollama: "Prompts go to your configured Ollama endpoint. Use localhost with a local model to keep inference on this device.",
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

type ChatUIProps = {
  onEmotionChange: (emotion: Emotion) => void;
};

export default function ChatUI({ onEmotionChange }: ChatUIProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InferenceMode>("groq");
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const localLLM = useBrowserLLM(mode === "webllm" ? WEBLLM_MODEL : undefined);
  const selectedMode = modeDetails[mode];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, error]);

  const submitMessage = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const content = input.trim();
    if (!content || isLoading) return;
    if (mode === "webllm" && localLLM.status !== "ready") {
      setError(localLLM.status === "unsupported" ? "This browser does not support WebGPU. Choose Groq or Ollama instead." : "The local model is still preparing.");
      return;
    }

    const userMessage: ChatMessage = { role: "user", content };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setIsLoading(true);
    if (inputRef.current) inputRef.current.style.height = "auto";

    try {
      let result: { reply: string; emotion: Emotion };
      if (mode === "webllm") {
        const generated = await localLLM.generate([
          { role: "system", content: systemPrompt },
          ...nextMessages,
        ]);
        result = parseAIResponse(generated);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, messages: nextMessages }),
        });
        const data: { reply?: unknown; emotion?: unknown; error?: string } = await response.json();
        if (!response.ok) throw new Error(data.error || "I couldn’t reach the companion service.");
        result = parseAIResponse(data);
      }

      setMessages([...nextMessages, { role: "assistant", content: result.reply }]);
      onEmotionChange(result.emotion);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
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
    onEmotionChange("neutral");
  };

  const webStatus = localLLM.status === "loading"
    ? `Preparing local model · ${Math.round(localLLM.progress * 100)}%`
    : localLLM.status === "ready"
      ? "Local model ready"
      : localLLM.status === "unsupported"
        ? "WebGPU is unavailable in this browser"
        : localLLM.status === "error"
          ? "Could not load the local model"
          : "Model loads when selected";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0b0e17]">
      <header className="relative z-20 flex shrink-0 items-center justify-between border-b border-white/[0.07] px-5 py-4 md:px-7 md:py-6">
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full border border-violet-300/20 bg-gradient-to-br from-violet-400/20 to-indigo-500/10 text-violet-200">
            <Bot size={19} strokeWidth={1.7} />
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#0b0e17] bg-emerald-400" />
          </div>
          <div>
            <h1 className="font-['Manrope'] text-sm font-bold text-slate-100">Chat with Shanaya</h1>
            <p className="mt-0.5 text-xs text-slate-500">{selectedMode.label} · here with you</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsSettingsOpen((open) => !open)}
            aria-expanded={isSettingsOpen}
            aria-label="Inference and privacy settings"
            title="Inference and privacy settings"
            className={`rounded-xl border p-2.5 transition ${isSettingsOpen ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : "border-white/[0.07] text-slate-500 hover:border-white/15 hover:text-slate-200"}`}
          >
            {isSettingsOpen ? <X size={15} /> : <Settings2 size={15} />}
          </button>
          <button
            type="button"
            onClick={resetConversation}
            disabled={isLoading}
            aria-label="Start a new conversation"
            title="New conversation"
            className="rounded-xl border border-white/[0.07] p-2.5 text-slate-500 transition hover:border-white/15 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={15} />
          </button>
        </div>

        {isSettingsOpen && (
          <div className="absolute right-4 top-[calc(100%-4px)] z-30 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-[#111622] p-4 shadow-2xl shadow-black/50 md:right-6">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-slate-300">
              <Cpu size={14} className="text-violet-300" /> Inference mode
            </div>
            <div className="space-y-2">
              {(Object.keys(modeDetails) as InferenceMode[]).map((option) => {
                const detail = modeDetails[option];
                const Icon = detail.icon;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isLoading}
                    onClick={() => {
                      setMode(option);
                      setError("");
                      setIsSettingsOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition disabled:opacity-50 ${mode === option ? "border-violet-400/30 bg-violet-400/[0.08]" : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.13]"}`}
                  >
                    <Icon size={16} className={mode === option ? "text-violet-200" : "text-slate-500"} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-200">{detail.label}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{detail.description}</span>
                    </span>
                    {mode === option && <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />}
                  </button>
                );
              })}
            </div>

            {mode === "webllm" && (
              <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${localLLM.status === "unsupported" || localLLM.status === "error" ? "border-amber-300/15 bg-amber-300/[0.04] text-amber-100/80" : "border-white/[0.06] bg-white/[0.025] text-slate-400"}`}>
                {webStatus}. The first model download can take a while; later visits use the browser cache.
              </p>
            )}
            {mode === "ollama" && (
              <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs leading-relaxed text-slate-400">
                Configure <code className="text-violet-200">OLLAMA_BASE_URL</code> and <code className="text-violet-200">OLLAMA_MODEL</code> in <code className="text-violet-200">server/.env</code>.
              </p>
            )}

            <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/15 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-300">
                <LockKeyhole size={13} className="text-emerald-300" /> Privacy
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                WebLLM prompts stay in your browser. Ollama sends prompts to the configured endpoint; use a local model for on-device inference. Groq sends prompts to Groq, and its Zero Data Retention setting must be enabled in your account controls. This app cannot verify or change that setting.
              </p>
            </div>
          </div>
        )}
      </header>

      <div ref={scrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-7">
        <div className="mx-auto flex max-w-[580px] flex-col gap-5">
          <div className="flex justify-center pb-1">
            <span className="rounded-full border border-white/[0.06] bg-white/[0.025] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-600">
              Today · {mode === "groq" ? "Groq Cloud" : mode === "webllm" ? "On-device session" : "Local Ollama"}
            </span>
          </div>

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            return (
              <div key={`${index}-${message.role}`} className={`flex items-end gap-2.5 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && (
                  <div className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-violet-300/15 bg-violet-400/[0.08] text-violet-200">
                    <Sparkles size={13} />
                  </div>
                )}
                <div className={`max-w-[86%] ${isUser ? "order-first" : ""}`}>
                  <div
                    className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-[13px] leading-[1.7] shadow-sm ${
                      isUser
                        ? "rounded-br-md bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-indigo-950/30"
                        : "rounded-bl-md border border-white/[0.045] bg-[#171b28] text-slate-200"
                    }`}
                  >
                    {message.content}
                  </div>
                  <p className={`mt-1.5 px-1 text-[10px] text-slate-600 ${isUser ? "text-right" : ""}`}>
                    {isUser ? "You" : "Shanaya"}
                  </p>
                </div>
                {isUser && (
                  <div className="mb-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.04] text-slate-400">
                    <UserRound size={13} />
                  </div>
                )}
              </div>
            );
          })}

          {(isLoading || (mode === "webllm" && localLLM.status === "loading")) && (
            <div className="flex items-end gap-2.5">
              <div className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-violet-300/15 bg-violet-400/[0.08] text-violet-200">
                <Sparkles size={13} />
              </div>
              <div className="flex min-h-11 items-center gap-1.5 rounded-2xl rounded-bl-md border border-white/[0.045] bg-[#171b28] px-4">
                {mode === "webllm" && localLLM.status === "loading" ? (
                  <span className="text-xs text-slate-400">Preparing local model · {Math.round(localLLM.progress * 100)}%</span>
                ) : (
                  <>
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />
                  </>
                )}
              </div>
            </div>
          )}

          {mode === "webllm" && localLLM.status === "unsupported" && !error && (
            <div role="status" className="ml-9 max-w-[86%] rounded-xl border border-amber-300/15 bg-amber-300/[0.04] px-3.5 py-2.5 text-xs leading-relaxed text-amber-100/80">
              WebGPU is not available in this browser. Select Groq Cloud or Local Ollama in settings.
            </div>
          )}

          {error && (
            <div role="alert" className="ml-9 max-w-[86%] rounded-xl border border-rose-400/15 bg-rose-400/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-rose-200/90">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 md:px-6 md:pb-6">
        <div className="mx-auto mb-2 flex max-w-[580px] items-start gap-2 px-1 text-[10px] leading-relaxed text-slate-500">
          <LockKeyhole size={11} className="mt-0.5 shrink-0 text-slate-500" />
          <span>{privacyCopy[mode]}</span>
        </div>
        <form
          onSubmit={(event) => void submitMessage(event)}
          className="mx-auto max-w-[580px] rounded-2xl border border-white/[0.09] bg-[#111521] p-2 transition focus-within:border-violet-400/40 focus-within:shadow-[0_0_0_3px_rgba(139,92,246,0.07)]"
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value.slice(0, 4000));
                event.target.style.height = "auto";
                event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={handleKeyDown}
              placeholder="Write a message…"
              aria-label="Message Shanaya"
              rows={1}
              maxLength={4000}
              className="max-h-[120px] min-h-[42px] flex-1 resize-none bg-transparent px-3 py-3 text-[13px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-600"
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading || (mode === "webllm" && localLLM.status !== "ready")}
              aria-label="Send message"
              className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-950/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowUp size={18} strokeWidth={2.2} />
            </button>
          </div>
        </form>
        <p className="mt-3 text-center text-[10px] text-slate-600">A little space to think, ask, or just be.</p>
      </div>
    </div>
  );
}
