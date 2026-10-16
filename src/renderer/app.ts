import type { KeaplayerApi, PlaybackOptions, PlaybackPlan, PreparedMedia } from "../shared/types.js";
import { parseSubtitles, shiftCues, type Cue } from "../shared/subtitles.js";
import { detectCapabilities } from "./capabilities.js";
import { AudioChain, EQ_PRESETS, MAX_VOLUME, splitVolume } from "./audio.js";
import JASSUB from "jassub";

declare global {
  interface Window {
    keaplayer: KeaplayerApi;
  }
}

const api = window.keaplayer;

/** Ce que la machine décode nativement ; le premier fichier attend cette mesure. */
const capabilitiesReady = detectCapabilities()
  .then((caps) => api.setCapabilities(caps))
  .catch(() => undefined);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $<HTMLElement>("stage");
const video = $<HTMLVideoElement>("video");
const seek = $<HTMLInputElement>("seek");
const timeEl = $("time");
const durationEl = $("duration");
const volume = $<HTMLInputElement>("volume");
const speed = $<HTMLSelectElement>("speed");
const audioSelect = $<HTMLSelectElement>("audio-track");
const subtitleSelect = $<HTMLSelectElement>("subtitle-track");
const playlistEl = $<HTMLOListElement>("playlist-items");
const osdEl = $("osd");
const loadingEl = $("loading");

// ---------- État ----------

let playlist: string[] = [];
let currentIndex = -1;
let media: PreparedMedia | null = null;
let plan: PlaybackPlan | null = null;
let options: PlaybackOptions = { start: 0, audioIndex: 0, audioDelay: 0 };
let subtitleCues: Cue[] = [];
let subtitleDelay = 0;
/** Rendu libass (styles, positions, karaoké) des sous-titres ASS/SSA. */
let assRenderer: JASSUB | null = null;
let lastResumeSave = 0;
let loadToken = 0;
let seeking = false;

/** Égaliseur, normalisation et amplification (au-delà de 100 %). */
const audio = new AudioChain(video);
let volumeLevel = 1;

/** Réglages du son conservés d'une séance à l'autre (stockage local, facultatif). */
const AUDIO_KEY = "keaplayer.audio";
function saveAudioSettings() {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify({ volume: volumeLevel, ...audio.state() }));
  } catch {
    // Stockage indisponible : les réglages valent pour cette séance seulement.
  }
}

/** Une seule piste de texte gérée par le lecteur ; ses répliques sont remplacées au besoin. */
const textTrack = video.addTextTrack("subtitles", "KEAPlayer", "und");

// ---------- Utilitaires ----------

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

