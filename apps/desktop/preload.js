const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shanayaDesktop", Object.freeze({
  platform: process.platform,
  confirmAction: (message) => ipcRenderer.invoke("shanaya:confirm", String(message).slice(0, 2000)),
}));
