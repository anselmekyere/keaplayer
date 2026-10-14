import { describe, expect, it } from "vitest";
import { parseSubtitles, shiftCues, toWebVtt } from "../../src/shared/subtitles";
import { decodeSubtitleFile } from "../../src/main/media/server";

const SRT = "﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nBonjour\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nDeux\r\nlignes\r\n\r\n3\r\ncassé --> rien\r\nIgnoré\r\n";

describe("sous-titres", () => {
  it("lit le SRT (BOM, fins de ligne Windows, répliques multilignes)", () => {
    expect(parseSubtitles(SRT)).toEqual([
      { start: 1.5, end: 3, text: "Bonjour" },
      { start: 62.25, end: 64, text: "Deux\nlignes" },
    ]);
  });

  it("lit le WebVTT, avec ou sans heures", () => {
    const vtt = "WEBVTT\n\n00:05.000 --> 00:06.500\nCourt\n\n01:00:00.000 --> 01:00:01.000 align:start\nLong";
    expect(parseSubtitles(vtt)).toEqual([
      { start: 5, end: 6.5, text: "Court" },
      { start: 3600, end: 3601, text: "Long" },
    ]);
  });

  it("convertit en WebVTT relisible", () => {
    const vtt = toWebVtt(SRT);
    expect(vtt.startsWith("WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nBonjour")).toBe(true);
    expect(parseSubtitles(vtt)).toEqual(parseSubtitles(SRT));
  });

  it("recale les répliques sur le flux et applique le décalage utilisateur", () => {
    const cues = parseSubtitles(SRT);
    expect(shiftCues(cues, 0, 0.5)[0]).toEqual({ start: 2, end: 3.5, text: "Bonjour" });
    // Flux FFmpeg démarré à 60 s : la première réplique est passée, la seconde arrive à 2,25 s.
    expect(shiftCues(cues, 60, 0)).toEqual([{ start: 2.25, end: 4, text: "Deux\nlignes" }]);
  });

  it("décode un .srt en Windows-1252 comme en UTF-8", () => {
    expect(decodeSubtitleFile(new Uint8Array([0x45, 0x74, 0xe9]))).toBe("Eté");
    expect(decodeSubtitleFile(new TextEncoder().encode("Été"))).toBe("Été");
  });
});
