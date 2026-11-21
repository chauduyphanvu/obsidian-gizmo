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
