import { fillWith, type Row } from "../data.ts";
import { display } from "../format.ts";
import { ACTION_KEYS } from "../keys.ts";
import { ROW_INDEX, ROW_SOURCE } from "../sources/list.ts";
import { rowsAreNotes } from "../sources/registry.ts";
import type { Panel } from "../spec.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";

/** A panel that acts needs something to do; opening a note, or running another app's shortcut, alone is enough. */
export function needsAction(view: string, p: Panel): string[] {
  return p.save || p.append || p.notify || p.open || p.then ? [] : [`${view} needs at least one of save, append, notify`];
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
  const other = totalled.find((f) => f !== "share");
  if (p.agg === "share") return other === undefined ? [] : [`agg: share gives each group its share; use share in ${what}, not "${other}"`];
  return totalled.length && !p.agg ? [`group with ${what} needs agg (sum, avg, min, max, first or last)`] : [];
}

/** The fields a chart draws as series: `y` as one name or a list. */
export function seriesNames(p: Pick<Panel, "y">): string[] {
  return Array.isArray(p.y) ? p.y : p.y ? [p.y] : [];
}

export function heading(el: HTMLElement, p: Panel, fallback?: string): void {
  const text = p.title ?? fallback;
  if (text) el.createDiv({ cls: "gz-title", text });
}

/**
 * The note a row is, by its `path`, when the panel reads notes from the vault (notes, tasks, a
 * base); undefined for rows from anywhere else, where `path` is only data and links nowhere.
 */
export function rowNote(p: Panel, row: Row): string | undefined {
  return rowsAreNotes(p.source) && typeof row.path === "string" ? row.path : undefined;
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
  const more = el.createEl("button", { cls: "gz-small gz-more", text: `Show all ${rows.length}` });
  more.addEventListener("click", () => {
    more.remove();
    rows.slice(ROW_CAP).forEach(draw);
  });
}

// ---- Selection -----------------------------------------------------------------------------------

/**
 * What each selectable element picks, so picking one can mark the others in its panel again;
 * `root` is the element of its panel when that panel shows `detail`.
 */
const PICKS = new WeakMap<Element, Picker>();

interface Picker {
  p: Panel;
  ctx: PanelCtx;
  row: Row;
  root?: Element;
}

/** A panel drawn with `detail`, and the row picked in it when it has no `select` to keep that in. */
interface Detailed {
  p: Panel;
  ctx: PanelCtx;
  pick?: Row;
}

/** Panels that show `detail`, by the element the panel is drawn in. */
const DETAILED = new WeakMap<Element, Detailed>();

/** The element of the panel `el` is drawn in, when that panel shows `detail`. */
function detailedOf(el: Element): Element | undefined {
  for (let x: Element | null = el; x; x = x.parentElement) if (DETAILED.has(x)) return x;
  return undefined;
}

/** The row picked in a panel: its selection, or with `detail` and no `select`, the panel's own pick. */
function pickedIn(p: Panel, ctx: PanelCtx, root: Element | undefined): Row | undefined {
  return p.select !== undefined ? ctx.selected(p.select) : root ? DETAILED.get(root)?.pick : undefined;
}

/**
 * Draws a panel's detail area, last in the panel, for the row picked in it as the panel shows that
 * row now; takes it away when nothing is picked or the row isn't shown any more. A note's row gets
 * an Open link.
 */
function drawDetail(root: Element): void {
  const d = DETAILED.get(root)!;
  for (const old of [...root.children]) if (old.classList.contains("gz-detail")) old.remove();
  const want = pickedIn(d.p, d.ctx, root);
  // Each element compares as it was made selectable: a board's cards are rows of their own, not its groups.
  const picks = [...root.querySelectorAll(".gz-selectable")].map((item) => PICKS.get(item));
  const row = want && picks.find((pick) => pick && sameRow(pick.p, want, pick.row))?.row;
  if (!row) {
    d.pick = undefined;
    return;
  }
  const area = (root as HTMLElement).createDiv({ cls: "gz-detail", attr: { role: "status" } });
  area.createSpan({ cls: "gz-detail-text", text: fillWith(d.p.detail!, row, (path, v) => display(d.p, path, v, d.ctx.now, "text")) });
  const note = rowNote(d.p, row);
  if (note) noteLink(area, "Open", note, d.ctx);
}

/**
 * Mounts a view in its panel's element. A panel with `detail` gets its detail area drawn again,
 * under the rows, each time the view draws them; a row it picked stays picked across those draws.
 */
export function mountView(def: ViewDef, el: HTMLElement, p: Panel, ctx: PanelCtx, key: string): PanelHandle {
  if (p.detail === undefined) {
    DETAILED.delete(el);
    return def.mount(el, p, ctx, key);
  }
  DETAILED.set(el, { p, ctx, pick: DETAILED.get(el)?.pick });
  const handle = def.mount(el, p, ctx, key);
  const resize = handle.resize;
  return {
    ...handle,
    update(data) {
      handle.update(data);
      drawDetail(el);
    },
    ...(resize ? { resize(width: number) { resize.call(handle, width); drawDetail(el); } } : {}),
  };
}

