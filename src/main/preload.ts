import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { KeaplayerApi, MenuCommand } from "../shared/types";

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
  setFullscreen: (on) => ipcRenderer.invoke("set-fullscreen", on),
  onFullscreenChange: (callback) => {
    ipcRenderer.on("fullscreen-changed", (_event, on: boolean) => callback(on));
  },
  updateMenuState: (state) => ipcRenderer.send("menu-state", state),
  onMenuCommand: (callback) => {
    ipcRenderer.on("menu-command", (_event, command: MenuCommand) => callback(command));
  },
};

contextBridge.exposeInMainWorld("keaplayer", api);
