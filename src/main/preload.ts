import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { KeaplayerApi } from "../shared/types";

const api: KeaplayerApi = {
  openFilesDialog: () => ipcRenderer.invoke("open-files-dialog"),
  openFolderDialog: () => ipcRenderer.invoke("open-folder-dialog"),
  pathsForFiles: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  expandPaths: (paths) => ipcRenderer.invoke("expand-paths", paths),
  setCapabilities: (capabilities) => ipcRenderer.invoke("set-capabilities", capabilities),
  prepare: (path) => ipcRenderer.invoke("prepare", path),
  plan: (id, options) => ipcRenderer.invoke("plan", id, options),
  saveResume: (path, time, duration) => ipcRenderer.invoke("save-resume", path, time, duration),
  saveScreenshot: (dataUrl, baseName) => ipcRenderer.invoke("save-screenshot", dataUrl, baseName),
  onOpenPaths: (callback) => {
    ipcRenderer.on("open-paths", (_event, paths: string[]) => callback(paths));
  },
};

contextBridge.exposeInMainWorld("keaplayer", api);
