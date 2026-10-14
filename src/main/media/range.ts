export type ByteRange = { start: number; end: number };

/**
 * Interprète un en-tête HTTP Range ("bytes=début-fin") pour un fichier de
 * `size` octets. Renvoie null sans en-tête (fichier entier) et "invalid" pour
 * une plage hors du fichier (réponse 416).
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";

  let start: number;
  let end: number;
  if (m[1] === "") {
    // "bytes=-N" : les N derniers octets.
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}
