import { describe, expect, it } from "vitest";
import { EncoderSelector, createEncoderRegistry, encoderArgs, type EncoderName, type EncoderProbe } from "../../src/main/media/encoders";
import { streamArgs } from "../../src/main/media/ffmpeg";
import { parseProbe } from "../../src/main/media/probe";
import { createPlaybackRegistry } from "../../src/main/media/playback";
import { EQ_FREQUENCIES, EQ_PRESETS, preampFor, splitVolume } from "../../src/renderer/audio";

function fakeProbe(available: string[], working: string[]): EncoderProbe & { load(): Promise<void>; tried: string[] } {
  const tried: string[] = [];
  return {
    available: new Set(available),
    tried,
    load: async () => undefined,
    tryEncode: async (name: EncoderName) => {
      tried.push(name);
      return working.includes(name);
    },
  };
}

describe("choix de l'encodeur de transcodage (comme les décodeurs de VLC)", () => {
  const platform = process.platform;
  const hw = platform === "win32" ? ["h264_nvenc", "h264_qsv", "h264_amf"] : platform === "darwin" ? ["h264_videotoolbox"] : ["h264_nvenc", "h264_qsv"];

  it("prend le premier encodeur matériel qui réussit l'essai, par score", async () => {
    const probe = fakeProbe(hw, hw.slice(1));
    const r = await createEncoderRegistry().load<EncoderProbe, EncoderName>("h264 encoder", probe);
    expect(r?.output).toBe(hw.length > 1 ? hw[1] : "libx264");
    if (hw.length > 1) expect(probe.tried).toEqual(hw.slice(0, 2));
  });

  it("revient à x264 sans matériel, ou quand l'essai échoue", async () => {
    expect((await createEncoderRegistry().load("h264 encoder", fakeProbe([], [])))?.output).toBe("libx264");
    expect((await createEncoderRegistry().load("h264 encoder", fakeProbe(hw, [])))?.output).toBe("libx264");
  });

  it("garde x264 tant que la détection n'est pas finie, puis sur échec en lecture", async () => {
    const selector = new EncoderSelector(() => fakeProbe(hw, hw));
    expect(selector.name).toBe("libx264");
    const name = await selector.detect();
    expect(name).toBe(hw[0]);
    expect(selector.name).toBe(hw[0]);
    selector.fallBack();
    expect(selector.name).toBe("libx264");
  });

  it("règle chaque encodeur sur une image clé par seconde, sans images B", () => {
    for (const name of ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"] as EncoderName[]) {
      const args = encoderArgs(name, 30).join(" ");
      expect(args).toContain(`-c:v ${name}`);
      expect(args).toContain("-g 30 -keyint_min 30 -bf 0");
    }
  });
});

describe("transcodage : matériel et désentrelacement", () => {
  const opts = { start: 5, audioIndex: 0, audioDelay: 0 };
  it("décode aussi par la carte graphique avec un encodeur matériel", () => {
    const args = streamArgs("/v/a.ts", { video: "h264", audio: "aac", encoder: "h264_nvenc" }, opts).join(" ");
    expect(args).toContain("-hwaccel auto -ss 5.000 -i /v/a.ts");
    expect(args).toContain("-c:v h264_nvenc");
  });
  it("reste en logiciel avec x264", () => {
    expect(streamArgs("/v/a.ts", { video: "h264", audio: "aac" }, opts).join(" ")).not.toContain("-hwaccel");
  });
  it("désentrelace avec yadif avant d'encoder", () => {
    const args = streamArgs("/v/a.ts", { video: "h264", audio: "aac", deinterlace: true }, opts).join(" ");
    expect(args).toMatch(/-vf yadif=mode=send_frame:parity=auto:deint=interlaced -c:v libx264/);
  });
  it("repère une source entrelacée et la fait transcoder", async () => {
    const info = parseProbe("/v/a.ts", {
      format: { format_name: "mpegts", duration: "10" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "25/1", field_order: "tt" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    });
    expect(info.video?.interlaced).toBe(true);
    const r = await createPlaybackRegistry().load("playback", { info, options: { start: 0, audioIndex: 0, audioDelay: 0 } });
    expect(r).toEqual({ module: "transcode", output: { mode: "transcode", job: { video: "h264", audio: "aac", deinterlace: true } } });
  });
});

describe("chaîne audio", () => {
  it("reprend les 10 bandes et 18 préréglages de VLC", () => {
    expect(EQ_FREQUENCIES).toEqual([60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
    expect(Object.keys(EQ_PRESETS)).toHaveLength(18);
    for (const p of Object.values(EQ_PRESETS)) expect(p.gains).toHaveLength(10);
  });
  it("pré-atténue de la moitié du plus fort relèvement", () => {
    expect(preampFor(EQ_PRESETS.flat.gains)).toBe(-0);
    expect(preampFor(EQ_PRESETS.rock.gains)).toBeCloseTo(-5.6);
    expect(preampFor([-3, -6])).toBe(-0);
  });
  it("répartit le volume entre l'élément (≤ 100 %) et l'amplification (≤ 200 %)", () => {
    expect(splitVolume(0.5)).toEqual({ element: 0.5, boost: 1 });
    expect(splitVolume(1.5)).toEqual({ element: 1, boost: 1.5 });
    expect(splitVolume(9)).toEqual({ element: 1, boost: 2 });
    expect(splitVolume(-1)).toEqual({ element: 0, boost: 1 });
  });
});
