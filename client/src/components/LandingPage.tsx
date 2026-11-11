import { useState, type FormEvent } from "react";
import {
  ArrowDown, ArrowRight, AudioLines, Cable, Eye, EyeOff, Globe2, Heart, LockKeyhole,
  MessageCircle, Mic2, ShieldCheck, Sparkles, X,
} from "lucide-react";
import AvatarScene from "./AvatarScene";

type LandingPageProps = { onStart: (groqApiKey: string) => void; onIntegrations: () => void };

const highlights = [
  {
    icon: MessageCircle,
    title: "A conversation with presence",
    description: "Talk through an idea, untangle a long day, or follow your curiosity. Shanaya meets you with thoughtful, natural replies.",
  },
  {
    icon: AudioLines,
    title: "Speak the way you want",
    description: "Type or use voice in English, Hindi, and Marathi, depending on the speech support available on your device.",
  },
  {
    icon: Sparkles,
    title: "A character that feels alive",
    description: "A real-time 3D avatar brings movement and emotion to the conversation, right in your browser.",
  },
];

export default function LandingPage({ onStart, onIntegrations }: LandingPageProps) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [groqApiKey, setGroqApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyError, setKeyError] = useState("");

  const beginConversation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = groqApiKey.trim();
    if (!key) {
      setKeyError("Enter your Groq API key to continue.");
      return;
    }
    const localDevelopment = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
    if (!window.isSecureContext && !localDevelopment) {
      setKeyError("For your safety, connect over HTTPS before sending an API key.");
      return;
    }
    const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim();
    if (configuredApiUrl) {
      try {
        const apiOrigin = new URL(configuredApiUrl, window.location.href);
        const localApi = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiOrigin.hostname);
        if (apiOrigin.protocol !== "https:" && !localApi) {
          setKeyError("Configure your API server to use HTTPS before sending a Groq key.");
          return;
        }
      } catch {
        setKeyError("The configured API server address is invalid.");
        return;
      }
    }
    onStart(key);
  };

  const openKeyDialog = () => {
    setKeyError("");
    setKeyDialogOpen(true);
  };

  return (
    <main className="landing-page relative h-[100dvh] overflow-y-auto bg-[#070a13] text-slate-100 selection:bg-cyan-300/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-40 top-32 h-[32rem] w-[32rem] rounded-full bg-indigo-600/[0.12] blur-[140px]" />
        <div className="absolute -right-40 top-[38rem] h-[32rem] w-[32rem] rounded-full bg-cyan-500/[0.08] blur-[150px]" />
        <div className="landing-grain absolute inset-0 opacity-[0.14]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#080b14]/75 backdrop-blur-2xl">
        <div className="mx-auto flex h-[4.25rem] max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-12">
          <a href="#home" className="group flex items-center gap-3" aria-label="Shanaya home">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-200/20 bg-cyan-200/[0.07] text-cyan-100 transition group-hover:border-cyan-200/40">
              <Sparkles size={17} strokeWidth={1.7} />
            </span>
            <span>
              <span className="block font-['Manrope'] text-[12px] font-extrabold tracking-[0.2em] text-white">SHANAYA</span>
              <span className="mt-0.5 block text-[8px] font-medium uppercase tracking-[0.2em] text-slate-500">AI companion</span>
            </span>
          </a>

          <nav className="hidden items-center gap-8 md:flex" aria-label="Main navigation">
            <a href="#experience" className="text-xs text-slate-400 transition hover:text-white">The experience</a>
            <a href="#how-it-works" className="text-xs text-slate-400 transition hover:text-white">How it works</a>
            <a href="#privacy" className="text-xs text-slate-400 transition hover:text-white">Your privacy</a>
            <button type="button" onClick={onIntegrations} className="text-xs text-slate-400 transition hover:text-white">Integrations</button>
            <a href="/about/" className="text-xs text-slate-400 transition hover:text-white">About</a>
          </nav>

          <button
            type="button"
            onClick={openKeyDialog}
            className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-4 py-2.5 text-[11px] font-semibold text-white transition hover:border-cyan-200/30 hover:bg-cyan-200/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/50"
          >
            Talk to Shanaya <ArrowRight size={13} className="transition group-hover:translate-x-0.5" />
          </button>
        </div>
      </header>

      <div className="relative z-10">
        <section id="home" className="mx-auto grid min-h-[calc(100dvh_-_4.25rem)] max-w-7xl items-center gap-8 px-5 pb-12 pt-8 sm:px-8 sm:pt-10 lg:grid-cols-[0.92fr_1.08fr] lg:gap-4 lg:px-12 lg:pb-16 lg:pt-4">
          <div className="relative z-10 max-w-xl py-5 lg:py-12">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-cyan-200/15 bg-cyan-100/[0.045] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.19em] text-cyan-100/80">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-50" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
              </span>
              A more human kind of AI
            </div>

            <h1 className="font-['Manrope'] text-[clamp(2.65rem,6vw,5.35rem)] font-semibold leading-[0.99] tracking-[-0.065em] text-white">
              A little more
              <span className="mt-1 block bg-gradient-to-r from-cyan-100 via-violet-200 to-indigo-300 bg-clip-text text-transparent">understood.</span>
            </h1>
            <p className="mt-7 max-w-[31rem] text-[14px] leading-[1.85] text-slate-400 sm:text-[15px]">
              Meet Shanaya: an expressive AI companion for real conversation, voice, and the little things you feel like sharing.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={openKeyDialog}
                className="group inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 px-5 text-[12px] font-bold text-[#090d1a] shadow-[0_10px_40px_rgba(111,119,255,0.19)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_48px_rgba(111,119,255,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100/70"
              >
                Talk to Shanaya
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#11172a]/10"><ArrowRight size={14} /></span>
              </button>
              <a href="#experience" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-[11px] font-semibold text-slate-300 transition hover:text-white">
                Discover the experience <ArrowDown size={13} />
              </a>
            </div>

            <button type="button" onClick={onIntegrations} className="mt-3 inline-flex items-center gap-2 text-left text-[10px] font-medium text-slate-500 transition hover:text-cyan-100">
              <Cable size={13} /> Connect Shanaya to another app with the API or MCP
            </button>

            <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.07] pt-5 text-[10px] text-slate-500">
              <span className="inline-flex items-center gap-2"><ShieldCheck size={13} className="text-cyan-200/70" /> Your key, your choice</span>
              <span className="inline-flex items-center gap-2"><Globe2 size={13} className="text-violet-200/70" /> English · हिन्दी · मराठी</span>
            </div>
          </div>

          <div className="relative mx-auto h-[min(66dvh,680px)] min-h-[390px] w-full max-w-[660px] lg:h-[min(82dvh,780px)] lg:min-h-[570px]">
            <div className="absolute inset-x-[7%] bottom-[6%] top-[7%] rounded-[2.5rem] border border-white/[0.08] bg-[#09162c]/60 shadow-[0_30px_100px_rgba(0,0,0,0.35)] backdrop-blur-sm" />
            <div className="absolute inset-x-[11%] bottom-[9%] top-[10%] overflow-hidden rounded-[2rem] border border-cyan-100/[0.11] shadow-[0_0_80px_rgba(44,139,255,0.13)]">
              <div className="avatar-stage absolute inset-0" />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#071323]/10 via-transparent to-[#070a13]/50" />
              <div className="absolute inset-0">
                <AvatarScene emotion="neutral" />
              </div>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 py-4 sm:px-5">
                <span className="rounded-full border border-white/10 bg-[#07101e]/65 px-3 py-1.5 font-mono text-[8px] tracking-[0.18em] text-cyan-100/75 backdrop-blur">SHANAYA · LIVE PRESENCE</span>
                <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#07101e]/65 px-2.5 py-1.5 text-[8px] text-slate-300 backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_#6ee7b7]" /> READY TO MEET YOU</span>
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 px-4 pb-4 sm:px-5 sm:pb-5">
                <div>
                  <p className="font-['Manrope'] text-[15px] font-semibold text-white sm:text-base">Here, with you.</p>
                  <p className="mt-1 text-[9px] text-slate-300/70">A conversation that moves at your pace.</p>
                </div>
                <div className="mb-0.5 flex shrink-0 items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-200/80" />
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-200/60" />
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-200/40" />
                </div>
              </div>
            </div>
            <div className="pointer-events-none absolute -left-1 top-[23%] hidden items-center gap-3 rounded-2xl border border-white/[0.09] bg-[#101523]/85 px-3.5 py-3 shadow-xl shadow-black/20 backdrop-blur-xl sm:flex">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-300/[0.1] text-violet-100"><Heart size={15} /></span>
              <span><span className="block text-[9px] font-semibold text-slate-200">Thoughtful by design</span><span className="mt-1 block text-[8px] text-slate-500">A companion for everyday moments</span></span>
            </div>
            <div className="pointer-events-none absolute -right-1 bottom-[23%] hidden items-center gap-3 rounded-2xl border border-white/[0.09] bg-[#101523]/85 px-3.5 py-3 shadow-xl shadow-black/20 backdrop-blur-xl sm:flex">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-300/[0.1] text-cyan-100"><Mic2 size={15} /></span>
              <span><span className="block text-[9px] font-semibold text-slate-200">Voice when you want it</span><span className="mt-1 block text-[8px] text-slate-500">Or keep it simple and type</span></span>
            </div>
          </div>
        </section>

        <section id="experience" className="mx-auto max-w-7xl scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
          <div className="max-w-2xl">
            <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-cyan-200/70">The experience</p>
            <h2 className="mt-4 font-['Manrope'] text-3xl font-semibold tracking-[-0.045em] text-white sm:text-4xl">More than an answer on a screen.</h2>
            <p className="mt-4 max-w-xl text-[13px] leading-7 text-slate-400">A familiar place to think out loud, ask anything, or simply have someone thoughtful to talk to.</p>
          </div>
          <div className="mt-10 grid gap-3 md:grid-cols-3">
            {highlights.map(({ icon: Icon, title, description }, index) => (
              <article key={title} className="group relative overflow-hidden rounded-2xl border border-white/[0.075] bg-white/[0.025] p-5 transition hover:-translate-y-1 hover:border-cyan-100/20 hover:bg-white/[0.04] sm:p-6">
                <span className="absolute right-4 top-4 font-mono text-[9px] text-white/20">0{index + 1}</span>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-100/10 bg-cyan-100/[0.055] text-cyan-100"><Icon size={17} strokeWidth={1.7} /></span>
                <h3 className="mt-6 font-['Manrope'] text-[14px] font-semibold text-slate-100">{title}</h3>
                <p className="mt-2.5 text-[11px] leading-6 text-slate-400">{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="border-y border-white/[0.06] bg-white/[0.018]">
          <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-[0.7fr_1.3fr] lg:gap-16 lg:px-12">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-violet-200/70">A simple beginning</p>
              <h2 className="mt-4 font-['Manrope'] text-3xl font-semibold tracking-[-0.045em] text-white sm:text-4xl">Your space.<br />Your conversation.</h2>
              <p className="mt-4 max-w-sm text-[12px] leading-7 text-slate-400">You decide when to begin and whether to type or use your voice.</p>
              <button type="button" onClick={openKeyDialog} className="group mt-7 inline-flex items-center gap-2 text-[11px] font-semibold text-cyan-100 transition hover:text-white">Talk to Shanaya <ArrowRight size={14} className="transition group-hover:translate-x-1" /></button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { number: "01", title: "Bring your Groq key", detail: "Connect your own Groq account to use cloud conversation." },
                { number: "02", title: "Meet Shanaya", detail: "Enter the companion space with the animated 3D avatar." },
                { number: "03", title: "Talk your way", detail: "Write a message or turn on voice when you feel like it." },
              ].map((step) => (
                <div key={step.number} className="rounded-2xl border border-white/[0.065] bg-[#0b0e17]/65 p-5 sm:p-4 lg:p-5">
                  <span className="font-mono text-[9px] tracking-[0.15em] text-cyan-200/70">STEP {step.number}</span>
                  <h3 className="mt-5 font-['Manrope'] text-[13px] font-semibold text-slate-100">{step.title}</h3>
                  <p className="mt-2 text-[10px] leading-6 text-slate-400">{step.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="privacy" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
          <div className="grid gap-8 rounded-3xl border border-cyan-100/[0.1] bg-[radial-gradient(ellipse_at_12%_0%,rgba(72,120,255,0.11),transparent_55%),rgba(255,255,255,0.02)] p-6 sm:p-9 lg:grid-cols-[1fr_auto] lg:items-center lg:p-11">
            <div className="max-w-2xl">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-100/10 bg-cyan-100/[0.06] text-cyan-100"><LockKeyhole size={17} /></span>
              <h2 className="mt-5 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-white sm:text-3xl">Your key stays yours.</h2>
              <p className="mt-3 text-[11px] leading-6 text-slate-400 sm:text-xs">Your Groq key stays in memory for this visit. Shanaya sends it to the configured API server in a request header for cloud turns; it is not saved in browser storage. Groq processes the conversation under its own terms.</p>
            </div>
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.045] px-4 text-[10px] font-semibold text-slate-200 transition hover:border-cyan-100/25 hover:text-white">
              Get a Groq API key <ArrowRight size={13} />
            </a>
          </div>
        </section>

        <footer className="border-t border-white/[0.06]">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-6 text-[9px] text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
            <span>© {new Date().getFullYear()} Shanaya · A thoughtful AI companion.</span>
            <div className="flex items-center gap-5"><button type="button" onClick={onIntegrations} className="transition hover:text-slate-200">API & Integrations</button><a href="/about/" className="transition hover:text-slate-200">About</a><a href="https://github.com/HarshTambade/Shanaya---Your-AI-companion-" target="_blank" rel="noreferrer" className="transition hover:text-slate-200">Source & project details</a></div>
          </div>
        </footer>
      </div>

      {keyDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-[#03050b]/75 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget) setKeyDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="connect-title" className="relative my-auto w-full max-w-md overflow-hidden rounded-3xl border border-white/[0.1] bg-[#0d111d] shadow-[0_30px_100px_rgba(0,0,0,0.65)]">
            <div className="pointer-events-none absolute -right-20 -top-28 h-60 w-60 rounded-full bg-violet-500/15 blur-[80px]" />
            <div className="relative p-6 sm:p-8">
              <button type="button" aria-label="Close" onClick={() => setKeyDialogOpen(false)} className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] text-slate-400 transition hover:bg-white/[0.05] hover:text-white"><X size={15} /></button>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-200/15 bg-violet-200/[0.07] text-violet-100"><Sparkles size={17} /></span>
              <p className="mt-6 text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100/70">Your first step</p>
              <h2 id="connect-title" className="mt-2 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-white">Bring your own Groq key.</h2>
                <p className="mt-3 text-[11px] leading-6 text-slate-400">Connect your key to start a cloud conversation with Shanaya. Groq checks it when you send your first message.</p>

              <form className="mt-6" onSubmit={beginConversation}>
                <label htmlFor="groq-key" className="mb-2 block text-[10px] font-semibold text-slate-200">Groq API key</label>
                <div className="flex items-center rounded-xl border border-white/[0.1] bg-[#080b13] pr-2 transition focus-within:border-violet-300/40">
                  <input
                    id="groq-key"
                    type={showApiKey ? "text" : "password"}
                    value={groqApiKey}
                    onChange={(event) => { setGroqApiKey(event.target.value); setKeyError(""); }}
                    placeholder="Paste your gsk_ key"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={512}
                    className="min-w-0 flex-1 bg-transparent px-3.5 py-3 text-xs text-slate-100 outline-none placeholder:text-slate-600"
                  />
                  <button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "Hide API key" : "Show API key"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-200">
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {keyError && <p role="alert" className="mt-2 text-[10px] text-rose-300">{keyError}</p>}
                <p className="mt-3 flex items-start gap-2 text-[9px] leading-5 text-slate-500"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-300/80" />Kept in memory for this visit, sent only with cloud requests, and never stored in your browser.</p>
                <button type="submit" disabled={!groqApiKey.trim()} className="group mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 text-[11px] font-bold text-[#090d1a] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50">
                  Enter Shanaya <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
                </button>
                <p className="mt-4 text-center text-[9px] text-slate-600">Need a key? <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-cyan-100/80 underline decoration-cyan-100/25 underline-offset-2 hover:text-cyan-50">Create one at Groq</a></p>
              </form>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
