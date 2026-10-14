export type Cue = { start: number; end: number; text: string };

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTime(value: string): number | null {
  const m = TIME.exec(value.trim());
  if (!m) return null;
  const [, h = "0", min, s, ms] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

/** Lit des sous-titres SRT ou WebVTT et renvoie leurs répliques triées. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const timingLine = lines.findIndex((l) => l.includes("-->"));
    if (timingLine < 0) continue;
    const [from, to] = lines[timingLine].split("-->");
    const start = parseTime(from);
    const end = parseTime(to ?? "");
    if (start === null || end === null || end < start) continue;
    const body = lines.slice(timingLine + 1).join("\n").trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function formatTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** Convertit des sous-titres SRT (ou VTT) en WebVTT, le seul format lu par Chromium. */
export function toWebVtt(text: string): string {
  const cues = parseSubtitles(text);
  const body = cues.map((c) => `${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}`);
  return ["WEBVTT", "", ...body.flatMap((b) => [b, ""])].join("\n");
}

/**
 * Décale des répliques dans la chronologie du flux affiché : `streamStart` est
 * la position du fichier à laquelle commence le flux (0 en lecture native),
 * `delay` le décalage choisi par l'utilisateur (positif : plus tard).
 */
export function shiftCues(cues: Cue[], streamStart: number, delay: number): Cue[] {
  const shift = delay - streamStart;
  return cues
    .map((c) => ({ ...c, start: c.start + shift, end: c.end + shift }))
    .filter((c) => c.end > 0)
    .map((c) => ({ ...c, start: Math.max(0, c.start) }));
}
