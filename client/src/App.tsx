import { useState } from "react";
import { Aperture, Sparkles } from "lucide-react";
import AvatarScene from "./components/AvatarScene";
import ChatUI from "./components/ChatUI";
import type { Emotion } from "./types";

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>("neutral");

  return (
    <main className="flex h-screen w-full flex-col overflow-hidden bg-[#080b14] md:flex-row">
      <section className="relative h-[40vh] w-full overflow-hidden border-b border-white/[0.07] md:h-full md:w-3/5 md:border-b-0 md:border-r">
        <div className="soft-grid pointer-events-none absolute inset-0 z-0 opacity-60" />
        <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_52%_50%,rgba(107,79,255,0.15),transparent_56%)]" />

        <header className="absolute left-5 right-5 top-5 z-10 flex items-center justify-between md:left-8 md:right-8 md:top-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-violet-300/20 bg-violet-400/[0.09] text-violet-200 shadow-[0_0_28px_rgba(139,92,246,0.13)]">
              <Aperture size={19} strokeWidth={1.7} />
            </div>
            <div>
              <p className="font-['Manrope'] text-sm font-bold tracking-wide text-white">SHANAYA</p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">Your AI companion</p>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-[#101522]/75 px-3 py-2 backdrop-blur-md">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-300">Online</span>
          </div>
        </header>

        <div className="absolute inset-0 z-[1]">
          <AvatarScene emotion={emotion} />
        </div>

        <div className="pointer-events-none absolute bottom-5 left-5 z-10 hidden items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500 md:flex md:bottom-7 md:left-8">
          <Sparkles size={12} className="text-violet-300/70" />
          <span>Drag to explore</span>
          <span className="mx-1 h-1 w-1 rounded-full bg-slate-600" />
          <span>Scroll to zoom</span>
        </div>
      </section>

      <section className="flex min-h-0 w-full flex-1 flex-col md:h-full md:w-2/5 md:flex-none">
        <ChatUI onEmotionChange={setEmotion} />
      </section>
    </main>
  );
}