let osdTimer: number | undefined;
function osd(message: string) {
  osdEl.textContent = message;
  osdEl.classList.add("visible");
  clearTimeout(osdTimer);
  osdTimer = window.setTimeout(() => osdEl.classList.remove("visible"), 1600);
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Position réelle dans le fichier, même quand FFmpeg diffuse à partir d'un point de départ. */
function position(): number {
  return (plan?.startOffset ?? 0) + video.currentTime;
}

function duration(): number {
  return media?.info.duration || (Number.isFinite(video.duration) ? video.duration : 0);
}

// ---------- Lecture ----------

async function applyPlan(next: PlaybackPlan, resumeAt: number | null, autoplay: boolean) {
  plan = next;
  const rate = video.playbackRate;
  loadingEl.hidden = false;
  video.src = next.url;
  video.playbackRate = rate;
  $("mode").textContent = next.mode === "native" ? "natif" : next.mode;
  $("mode").title = `Moteur de lecture : module « ${next.module} »`;
  if (next.seekable && resumeAt) {
    video.addEventListener("loadedmetadata", () => (video.currentTime = resumeAt), { once: true });
  }
  applySubtitles();
  if (autoplay) await video.play().catch(() => undefined);
}

/** Reprogramme le flux (changement de piste, de décalage, ou saut en mode FFmpeg). */
async function replan(changes: Partial<PlaybackOptions>) {
  if (!media) return;
  const wasPlaying = !video.paused;
  options = { ...options, start: position(), ...changes };
  const next = await api.plan(media.id, options);
  const resumeAt = next.seekable ? options.start : null;
  await applyPlan(next, resumeAt, wasPlaying);
}

async function seekTo(t: number) {
  if (!media) return;
  t = Math.min(Math.max(0, t), Math.max(0, duration() - 0.5));
  if (plan?.seekable) video.currentTime = t;
  else await replan({ start: t });
}

async function playIndex(index: number) {
  if (index < 0 || index >= playlist.length) return;
  saveResume();
  const token = ++loadToken;
  currentIndex = index;
  renderPlaylist();
  const file = playlist[index];
  loadingEl.hidden = false;
  try {
    await capabilitiesReady;
    const prepared = await api.prepare(file);
    if (token !== loadToken) return;
    media = prepared;
    retriedStream = false;
    subtitleCues = [];
    clearAss();
    thumbCache.clear();
    previewWanted = -1;
    subtitleDelay = 0;
    const defaultAudio = Math.max(0, prepared.info.audio.findIndex((a) => a.isDefault));
    options = { start: prepared.plan.startOffset, audioIndex: defaultAudio, audioDelay: 0 };
    stage.classList.add("has-media");
    $("title").textContent = basename(file);
    document.title = `${basename(file)} — KEAPlayer`;
    fillTrackMenus();
    updateDelays();
    await applyPlan(prepared.plan, prepared.resumeAt, true);
    if (prepared.resumeAt) osd(`Reprise à ${formatTime(prepared.resumeAt)}`);
  } catch (err) {
    loadingEl.hidden = true;
    osd(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Lecture impossible");
  }
}

function saveResume() {
  if (media && duration() > 0) api.saveResume(media.info.path, position(), duration());
}

// ---------- Pistes et sous-titres ----------

function fillTrackMenus() {
  if (!media) return;
  queueMicrotask(pushMenuState);
  const { info, subtitles } = media;
  audioSelect.replaceChildren(
    ...info.audio.map((a) => new Option(
      [a.title, a.language, a.codec].filter(Boolean).join(" · ") || `Piste ${a.index + 1}`,
      String(a.index),
    )),
  );
  audioSelect.disabled = info.audio.length < 2;
  audioSelect.value = String(options.audioIndex);

  subtitleSelect.replaceChildren(
    new Option("Désactivés", ""),
    ...subtitles.map((s) => new Option(`${s.label}${s.external ? " (fichier)" : ""}`, s.id)),
  );
  subtitleSelect.disabled = subtitles.length === 0;
  // Comme VLC : un fichier de sous-titres voisin est activé d'office.
  const auto = subtitles.find((s) => s.external);
  subtitleSelect.value = auto?.id ?? "";
  if (auto) loadSubtitles(auto.id);

  const v = info.video;
  $("info").textContent = [
    v ? `${v.codec.toUpperCase()} ${v.width}×${v.height} · ${v.fps.toFixed(2).replace(/\.00$/, "")} i/s` : "Audio seul",
    info.audio[options.audioIndex]?.codec.toUpperCase(),
    info.formatName.split(",")[0],
  ].filter(Boolean).join(" · ");
}

async function loadSubtitles(id: string) {
  subtitleCues = [];
  clearAss();
  applySubtitles();
  const source = media?.subtitles.find((s) => s.id === id);
  if (!source) return;
  const owner = media;
  try {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    if (media !== owner || subtitleSelect.value !== id) return;
    if (source.format === "ass") startAss(text);
    else subtitleCues = parseSubtitles(text);
    applySubtitles();
    osd(`Sous-titres : ${source.label}`);
  } catch {
    osd("Sous-titres illisibles");
  }
}

const jassubBase = new URL("jassub/", location.href).href;

function startAss(content: string) {
  clearAss();
  assRenderer = new JASSUB({
    video,
    subContent: content,
    workerUrl: `${jassubBase}worker.js`,
    wasmUrl: `${jassubBase}jassub-worker.wasm`,
    modernWasmUrl: `${jassubBase}jassub-worker-modern.wasm`,
    // Polices jointes au MKV, puis police de secours libre.
    fonts: media?.fonts ?? [],
    availableFonts: { "liberation sans": `${jassubBase}default.woff2` },
    queryFonts: false,
  });
  assRenderer.ready.catch(() => osd("Rendu ASS indisponible"));
}

function clearAss() {
  assRenderer?.destroy().catch(() => undefined);
  assRenderer = null;
}

function applySubtitles() {
  // libass dessine au temps de la vidéo + timeOffset : on y ramène le temps du fichier.
  if (assRenderer) {
    assRenderer.timeOffset = (plan?.startOffset ?? 0) - subtitleDelay;
    if (video.paused) assRenderer.resize(true).catch(() => undefined);
  }
  for (const cue of Array.from(textTrack.cues ?? [])) textTrack.removeCue(cue);
  // Les répliques s'affichent juste au-dessus de la barre de commandes.
  const controlsHeight = $("controls").offsetHeight || 90;
  const line = Math.max(50, 100 - ((controlsHeight + 12) / Math.max(1, video.clientHeight)) * 100);
  for (const c of shiftCues(subtitleCues, plan?.startOffset ?? 0, subtitleDelay)) {
    const cue = new VTTCue(c.start, c.end, c.text);
    cue.snapToLines = false;
    cue.line = line;
    cue.lineAlign = "end";
    textTrack.addCue(cue);
  }
  textTrack.mode = subtitleCues.length ? "showing" : "hidden";
}

function updateDelays() {
  $("audio-delay").textContent = `${Math.round(options.audioDelay * 1000)} ms`;
  $("sub-delay").textContent = `${Math.round(subtitleDelay * 1000)} ms`;
}

function changeAudioDelay(delta: number) {
  const value = Math.round((options.audioDelay + delta) * 1000) / 1000;
  updateDelays();
  osd(`Décalage audio : ${Math.round(value * 1000)} ms`);
  replan({ audioDelay: value }).then(updateDelays);
}

function changeSubtitleDelay(delta: number) {
  subtitleDelay = Math.round((subtitleDelay + delta) * 1000) / 1000;
  updateDelays();
  applySubtitles();
  osd(`Décalage sous-titres : ${Math.round(subtitleDelay * 1000)} ms`);
}

function cycleSelect(select: HTMLSelectElement) {
  if (select.disabled || select.options.length < 2) return;
  select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
  select.dispatchEvent(new Event("change"));
}

// ---------- Liste de lecture ----------

function renderPlaylist() {
  playlistEl.replaceChildren(
    ...playlist.map((file, i) => {
      const li = document.createElement("li");
      li.classList.toggle("current", i === currentIndex);
      li.title = file;
      const name = document.createElement("span");
      name.textContent = basename(file);
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Retirer ${basename(file)}`);
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        playlist.splice(i, 1);
        if (i < currentIndex) currentIndex--;
        else if (i === currentIndex) currentIndex = -1;
        renderPlaylist();
      });
      li.append(name, remove);
      li.tabIndex = 0;
      li.setAttribute("aria-current", i === currentIndex ? "true" : "false");
      li.addEventListener("click", () => playIndex(i));
      li.addEventListener("keydown", (e) => {
        // Entrée : lire ; flèches : passer à l'élément voisin ; Suppr : retirer.
        if (e.key === "Enter") playIndex(i);
        else if (e.key === "ArrowDown") (li.nextElementSibling as HTMLElement | null)?.focus();
        else if (e.key === "ArrowUp") (li.previousElementSibling as HTMLElement | null)?.focus();
        else if (e.key === "Delete") remove.click();
        else return;
        e.preventDefault();
        e.stopPropagation();
      });
      return li;
    }),
  );
}

/** Ajoute des fichiers ; `play` lance le premier ajouté. */
function enqueue(files: string[], play: boolean) {
  if (!files.length) return;
  const first = playlist.length;
  playlist.push(...files);
  renderPlaylist();
  if (play || currentIndex < 0) playIndex(first);
  if (files.length > 1) setPanel("playlist", true);
}

// ---------- Commandes ----------

function togglePlay() {
  if (!media) return;
  if (video.paused) video.play();
  else video.pause();
}

function setSpeed(value: number) {
  const v = Math.min(4, Math.max(0.25, Math.round(value * 100) / 100));
  video.playbackRate = v;
  speed.value = [...speed.options].some((o) => Number(o.value) === v) ? String(v) : speed.value;
  osd(`Vitesse : ${String(v).replace(".", ",")}×`);
}

function frameStep() {
  if (!media?.info.video) return;
  video.pause();
  video.currentTime += 1 / (media.info.video.fps || 25);
}

async function snapshot() {
  if (!media?.info.video || !video.videoWidth) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(video, 0, 0);
  const name = `${basename(media.info.path).replace(/\.[^.]+$/, "")}-${formatTime(position()).replace(/:/g, "-")}`;
  try {
    const file = await api.saveScreenshot(canvas.toDataURL("image/png"), name);
    osd(`Capture enregistrée : ${basename(file)}`);
  } catch {
    osd("Capture impossible");
  }
}

/** Plein écran de la fenêtre entière (géré par Electron : menus et bordures masqués). */
let fullscreen = false;
function toggleFullscreen() {
  api.setFullscreen();
}

function setVolume(v: number, announce = true) {
  volumeLevel = Math.min(MAX_VOLUME, Math.max(0, Math.round(v * 100) / 100));
  const { element, boost } = splitVolume(volumeLevel);
  video.volume = element;
  audio.setBoost(boost);
  video.muted = false;
  volume.value = String(volumeLevel);
  if (announce) osd(`Volume : ${Math.round(volumeLevel * 100)} %`);
  saveAudioSettings();
}

async function openFiles() {
  enqueue(await api.openFilesDialog(), true);
}

// ---------- Événements du lecteur ----------

video.addEventListener("play", () => {
  stage.classList.add("playing");
  audio.resume();
});
video.addEventListener("pause", () => {
  stage.classList.remove("playing");
  saveResume();
});
video.addEventListener("playing", () => (loadingEl.hidden = true));
video.addEventListener("canplay", () => (loadingEl.hidden = true));
video.addEventListener("waiting", () => (loadingEl.hidden = false));
video.addEventListener("volumechange", () => {
  stage.classList.toggle("muted", video.muted || video.volume === 0);
  volume.value = String(video.muted ? 0 : volumeLevel);
});
video.addEventListener("timeupdate", () => {
  const t = position();
  const d = duration();
  timeEl.textContent = formatTime(t);
  durationEl.textContent = formatTime(d);
  if (!seeking && d > 0) seek.value = String(Math.round((t / d) * 1000));
  if (Date.now() - lastResumeSave > 5000) {
    lastResumeSave = Date.now();
    saveResume();
  }
});
video.addEventListener("ended", () => {
  if (media) api.saveResume(media.info.path, duration(), duration());
  if (currentIndex < playlist.length - 1) playIndex(currentIndex + 1);
});
let retriedStream = false;
video.addEventListener("error", () => {
  loadingEl.hidden = true;
  if (!video.src) return;
  // Un flux FFmpeg en échec (encodeur matériel défaillant…) est relancé une
  // fois : le processus principal est entre-temps revenu à x264.
  if (plan && plan.mode !== "native" && !retriedStream) {
    retriedStream = true;
    osd("Nouvel essai de lecture…");
    replan({});
    return;
  }
  osd("Erreur de lecture");
});
video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", toggleFullscreen);

// ---------- Aperçu au survol de la barre de progression ----------

const preview = $("preview");
const previewImg = $<HTMLImageElement>("preview-img");
const previewTime = $("preview-time");
const thumbCache = new Map<number, string>();
let previewTimer: number | undefined;
let previewWanted = -1;

/** Instant pointé : la largeur utile du curseur exclut la moitié du bouton de chaque côté. */
function seekTimeAt(clientX: number): { t: number; x: number } {
  const rect = seek.getBoundingClientRect();
  const thumb = 8;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left - thumb) / Math.max(1, rect.width - 2 * thumb)));
  return { t: ratio * duration(), x: clientX - rect.left };
}

function showPreview(t: number, x: number) {
  if (!media || duration() <= 0) return;
  previewTime.textContent = formatTime(t);
  preview.hidden = false;
  const hostWidth = seek.parentElement?.clientWidth ?? 0;
  const half = preview.offsetWidth / 2;
  const left = seek.offsetLeft + x;
  preview.style.left = `${Math.min(Math.max(half, left), Math.max(half, hostWidth - half))}px`;
  if (!media.info.video) {
    previewImg.hidden = true;
    return;
  }
  // Images regroupées par pas (≈ 200 par fichier) : le cache resservira au survol suivant.
  const step = Math.max(1, Math.round(duration() / 200));
  const bucket = Math.min(Math.floor(t / step) * step, Math.max(0, duration() - 1));
  if (bucket === previewWanted) return;
  previewWanted = bucket;
  const url = thumbCache.get(bucket) ?? `kp://local/thumb/${media.id}?t=${bucket}&w=192`;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    thumbCache.set(bucket, url);
    previewImg.src = url;
  }, thumbCache.has(bucket) ? 0 : 70);
}

function hidePreview() {
  clearTimeout(previewTimer);
  preview.hidden = true;
}

previewImg.addEventListener("load", () => (previewImg.hidden = false));
previewImg.addEventListener("error", () => (previewImg.hidden = true));
seek.addEventListener("pointermove", (e) => {
  const { t, x } = seekTimeAt(e.clientX);
  showPreview(t, x);
});
seek.addEventListener("pointerleave", () => {
  if (!seeking) hidePreview();
});
seek.addEventListener("blur", hidePreview);

// ---------- Commandes de l'interface ----------

seek.addEventListener("input", () => {
  seeking = true;
  const t = (Number(seek.value) / 1000) * duration();
  timeEl.textContent = formatTime(t);
  showPreview(t, (Number(seek.value) / 1000) * seek.clientWidth);
});
seek.addEventListener("change", () => {
  seeking = false;
  if (!seek.matches(":hover")) hidePreview();
  seekTo((Number(seek.value) / 1000) * duration());
});
volume.addEventListener("input", () => setVolume(Number(volume.value)));
speed.addEventListener("change", () => setSpeed(Number(speed.value)));
audioSelect.addEventListener("change", () => {
  replan({ audioIndex: Number(audioSelect.value) });
  osd(`Piste audio : ${audioSelect.selectedOptions[0]?.text ?? ""}`);
});
subtitleSelect.addEventListener("change", () => {
  if (subtitleSelect.value) loadSubtitles(subtitleSelect.value);
  else {
    subtitleCues = [];
    clearAss();
    applySubtitles();
    osd("Sous-titres désactivés");
  }
});

$("play").addEventListener("click", togglePlay);
$("prev").addEventListener("click", () => playIndex(currentIndex - 1));
$("next").addEventListener("click", () => playIndex(currentIndex + 1));
$("mute").addEventListener("click", () => (video.muted = !video.muted));
$("frame").addEventListener("click", frameStep);
$("snapshot").addEventListener("click", snapshot);
$("fullscreen").addEventListener("click", toggleFullscreen);
$("tracks-toggle").addEventListener("click", () => setPanel("tracks"));
$("playlist-toggle").addEventListener("click", () => setPanel("playlist"));
$("open-files").addEventListener("click", openFiles);
$("add-files").addEventListener("click", async () => enqueue(await api.openFilesDialog(), false));
$("open-folder").addEventListener("click", async () => enqueue(await api.openFolderDialog(), true));
$("clear-playlist").addEventListener("click", () => {
  playlist = currentIndex >= 0 ? [playlist[currentIndex]] : [];
  currentIndex = playlist.length ? 0 : -1;
  renderPlaylist();
});
$("audio-delay-minus").addEventListener("click", () => changeAudioDelay(-0.05));
$("audio-delay-plus").addEventListener("click", () => changeAudioDelay(0.05));
$("sub-delay-minus").addEventListener("click", () => changeSubtitleDelay(-0.05));
$("sub-delay-plus").addEventListener("click", () => changeSubtitleDelay(0.05));

// Les commandes disparaissent après 2,5 s sans mouvement pendant la lecture.
let idleTimer: number | undefined;
function wake() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => stage.classList.add("idle"), 2500);
}
document.addEventListener("mousemove", wake);

// Glisser-déposer de fichiers ou de dossiers.
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("dragging");
});
document.addEventListener("dragleave", () => stage.classList.remove("dragging"));
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  stage.classList.remove("dragging");
  const files = Array.from(e.dataTransfer?.files ?? []);
  enqueue(await api.expandPaths(api.pathsForFiles(files)), true);
});

