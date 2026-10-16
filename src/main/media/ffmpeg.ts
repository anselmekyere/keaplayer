import path from "node:path";
import type { PlaybackOptions } from "../../shared/types";
import { encoderArgs, type EncoderName } from "./encoders";

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
 * Arguments FFmpeg pour une miniature JPEG à la position `time` : recherche
 * rapide sur l'image clé précédente (aperçu, pas image exacte), une seule
 * image décodée, désentrelacée si besoin.
 */
export function thumbnailArgs(file: string, time: number, width: number, deinterlace = false): string[] {
  const filters = [...(deinterlace ? ["yadif"] : []), `scale=${width}:-2`].join(",");
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", Math.max(0, time).toFixed(2), "-noaccurate_seek", "-i", file,
    "-map", "0:v:0", "-frames:v", "1", "-vf", filters, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
  ];
}

/** Arguments FFmpeg pour extraire une pièce jointe (police) vers `out`. */
export function attachmentArgs(file: string, streamIndex: number, out: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", `-dump_attachment:${streamIndex}`, out, "-i", file];
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
  /** Encodeur H.264 du réencodage (matériel si la machine en a un qui fonctionne). */
  encoder?: EncoderName;
  /** Source entrelacée (TNT, DVD, caméscope) : désentrelacer avant de réencoder. */
  deinterlace?: boolean;
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
  const encoder = job.encoder ?? "libx264";
  // Avec un encodeur matériel, le décodage passe aussi par la carte graphique
  // quand elle le permet (FFmpeg revient seul au logiciel sinon).
  const hwDecode = job.video === "h264" && encoder !== "libx264" ? ["-hwaccel", "auto"] : [];
  args.push(...hwDecode, ...seek, "-i", file);
  if (delayed) args.push("-itsoffset", options.audioDelay.toFixed(3), ...seek, "-i", file);

  if (job.video !== "none") args.push("-map", "0:v:0");
  if (job.audio !== "none") args.push("-map", `${delayed ? 1 : 0}:a:${options.audioIndex}`);

  if (job.video === "copy") args.push("-c:v", "copy", ...(job.videoTag ? ["-tag:v", job.videoTag] : []));
  if (job.video === "h264") {
    // Le MP4 fragmenté n'émet un fragment qu'à chaque image clé : une par
    // seconde de source (au lieu de 10 s par défaut) ramène la première image
    // et chaque recherche de ~5 s à ~1,5 s.
    const gop = Math.max(1, Math.round(job.fps && job.fps > 0 ? job.fps : 25));
    // yadif : désentrelacement de VLC et FFmpeg, une image par image source.
    if (job.deinterlace) args.push("-vf", "yadif=mode=send_frame:parity=auto:deint=interlaced");
    args.push(...encoderArgs(encoder, gop));
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

/**
 * Arguments FFmpeg pour extraire une piste de sous-titres texte : en ASS brut
 * (styles conservés, rendu par libass) ou convertie en WebVTT.
 */
export function subtitleArgs(file: string, subtitleIndex: number, format: "vtt" | "ass" = "vtt"): string[] {
  if (format === "ass") {
    return ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-map", `0:s:${subtitleIndex}`, "-c:s", "copy", "-f", "ass", "pipe:1"];
  }
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
