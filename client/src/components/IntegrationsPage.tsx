import { useState } from "react";
import {
  ArrowLeft, ArrowUpRight, Check, Clipboard, Code2, KeyRound, Network,
  PlugZap, Server, ShieldCheck, Terminal,
} from "lucide-react";
import { apiUrl } from "../services/api";

type IntegrationsPageProps = { onBack: () => void };

const apiRoot = new URL(apiUrl("/api"), window.location.href).toString().replace(/\/$/, "");
const mcpEndpoint = new URL(apiUrl("/mcp"), window.location.href).toString();
const localMcpConfig = JSON.stringify({
  mcpServers: {
    shanaya: {
      command: "node",
      args: ["/absolute/path/to/Shanaya/server/mcp-stdio.mjs"],
      env: { SHANAYA_API_URL: "http://127.0.0.1:3001" },
    },
  },
}, null, 2);
const apiExample = `curl -X POST "${apiRoot}/chat" \\
  -H "Content-Type: application/json" \\
  -H "X-Groq-API-Key: $GROQ_API_KEY" \\
  -d '{"mode":"cloud","messages":[{"role":"user","content":"Hello, Shanaya!"}]}'`;

const endpoints = [
  { method: "GET", path: "/api/health", description: "Check that the Shanaya API is responding." },
  { method: "GET", path: "/api/models", description: "List the cloud models available to this server." },
  { method: "POST", path: "/api/chat", description: "Send a conversation and receive a reply with an emotion." },
  { method: "POST", path: "/api/agent", description: "Request one agent step with tools; the client validates and runs tools." },
];

