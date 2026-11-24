/** FNV-1a over a string's UTF-16 code units, as an unsigned 32-bit number. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * JSON with object keys sorted, so the order keys were written in doesn't matter; a key holding
 * undefined is left out, as JSON and a note's properties leave it out.
 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A short fingerprint of a note's text, to tell whether it changed after the app wrote it. */
export function textHash(text: string): string {
  return `${fnv1a(text).toString(16)}:${text.length}`;
}
