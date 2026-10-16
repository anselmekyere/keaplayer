import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from "electron";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capabilities, PlaybackOptions, PlaybackPlan, PreparedMedia, SubtitleSource } from "../shared/types";
import {
  createPlaybackRegistry,
  DEFAULT_CAPABILITIES,
  type PlaybackDecision,
  type PlaybackInput,
} from "./media/playback";
import { expandPaths, findExternalSubtitles, isMedia } from "./media/library";
import { probe } from "./media/probe";
import { isAssCodec, isAssFile, MediaServer, ORIGIN, SCHEME } from "./media/server";
import { EncoderSelector, ffmpegEncoderProbe } from "./media/encoders";
import { ffmpegPath } from "./media/ffmpeg";
import { ResumeStore } from "./store";
import { buildMenuTemplate, DEFAULT_MENU_STATE, sanitizeMenuState } from "./menu";
import type { MenuCommand, MenuState } from "../shared/types";

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const registry = createPlaybackRegistry();
const encoders = new EncoderSelector(() => ffmpegEncoderProbe(ffmpegPath()));
const server = new MediaServer(path.join(__dirname, "..", "..", "renderer"), encoders);
let resume: ResumeStore;
let capabilities: Capabilities = DEFAULT_CAPABILITIES;

/** Ne garde que des noms de codecs plausibles venant de l'interface. */
function sanitizeCapabilities(value: unknown): Capabilities | null {
  const v = value as Partial<Capabilities> | null;
  const names = (list: unknown) =>
    Array.isArray(list) ? list.filter((c): c is string => typeof c === "string" && /^[a-z0-9_]{1,16}$/.test(c)) : null;
  const video = names(v?.video);
  const audio = names(v?.audio);
  return video && audio ? { video, audio } : null;
}
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
    capabilities,
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
    ...(job!.videoTag ? { tag: job!.videoTag } : {}),
    ...(job!.deinterlace ? { di: "1" } : {}),
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
      format: isAssFile(sub.file) ? ("ass" as const) : ("vtt" as const),
    })),
    ...info.subtitles
      .filter((s) => s.isText)
      .map((s) => ({
        id: `emb-${s.index}`,
        label: s.title ?? s.language ?? `Piste ${s.index + 1}`,
        language: s.language,
        external: false,
        url: `${ORIGIN}/subs/${id}/emb-${s.index}`,
        format: isAssCodec(s.codec) ? ("ass" as const) : ("vtt" as const),
      })),
  ];
  const fonts = info.fonts.map((_, n) => `${ORIGIN}/fonts/${id}/${n}`);
  const defaultAudio = Math.max(0, info.audio.findIndex((a) => a.isDefault));
  const resumeAt = resume.get(file);
  const plan = await planFor(id, { start: resumeAt ?? 0, audioIndex: defaultAudio, audioDelay: 0 });
  return { id, info, plan, subtitles, fonts, resumeAt };
}

let menuState: MenuState = { ...DEFAULT_MENU_STATE };

function refreshMenu() {
  const template = buildMenuTemplate(menuState, {
    send: (command: MenuCommand) => win?.webContents.send("menu-command", command),
    toggleFullscreen: () => win?.setFullScreen(!win.isFullScreen()),
    toggleAlwaysOnTop: () => {
      if (!win) return;
      win.setAlwaysOnTop(!win.isAlwaysOnTop());
      menuState = { ...menuState, alwaysOnTop: win.isAlwaysOnTop() };
      refreshMenu();
    },
    about: () =>
      dialog.showMessageBox(win!, {
        type: "info",
        title: "À propos de KEAPlayer",
        message: `KEAPlayer ${app.getVersion()}`,
        detail:
          "Lecteur multimédia inspiré de l'architecture de VLC.\n" +
          "Lecture native Chromium, remux et transcodage FFmpeg.\n" +
          `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
      }),
    quit: () => app.quit(),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 520,
    minHeight: 360,
    backgroundColor: "#0e0f12",
    title: "KEAPlayer",
    // Barre de menus visible (Média, Lecture, Audio…) ; masquée en plein écran.
    autoHideMenuBar: false,
    icon: path.join(__dirname, "..", "..", "..", "build", "icon.png"),
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

  // Plein écran de la fenêtre entière (barre de menus et bordures masquées).
  const notifyFullscreen = () => {
    if (!win) return;
    const on = win.isFullScreen();
    win.webContents.send("fullscreen-changed", on);
    menuState = { ...menuState, fullscreen: on };
    refreshMenu();
  };
  win.on("enter-full-screen", notifyFullscreen);
  win.on("leave-full-screen", notifyFullscreen);

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
    ipcMain.handle("set-capabilities", (_e, value: unknown) => {
      const detected = sanitizeCapabilities(value);
      if (detected) capabilities = detected;
    });
    ipcMain.handle("set-fullscreen", (_e, on?: unknown) => {
      if (!win) return;
      win.setFullScreen(typeof on === "boolean" ? on : !win.isFullScreen());
    });
    ipcMain.on("menu-state", (_e, value: unknown) => {
      const next = sanitizeMenuState(value);
      if (!next || !win) return;
      menuState = { ...next, fullscreen: win.isFullScreen(), alwaysOnTop: win.isAlwaysOnTop() };
      refreshMenu();
    });
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

    refreshMenu();
    createWindow();
    // Recherche de l'encodeur matériel en tâche de fond, sans retarder l'ouverture.
    encoders.detect().then((name) => console.log(`Encodeur de transcodage : ${name}`));
  });

  app.on("window-all-closed", () => app.quit());
}
