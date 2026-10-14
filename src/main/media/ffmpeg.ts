import path from "node:path";
import type { PlaybackOptions } from "../../shared/types";

/**
 * Chemins des binaires. KEAPLAYER_FFMPEG / KEAPLAYER_FFPROBE permettent
 * d'utiliser ceux du système (tests, distributions Linux). Dans l'application
 * empaquetée, les binaires npm sont extraits de l'archive asar.
 */
function unpacked(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export function ffmpegPath(): string {
  if (process.env.KEAPLAYER_FFMPEG) return process.env.KEAPLAYER_FFMPEG;
  const p = require("ffmpeg-static") as string | null;
  if (!p) throw new Error("FFmpeg introuvable pour cette plateforme.");
  return unpacked(p);
}

export function ffprobePath(): string {
  if (process.env.KEAPLAYER_FFPROBE) return process.env.KEAPLAYER_FFPROBE;
  return unpacked((require("@ffprobe-installer/ffprobe") as { path: string }).path);
}

export type StreamJob = {
  /** Copier la vidéo telle quelle (remux) ou la réencoder en H.264. */
  video: "copy" | "h264" | "none";
  /** Copier l'audio ou le réencoder en AAC. */
  audio: "copy" | "aac" | "none";
};

/**
 * Arguments FFmpeg pour produire, à partir de `options.start`, un MP4
 * fragmenté lisible en flux par Chromium. Le décalage audio passe par
 * `-itsoffset` sur une seconde lecture du même fichier, réservée au son.
 */
export function streamArgs(file: string, job: StreamJob, options: PlaybackOptions): string[] {
  const start = Math.max(0, options.start);
  const seek = start > 0 ? ["-ss", start.toFixed(3)] : [];
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];

  const delayed = job.audio !== "none" && options.audioDelay !== 0;
  args.push(...seek, "-i", file);
  if (delayed) args.push("-itsoffset", options.audioDelay.toFixed(3), ...seek, "-i", file);

  if (job.video !== "none") args.push("-map", "0:v:0");
  if (job.audio !== "none") args.push("-map", `${delayed ? 1 : 0}:a:${options.audioIndex}`);

  if (job.video === "copy") args.push("-c:v", "copy");
  if (job.video === "h264") {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  }
  if (job.audio === "copy") args.push("-c:a", "copy");
  if (job.audio === "aac") args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");

  args.push(
    "-sn",
    "-dn",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  );
  return args;
}

/** Arguments FFmpeg pour extraire une piste de sous-titres texte en WebVTT. */
export function subtitleArgs(file: string, subtitleIndex: number): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    file,
    "-map",
    `0:s:${subtitleIndex}`,
    "-f",
    "webvtt",
    "pipe:1",
  ];
}