// ---------- Raccourcis clavier (inspirés de VLC) ----------

document.addEventListener("keydown", (e) => {
  if (e.key === "F6") {
    e.preventDefault();
    focusZone(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "Escape" && fullscreen && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    api.setFullscreen(false);
    return;
  }
  const target = e.target as HTMLElement;
  if (target.tagName === "SELECT" || (target.tagName === "INPUT" && target.getAttribute("type") !== "range")) return;
  wake();
  const key = e.key;
  const handled = () => e.preventDefault();

  if (e.ctrlKey && key.toLowerCase() === "o") return handled(), void openFiles();
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  switch (key) {
    case " ": handled(); togglePlay(); break;
    case "ArrowRight": handled(); seekTo(position() + (e.shiftKey ? 60 : 10)); break;
    case "ArrowLeft": handled(); seekTo(position() - (e.shiftKey ? 60 : 10)); break;
    case "ArrowUp": handled(); setVolume(volumeLevel + 0.05); break;
    case "ArrowDown": handled(); setVolume(volumeLevel - 0.05); break;
    case "m": case "M": video.muted = !video.muted; osd(video.muted ? "Son coupé" : "Son rétabli"); break;
    case "f": case "F": toggleFullscreen(); break;
    case "n": case "N": playIndex(currentIndex + 1); break;
    case "p": case "P": playIndex(currentIndex - 1); break;
    case "[": setSpeed(video.playbackRate - 0.25); break;
    case "]": setSpeed(video.playbackRate + 0.25); break;
    case "=": setSpeed(1); break;
    case "e": case "E": frameStep(); break;
    case "b": case "B": cycleSelect(audioSelect); break;
    case "v": case "V": cycleSelect(subtitleSelect); break;
    case "j": case "J": changeAudioDelay(-0.05); break;
    case "k": case "K": changeAudioDelay(0.05); break;
    case "g": case "G": changeSubtitleDelay(-0.05); break;
    case "h": case "H": changeSubtitleDelay(0.05); break;
    case "S": if (e.shiftKey) snapshot(); break;
    case "l": case "L": setPanel("playlist"); break;
    case "t": case "T": setPanel("tracks"); break;
    case "?": $<HTMLDialogElement>("help").showModal(); break;
  }
});

let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(applySubtitles, 150);
});
// ---------- Son ----------

