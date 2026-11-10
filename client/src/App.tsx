import { useState } from "react";
import { Aperture, Sparkles } from "lucide-react";
import AvatarScene from "./components/AvatarScene";
import ChatUI from "./components/ChatUI";
import type { Emotion } from "./types";

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>("neutral");

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[#080b14]">
      <div className="soft-grid pointer-events-none absolute inset-0 z-0 opacity-60" />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_52%_40%,rgba(107,79,255,0.16),transparent_58%)]" />
      <section className="absolute inset-0 z-[1]" aria-label="Shanaya 3D avatar">
        <AvatarScene emotion={emotion} />
      </section>

      <header
        className="pointer-events-none absolute left-4 right-4 top-0 z-10 flex items-center justify-between md:left-8 md:right-8"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-[#101522]/70 px-3 py-2 backdrop-blur-xl">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-400/[0.09] text-violet-200">
            <Aperture size={17} strokeWidth={1.7} />
          </div>
          <div>
            <p className="font-['Manrope'] text-xs font-bold tracking-wide text-white">SHANAYA</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-slate-400">Your AI companion</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-[#101522]/70 px-3 py-2 text-[10px] uppercase tracking-[0.15em] text-slate-300 backdrop-blur-xl sm:flex">
          <Sparkles size={12} className="text-violet-300" /> Interactive avatar
        </div>
      </header>

      <div
        className="absolute inset-x-0 bottom-0 z-20 px-2 sm:px-4"
        style={{ paddingBottom: "max(0.65rem, env(safe-area-inset-bottom))" }}
      >
        <ChatUI onEmotionChange={setEmotion} />
      </div>
    </main>
  );
}
