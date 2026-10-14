import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlaybackOptions, PlaybackPlan, PreparedMedia, SubtitleSource } from "../shared/types";
import { createPlaybackRegistry, type PlaybackDecision, type PlaybackInput } from "./media/playback";
import { expandPaths, findExternalSubtitles, isMedia } from "./media/library";
import { probe } from "./media/probe";
import { MediaServer, ORIGIN, SCHEME } from "./media/server";
import { ResumeStore } from "./store";

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const registry = createPlaybackRegistry();
const server = new MediaServer(path.join(__dirname, "..", "..", "renderer"));
let resume: ResumeStore;
let win: BrowserWindow | undefined;

/** Fichiers passés en ligne de commande (« Ouvrir avec KEAPlayer » sous Windows). */
function pathsFromArgv(argv: string[]): string[] {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && isMedia(a));
}

async function sendOpenPaths(paths: string[]) {
  const expanded = await expandPaths(paths);
  if (expanded.length && win) win.webContents.send("open-paths", expanded);
}

async function planFor(id: string, options: PlaybackOptions): Promise<PlaybackPlan> {
  const session = server.get(id);
  if (!session) throw new Error("Média inconnu.");
  const result = await registry.load<PlaybackInput, PlaybackDecision>("playback", {
    info: session.info,
    options,
  });
  if (!result) throw new Error("Aucun module ne sait lire ce fichier.");
  const { mode, job } = result.output;
  if (mode === "native") {
    return { mode, module: result.module, url: `${ORIGIN}/media/${id}`, startOffset: 0, seekable: true };
  }
  const q = new URLSearchParams({
    v: job!.video,
    a: job!.audio,
    start: options.start.toFixed(3),
    track: String(options.audioIndex),
    delay: options.audioDelay.toFixed(3),
    // Chaque saut est une nouvelle requête : FFmpeg repart de cette position.
    n: String(Date.now()),
  });
  return { mode, module: result.module, url: `${ORIGIN}/stream/${id}?${q}`, startOffset: options.start, seekable: false };
}

async function prepare(file: string): Promise<PreparedMedia> {
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) throw new Error(`Fichier introuvable : ${file}`);
  const info = await probe(file);
  const externalSubtitles = await findExternalSubtitles(file);
  const id = server.add({ path: file, info, externalSubtitles });

  const subtitles: SubtitleSource[] = [
    ...externalSubtitles.map((sub, i) => ({
      id: `ext-${i}`,
      label: `${path.basename(sub.file)}`,
      language: sub.language,
      external: true,
      url: `${ORIGIN}/subs/${id}/ext-${i}`,
    })),
    ...info.subtitles
      .filter((s) => s.isText)
      .map((s) => ({
        id: `emb-${s.index}`,
        label: s.title ?? s.language ?? `Piste ${s.index + 1}`,
        language: s.language,
        external: false,
        url: `${ORIGIN}/subs/${id}/emb-${s.index}`,
      })),
  ];
  const defaultAudio = Math.max(0, info.audio.findIndex((a) => a.isDefault));
  const resumeAt = resume.get(file);
  const plan = await planFor(id, { start: resumeAt ?? 0, audioIndex: defaultAudio, audioDelay: 0 });
  return { id, info, plan, subtitles, resumeAt };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 520,
    minHeight: 360,
    backgroundColor: "#0e0f12",
    title: "KEAPlayer",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // L'interface ne quitte jamais l'application : tout lien externe part vers le navigateur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });

  win.loadURL(`${ORIGIN}/app/renderer/index.html`);
  win.webContents.once("did-finish-load", () => sendOpenPaths(pathsFromArgv(process.argv)));
  win.on("closed", () => {
    server.stopAll();
    win = undefined;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    sendOpenPaths(pathsFromArgv(argv));
  });

  app.whenReady().then(() => {
    resume = new ResumeStore(path.join(app.getPath("userData"), "resume.json"));
    protocol.handle(SCHEME, (request) => server.handle(request));

    ipcMain.handle("open-files-dialog", async () => {
      const r = await dialog.showOpenDialog(win!, {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Médias", extensions: ["*"] }],
      });
      return r.canceled ? [] : expandPaths(r.filePaths);
    });
    ipcMain.handle("open-folder-dialog", async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
      return r.canceled ? [] : expandPaths(r.filePaths);
    });
    ipcMain.handle("expand-paths", (_e, paths: string[]) => expandPaths(paths));
    ipcMain.handle("prepare", (_e, file: string) => prepare(file));
    ipcMain.handle("plan", (_e, id: string, options: PlaybackOptions) => planFor(id, options));
    ipcMain.handle("save-resume", (_e, file: string, time: number, duration: number) => {
      resume.set(file, time, duration);
    });
    ipcMain.handle("save-screenshot", async (_e, dataUrl: string, baseName: string) => {
      const prefix = "data:image/png;base64,";
      if (!dataUrl.startsWith(prefix)) throw new Error("Capture invalide.");
      const dir = path.join(app.getPath("pictures"), "KEAPlayer");
      await mkdir(dir, { recursive: true });
      const safe = baseName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
      const file = path.join(dir, `${safe}.png`);
      await writeFile(file, Buffer.from(dataUrl.slice(prefix.length), "base64"));
      return file;
    });

    createWindow();
  });

  app.on("window-all-closed", () => app.quit());
}