/** What tells a row apart from the others of its panel across reloads: its place in a saved list, or its note. */
export function rowKey(r: Row): unknown {
  const index = (r as Record<symbol, unknown>)[ROW_INDEX];
  // Two devices' notes each have a first row.
  const source = (r as Record<symbol, unknown>)[ROW_SOURCE];
  if (typeof index === "number") return typeof source === "string" ? `${source}#${index}` : index;
  // A note holds many tasks, each on its own line.
  return typeof r.path === "string" ? (typeof r.line === "number" ? `${r.path}:${r.line}` : r.path) : undefined;
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
  el.classList.toggle("gz-selected", on);
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
  let scope: Element = el.closest(".gz-panel") ?? el;
  if (scope === el) while (scope.parentElement) scope = scope.parentElement;
  for (const item of scope.querySelectorAll(".gz-selectable")) {
    const pick = PICKS.get(item);
    if (pick) mark(item, sameRow(pick.p, pickedIn(pick.p, pick.ctx, pick.root), pick.row));
  }
}

/** Whether a panel's rows can be picked: it names a selection, or shows a detail of the picked row. */
export function picks(p: Panel): boolean {
  return p.select !== undefined || p.detail !== undefined;
}

/**
 * Makes `el` (a list item, a table row, a bar, a slice, a legend entry) pick `row` as the panel's
 * `select`, and for its `detail`: a button for the mouse and keyboard (Enter or Space), marked
 * `gz-selected` while its row is the one picked. Picking it again clears the pick. Every element
 * of the panel is marked again in place, so the panel isn't redrawn; its detail area is drawn
 * again. Does nothing when the panel has neither `select` nor `detail`.
 * Returns what a view that updates rows in place calls with the row's new values: the element then
 * picks those, and a selection of this row takes them too.
 */
export function selectable(el: Element, p: Panel, ctx: PanelCtx, row: Row, label?: string): (row: Row) => void {
  if (!picks(p)) return () => {};
  const name = p.select;
  const root = detailedOf(el);
  const pick: Picker = { p, ctx, row, root };
  PICKS.set(el, pick);
  el.classList.add("gz-selectable");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  if (label) el.setAttribute("aria-label", label);
  mark(el, sameRow(p, pickedIn(p, ctx, root), row));
  const toggle = () => {
    const next = sameRow(p, pickedIn(p, ctx, root), pick.row) ? undefined : pick.row;
    if (name !== undefined) ctx.select(name, next);
    else if (root) DETAILED.get(root)!.pick = next;
    markAll(el);
    if (root) drawDetail(root);
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
    if (name === undefined) return;
    const current = ctx.selected(name);
    if (current && current !== next && sameRow(p, current, next) && JSON.stringify(current) !== JSON.stringify(next)) ctx.select(name, next);
  };
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * A control that saves a field as it is edited. A checkbox or dropdown writes at once; text,
 * numbers and dates when changed (leaving the field, or Enter). The control is disabled while its
 * write runs and keeps focus. Returns what shows a value, which leaves a field being typed in
 * (focused, or changed and not yet saved) alone. `look` gives the classes beside a dropdown's, the
 * accessible name, and the element for a type that is neither a list nor `checkbox`: `textarea`,
 * or an input's type.
 */
export function fieldControl(
  parent: HTMLElement, type: string | string[], write: (value: unknown) => Promise<void>,
  look: { cls?: string; label?: string; input(type: string): string },
): (value: unknown) => void {
  const cls = look.cls ? { cls: look.cls } : {};
  const run = async (control: Control, value: unknown) => {
    const focused = control.ownerDocument.activeElement === control;
    control.disabled = true;
    try {
      await write(value);
    } finally {
      control.disabled = false;
      if (focused) control.focus();
    }
  };
  if (Array.isArray(type)) {
    const select = parent.createEl("select", { cls: look.cls ? `dropdown ${look.cls}` : "dropdown" });
    if (look.label) select.setAttr("aria-label", look.label);
    let options: unknown[] = [];
    select.addEventListener("change", () => void run(select, options[Number(select.value)]));
    return (v) => {
      // A value that isn't one of the choices (or none yet) is still shown as it is.
      options = type.some((c) => c === v) ? type : [v ?? "", ...type];
      select.empty();
      options.forEach((o, i) => {
        const option = select.createEl("option", { text: String(o), value: String(i) });
        if (o === (v ?? "")) option.setAttr("selected", "");
      });
    };
  }
  if (type === "checkbox") {
    const box = parent.createEl("input", { type: "checkbox", ...cls });
    if (look.label) box.setAttr("aria-label", look.label);
    box.addEventListener("change", () => void run(box, box.checked));
    return (v) => { box.checked = v === true; };
  }
  const kind = look.input(type);
  const input = kind === "textarea" ? parent.createEl("textarea", cls) : parent.createEl("input", { type: kind, ...cls });
  if (look.label) input.setAttr("aria-label", look.label);
  if (kind === "number") input.setAttr("step", "any");
  let saved = "";
  input.addEventListener("change", () => {
    saved = input.value;
    void run(input, kind === "number" ? (input.value === "" ? null : Number(input.value)) : input.value);
  });
  return (v) => {
    if (input.ownerDocument.activeElement === input || input.value !== saved) return;
    saved = v === undefined || v === null ? "" : String(v);
    input.value = saved;
  };
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
