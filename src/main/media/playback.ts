import path from "node:path";
import { ModuleRegistry, type Module } from "../core/modules";
import type { Capabilities, MediaInfo, PlaybackMode, PlaybackOptions } from "../../shared/types";
import type { StreamJob } from "./ffmpeg";

export type PlaybackInput = { info: MediaInfo; options: PlaybackOptions; capabilities?: Capabilities };
export type PlaybackDecision = { mode: PlaybackMode; job?: StreamJob };

/** Codecs que Chromium décode partout ; la détection au démarrage peut en ajouter (HEVC…). */
export const DEFAULT_CAPABILITIES: Capabilities = {
  video: ["h264", "vp8", "vp9", "av1"],
  audio: ["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le"],
};
/** Codecs qu'on sait placer dans un MP4 fragmenté sans les réencoder. */
const MP4_VIDEO = new Set(["h264", "hevc", "vp9", "av1"]);
const MP4_AUDIO = new Set(["aac", "mp3", "opus", "flac", "ac3", "eac3"]);

const caps = (input: PlaybackInput) => input.capabilities ?? DEFAULT_CAPABILITIES;
const canCopyVideo = (input: PlaybackInput, codec: string) => MP4_VIDEO.has(codec) && caps(input).video.includes(codec);
const canCopyAudio = (input: PlaybackInput, codec: string) => MP4_AUDIO.has(codec) && caps(input).audio.includes(codec);

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
    if (info.video && !caps(input).video.includes(info.video.codec)) return null;
    if (info.audio.some((a) => !caps(input).audio.includes(a.codec))) return null;
    if (!info.video && info.audio.length === 0) return null;
    return { mode: "native" };
  },
};

/** Score 50 : FFmpeg change seulement le conteneur (MKV → MP4), sans réencoder l'image. */
export const remuxModule: Module<PlaybackInput, PlaybackDecision> = {
  name: "remux",
  capability: "playback",
  score: 50,
  probe(input) {
    const { info, options } = input;
    if (info.video && !canCopyVideo(input, info.video.codec)) return null;
    const audio = info.audio[options.audioIndex];
    if (!info.video && !audio) return null;
    return {
      mode: "remux",
      job: {
        video: info.video ? "copy" : "none",
        // Un son non recopiable est réencodé : c'est peu coûteux, l'image reste copiée.
        audio: !audio ? "none" : canCopyAudio(input, audio.codec) ? "copy" : "aac",
        // Chromium n'accepte le HEVC en MP4 que sous l'étiquette « hvc1 ».
        ...(info.video?.codec === "hevc" ? { videoTag: "hvc1" } : {}),
      },
    };
  },
};

/** Score 10 : dernier recours, FFmpeg réencode tout (AVI, WMV, HEVC sans décodeur…). */
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
