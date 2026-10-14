import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRange } from "../../src/main/media/range";
import { streamArgs, subtitleArgs } from "../../src/main/media/ffmpeg";
import { parseProbe } from "../../src/main/media/probe";
import { expandPaths, findExternalSubtitles } from "../../src/main/media/library";
import { ResumeStore } from "../../src/main/store";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("parseRange", () => {
  it("gère les plages complètes, ouvertes et suffixes", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  });
  it("refuse les plages hors fichier ou mal formées", () => {
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=9-3", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});

describe("arguments FFmpeg", () => {
  it("remuxe à partir d'une position, piste audio choisie", () => {
    const args = streamArgs("/v/a.mkv", { video: "copy", audio: "copy" }, { start: 12.5, audioIndex: 1, audioDelay: 0 });
    expect(args.join(" ")).toContain("-ss 12.500 -i /v/a.mkv -map 0:v:0 -map 0:a:1 -c:v copy -c:a copy");
    expect(args.slice(-3)).toEqual(["-f", "mp4", "pipe:1"]);
  });
  it("applique un décalage audio via une seconde entrée", () => {
    const args = streamArgs("/v/a.mkv", { video: "h264", audio: "aac" }, { start: 0, audioIndex: 0, audioDelay: -0.25 });
    expect(args.join(" ")).toContain("-i /v/a.mkv -itsoffset -0.250 -i /v/a.mkv -map 0:v:0 -map 1:a:0 -c:v libx264");
  });
  it("extrait une piste de sous-titres en WebVTT", () => {
    expect(subtitleArgs("/v/a.mkv", 2)).toContain("0:s:2");
  });
});

describe("parseProbe", () => {
  it("ignore les pochettes et classe les pistes", () => {
    const info = parseProbe("/m/a.mkv", {
      format: { format_name: "matroska,webm", duration: "61.5" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "24000/1001", disposition: { default: 1 } },
        { codec_type: "audio", codec_name: "aac", tags: { language: "fre" }, disposition: { default: 1 } },
        { codec_type: "audio", codec_name: "ac3", tags: { language: "eng", title: "VO" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "fre" } },
        { codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" },
        { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
      ],
    });
    expect(info.duration).toBe(61.5);
    expect(info.video).toMatchObject({ codec: "h264", width: 1920, height: 1080 });
    expect(info.video!.fps).toBeCloseTo(23.976, 3);
    expect(info.audio.map((a) => [a.index, a.codec, a.language, a.isDefault])).toEqual([
      [0, "aac", "fre", true],
      [1, "ac3", "eng", false],
    ]);
    expect(info.subtitles.map((s) => [s.index, s.isText])).toEqual([[0, true], [1, false]]);
  });
});

describe("bibliothèque", () => {
  it("développe un dossier en ordre naturel et trouve les sous-titres voisins", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kp-"));
    for (const f of ["Episode 10.mkv", "Episode 2.mkv", "notes.txt", "Episode 2.srt", "Episode 2.fr.srt", "Episode 20.srt"]) {
      await writeFile(path.join(dir, f), "");
    }
    await mkdir(path.join(dir, "sous-dossier"));
    expect((await expandPaths([dir, path.join(dir, "absent.mp4")])).map((p) => path.basename(p))).toEqual([
      "Episode 2.mkv",
      "Episode 10.mkv",
    ]);
    const subs = await findExternalSubtitles(path.join(dir, "Episode 2.mkv"));
    expect(subs.map((s) => [path.basename(s.file), s.language])).toEqual([
      ["Episode 2.fr.srt", "fr"],
      ["Episode 2.srt", undefined],
    ]);
  });
});

describe("ResumeStore", () => {
  it("retient une position, oublie le début et la fin, et persiste sur disque", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kp-"));
    const file = path.join(dir, "resume.json");
    const store = new ResumeStore(file);
    store.set("/a.mkv", 120, 3600);
    store.set("/b.mkv", 5, 3600);
    store.set("/c.mkv", 3500, 3600);
    expect(new ResumeStore(file).get("/a.mkv")).toBe(120);
    expect(store.get("/b.mkv")).toBeNull();
    expect(store.get("/c.mkv")).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8")).resume["/a.mkv"].time).toBe(120);
  });
  it("supporte un fichier d'état corrompu", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kp-"));
    await writeFile(path.join(dir, "resume.json"), "{pas du json");
    expect(new ResumeStore(path.join(dir, "resume.json")).get("/a")).toBeNull();
  });
});
