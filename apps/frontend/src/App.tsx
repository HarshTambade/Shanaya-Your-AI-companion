import { useState } from "react";
import { Aperture } from "lucide-react";
import Avatar from "./components/Avatar";
import ChatUI from "./components/ChatUI";
import type { Emotion } from "./services/LLMRouter";

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>("neutral");

  return (
    <main className="relative h-[100dvh] min-h-[440px] w-full overflow-hidden bg-[#080b14] text-slate-100">
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_50%_32%,rgba(113,82,255,0.2),transparent_58%)]" />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[url('/avatar-circuit-bg.svg')] bg-cover bg-center opacity-40" />
      <section className="absolute inset-0 z-[1]" aria-label="Shanaya's 3D avatar">
        <Avatar emotion={emotion} />
      </section>
      <header className="pointer-events-none absolute left-4 right-4 top-0 z-10 flex items-center justify-between" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-[#101522]/70 px-3 py-2 backdrop-blur-xl">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-400/[0.1] text-violet-200"><Aperture size={17} /></div>
          <div>
            <p className="text-xs font-bold tracking-wide">SHANAYA</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-slate-400">Your AI companion</p>
          </div>
        </div>
        <span className="hidden rounded-full border border-white/[0.08] bg-[#101522]/70 px-3 py-2 text-[10px] uppercase tracking-[0.15em] text-slate-300 backdrop-blur-xl sm:inline-flex">Groq first · private local fallback</span>
      </header>
      <div className="absolute inset-x-0 bottom-0 z-20 px-2 pb-[max(0.65rem,env(safe-area-inset-bottom))] sm:px-4">
        <ChatUI onEmotionChange={setEmotion} />
      </div>
    </main>
  );
}
