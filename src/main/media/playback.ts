import path from "node:path";
import { ModuleRegistry, type Module } from "../core/modules";
import type { MediaInfo, PlaybackMode, PlaybackOptions } from "../../shared/types";
import type { StreamJob } from "./ffmpeg";

export type PlaybackInput = { info: MediaInfo; options: PlaybackOptions };
export type PlaybackDecision = { mode: PlaybackMode; job?: StreamJob };

/** Codecs que Chromium sait décoder seul. */
const NATIVE_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const NATIVE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le"]);
/** Codecs qu'on peut recopier tels quels dans un MP4 fragmenté. */
const COPY_VIDEO = new Set(["h264", "vp9", "av1"]);
const COPY_AUDIO = new Set(["aac", "mp3", "opus", "flac"]);

function nativeContainer(info: MediaInfo): boolean {
  const ext = path.extname(info.path).toLowerCase();
  const f = info.formatName;
  if (f.includes("mp4") && [".mp4", ".m4v", ".m4a", ".mov"].includes(ext)) return true;
  if (f.includes("webm") && ext === ".webm") return true;
  return ["ogg", "mp3", "wav", "flac"].some((n) => f.split(",").includes(n));
}

/** Choix de piste ou décalage audio : seule la voie FFmpeg sait les appliquer. */
function needsFfmpeg(input: PlaybackInput): boolean {
  const { info, options } = input;
  const defaultAudio = Math.max(0, info.audio.findIndex((a) => a.isDefault));
  return options.audioDelay !== 0 || (info.audio.length > 1 && options.audioIndex !== defaultAudio);
}

/** Score 100 : Chromium lit le fichier directement, avec recherche instantanée. */
export const nativeModule: Module<PlaybackInput, PlaybackDecision> = {
  name: "native",
  capability: "playback",
  score: 100,
  probe(input) {
    const { info } = input;
    if (needsFfmpeg(input) || !nativeContainer(info)) return null;
    if (info.video && !NATIVE_VIDEO.has(info.video.codec)) return null;
    if (info.audio.some((a) => !NATIVE_AUDIO.has(a.codec))) return null;
    if (!info.video && info.audio.length === 0) return null;
    return { mode: "native" };
  },
};

/** Score 50 : FFmpeg change seulement le conteneur (MKV → MP4), sans réencoder l'image. */
export const remuxModule: Module<PlaybackInput, PlaybackDecision> = {
  name: "remux",
  capability: "playback",
  score: 50,
  probe({ info, options }) {
    if (info.video && !COPY_VIDEO.has(info.video.codec)) return null;
    const audio = info.audio[options.audioIndex];
    if (!info.video && !audio) return null;
    return {
      mode: "remux",
      job: {
        video: info.video ? "copy" : "none",
        // Un son non recopiable est réencodé : c'est peu coûteux, l'image reste copiée.
        audio: !audio ? "none" : COPY_AUDIO.has(audio.codec) ? "copy" : "aac",
      },
    };
  },
};

/** Score 10 : dernier recours, FFmpeg réencode tout (AVI, WMV, HEVC…). */
export const transcodeModule: Module<PlaybackInput, PlaybackDecision> = {
  name: "transcode",
  capability: "playback",
  score: 10,
  probe({ info, options }) {
    const audio = info.audio[options.audioIndex];
    if (!info.video && !audio) return null;
    return {
      mode: "transcode",
      job: { video: info.video ? "h264" : "none", audio: audio ? "aac" : "none" },
    };
  },
};

export function createPlaybackRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(nativeModule);
  registry.register(remuxModule);
  registry.register(transcodeModule);
  return registry;
}