const eqSelect = $<HTMLSelectElement>("eq-preset");
const normalizeBox = $<HTMLInputElement>("normalize");
eqSelect.replaceChildren(...Object.entries(EQ_PRESETS).map(([key, p]) => new Option(p.label, key)));
eqSelect.addEventListener("change", () => {
  audio.setPreset(eqSelect.value);
  osd(`Égaliseur : ${EQ_PRESETS[eqSelect.value].label}`);
  saveAudioSettings();
});
normalizeBox.addEventListener("change", () => {
  audio.setNormalize(normalizeBox.checked);
  osd(normalizeBox.checked ? "Volume normalisé" : "Normalisation désactivée");
  saveAudioSettings();
});
try {
  const saved = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? "null") as
    | { volume?: number; preset?: string; normalize?: boolean }
    | null;
  if (saved?.preset && saved.preset in EQ_PRESETS) {
    eqSelect.value = saved.preset;
    audio.setPreset(saved.preset);
  }
  if (saved?.normalize) {
    normalizeBox.checked = true;
    audio.setNormalize(true);
  }
  if (typeof saved?.volume === "number") setVolume(saved.volume, false);
} catch {
  // Pas de réglages enregistrés : valeurs par défaut.
}
// Accès en lecture pour les tests de bout en bout.
Object.defineProperty(window, "__keaplayerAudio", { value: () => ({ volume: volumeLevel, ...audio.state() }) });

