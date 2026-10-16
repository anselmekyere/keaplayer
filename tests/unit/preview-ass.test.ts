import { describe, expect, it } from "vitest";
import { attachmentArgs, subtitleArgs, thumbnailArgs } from "../../src/main/media/ffmpeg";
import { parseProbe } from "../../src/main/media/probe";
import { isAssCodec, isAssFile } from "../../src/main/media/server";

describe("aperçu au survol", () => {
  it("extrait une image clé réduite en JPEG, sans recherche précise", () => {
    const args = thumbnailArgs("/v/a.mkv", 61.234, 192).join(" ");
    expect(args).toContain("-ss 61.23 -noaccurate_seek -i /v/a.mkv");
    expect(args).not.toContain("-skip_frame");
    expect(args).toContain("-map 0:v:0 -frames:v 1 -vf scale=192:-2");
    expect(args).toMatch(/-f image2 -c:v mjpeg pipe:1$/);
  });
  it("désentrelace les sources entrelacées et borne le temps à 0", () => {
    const args = thumbnailArgs("/v/a.ts", -3, 160, true).join(" ");
    expect(args).toContain("-ss 0.00");
    expect(args).toContain("-vf yadif,scale=160:-2");
  });
});

describe("sous-titres ASS", () => {
  it("reconnaît les fichiers et codecs ASS/SSA", () => {
    expect(isAssFile("/v/film.fr.ASS")).toBe(true);
    expect(isAssFile("/v/film.ssa")).toBe(true);
    expect(isAssFile("/v/film.srt")).toBe(false);
    expect(isAssCodec("ass")).toBe(true);
    expect(isAssCodec("ssa")).toBe(true);
    expect(isAssCodec("subrip")).toBe(false);
  });
  it("copie la piste ASS intégrée telle quelle, styles compris", () => {
    expect(subtitleArgs("/v/a.mkv", 1, "ass").join(" ")).toMatch(/-map 0:s:1 -c:s copy -f ass pipe:1$/);
    expect(subtitleArgs("/v/a.mkv", 1).join(" ")).toContain("-f webvtt");
  });
  it("extrait une police jointe par son index de flux", () => {
    expect(attachmentArgs("/v/a.mkv", 4, "/tmp/f.ttf")).toEqual(
      expect.arrayContaining(["-dump_attachment:4", "/tmp/f.ttf", "-i", "/v/a.mkv"]),
    );
  });
  it("liste les polices jointes au MKV, pas les autres pièces jointes", () => {
    const info = parseProbe("/v/a.mkv", {
      format: { format_name: "matroska,webm", duration: "10" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "25/1" },
        { codec_type: "subtitle", codec_name: "ass" },
        { codec_type: "attachment", codec_name: "ttf", tags: { filename: "Police.ttf", mimetype: "application/x-truetype-font" } },
        { codec_type: "attachment", tags: { filename: "cover.jpg", mimetype: "image/jpeg" } },
        { codec_type: "attachment", tags: { filename: "Titre.OTF" } },
      ],
    });
    expect(info.fonts).toEqual([
      { index: 2, filename: "Police.ttf" },
      { index: 4, filename: "Titre.OTF" },
    ]);
  });
});
