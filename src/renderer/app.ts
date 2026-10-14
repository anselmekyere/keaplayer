import type { KeaplayerApi, PlaybackOptions, PlaybackPlan, PreparedMedia } from "../shared/types.js";
import { parseSubtitles, shiftCues, type Cue } from "../shared/subtitles.js";

declare global {
  interface Window {
    keaplayer: KeaplayerApi;
  }
}

const api = window.keaplayer;
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
let lastResumeSave = 0;
let loadToken = 0;
let seeking = false;

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
    const prepared = await api.prepare(file);
    if (token !== loadToken) return;
    media = prepared;
    subtitleCues = [];
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
  applySubtitles();
  const source = media?.subtitles.find((s) => s.id === id);
  if (!source) return;
  try {
    const res = await fetch(source.url);
    subtitleCues = parseSubtitles(await res.text());
    applySubtitles();
    osd(`Sous-titres : ${source.label}`);
  } catch {
    osd("Sous-titres illisibles");
  }
}

function applySubtitles() {
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
      li.addEventListener("dblclick", () => playIndex(i));
      li.addEventListener("click", () => playIndex(i));
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
  if (files.length > 1) $("playlist").hidden = false;
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

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

function setVolume(v: number) {
  video.volume = Math.min(1, Math.max(0, v));
  video.muted = false;
  osd(`Volume : ${Math.round(video.volume * 100)} %`);
}

async function openFiles() {
  enqueue(await api.openFilesDialog(), true);
}

// ---------- Événements du lecteur ----------

video.addEventListener("play", () => stage.classList.add("playing"));
video.addEventListener("pause", () => {
  stage.classList.remove("playing");
  saveResume();
});
video.addEventListener("playing", () => (loadingEl.hidden = true));
video.addEventListener("canplay", () => (loadingEl.hidden = true));
video.addEventListener("waiting", () => (loadingEl.hidden = false));
video.addEventListener("volumechange", () => {
  stage.classList.toggle("muted", video.muted || video.volume === 0);
  volume.value = String(video.muted ? 0 : video.volume);
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
video.addEventListener("error", () => {
  loadingEl.hidden = true;
  if (video.src) osd("Erreur de lecture");
});
video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", toggleFullscreen);

// ---------- Commandes de l'interface ----------

seek.addEventListener("input", () => {
  seeking = true;
  timeEl.textContent = formatTime((Number(seek.value) / 1000) * duration());
});
seek.addEventListener("change", () => {
  seeking = false;
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
$("tracks-toggle").addEventListener("click", () => ($("tracks").hidden = !$("tracks").hidden));
$("playlist-toggle").addEventListener("click", () => ($("playlist").hidden = !$("playlist").hidden));
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
    case "ArrowUp": handled(); setVolume(video.volume + 0.05); break;
    case "ArrowDown": handled(); setVolume(video.volume - 0.05); break;
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
    case "l": case "L": $("playlist").hidden = !$("playlist").hidden; break;
    case "?": $<HTMLDialogElement>("help").showModal(); break;
  }
});

let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(applySubtitles, 150);
});
window.addEventListener("beforeunload", saveResume);
api.onOpenPaths((paths) => enqueue(paths, true));
wake();
