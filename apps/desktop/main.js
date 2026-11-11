const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");

let mainWindow;
let frontendServer;

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
  const devUrl = process.env.SHANAYA_DEV_SERVER_URL || (!app.isPackaged ? "http://localhost:5173" : undefined);
  if (devUrl) await waitForDevServer(devUrl);
  const frontendUrl = devUrl || await startFrontendServer();
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
      if (new URL(url).origin === new URL(frontendUrl).origin) return;
    } catch {
      // Block malformed navigation targets.
    }
    event.preventDefault();
  });

  void mainWindow.loadURL(frontendUrl);
}

ipcMain.handle("shanaya:confirm", async (_event, message) => {
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
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
