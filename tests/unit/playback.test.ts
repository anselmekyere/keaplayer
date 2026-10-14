import { describe, expect, it } from "vitest";
import { createPlaybackRegistry } from "../../src/main/media/playback";
import type { MediaInfo, PlaybackOptions } from "../../src/shared/types";

const opts = (o: Partial<PlaybackOptions> = {}): PlaybackOptions => ({ start: 0, audioIndex: 0, audioDelay: 0, ...o });
const audio = (codec: string, index = 0, isDefault = index === 0) => ({ index, codec, isDefault });
function media(path: string, formatName: string, video: string | null, audios: string[]): MediaInfo {
  return {
    path,
    formatName,
    duration: 60,
    video: video ? { index: 0, codec: video, isDefault: true, width: 1280, height: 720, fps: 25 } : undefined,
    audio: audios.map((c, i) => audio(c, i)),
    subtitles: [],
  };
}

async function choose(info: MediaInfo, o?: Partial<PlaybackOptions>) {
  return (await createPlaybackRegistry().load("playback", { info, options: opts(o) }))!;
}

describe("choix du moteur de lecture", () => {
  it("lit en natif un MP4 H.264/AAC", async () => {
    expect((await choose(media("/v/a.mp4", "mov,mp4,m4a,3gp,3g2,mj2", "h264", ["aac"]))).module).toBe("native");
  });

  it("lit en natif un MP3 seul", async () => {
    expect((await choose(media("/m/a.mp3", "mp3", null, ["mp3"]))).module).toBe("native");
  });

  it("remuxe un MKV H.264/AAC sans réencoder", async () => {
    const r = await choose(media("/v/a.mkv", "matroska,webm", "h264", ["aac"]));
    expect(r).toEqual({ module: "remux", output: { mode: "remux", job: { video: "copy", audio: "copy" } } });
  });

  it("garde l'image et réencode seulement un son AC-3", async () => {
    const r = await choose(media("/v/a.mkv", "matroska,webm", "h264", ["ac3"]));
    expect(r.output).toEqual({ mode: "remux", job: { video: "copy", audio: "aac" } });
  });

  it("transcode un AVI MPEG-4 Part 2 / MP3", async () => {
    const r = await choose(media("/v/a.avi", "avi", "mpeg4", ["mp3"]));
    expect(r.output).toEqual({ mode: "transcode", job: { video: "h264", audio: "aac" } });
  });

  it("passe par FFmpeg pour une autre piste audio ou un décalage audio", async () => {
    const mp4 = media("/v/a.mp4", "mov,mp4,m4a,3gp,3g2,mj2", "h264", ["aac", "aac"]);
    expect((await choose(mp4, { audioIndex: 1 })).module).toBe("remux");
    expect((await choose(mp4, { audioDelay: 0.2 })).module).toBe("remux");
    expect((await choose(mp4, { audioIndex: 0 })).module).toBe("native");
  });

  it("ne lit pas en natif un .mkv même avec des codecs compatibles WebM", async () => {
    expect((await choose(media("/v/a.mkv", "matroska,webm", "vp9", ["opus"]))).module).toBe("remux");
    expect((await choose(media("/v/a.webm", "matroska,webm", "vp9", ["opus"]))).module).toBe("native");
  });

  it("refuse un fichier sans image ni son", async () => {
    expect(await createPlaybackRegistry().load("playback", { info: media("/x.mkv", "matroska", null, []), options: opts() })).toBeNull();
  });
});

describe("choix selon les capacités détectées", () => {
  const withHevc = { video: ["h264", "hevc", "vp9", "av1"], audio: ["aac", "mp3", "opus", "flac", "ac3", "eac3"] };
  const pick = async (info: MediaInfo, capabilities?: typeof withHevc) =>
    (await createPlaybackRegistry().load("playback", { info, options: opts(), capabilities }))!;

  it("lit un MP4 HEVC en natif quand le matériel le décode, sinon le transcode", async () => {
    const hevc = media("/v/a.mp4", "mov,mp4,m4a,3gp,3g2,mj2", "hevc", ["aac"]);
    expect((await pick(hevc, withHevc)).module).toBe("native");
    expect((await pick(hevc)).module).toBe("transcode");
  });

  it("remuxe un MKV HEVC en l'étiquetant hvc1 et garde l'AC-3 quand il est décodable", async () => {
    const r = await pick(media("/v/a.mkv", "matroska,webm", "hevc", ["ac3"]), withHevc);
    expect(r.output).toEqual({ mode: "remux", job: { video: "copy", audio: "copy", videoTag: "hvc1" } });
  });
});
