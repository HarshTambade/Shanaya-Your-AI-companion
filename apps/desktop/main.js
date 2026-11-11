const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");

let mainWindow;
let frontendServer;
let pythonBackend;
let trustedFrontendOrigin;

const webRoot = app.isPackaged
  ? path.join(process.resourcesPath, "frontend", "dist")
  : path.resolve(__dirname, "../frontend/dist");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

function isPythonApiAlreadyRunning() {
  return fetch("http://127.0.0.1:8000/api/health", { signal: AbortSignal.timeout(500) })
    .then(async (response) => {
      if (!response.ok) return false;
      const status = await response.json().catch(() => ({}));
      return status.status === "ok";
    })
    .catch(() => false);
}

function startPythonFallback() {
  if (process.env.SHANAYA_ENABLE_PYTHON_FALLBACK === "false") return Promise.resolve();
  return isPythonApiAlreadyRunning().then((alreadyRunning) => {
    // If another local fallback already owns the port, leave it alone.
    if (alreadyRunning || pythonBackend || process.env.SHANAYA_SKIP_PYTHON_SPAWN === "true") return;
    const packagedRoot = process.resourcesPath;
    const projectRoot = path.resolve(__dirname, "../..");
    const backendRoot = app.isPackaged ? packagedRoot : projectRoot;
    const python = process.env.SHANAYA_PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");
    const envAllowlist = [
      "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TMP", "TEMP", "LANG",
      "GROQ_API_KEY", "GROQ_MODELS", "OPENAI_API_KEY", "OPENAI_MODELS", "ANTHROPIC_API_KEY", "ANTHROPIC_MODELS",
      "GEMINI_API_KEY", "GEMINI_MODELS", "LLAMA_CPP_MODEL_PATH", "LLAMA_CPP_N_CTX", "LLAMA_CPP_N_THREADS",
      "LOCAL_LLM_BASE_URL", "LOCAL_LLM_MODEL", "LOCAL_LLM_API_KEY", "MITHI_TTS_URL", "MITHI_TTS_API_KEY",
      "APPROVAL_TTL_SECONDS", "SHANAYA_PYTHON_SANDBOX_IMAGE", "SHANAYA_NODE_SANDBOX_IMAGE", "SHANAYA_SHELL_SANDBOX_IMAGE",
    ];
    const childEnv = Object.fromEntries(envAllowlist
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]));
    childEnv.SHANAYA_HOST = "127.0.0.1";
    childEnv.SHANAYA_PORT = "8000";
    childEnv.NODE_ENV = app.isPackaged ? "production" : (process.env.NODE_ENV || "development");
    childEnv.SHANAYA_WORKSPACE = path.join(app.getPath("userData"), "workspace");
    // Keep the append-only audit chain in the app's private writable data area,
    // not beside packaged read-only application resources.
    childEnv.SHANAYA_AUDIT_LOG = path.join(app.getPath("userData"), "logs", "shanaya_audit.jsonl");

    try {
      // Fixed module and arguments, shell disabled, and no process APIs exposed to the renderer.
      pythonBackend = spawn(python, ["-m", "backend.main"], {
        cwd: backendRoot,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      pythonBackend.once("error", (error) => {
        pythonBackend = undefined;
        console.warn(`Python fallback did not start (${error.code || error.name || "process error"}).`);
      });
      pythonBackend.once("exit", (code) => {
        pythonBackend = undefined;
        if (code && code !== 0) console.warn(`Python fallback stopped with exit code ${code}.`);
      });
    } catch (error) {
      console.warn(`Python fallback did not start (${error.code || error.name || "process error"}).`);
    }
  }).catch((error) => {
    console.warn(`Python fallback availability could not be checked (${error?.code || error?.name || "startup error"}).`);
  });
}

function isTrustedMainFrame(event) {
  if (!(
    mainWindow
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
  )) return false;
  try {
    // A remote or navigated page must never receive the desktop confirmation bridge.
    return new URL(event.senderFrame.url).origin === trustedFrontendOrigin;
  } catch {
    return false;
  }
}

function parseLocalFrontendUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("The desktop frontend must be served from a local HTTP origin.");
  }
  return url;
}

function startFrontendServer() {
  if (frontendServer?.listening) return Promise.resolve("http://localhost:5173");
  frontendServer = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    const requested = pathname === "/" ? "/index.html" : pathname;
    const filename = path.resolve(webRoot, `.${requested}`);
    if (filename !== webRoot && !filename.startsWith(`${webRoot}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filename, (error, content) => {
      const isAsset = path.extname(requested) !== "";
      if (error && isAsset) {
        response.writeHead(404).end("Not found");
        return;
      }
      let body = content;
      let servedFile = filename;
      if (error) {
        servedFile = path.join(webRoot, "index.html");
        try {
          body = fs.readFileSync(servedFile);
        } catch {
          response.writeHead(503).end("Build the frontend before launching the desktop app.");
          return;
        }
      }
      response.writeHead(200, {
        "Cache-Control": path.basename(servedFile) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'self' https: data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' http://localhost:* http://127.0.0.1:* https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        "Content-Type": mimeTypes[path.extname(servedFile)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      if (request.method === "HEAD") response.end();
      else response.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    frontendServer.once("error", reject);
    frontendServer.listen(5173, "127.0.0.1", () => resolve("http://localhost:5173"));
  });
}

async function waitForDevServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      await response.body?.cancel();
    } catch {
      // The frontend workspace may still be starting under concurrently.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`The frontend did not become available at ${url}.`);
}

async function createWindow() {
  // Packaged builds always use the bundled frontend; an environment override is dev-only.
  const devUrl = app.isPackaged ? undefined : (process.env.SHANAYA_DEV_SERVER_URL || "http://localhost:5173");
  // Validate before making even a health-check request to a developer-supplied URL.
  if (devUrl) parseLocalFrontendUrl(devUrl);
  if (devUrl) await waitForDevServer(devUrl);
  const frontendUrl = devUrl || await startFrontendServer();
  const parsedFrontendUrl = parseLocalFrontendUrl(frontendUrl);
  trustedFrontendOrigin = parsedFrontendUrl.origin;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#080b14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === trustedFrontendOrigin) return;
    } catch {
      // Block malformed navigation targets.
    }
    event.preventDefault();
  });

  void mainWindow.loadURL(frontendUrl);
}

ipcMain.handle("shanaya:confirm", async (event, message) => {
  if (!isTrustedMainFrame(event)) return false;
  if (typeof message !== "string" || message.length > 2000) return false;
  const { response } = await require("electron").dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["Cancel", "Confirm"],
    defaultId: 0,
    cancelId: 0,
    title: "Confirm action",
    message,
  });
  return response === 1;
});

app.whenReady().then(async () => {
  await startPythonFallback();
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}).catch((error) => {
  // A missing system Python/dependency must not prevent the desktop shell opening.
  console.error(`Shanaya desktop window could not start (${error?.code || error?.name || "startup error"}).`);
  app.quit();
});

app.on("before-quit", () => {
  if (pythonBackend && !pythonBackend.killed) pythonBackend.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
