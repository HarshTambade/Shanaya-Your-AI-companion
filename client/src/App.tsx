import { useState } from "react";
import { Aperture } from "lucide-react";
import AvatarScene, { type AvatarMotion } from "./components/AvatarScene";
import ChatUI from "./components/ChatUI";
import PlatformDownloads from "./components/PlatformDownloads";
import type { Emotion } from "./types";

const emotionColors: Record<Emotion, string> = {
  happy: "#fbbf24",
  sad: "#60a5fa",
  angry: "#fb7185",
  neutral: "#a78bfa",
  surprised: "#fb923c",
  thinking: "#c084fc",
};

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [motion, setMotion] = useState<AvatarMotion>("loading");

  return (
    <main className="relative h-[100dvh] min-h-0 w-full overflow-hidden bg-[#080b14] text-slate-100">
      <div className="soft-grid pointer-events-none absolute inset-0 z-0 opacity-60" />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_24%_44%,rgba(86,67,190,0.22),transparent_44%),radial-gradient(ellipse_at_78%_18%,rgba(20,184,166,0.06),transparent_34%)]" />

      <div className="relative z-[1] grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,0.43fr)_minmax(0,0.57fr)] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-1">
        <section className="relative min-h-0 overflow-hidden border-b border-white/[0.07] bg-[#0a0d17]/65 lg:border-b-0 lg:border-r" aria-label="Shanaya avatar">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_48%,rgba(117,94,255,0.16),transparent_58%)]" />

          <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 pt-[max(0.85rem,env(safe-area-inset-top))] sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-300/[0.08] text-violet-200">
                <Aperture size={17} strokeWidth={1.7} />
              </div>
              <div className="min-w-0">
                <p className="font-['Manrope'] text-xs font-bold tracking-[0.18em] text-white">SHANAYA</p>
                <p className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-slate-500">Avatar presence</p>
              </div>
            </div>
            <span className="rounded-full border border-white/[0.07] bg-black/20 px-2.5 py-1.5 font-mono text-[9px] tracking-[0.12em] text-slate-500">3D / LIVE</span>
          </header>

          <div className="absolute inset-x-0 bottom-[4.8rem] top-[3.8rem] sm:bottom-[5.2rem] sm:top-[4.2rem]">
            <AvatarScene emotion={emotion} onMotionChange={setMotion} />
          </div>

          <footer className="absolute inset-x-3 bottom-3 z-10 grid grid-cols-2 gap-2 sm:inset-x-5 sm:bottom-5 sm:gap-3">
            <div className="min-w-0 rounded-xl border border-white/[0.08] bg-[#0c101b]/80 px-3 py-2 backdrop-blur-xl sm:px-4 sm:py-2.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-slate-500 sm:text-[9px]">Current emotion</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full shadow-[0_0_12px_currentColor]" style={{ color: emotionColors[emotion], backgroundColor: emotionColors[emotion] }} />
                <span className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-200 sm:text-xs">{emotion}</span>
              </div>
            </div>
            <div className="min-w-0 rounded-xl border border-white/[0.08] bg-[#0c101b]/80 px-3 py-2 backdrop-blur-xl sm:px-4 sm:py-2.5">
              <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-slate-500 sm:text-[9px]">Model movement</p>
              <div className="mt-1 flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${motion === "loading" ? "animate-pulse bg-amber-300" : "bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.6)]"}`} />
                <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-200 sm:text-[11px]">
                  {motion === "loading" ? "Loading model" : motion === "animation" ? "Idle animation active" : "Live motion active"}
                </span>
              </div>
            </div>
          </footer>
        </section>

        <section className="flex min-h-0 flex-col gap-2.5 p-3 sm:gap-4 sm:p-5 lg:gap-5 lg:p-7" aria-label="Chat and settings">
          <header className="flex shrink-0 items-center justify-between gap-3 px-1">
            <div className="min-w-0">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-violet-200/70">Companion interface</p>
              <h1 className="mt-0.5 font-['Manrope'] text-base font-semibold text-white sm:text-lg">Conversation</h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a href="/about/" className="rounded-lg px-2 py-2 text-[11px] text-slate-400 transition hover:bg-white/[0.04] hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/50">
                About
              </a>
              <PlatformDownloads />
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <ChatUI panel onEmotionChange={setEmotion} />
          </div>
        </section>
      </div>
    </main>
  );
}
