import type { Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import type { PanelCtx } from "./registry.ts";

/** `names` is one field name or a list of them (several chart series). */
export type KeyType = "string" | "number" | "strings" | "names" | "stringMap" | "fieldMap" | "where";

/** Every panel key and the YAML shape it takes. Which views accept which keys is in each ViewDef. */
export const KEY_TYPES: Record<keyof Panel, KeyType> = {
  view: "string", title: "string", source: "string", headers: "stringMap", pick: "string",
  from: "string", where: "where", sort: "string", limit: "number", group: "string", per: "string",
  x: "string", y: "names",
  field: "string", agg: "string", label: "string", unit: "string", decimals: "number",
  tab: "string", span: "number", text: "string", item: "string", columns: "strings", max: "number", to: "string",
  minutes: "number", fields: "fieldMap", items: "strings", save: "string", append: "string",
  line: "string", notify: "string",
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkType(value: unknown, type: KeyType): boolean {
  const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
  switch (type) {
    case "string": return typeof value === "string" || typeof value === "number";
    case "number": return typeof value === "number";
    case "strings": return Array.isArray(value) && value.every(scalar);
    case "names":
      return typeof value === "string" || typeof value === "number"
        || (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" || typeof v === "number"));
    case "stringMap":
    case "where":
      return isPlainObject(value) && Object.values(value).every(scalar);
    case "fieldMap":
      return isPlainObject(value) && Object.values(value).every(
        (v) => typeof v === "string" || (Array.isArray(v) && v.every(scalar)),
      );
  }
}

/** Checks one known key's value against its type; text keys take numbers and dates as text. */
export function readValue(key: keyof Panel, value: unknown): { value: unknown } | { error: string } {
  const type = KEY_TYPES[key];
  if (value instanceof Date && type === "string") return { value: value.toISOString().slice(0, 10) };
  if (!checkType(value, type)) return { error: `"${key}" has the wrong type (expected ${type})` };
  if (type === "names") return { value: Array.isArray(value) ? value.map(String) : String(value) };
  return { value: type === "string" ? String(value) : value };
}

/** Keys every view accepts. */
export const COMMON_KEYS = ["view", "title", "tab", "span"] as const;
/** Keys that say where a panel's data comes from and how rows are narrowed. */
export const DATA_KEYS = ["source", "headers", "pick", "from", "where", "sort", "limit"] as const;
/** Keys that turn rows into one row per group or period. */
export const GROUP_KEYS = ["group", "per"] as const;
/** Keys that make a panel write or notify when used. */
export const ACTION_KEYS = ["save", "append", "line", "notify"] as const;

export function needsAction(view: string, p: Panel): string[] {
  return p.save || p.append || p.notify ? [] : [`${view} needs at least one of save, append, notify`];
}

/**
 * Checks for a panel that totals fields per group: those other than count need an agg, and a
 * streak belongs on number and progress.
 */
export function groupedTotals(p: Panel, fields: readonly string[], what: string): string[] {
  if (!p.group) return p.agg ? [`"agg" needs "group" here`] : [];
  if (p.agg === "streak") return ["agg: streak only works on number and progress"];
  const totalled = fields.filter((f) => f !== p.group && f !== "count");
  return totalled.length && !p.agg ? [`group with ${what} needs agg (sum, avg, min, max, first or last)`] : [];
}

/** The fields a chart draws as series: `y` as one name or a list. */
export function seriesNames(p: Pick<Panel, "y">): string[] {
  return Array.isArray(p.y) ? p.y : p.y ? [p.y] : [];
}

export function heading(el: HTMLElement, p: Panel, fallback?: string): void {
  const text = p.title ?? fallback;
  if (text) el.createDiv({ cls: "na-title", text });
}

export function rowsOf(data: unknown): Row[] {
  if (Array.isArray(data)) return data.map((r) => (r !== null && typeof r === "object" ? (r as Row) : { value: r }));
  if (data !== null && typeof data === "object") return [data as Row];
  return data === undefined ? [] : [{ value: data }];
}

export function noteLink(el: HTMLElement, text: string, path: string, ctx: PanelCtx): void {
  const a = el.createEl("a", { cls: "internal-link", text, href: "#" });
  a.addEventListener("click", (e) => { e.preventDefault(); ctx.openNote(path); });
}

/** Disables the button while its work runs, so a double click doesn't save twice. */
export function busy(button: HTMLButtonElement, work: () => Promise<void>): void {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  });
}

/** Rows drawn at first; the rest wait behind a "Show all" button so big queries stay cheap. */
export const ROW_CAP = 200;

export function shownRows(el: HTMLElement, rows: Row[], draw: (r: Row) => void): void {
  rows.slice(0, ROW_CAP).forEach(draw);
  if (rows.length <= ROW_CAP) return;
  const more = el.createEl("button", { cls: "na-small na-more", text: `Show all ${rows.length}` });
  more.addEventListener("click", () => {
    more.remove();
    rows.slice(ROW_CAP).forEach(draw);
  });
}

/** A handle whose update simply redraws the panel's contents. */
export function redraw(el: HTMLElement, draw: (data: unknown) => void) {
  return {
    update(data: unknown) {
      el.empty();
      draw(data);
    },
  };
}
