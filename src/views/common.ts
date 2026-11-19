import type { Row } from "../data.ts";
import { ROW_INDEX } from "../sources/list.ts";
import { sourceDef } from "../sources/registry.ts";
import type { Panel } from "../spec.ts";
import type { PanelCtx } from "./registry.ts";

/**
 * `names` is one field name or a list of them (several chart series); `json` is text or any set of
 * keys; `format` is text or field → text; `valueMap` is field → (value → text); `alert` is a
 * condition or a `where`-style map; `compute` is name → formula; `textMap` is name → text.
 */
export type KeyType =
  | "string" | "number" | "strings" | "names" | "stringMap" | "fieldMap" | "where"
  | "boolean" | "json" | "format" | "valueMap" | "alert" | "compute" | "textMap";

/** Keys expansion adds to a panel. They have no YAML type, so typing one is an unknown key. */
export const INTERNAL_KEYS = ["upstream", "schema", "vars", "target", "secrets"] as const;
export type InternalKey = (typeof INTERNAL_KEYS)[number];
/** A key that can be typed on a panel. */
export type PanelKey = Exclude<keyof Panel, InternalKey>;

/** Every panel key and the YAML shape it takes. Which views accept which keys is in each ViewDef. */
export const KEY_TYPES: Record<PanelKey, KeyType> = {
  view: "string", title: "string", source: "string", headers: "stringMap", pick: "string",
  from: "string", where: "where", sort: "string", limit: "number", group: "string", per: "string",
  x: "string", y: "names",
  field: "string", agg: "string", label: "string", unit: "string", decimals: "number",
  tab: "string", span: "number", text: "string", item: "string", columns: "strings", max: "number", to: "string",
  minutes: "number", fields: "fieldMap", items: "strings", save: "string", append: "string",
  line: "string", notify: "string",
  compute: "compute", select: "string", action: "string", row: "textMap", name: "string", template: "string",
  open: "string", edit: "strings", format: "format", labels: "textMap", values: "valueMap", cells: "textMap",
  layout: "string", compare: "string", goal: "number", stack: "boolean", body: "json", start: "string",
  end: "string", shortcut: "string", pin: "string", alert: "alert",
};

/** What a wrong value should have been, for the types whose names don't say it plainly. */
const EXPECTED: Partial<Record<KeyType, string>> = {
  boolean: "true or false",
  json: "text or a set of keys",
  format: "text, or a set of field: format",
  valueMap: "a set of field: {value: text}",
  alert: "a condition, or a set of field: condition",
  compute: "a set of name: formula",
  textMap: "a set of name: text",
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
const isText = (v: unknown) => typeof v === "string" || typeof v === "number";
const isMap = (v: unknown): v is Record<string, unknown> => isPlainObject(v) && !(v instanceof Date);
const scalarMap = (v: unknown): v is Record<string, unknown> => isMap(v) && Object.values(v).every(scalar);
const textOf = (map: Record<string, unknown>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)]));

function checkType(value: unknown, type: KeyType): boolean {
  switch (type) {
    case "string": return isText(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "strings": return Array.isArray(value) && value.every(scalar);
    case "names":
      return isText(value) || (Array.isArray(value) && value.length > 0 && value.every(isText));
    case "stringMap":
    case "where":
      return isPlainObject(value) && Object.values(value).every(scalar);
    case "fieldMap":
      return isPlainObject(value) && Object.values(value).every(
        (v) => typeof v === "string" || (Array.isArray(v) && v.every(scalar)),
      );
    case "json": return isText(value) || isMap(value);
    case "format":
    case "alert":
      return isText(value) || scalarMap(value);
    case "textMap": return scalarMap(value);
    case "valueMap": return isMap(value) && Object.values(value).every(scalarMap);
    case "compute": return isMap(value) && Object.values(value).every(isText);
  }
}

/** Checks one known key's value against its type; text keys take numbers and dates as text. */
export function readValue(key: PanelKey, value: unknown): { value: unknown } | { error: string } {
  const type = KEY_TYPES[key];
  if (value instanceof Date && type === "string") return { value: value.toISOString().slice(0, 10) };
  if (!checkType(value, type)) return { error: `"${key}" has the wrong type (expected ${EXPECTED[type] ?? type})` };
  switch (type) {
    case "names": return { value: Array.isArray(value) ? value.map(String) : String(value) };
    case "string": return { value: String(value) };
    case "json":
    case "alert":
      return { value: isText(value) ? String(value) : value };
    case "format": return { value: isText(value) ? String(value) : textOf(value as Record<string, unknown>) };
    case "textMap": return { value: textOf(value as Record<string, unknown>) };
    case "valueMap":
      return { value: Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([k, v]) => [k, textOf(v)])) };
    default: return { value };
  }
}

