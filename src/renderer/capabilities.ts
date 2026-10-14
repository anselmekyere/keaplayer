import type { Capabilities } from "../shared/types.js";

/** Codec (nom FFmpeg) → type MIME interrogé auprès de Chromium. */
const VIDEO: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp09.00.40.08"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
};
const AUDIO: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: "audio/mpeg",
  opus: 'audio/webm; codecs="opus"',
  vorbis: 'audio/ogg; codecs="vorbis"',
  flac: "audio/flac",
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  pcm_s16le: 'audio/wav; codecs="1"',
};

async function supported(kind: "video" | "audio", contentType: string): Promise<boolean> {
  try {
    // MediaCapabilities tient compte du décodage matériel (HEVC sous Windows, par exemple).
    const config: MediaDecodingConfiguration =
      kind === "video"
        ? { type: "file", video: { contentType, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 } }
        : { type: "file", audio: { contentType, channels: "2", bitrate: 192_000, samplerate: 48_000 } };
    return (await navigator.mediaCapabilities.decodingInfo(config)).supported;
  } catch {
    return document.createElement("video").canPlayType(contentType) === "probably";
  }
}

/** Liste des codecs que cette machine sait lire nativement. */
export async function detectCapabilities(): Promise<Capabilities> {
  const check = async (kind: "video" | "audio", table: Record<string, string>) => {
    const results = await Promise.all(
      Object.entries(table).map(async ([codec, type]) => ((await supported(kind, type)) ? codec : null)),
    );
    return results.filter((c): c is string => c !== null);
  };
  const [video, audio] = await Promise.all([check("video", VIDEO), check("audio", AUDIO)]);
  return { video, audio };
}