// ---------- Panneaux et navigation entre zones ----------

function setPanel(id: "playlist" | "tracks", visible?: boolean) {
  const panel = $(id);
  panel.hidden = visible === undefined ? !panel.hidden : !visible;
  $(`${id}-toggle`).setAttribute("aria-expanded", String(!panel.hidden));
  pushMenuState();
}

/**
 * F6 / Maj+F6 : passe d'une zone à l'autre (barre de commandes, liste de
 * lecture, panneau des pistes), comme dans les applications de bureau.
 */
function focusZone(direction: 1 | -1) {
  wake();
  const zones = ["controls", "playlist", "tracks"]
    .map((id) => $(id))
    .filter((zone) => !zone.hidden && getComputedStyle(zone).display !== "none");
  if (!stage.classList.contains("has-media")) zones.unshift($("empty"));
  if (!zones.length) return;
  const current = zones.findIndex((z) => z.contains(document.activeElement));
  const next = zones[(current + direction + zones.length) % zones.length];
  const target =
    next.querySelector<HTMLElement>("li.current") ??
    next.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled]), input:not([disabled]), li[tabindex]");
  target?.focus();
  const names: Record<string, string> = {
    controls: "Commandes",
    playlist: "Liste de lecture",
    tracks: "Pistes et son",
    empty: "Accueil",
  };
  osd(names[next.id] ?? "");
}