/** The input types a field can have, besides a list of choices. */
export const FIELD_TYPES = ["text", "number", "date", "time", "checkbox", "textarea"];

/** Problems with a `fields` map (a form's, or a data block's schema). */
export function checkFields(fields: Record<string, string | string[]>): string[] {
  return Object.entries(fields)
    .filter(([, type]) => typeof type === "string" && !FIELD_TYPES.includes(type))
    .map(([name]) => `field "${name}" type must be one of ${FIELD_TYPES.join(", ")} or a list of choices`);
}

/** Keys every view accepts. */
export const COMMON_KEYS = ["view", "title", "tab", "span"] as const;
/** Keys that say where a panel's data comes from and how rows are narrowed. */
export const DATA_KEYS = ["source", "headers", "body", "pick", "from", "where", "sort", "limit", "compute"] as const;
/** Keys that turn rows into one row per group or period. */
export const GROUP_KEYS = ["group", "per"] as const;
/**
 * Keys that make a panel write, notify or open a note when used; `row` shapes what is saved,
 * `name` and `template` the note a save to a folder creates.
 */
export const ACTION_KEYS = ["save", "append", "line", "notify", "open", "row", "name", "template"] as const;

/** A panel that acts needs something to do; opening a note alone is enough. */
export function needsAction(view: string, p: Panel): string[] {
  return p.save || p.append || p.notify || p.open ? [] : [`${view} needs at least one of save, append, notify`];
}

