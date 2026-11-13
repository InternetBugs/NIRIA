const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("niriaDesktop", Object.freeze({
  showMain: () => ipcRenderer.invoke("niria:show-main"),
  showWidget: () => ipcRenderer.invoke("niria:show-widget"),
  collapseWidget: () => ipcRenderer.invoke("niria:collapse-widget"),
  hideWidget: () => ipcRenderer.invoke("niria:hide-widget"),
  desktopState: () => ipcRenderer.invoke("niria:desktop-state"),
  toggleTopmost: () => ipcRenderer.invoke("niria:toggle-topmost"),
  onDesktopState: (listener) => {
    if (typeof listener !== "function") return () => {};
    const receive = (_event, value) => listener(value);
    ipcRenderer.on("niria:desktop-state", receive);
    return () => ipcRenderer.removeListener("niria:desktop-state", receive);
  }
}));
