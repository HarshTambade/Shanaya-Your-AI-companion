import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";

const workflowUrl = "https://github.com/HarshTambade/Shanaya---Your-AI-companion-/actions/workflows/build.yml";

const platforms = [
  { name: "Android", artifact: "shanaya-android", packageType: "APK", href: import.meta.env.VITE_ANDROID_DOWNLOAD_URL },
  { name: "iOS", artifact: "shanaya-ios-archive", packageType: "App Store / TestFlight", href: import.meta.env.VITE_IOS_DOWNLOAD_URL },
  { name: "macOS", artifact: "shanaya-electron-macos-15", packageType: "DMG", href: import.meta.env.VITE_MACOS_DOWNLOAD_URL },
  { name: "Windows", artifact: "shanaya-electron-windows-2022", packageType: "EXE", href: import.meta.env.VITE_WINDOWS_DOWNLOAD_URL },
  { name: "Linux", artifact: "shanaya-electron-ubuntu-24.04", packageType: "AppImage / DEB", href: import.meta.env.VITE_LINUX_DOWNLOAD_URL },
];

export default function PlatformDownloads() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls="platform-download-menu"
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-2 rounded-xl border border-violet-200/15 bg-[#101522]/85 px-3 py-2.5 text-xs font-semibold text-violet-100 shadow-lg backdrop-blur-xl transition hover:border-violet-200/30 hover:bg-violet-400/10"
      >
        <Download size={14} />
        <span>Downloads</span>
      </button>

      {isOpen && (
        <div
          id="platform-download-menu"
          role="menu"
          aria-label="Shanaya downloads by platform"
          className="absolute right-0 top-[calc(100%+0.6rem)] z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-[#111622]/[0.97] p-3 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        >
          <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Choose your platform</p>
          <div className="space-y-1">
            {platforms.map((platform) => (
              <a
                key={platform.name}
                role="menuitem"
                href={platform.href?.trim() || workflowUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-white/[0.08] hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-100">Download for {platform.name}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                    {platform.href?.trim() ? platform.packageType : `${platform.artifact} · ${platform.packageType}`}
                  </span>
                </span>
                <ExternalLink size={13} className="shrink-0 text-slate-500" />
              </a>
            ))}
          </div>
          <p className="mt-2 border-t border-white/[0.07] px-2 pt-2 text-[10px] leading-relaxed text-slate-500">
            Without a direct download URL, buttons open GitHub Actions. Open the latest successful run and download the named artifact. iOS builds require signing and App Store or TestFlight distribution before installing on a device.
          </p>
        </div>
      )}
    </div>
  );
}
