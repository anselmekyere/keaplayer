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

/**
 * Environnement des processus FFmpeg/ffprobe. Les binaires statiques Linux
 * fournis par npm plantent (segfault) dès qu'ils ouvrent un MPEG-TS : le
 * démultiplexeur appelle iconv, qui charge les modules gconv de la glibc du
 * système, incompatibles avec la glibc embarquée. Sans ces modules, iconv
 * échoue proprement et le fichier se lit normalement.
 */
export function binaryEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "linux") return env;
  return { ...env, GCONV_PATH: "/nonexistent-keaplayer-gconv" };
}

export type StreamJob = {
  /** Copier la vidéo telle quelle (remux) ou la réencoder en H.264. */
  video: "copy" | "h264" | "none";
  /** Copier l'audio ou le réencoder en AAC. */
  audio: "copy" | "aac" | "none";
  /** Images par seconde de la source : fixe l'intervalle entre images clés du réencodage. */
  fps?: number;
  /** Étiquette du flux vidéo recopié (« hvc1 » pour le HEVC). */
  videoTag?: string;
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

  if (job.video === "copy") args.push("-c:v", "copy", ...(job.videoTag ? ["-tag:v", job.videoTag] : []));
  if (job.video === "h264") {
    // Le MP4 fragmenté n'émet un fragment qu'à chaque image clé : avec le
    // réglage par défaut de x264 (250 images, 10 s), la première image et
    // chaque recherche attendaient ~5 s. Une image clé par seconde et
    // « zerolatency » (sans anticipation) ramènent ce délai à ~1,5 s.
    const gop = Math.max(1, Math.round(job.fps && job.fps > 0 ? job.fps : 25));
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "20",
      "-g", String(gop), "-keyint_min", String(gop), "-pix_fmt", "yuv420p",
    );
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
