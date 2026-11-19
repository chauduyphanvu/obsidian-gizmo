import type { Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import type { PanelCtx } from "./registry.ts";

export type KeyType = "string" | "number" | "strings" | "stringMap" | "fieldMap" | "where";

/** Every panel key and the YAML shape it takes. Which views accept which keys is in each ViewDef. */
export const KEY_TYPES: Record<keyof Panel, KeyType> = {
  view: "string", title: "string", source: "string", headers: "stringMap", pick: "string",
  from: "string", where: "where", sort: "string", limit: "number", x: "string", y: "string",
  field: "string", agg: "string", label: "string", unit: "string", decimals: "number",
  text: "string", item: "string", columns: "strings", max: "number", to: "string",
  minutes: "number", fields: "fieldMap", items: "strings", save: "string", append: "string",
  line: "string", notify: "string",
};

/** Keys every view accepts. */
export const COMMON_KEYS = ["view", "title"] as const;
/** Keys that say where a panel's data comes from and how rows are narrowed. */
export const DATA_KEYS = ["source", "headers", "pick", "from", "where", "sort", "limit"] as const;
/** Keys that make a panel write or notify when used. */
export const ACTION_KEYS = ["save", "append", "line", "notify"] as const;

export function needsAction(view: string, p: Panel): string[] {
  return p.save || p.append || p.notify ? [] : [`${view} needs at least one of save, append, notify`];
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