export default function IntegrationsPage({ onBack }: IntegrationsPageProps) {
  const [copied, setCopied] = useState("");

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1800);
    } catch {
      setCopied("");
    }
  };

  return (
    <main className="landing-page relative h-[100dvh] overflow-y-auto bg-[#070a13] text-slate-100 selection:bg-cyan-300/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-40 top-32 h-[32rem] w-[32rem] rounded-full bg-indigo-600/[0.12] blur-[140px]" />
        <div className="absolute -right-40 top-[38rem] h-[32rem] w-[32rem] rounded-full bg-cyan-500/[0.08] blur-[150px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#080b14]/80 backdrop-blur-2xl">
        <div className="mx-auto flex h-[4.25rem] max-w-6xl items-center justify-between px-5 sm:px-8">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 transition hover:text-white">
            <ArrowLeft size={15} /> Back
          </button>
          <span className="font-['Manrope'] text-[11px] font-extrabold tracking-[0.2em] text-white">SHANAYA</span>
          <span className="w-12" aria-hidden="true" />
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl px-5 pb-16 pt-12 sm:px-8 sm:pt-16">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.22em] text-cyan-200/75"><PlugZap size={13} /> Connect Shanaya</p>
          <h1 className="mt-4 font-['Manrope'] text-4xl font-semibold tracking-[-0.055em] text-white sm:text-5xl">Bring Shanaya into your workflow.</h1>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-400">Use the REST API from your own app, or connect an MCP-compatible host to chat with Shanaya and inspect available models.</p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <section className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-5 sm:p-7">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-100/10 bg-cyan-100/[0.06] text-cyan-100"><Code2 size={19} /></span>
              <div>
                <h2 className="font-['Manrope'] text-lg font-semibold text-white">REST API</h2>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">Connect websites, automations, and custom apps to Shanaya’s API.</p>
              </div>
            </div>

            <div className="mt-6 space-y-2">
              {endpoints.map((endpoint) => (
                <div key={endpoint.path} className="flex flex-col gap-1 rounded-xl border border-white/[0.055] bg-[#080b13]/60 px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3">
                  <span className={`w-11 shrink-0 font-mono text-[8px] font-bold ${endpoint.method === "GET" ? "text-emerald-200/80" : "text-violet-200/80"}`}>{endpoint.method}</span>
                  <div className="min-w-0 flex-1">
                    <code className="text-[10px] text-slate-200">{endpoint.path}</code>
                    <p className="mt-1 text-[9px] leading-4 text-slate-500">{endpoint.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl border border-white/[0.07] bg-[#06080e]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
                <span className="inline-flex items-center gap-2 text-[9px] font-semibold text-slate-400"><Terminal size={12} /> Quick example</span>
                <button type="button" onClick={() => void copy(apiExample, "api")} className="inline-flex items-center gap-1.5 text-[9px] text-slate-400 transition hover:text-white" aria-label="Copy API example">
                  {copied === "api" ? <Check size={12} /> : <Clipboard size={12} />}{copied === "api" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 text-[9px] leading-5 text-cyan-50/80"><code>{apiExample}</code></pre>
            </div>

            <p className="mt-4 flex items-start gap-2 text-[9px] leading-5 text-slate-500"><KeyRound size={13} className="mt-0.5 shrink-0 text-cyan-200/70" />Use your own Groq key in the request header. Do not put keys in frontend source code or public URLs.</p>
          </section>

          <section className="rounded-3xl border border-violet-100/[0.09] bg-[radial-gradient(ellipse_at_100%_0%,rgba(139,92,246,0.11),transparent_48%),rgba(255,255,255,0.025)] p-5 sm:p-7">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-100/10 bg-violet-100/[0.06] text-violet-100"><Network size={19} /></span>
              <div>
                <h2 className="font-['Manrope'] text-lg font-semibold text-white">MCP integrations</h2>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">Expose Shanaya to a desktop, IDE, or other MCP-capable host.</p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                { name: "shanaya_chat", detail: "Chat with optional recent context." },
                { name: "shanaya_status", detail: "Check service and provider status." },
                { name: "shanaya_models", detail: "List configured model IDs." },
              ].map((tool) => (
                <div key={tool.name} className="rounded-xl border border-white/[0.06] bg-[#080b13]/60 p-3">
                  <code className="text-[9px] font-semibold text-violet-100">{tool.name}</code>
                  <p className="mt-2 text-[9px] leading-4 text-slate-500">{tool.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-2xl border border-white/[0.07] bg-[#06080e]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <span className="inline-flex items-center gap-2 text-[9px] font-semibold text-slate-300"><Server size={12} /> Local desktop / IDE setup</span>
                <button type="button" onClick={() => void copy(localMcpConfig, "mcp")} className="inline-flex items-center gap-1.5 text-[9px] text-slate-400 transition hover:text-white" aria-label="Copy local MCP configuration">
                  {copied === "mcp" ? <Check size={12} /> : <Clipboard size={12} />}{copied === "mcp" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 text-[9px] leading-5 text-violet-50/80"><code>{localMcpConfig}</code></pre>
            </div>
            <ol className="mt-4 space-y-2 text-[9px] leading-5 text-slate-400">
              <li><span className="mr-2 font-mono text-violet-200/70">01</span>Run `npm install --prefix server` and start the API with `npm run dev:server`.</li>
              <li><span className="mr-2 font-mono text-violet-200/70">02</span>Replace the example path with the full path to this project’s `server/mcp-stdio.mjs`.</li>
              <li><span className="mr-2 font-mono text-violet-200/70">03</span>Add the JSON to your MCP host settings and restart that host.</li>
            </ol>

            <div className="mt-5 rounded-xl border border-amber-200/10 bg-amber-100/[0.035] p-4">
              <p className="flex items-center gap-2 text-[10px] font-semibold text-amber-100/90"><ShieldCheck size={13} /> Remote MCP endpoint</p>
              <p className="mt-2 break-all font-mono text-[9px] text-slate-300">{mcpEndpoint}</p>
              <p className="mt-2 text-[9px] leading-5 text-slate-500">For remote hosts, enable `MCP_ENABLED=true` and set a server-side `MCP_API_TOKEN` (32+ characters). Send it as a Bearer token from the host’s secret settings. Keep it out of this app and all browser code.</p>
            </div>
          </section>
        </div>

        <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-start gap-3"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-200/80" /><p className="max-w-3xl text-[10px] leading-5 text-slate-400">MCP provides chat, status, and model listing only. It does not let another platform control Shanaya’s device tools or access her private app data. The receiving platform must support MCP and apply its own permissions.</p></div>
          <a href="https://modelcontextprotocol.io/" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 text-[9px] font-medium text-cyan-100/80 transition hover:text-white">MCP overview <ArrowUpRight size={12} /></a>
        </div>
      </div>
    </main>
  );
}
