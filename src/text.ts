/**
 * A value as text, as String() gives it for a string, number, boolean or date and for a list item
 * by item; a set of keys reads as JSON, not as "[object Object]".
 */
export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return String(v);
  if (Array.isArray(v)) return v.map((item) => (item === null || item === undefined ? "" : textOf(item))).join(",");
  return JSON.stringify(v) ?? "";
}

/** A count with its word, in the plural unless it is one: 1 row, 2 rows. */
export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Names in a sentence: "a", "a and b", "a, b and c". */
export function listed(names: string[]): string {
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
