import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { MediaInfo, PlaybackOptions } from "../../shared/types";
import { toWebVtt } from "../../shared/subtitles";
import { binaryEnv, ffmpegPath, streamArgs, subtitleArgs, type StreamJob } from "./ffmpeg";
import { parseRange } from "./range";
import type { EncoderSelector } from "./encoders";

/** Toutes les ressources sont servies depuis une seule origine : kp://local. */
export const SCHEME = "kp";
export const ORIGIN = `${SCHEME}://local`;

export type Session = {
  path: string;
  info: MediaInfo;
  externalSubtitles: { file: string; language?: string }[];
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".m4a": "audio/mp4",
  ".mov": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

const notFound = () => new Response("Introuvable", { status: 404 });

/**
 * Beaucoup de fichiers .srt français sont en Windows-1252 et non en UTF-8 :
 * on essaie l'UTF-8 strict, puis on se rabat sur Windows-1252.
 */
export function decodeSubtitleFile(raw: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("windows-1252").decode(raw);
  }
}

/**
 * Lance FFmpeg et expose sa sortie standard en flux ; l'arrêt du lecteur tue
 * le processus. `onFailure` est appelé si FFmpeg échoue sans rien produire.
 */
function ffmpegResponse(
  args: string[],
  contentType: string,
  onSpawn?: (p: ChildProcess) => void,
  onFailure?: () => void,
): Response {
  const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"], env: binaryEnv() });
  onSpawn?.(child);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  let produced = 0;
  child.stdout.on("data", (d: Buffer) => (produced += d.length));
  child.on("close", (code, signal) => {
    if (code && code !== 255 && stderr) console.error(`FFmpeg (${code}) : ${stderr.trim()}`);
    if (code && !signal && produced === 0) onFailure?.();
  });
  const body = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      child.kill("SIGKILL");
    },
  });
  return new Response(stream, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
}

export class MediaServer {
  private readonly sessions = new Map<string, Session>();
  /** Un seul flux FFmpeg vivant par média : un nouveau saut remplace le précédent. */
  private readonly streams = new Map<string, ChildProcess>();
  private nextId = 1;

  constructor(
    private readonly appDir: string,
    private readonly encoders?: EncoderSelector,
  ) {}

  add(session: Session): string {
    const id = String(this.nextId++);
    this.sessions.set(id, session);
    return id;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  stopAll(): void {
    for (const child of this.streams.values()) child.kill("SIGKILL");
    this.streams.clear();
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host !== "local") return notFound();
    const [, kind, id, extra] = url.pathname.split("/");

    if (kind === "app") return this.serveApp(url.pathname.slice("/app/".length));
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) return notFound();

    if (kind === "media") return this.serveFile(session.path, request.headers.get("range"));
    if (kind === "stream") return this.serveStream(id, session, url.searchParams);
    if (kind === "subs" && extra) return this.serveSubtitles(session, extra);
    return notFound();
  }

  private async serveApp(relative: string): Promise<Response> {
    const file = path.resolve(this.appDir, relative);
    if (!file.startsWith(this.appDir + path.sep)) return notFound();
    const data = await readFile(file).catch(() => null);
    if (!data) return notFound();
    return new Response(data, {
      headers: { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" },
    });
  }

  /** Lecture native : le fichier tel quel, avec prise en charge des plages (recherche). */
  private async serveFile(file: string, rangeHeader: string | null): Promise<Response> {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound();
    const size = info.size;
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = parseRange(rangeHeader, size);

    if (range === "invalid") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: range ? 206 : 200, headers });
  }

  /** Remux ou transcodage : FFmpeg produit un MP4 fragmenté à partir de la position demandée. */
  private serveStream(id: string, session: Session, params: URLSearchParams): Response {
    const job: StreamJob = {
      video: (params.get("v") as StreamJob["video"]) ?? "none",
      audio: (params.get("a") as StreamJob["audio"]) ?? "none",
      fps: session.info.video?.fps,
      videoTag: params.get("tag") === "hvc1" ? "hvc1" : undefined,
      deinterlace: params.get("di") === "1",
      encoder: this.encoders?.name ?? "libx264",
    };
    const options: PlaybackOptions = {
      start: Number(params.get("start") ?? 0) || 0,
      audioIndex: Number(params.get("track") ?? 0) || 0,
      audioDelay: Number(params.get("delay") ?? 0) || 0,
    };
    this.streams.get(id)?.kill("SIGKILL");
    const hardware = job.video === "h264" && job.encoder !== "libx264";
    return ffmpegResponse(
      streamArgs(session.path, job, options),
      "video/mp4",
      (child) => {
        this.streams.set(id, child);
        child.on("close", () => {
          if (this.streams.get(id) === child) this.streams.delete(id);
        });
      },
      // Encodeur matériel en échec sur ce fichier : x264 pour la suite (l'interface relance).
      hardware ? () => this.encoders?.fallBack() : undefined,
    );
  }

  /** "ext-N" : fichier .srt/.vtt voisin ; "emb-N" : piste texte intégrée au fichier. */
  private async serveSubtitles(session: Session, which: string): Promise<Response> {
    const [source, n] = which.split("-");
    const index = Number(n);
    if (source === "ext") {
      const sub = session.externalSubtitles[index];
      if (!sub) return notFound();
      const text = decodeSubtitleFile(await readFile(sub.file));
      return new Response(toWebVtt(text), { headers: { "Content-Type": "text/vtt; charset=utf-8" } });
    }
    if (source === "emb" && session.info.subtitles[index]?.isText) {
      return ffmpegResponse(subtitleArgs(session.path, index), "text/vtt; charset=utf-8");
    }
    return notFound();
  }
}