/** On a list or table, the action keys need `action` (the button each row gets), and it needs one of them. */
export function rowActionErrors(view: string, p: Panel): string[] {
  if (!p.action) return ACTION_KEYS.filter((k) => p[k] !== undefined).map((k) => `"${k}" needs "action" on a ${view}`);
  return p.save || p.append || p.notify || p.open ? [] : ['"action" needs at least one of save, append, notify, open'];
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

// ---- Selection -----------------------------------------------------------------------------------

/** What each selectable element picks, so picking one can mark the others in its panel again. */
const PICKS = new WeakMap<Element, { p: Panel; ctx: PanelCtx; row: Row }>();

/** What tells a row apart from the others of its panel across reloads: its place in a saved list, or its note. */
export function rowKey(r: Row): unknown {
  const index = (r as Record<symbol, unknown>)[ROW_INDEX];
  // A note holds many tasks, each on its own line.
  return typeof index === "number" ? index : typeof r.path === "string" ? (typeof r.line === "number" ? `${r.path}:${r.line}` : r.path) : undefined;
}

/** Whether two rows of one panel are the same row: by group key, then list place or note, then content. */
export function sameRow(p: Panel, a: Row | undefined, b: Row): boolean {
  if (!a) return false;
  if (p.group) return a[p.group] === b[p.group];
  const key = rowKey(a);
  if (key !== undefined) return key === rowKey(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function mark(el: Element, on: boolean): void {
  el.classList.toggle("na-selected", on);
  el.setAttribute("aria-pressed", String(on));
}

/** A click or key that lands on a link, button or field inside the element is that control's. */
function fromControl(e: Event, el: Element): boolean {
  const control = (e.target as Element | null)?.closest?.("a, button, input, select, textarea, label");
  return !!control && control !== el && el.contains(control);
}

/** Marks every selectable element in `el`'s panel against the current selections. */
function markAll(el: Element): void {
  // Outside an app (a view drawn on its own) the whole tree it hangs in stands in for the panel.
  let scope: Element = el.closest(".na-panel") ?? el;
  if (scope === el) while (scope.parentElement) scope = scope.parentElement;
  for (const item of scope.querySelectorAll(".na-selectable")) {
    const pick = PICKS.get(item);
    if (pick) mark(item, sameRow(pick.p, pick.ctx.selected(pick.p.select!), pick.row));
  }
}

/**
 * Makes `el` (a list item, a table row, a bar, a slice, a legend entry) pick `row` as the panel's
 * `select`: a button for the mouse and keyboard (Enter or Space), marked `na-selected` while its
 * row is the selection. Picking it again clears the selection. Every element of the panel is marked
 * again in place, so the panel isn't redrawn. Does nothing when the panel has no `select`.
 * Returns what a view that updates rows in place calls with the row's new values: the element then
 * picks those, and a selection of this row takes them too.
 */
export function selectable(el: Element, p: Panel, ctx: PanelCtx, row: Row, label?: string): (row: Row) => void {
  if (!p.select) return () => {};
  const name = p.select;
  const pick = { p, ctx, row };
  PICKS.set(el, pick);
  el.classList.add("na-selectable");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  if (label) el.setAttribute("aria-label", label);
  mark(el, sameRow(p, ctx.selected(name), row));
  const toggle = () => {
    ctx.select(name, sameRow(p, ctx.selected(name), pick.row) ? undefined : pick.row);
    markAll(el);
  };
  el.addEventListener("click", (e) => { if (!fromControl(e, el)) toggle(); });
  el.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if ((key !== "Enter" && key !== " ") || fromControl(e, el)) return;
    e.preventDefault();
    toggle();
  });
  return (next) => {
    pick.row = next;
    const current = ctx.selected(name);
    if (current && current !== next && sameRow(p, current, next) && JSON.stringify(current) !== JSON.stringify(next)) ctx.select(name, next);
  };
}

// ---- Edit in place -------------------------------------------------------------------------------

/** Fields of a notes row that come from the file, not from its properties. */
const FILE_FIELDS = ["name", "path", "tags", "mtime", "ctime"];

/**
 * What a panel's rows can be written back to: their notes (from `notes` or a base), their saved
 * list, or the task lines they came from; else undefined.
 */
export function editableSource(p: Panel): "notes" | "list" | "tasks" | undefined {
  const id = p.source ? sourceDef(p.source).id : undefined;
  return id === "notes" || id === "list" || id === "tasks" ? id : id === "base" ? "notes" : undefined;
}

/**
 * Problems with changing these fields of a panel's rows where they came from (a table's `edit`;
 * a board's group field). The source is decided by the root of its chain; computed columns and a
 * note's file fields can't be written.
 */
export function editErrors(p: Panel, fields: readonly string[]): string[] {
  const kind = editableSource(p);
  if (!kind) return ["edit works on notes and saved lists"];
  if (kind === "tasks" && fields.some((f) => f !== "done")) return ['edit: only "done" can be changed on tasks'];
  const computed = new Set([p, ...(p.upstream ?? [])].flatMap((s) => Object.keys(s.compute ?? {})));
  return fields.flatMap((f) => (computed.has(f) ? [`edit: "${f}" is computed`]
    : kind === "notes" && FILE_FIELDS.includes(f) ? [`edit: "${f}" comes from the note's file, not its properties`]
    : []));
}

/**
 * The permission changing a panel's rows needs, asked by `key`: notes in its `from` (any note,
 * for a base), or ticking tasks in its `from`; a saved list is the app's own.
 */
export function editPermissions(p: Panel, key: keyof Panel): [string, keyof Panel][] {
  if (editableSource(p) === "tasks") return p.from ? [[`tasks:${p.from}`, key]] : [];
  if (editableSource(p) === "notes" && sourceDef(p.source!).id === "base") return [["edit:*", key]];
  return editableSource(p) === "notes" && p.from ? [[`edit:${p.from}`, key]] : [];
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
