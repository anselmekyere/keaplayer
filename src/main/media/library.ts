import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".mpg", ".mpeg",
  ".ts", ".m2ts", ".3gp", ".ogv", ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg",
  ".opus", ".wma",
]);
export const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt"]);

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

export function isMedia(file: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Fichiers et dossiers déposés → liste de médias, dossiers développés en ordre naturel. */
export async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (s.isFile()) {
      if (isMedia(p)) out.push(p);
      continue;
    }
    if (s.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && isMedia(e.name))
        .map((e) => e.name)
        .sort(collator.compare);
      out.push(...files.map((f) => path.join(p, f)));
    }
  }
  return out;
}

/**
 * Sous-titres externes du même nom que la vidéo, comme le fait VLC :
 * « film.srt », « film.fr.srt », « film.en.vtt »…
 */
export async function findExternalSubtitles(media: string): Promise<{ file: string; language?: string }[]> {
  const dir = path.dirname(media);
  const stem = path.basename(media, path.extname(media)).toLowerCase();
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((name) => SUBTITLE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .filter((name) => {
      const base = path.basename(name, path.extname(name)).toLowerCase();
      return base === stem || base.startsWith(`${stem}.`);
    })
    .sort(collator.compare)
    .map((name) => {
      const base = path.basename(name, path.extname(name));
      const suffix = base.slice(stem.length + 1);
      return { file: path.join(dir, name), language: suffix || undefined };
    });
}
