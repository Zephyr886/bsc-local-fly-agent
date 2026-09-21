const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flapDesktop", Object.freeze({
  startSetup: () => ipcRenderer.invoke("setup:start"),
  skipSetup: () => ipcRenderer.invoke("setup:skip"),
  onProgress: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("setup:progress", handler);
    return () => ipcRenderer.removeListener("setup:progress", handler);
  },
}));