// ---------- Barre de menus ----------

let menuTimer: number | undefined;
/** Reflète l'état de l'interface dans la barre de menus (cases, pistes…). */
function pushMenuState() {
  clearTimeout(menuTimer);
  menuTimer = window.setTimeout(() => {
    api.updateMenuState({
      hasMedia: Boolean(media),
      playing: !video.paused,
      muted: video.muted,
      speed: video.playbackRate,
      audioTracks: [...audioSelect.options].map((o) => ({ index: Number(o.value), label: o.text })),
      audioIndex: options.audioIndex,
      subtitles: [...subtitleSelect.options].filter((o) => o.value).map((o) => ({ id: o.value, label: o.text })),
      subtitleId: subtitleSelect.value,
      presets: Object.entries(EQ_PRESETS).map(([id, p]) => ({ id, label: p.label })),
      preset: eqSelect.value,
      normalize: normalizeBox.checked,
      playlistVisible: !$("playlist").hidden,
      tracksVisible: !$("tracks").hidden,
      fullscreen,
      alwaysOnTop: false,
    });
  }, 80);
}

function choose(select: HTMLSelectElement | HTMLInputElement, value: string | boolean) {
  if (select instanceof HTMLInputElement) select.checked = Boolean(value);
  else select.value = String(value);
  select.dispatchEvent(new Event("change"));
}

