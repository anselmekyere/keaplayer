import { execFile } from "node:child_process";
import type { MediaInfo, StreamInfo, SubtitleStreamInfo } from "../../shared/types";
import { binaryEnv, ffprobePath } from "./ffmpeg";

type RawStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  disposition?: { default?: number; attached_pic?: number };
  tags?: { language?: string; title?: string };
};

type RawProbe = {
  format?: { format_name?: string; duration?: string };
  streams?: RawStream[];
};

const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);

function rate(value?: string): number {
  if (!value) return 0;
  const [n, d] = value.split("/").map(Number);
  return d ? n / d : n || 0;
}

/** Convertit la sortie JSON de ffprobe en description exploitable par le lecteur. */
export function parseProbe(path: string, raw: RawProbe): MediaInfo {
  const streams = raw.streams ?? [];
  const counters = { audio: 0, subtitle: 0 };
  const base = (s: RawStream, index: number): StreamInfo => ({
    index,
    codec: s.codec_name ?? "inconnu",
    language: s.tags?.language,
    title: s.tags?.title,
    isDefault: s.disposition?.default === 1,
  });

  // Une pochette d'album est un flux "vidéo" qu'il faut ignorer.
  const v = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const info: MediaInfo = {
    path,
    formatName: raw.format?.format_name ?? "",
    duration: Number(raw.format?.duration ?? 0) || 0,
    audio: [],
    subtitles: [],
  };
  if (v) {
    info.video = {
      ...base(v, 0),
      width: v.width ?? 0,
      height: v.height ?? 0,
      fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 25,
    };
  }
  for (const s of streams) {
    if (s.codec_type === "audio") info.audio.push(base(s, counters.audio++));
    if (s.codec_type === "subtitle") {
      const sub: SubtitleStreamInfo = {
        ...base(s, counters.subtitle++),
        isText: TEXT_SUBTITLE_CODECS.has(s.codec_name ?? ""),
      };
      info.subtitles.push(sub);
    }
  }
  return info;
}

export function probe(path: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { maxBuffer: 16 * 1024 * 1024, env: binaryEnv() },
      (err, stdout) => {
        if (err) return reject(new Error(`Fichier illisible : ${path}`));
        try {
          resolve(parseProbe(path, JSON.parse(stdout) as RawProbe));
        } catch {
          reject(new Error(`Analyse impossible : ${path}`));
        }
      },
    );
  });
}
