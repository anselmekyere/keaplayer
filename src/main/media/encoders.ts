import { execFile } from "node:child_process";
import { ModuleRegistry, type Module } from "../core/modules";
import { binaryEnv } from "./ffmpeg";

/**
 * Encodeurs H.264 pour le transcodage, choisis comme les décodeurs de VLC :
 * le matériel d'abord (score élevé), x264 en dernier recours. Chaque candidat
 * matériel n'est retenu qu'après un court encodage d'essai réussi : un
 * encodeur présent dans FFmpeg peut manquer de pilote ou de carte graphique.
 */
export type EncoderName = "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_videotoolbox" | "libx264";

export type EncoderProbe = {
  /** Encodeurs compilés dans le binaire FFmpeg (sortie de « ffmpeg -encoders »). */
  available: Set<string>;
  /** Essaie d'encoder quelques images ; vrai si FFmpeg réussit. */
  tryEncode(name: EncoderName): Promise<boolean>;
};

/** Arguments vidéo d'un encodeur, avec une image clé toutes les `gop` images. */
export function encoderArgs(name: EncoderName, gop: number): string[] {
  const g = ["-g", String(gop), "-keyint_min", String(gop), "-bf", "0"];
  switch (name) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p2", "-tune", "ll", "-rc", "vbr", "-cq", "23", "-b:v", "0", ...g, "-pix_fmt", "yuv420p"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-look_ahead", "0", ...g, "-pix_fmt", "nv12"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-usage", "lowlatency", "-quality", "speed", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", ...g, "-pix_fmt", "nv12"];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", "8M", ...g, "-pix_fmt", "yuv420p"];
    case "libx264":
      // Une image clé par seconde : le MP4 fragmenté n'émet rien avant la suivante.
      return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "20", "-g", String(gop), "-keyint_min", String(gop), "-pix_fmt", "yuv420p"];
  }
}

const hardware = (name: EncoderName, score: number, platforms: NodeJS.Platform[]): Module<EncoderProbe, EncoderName> => ({
  name,
  capability: "h264 encoder",
  score,
  async probe(env) {
    if (!platforms.includes(process.platform) || !env.available.has(name)) return null;
    return (await env.tryEncode(name)) ? name : null;
  },
});

export function createEncoderRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(hardware("h264_nvenc", 300, ["win32", "linux"]));
  registry.register(hardware("h264_qsv", 250, ["win32", "linux"]));
  registry.register(hardware("h264_amf", 200, ["win32"]));
  registry.register(hardware("h264_videotoolbox", 200, ["darwin"]));
  registry.register<EncoderProbe, EncoderName>({ name: "libx264", capability: "h264 encoder", score: 1, probe: () => "libx264" });
  return registry;
}

function run(ffmpeg: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { timeout, env: binaryEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout) }),
    );
  });
}

/** Sonde réelle : interroge le binaire FFmpeg et encode une seconde de mire. */
export function ffmpegEncoderProbe(ffmpeg: string): EncoderProbe & { load(): Promise<void> } {
  const available = new Set<string>();
  return {
    available,
    async load() {
      const { stdout } = await run(ffmpeg, ["-hide_banner", "-encoders"], 10_000);
      for (const m of stdout.matchAll(/^\s*V\S*\s+(\S+)/gm)) available.add(m[1]);
    },
    async tryEncode(name) {
      const args = [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=1",
        ...encoderArgs(name, 25), "-f", "null", "-",
      ];
      return (await run(ffmpeg, args, 15_000)).ok;
    },
  };
}

/**
 * Encodeur retenu pour cette session. La détection se fait une fois, en tâche
 * de fond ; tant qu'elle n'est pas finie, ou si l'encodeur matériel échoue en
 * cours de route, x264 prend le relais.
 */
export class EncoderSelector {
  private current: EncoderName = "libx264";
  private detection: Promise<EncoderName> | undefined;

  constructor(private readonly makeProbe: () => EncoderProbe & { load(): Promise<void> }) {}

  get name(): EncoderName {
    return this.current;
  }

  detect(): Promise<EncoderName> {
    this.detection ??= (async () => {
      try {
        const probe = this.makeProbe();
        await probe.load();
        const result = await createEncoderRegistry().load<EncoderProbe, EncoderName>("h264 encoder", probe);
        this.current = result?.output ?? "libx264";
      } catch {
        this.current = "libx264";
      }
      return this.current;
    })();
    return this.detection;
  }

  /** L'encodeur matériel a échoué sur un vrai fichier : on revient à x264. */
  fallBack(): void {
    this.current = "libx264";
  }
}
