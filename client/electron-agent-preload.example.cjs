require("@capawesome/capacitor-electron/preload");

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shanayaDesktop", {
  confirmAction: (action, input) => ipcRenderer.invoke("shanaya:computer:confirm", { action, input }),
  screenshot: (approvalToken) => ipcRenderer.invoke("shanaya:computer:screenshot", approvalToken),
  perform: (action, input, approvalToken) => ipcRenderer.invoke("shanaya:computer:perform", { action, input, approvalToken }),
});