api.onMenuCommand(async (command) => {
  wake();
  switch (command.type) {
    case "open-files": return openFiles();
    case "open-folder": return enqueue(await api.openFolderDialog(), true);
    case "play-pause": return togglePlay();
    case "previous": return playIndex(currentIndex - 1);
    case "next": return playIndex(currentIndex + 1);
    case "frame": return frameStep();
    case "snapshot": return snapshot();
    case "mute":
      video.muted = !video.muted;
      return osd(video.muted ? "Son coupé" : "Son rétabli");
    case "seek": return seekTo(position() + command.value);
    case "speed": return setSpeed(command.value);
    case "volume": return setVolume(volumeLevel + command.value);
    case "audio-track": return choose(audioSelect, String(command.value));
    case "audio-delay": return changeAudioDelay(command.value);
    case "sub-delay": return changeSubtitleDelay(command.value);
    case "subtitle": return choose(subtitleSelect, command.value);
    case "eq": return choose(eqSelect, command.value);
    case "normalize": return choose(normalizeBox, command.value);
    case "toggle-playlist": return setPanel("playlist");
    case "toggle-tracks": return setPanel("tracks");
    case "focus-next": return focusZone(1);
    case "focus-previous": return focusZone(-1);
    case "help": return $<HTMLDialogElement>("help").showModal();
  }
});

api.onFullscreenChange((on) => {
  fullscreen = on;
  document.body.classList.toggle("fullscreen", on);
  $("fullscreen").setAttribute("aria-pressed", String(on));
  if (on) osd("Plein écran — Échap pour quitter");
  pushMenuState();
});

for (const event of ["play", "pause", "volumechange", "ratechange", "loadedmetadata"]) {
  video.addEventListener(event, pushMenuState);
}
for (const control of [audioSelect, subtitleSelect, eqSelect, normalizeBox]) {
  control.addEventListener("change", pushMenuState);
}

window.addEventListener("beforeunload", saveResume);
api.onOpenPaths((paths) => enqueue(paths, true));
wake();
pushMenuState();
