import { textOf } from "../text.ts";
import { handler } from "../handler.ts";
import { compareWindows, splitByWindow, type Windows } from "../compare.ts";
import { fillWith, getPath, type Row } from "../data.ts";
import { display } from "../format.ts";
import { ACTION_KEYS } from "../keys.ts";
import { ROW_INDEX } from "../sources/list.ts";
import { conflictsOf, rowIdOf } from "../ledger-store.ts";
import { rowsAreNotes, rowsAreSaved } from "../sources/registry.ts";
import type { Panel } from "../spec.ts";
import type { StepName, Trace, TracedStep } from "../pipeline.ts";
import { nearMiss } from "../template.ts";
import { periodStart, shiftPeriod } from "../time.ts";
import type { PanelCtx, PanelHandle, SheetPick, ViewDef } from "./registry.ts";

/** What a panel does when it acts: save, add a line, tell, open a note; a form or button may also run another app's shortcut (`then`), which rows don't take. Any one is enough. */
const DOES = ["save", "append", "notify", "open"] as const;
const PANEL_DOES = [...DOES, "then"] as const;

/** A panel that acts needs something to do. */
export function needsAction(view: string, p: Panel): string[] {
  return PANEL_DOES.some((k) => p[k] !== undefined) ? [] : [`${view} needs at least one of ${PANEL_DOES.join(", ")}`];
}

/** On a list or table, the action keys need `action` (the button each row gets), and it needs one of them. */
export function rowActionErrors(view: string, p: Panel): string[] {
  if (!p.action) return ACTION_KEYS.filter((k) => p[k] !== undefined).map((k) => `"${k}" needs "action" on a ${view}`);
  return DOES.some((k) => p[k] !== undefined) ? [] : [`"action" needs at least one of ${DOES.join(", ")}`];
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
export function busy(button: HTMLButtonElement, work: () => Promise<unknown>): void {
  button.addEventListener("click", handler(async () => {
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }));
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

// ---- Windows in words, and what an empty panel says -------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayName = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

/**
 * A window as the dates it covers: `Oct 1`, `Oct 1–20`, `Sep 28 – Oct 4`; its last day is the one
 * before its end. A window that ends in another year than now says which.
 */
export function windowName([from, to]: readonly [number, number], now: Date): string {
  const a = new Date(from), b = new Date(Math.max(from, to - 1));
  const year = b.getFullYear() === now.getFullYear() ? "" : `, ${b.getFullYear()}`;
  if (a.toDateString() === b.toDateString()) return `${dayName(a)}${year}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${dayName(a)}–${b.getDate()}${year}`;
  return `${dayName(a)} – ${dayName(b)}${year}`;
}

/** The window before, in a word where one fits (`last week`, `last month`, `last year`, `the day before`), else its dates. */
export function windowWord(w: Windows, now: Date): string {
  const { per, n } = w.step;
  if (n === 1) return per === "day" ? "the day before" : `last ${per}`;
  if (per === "month" && n === 12 && new Date(w.current[0]).getMonth() === 0) return "last year";
  return windowName(w.previous, now);
}

/**
 * The window itself, as words that follow "Nothing logged": `today`, `this week`, `this month`,
 * `this year`, or `in the last 30 days`, for a window that ends with the period holding now; else
 * `yesterday`, or its dates (`on Nov 18`, `for Nov 21–28`).
 */
function windowWords(w: Windows, now: Date): string {
  const t = now.getTime();
  const [from, to] = w.current;
  const { per, n } = w.step;
  // A window of whole years steps by months, twelve to a year.
  const years = per === "month" && n % 12 === 0 && new Date(from).getMonth() === 0 ? n / 12 : 0;
  const unit = years ? "year" : per;
  const count = years || n;
  if (to === shiftPeriod(periodStart(t, unit), unit, 1)) {
    if (count > 1) return `in the last ${count} ${unit}s`;
    return unit === "day" ? "today" : `this ${unit}`;
  }
  const day = unit === "day" && count === 1;
  if (day && to === periodStart(t, "day")) return "yesterday";
  return `${day ? "on" : "for"} ${windowName(w.current, now)}`;
}

/** The date window a panel's rows are kept to: in its own `where`, else the nearest block's above it. */
function keptWindow(p: Panel, now: Date): Windows | undefined {
  for (const where of [p.where, ...(p.upstream ?? []).map((s) => s.where).reverse()]) {
    const w = compareWindows(where, now);
    if (w) return w;
  }
  return undefined;
}

/**
 * What a panel with no rows says: its `empty` text, else that nothing is logged (in one of the
 * app's own lists) or here (from anywhere else), in the window its `where` keeps if it has one:
 * `Nothing logged this month yet.`, `Nothing here this week.` From anywhere else with no window it
 * says `fallback`, the view's own words. `caption` leaves off the full stop, for a line under a value.
 */
export function emptyText(p: Panel, now: Date, fallback: string, caption = false): string {
  if (p.empty !== undefined) return p.empty;
  const w = keptWindow(p, now);
  const logged = rowsAreSaved(p.source);
  if (!w && !logged) return fallback;
  const words = w ? ` ${windowWords(w, now)}` : "";
  // A window that is over has nothing more coming, so it isn't nothing "yet".
  const sentence = logged ? `Nothing logged${words}${!w || w.current[1] > now.getTime() ? " yet" : ""}` : `Nothing here${words}`;
  return caption ? sentence : `${sentence}.`;
}

// ---- Why a panel shows nothing -------------------------------------------------------------------

/**
 * Beside what a panel says when it shows nothing, a "Why?" link, when its source did give something
 * and the app can tell (`ctx.why`): a wrong pick, a where that keeps too little or a misspelled
 * field look just like having no data. `line` holds the link, else it gets a line of its own at the
 * end of `panel`. Selecting it shows under the panel what each step kept, down to the one that lost
 * the rows (the steps run again only then), with ways to the panel's line in the note and to its
 * source in Inspect data; selecting it again hides that. A source that gave nothing gets no link,
 * since the empty sentence is then the truth.
 */
export function whyEmpty(panel: HTMLElement, p: Panel, ctx: PanelCtx, line?: HTMLElement): void {
  const why = ctx.why;
  if (!why?.hasData()) return;
  const at = line ?? panel.createDiv({ cls: "gz-label" });
  if (line) at.append(" ");
  const link = at.createEl("button", { cls: "gz-error-link gz-why-link", text: "Why?", attr: { "aria-expanded": "false" } });
  let box: HTMLElement | undefined;
  link.addEventListener("click", () => {
    if (box) {
      box.remove();
      box = undefined;
    } else {
      const { chain, lost } = whyWords(p, why.trace(), ctx.now);
      box = panel.createDiv({ cls: "gz-detail gz-why", attr: { role: "status" } });
      box.createDiv({ cls: "gz-why-chain", text: chain });
      for (const text of lost) box.createDiv({ text });
      const actions = box.createDiv({ cls: "gz-actions" });
      actions.createEl("button", { cls: "gz-small", text: "Show in source" }).addEventListener("click", () => why.showInSource());
      actions.createEl("button", { cls: "gz-small", text: "See the answer" }).addEventListener("click", () => why.seeAnswer());
    }
    link.setAttr("aria-expanded", String(box !== undefined));
  });
}

const rowCount = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** The first few names, in a line: `a, b, c and 4 more`. */
const someOf = (names: string[], max = 8) => (names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`);
/** A where as typed, compactly: `{at: this month, kp: >= 5}`. */
const typedWhere = (where: NonNullable<Panel["where"]>) => `{${Object.entries(where).map(([k, v]) => `${k}: ${textOf(v)}`).join(", ")}}`;

/** The fields rows have, in the order first met. */
function fieldsOf(rows: unknown[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (isRecord(r)) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/**
 * The names where a field stops being found, as paths: for `properties.mga`, the keys under
 * `properties` (`properties.mag`, `properties.place`); for a plain name, the rows' own fields.
 */
function namesNear(rows: unknown[], field: string): string[] {
  const parts = field.split(".");
  for (let n = parts.length - 1; n > 0; n--) {
    const prefix = parts.slice(0, n).join(".");
    const inner = rows.map((r) => getPath(r, prefix)).filter(isRecord);
    if (inner.length) return fieldsOf(inner).map((k) => `${prefix}.${k}`);
  }
  return fieldsOf(rows);
}

/** `no row has amout (rows have amount, note, at) — did you mean amount?`; undefined when a row has the field. */
function noRowHas(field: string, rows: unknown[]): string | undefined {
  if (rows.length === 0 || rows.some((r) => getPath(r, field) !== undefined)) return undefined;
  const names = namesNear(rows, field);
  const close = nearMiss(field, names);
  return `no row has ${field}${names.length ? ` (rows have ${someOf(names)})` : ""}${close === undefined ? "" : ` — did you mean ${close}?`}`;
}

/** Where a pick stops finding anything, and what is there: `pick: chart.result.0 found nothing (the answer has: chart.error)`. */
function pickMissed(pick: string, data: unknown): string {
  let at = data;
  const found: string[] = [];
  for (const part of pick.split(".")) {
    const next = getPath(at, part);
    if (next === undefined) break;
    at = next;
    found.push(part);
  }
  const path = found.join(".");
  const name = path || "the answer";
  const keys = isRecord(at) ? Object.keys(at) : [];
  const has = Array.isArray(at) ? `${name} has ${at.length} ${at.length === 1 ? "item" : "items"}`
    : keys.length ? `the answer has: ${someOf(keys.map((k) => (path ? `${path}.${k}` : k)))}`
    : isRecord(at) ? `${name} is empty`
    : `${name} is ${textOf(at)}`;
  return `pick: ${pick} found nothing (${has})`;
}

/** The fields a panel's view reads from its rows; a count or share a group makes is no row's own. */
function readFields(p: Panel, grouped: boolean): string[] {
  const fields = [p.field, p.x, ...seriesNames(p), p.group, p.start].filter((f): f is string => f !== undefined);
  return [...new Set(fields)].filter((f) => !grouped || (f !== "count" && f !== "share"));
}

const CHAIN_WORDS: Record<StepName, string> = { pick: "pick found", compute: "compute left", where: "where kept", group: "group made", limit: "limit kept" };

/** What lost every row at a step, in plain words: the step as typed, then any field it reads that no row has. */
function lostAt(s: TracedStep): string[] {
  const rows = Array.isArray(s.before) ? s.before : [];
  const of = `of ${rowCount(rows.length)}`;
  const missing = (fields: string[]) => fields.map((f) => noRowHas(f, rows)).filter((m): m is string => m !== undefined);
  switch (s.step) {
    case "pick":
      if (s.keys.pick === undefined) return ["the answer has no rows"];
      return [s.after === undefined ? pickMissed(s.keys.pick, s.before) : `pick: ${s.keys.pick} found 0 rows`];
    case "where":
      return [`where ${typedWhere(s.keys.where ?? {})} kept 0 ${of}`, ...missing(Object.keys(s.keys.where ?? {}))];
    case "group":
      return [`group by ${s.keys.group}${s.keys.per ? ` per ${s.keys.per}` : ""} made no groups from ${rowCount(rows.length)}`, ...missing([s.keys.group!])];
    case "limit":
      return [`limit ${s.keys.limit} kept 0 ${of}`];
    case "compute":
      return [`compute left 0 ${of}`];
  }
}

/**
 * Why a panel shows nothing though its source gave something, from the trace of its steps: the
 * chain its rows went through, compactly (`34 rows → where kept 0`), and what lost them. A step
 * that loses no row and narrows nothing (a compute, a source's lists made rows) stays out of the
 * chain. When no step lost them, it is a field the view reads that no row has, else that the rows
 * hold nothing it can show.
 */
export function whyWords(p: Panel, trace: Trace, now: Date): { chain: string; lost: string[] } {
  const own = p.upstream?.length ?? 0;
  const chain = [Array.isArray(trace.input) ? rowCount(trace.input.length) : "the answer"];
  let out = trace.input;
  for (const s of trace.steps) {
    // A compare panel's own where keeps the window before too; it shows only the current one.
    const after = s.step === "where" && s.stage === own && p.compare ? splitByWindow(p, s.after, now).current : s.after;
    out = s.after;
    const n = Array.isArray(after) ? after.length : undefined;
    const lost = after === undefined || (n === 0 && (!Array.isArray(s.before) || s.before.length > 0));
    if (!lost && (s.step === "compute" || (s.step === "pick" && s.keys.pick === undefined))) continue;
    chain.push(s.step === "pick" && s.keys.pick === undefined ? "0 rows" : `${CHAIN_WORDS[s.step]} ${n ?? (after === undefined ? "nothing" : "one")}`);
    if (!lost) continue;
    const [said, ...more] = lostAt(s);
    return { chain: chain.join(" → "), lost: [s.stage < own ? `${said}, in a data block it reads` : said, ...more] };
  }
  const grouped = trace.steps.find((s) => s.stage === own && s.step === "group");
  const read = grouped ? grouped.before : out;
  const rows = Array.isArray(read) ? read : isRecord(read) ? [read] : [];
  const fields = readFields(p, grouped !== undefined);
  for (const f of fields) {
    const missing = noRowHas(f, rows);
    if (missing) return { chain: chain.join(" → "), lost: [missing] };
  }
  const n = Array.isArray(out) ? out.length : undefined;
  const reach = n === undefined ? "the answer reaches this panel, but it has" : `${rowCount(n)} ${n === 1 ? "reaches" : "reach"} this panel, but none has`;
  return { chain: chain.join(" → "), lost: [`${reach} a value it can show${fields.length ? ` in ${listed(fields)}` : ""}`] };
}

// ---- Selection -----------------------------------------------------------------------------------

/**
 * What each selectable element picks, so picking one can mark the others in its panel again;
 * `root` is the element of its panel when that panel keeps its own pick (see OWN).
 */
const PICKS = new WeakMap<Element, Picker>();

interface Picker {
  p: Panel;
  ctx: PanelCtx;
  row: Row;
  root?: Element;
  label?: string;
  record: boolean;
  /** Whether the element takes the focus and is named for screen readers, or only the pointer picks with it. */
  keyboard: boolean;
}

/** A panel that keeps the row picked in it when it has no `select` to keep that in. */
interface Own {
  p: Panel;
  ctx: PanelCtx;
  pick?: Row;
}

/**
 * Panels that keep their own pick, by the element the panel is drawn in: those that show `detail`,
 * and in an app with a side sheet every panel, since a record opens there without either key.
 */
const OWN = new WeakMap<Element, Own>();

/** The element of the panel `el` is drawn in, when that panel keeps its own pick. */
function ownerOf(el: Element): Element | undefined {
  for (let x: Element | null = el; x; x = x.parentElement) if (OWN.has(x)) return x;
  return undefined;
}

/** The row picked in a panel: its selection, or with no `select`, the panel's own pick. */
function pickedIn(p: Panel, ctx: PanelCtx, root: Element | undefined): Row | undefined {
  return p.select !== undefined ? ctx.selected(p.select) : root ? OWN.get(root)?.pick : undefined;
}

/** The selectable element in a panel that shows `want`, as each compares as it was made selectable: a board's cards are rows of their own, not its groups. */
function shownIn(root: Element, want: Row | undefined): Element | undefined {
  if (!want) return undefined;
  return [...root.querySelectorAll(".gz-selectable")].find((item) => {
    const pick = PICKS.get(item);
    return pick && sameRow(pick.p, want, pick.row);
  });
}

/** A panel's `detail` sentence filled in for a row, its values shown as the panel shows them. */
export function detailText(p: Panel, row: Row, now: Date): string {
  return fillWith(p.detail!, row, (path, v) => display(p, path, v, now, "text"));
}

/**
 * Draws a panel's detail area, last in the panel, for the row picked in it as the panel shows that
 * row now; takes it away when nothing is picked or the row isn't shown any more. A note's row gets
 * an Open link.
 */
function drawDetail(root: Element): void {
  const d = OWN.get(root)!;
  for (const old of [...root.children]) if (old.classList.contains("gz-detail")) old.remove();
  const shown = shownIn(root, pickedIn(d.p, d.ctx, root));
  const row = shown && PICKS.get(shown)!.row;
  if (!row) {
    d.pick = undefined;
    return;
  }
  const area = (root as HTMLElement).createDiv({ cls: "gz-detail", attr: { role: "status" } });
  area.createSpan({ cls: "gz-detail-text", text: detailText(d.p, row, d.ctx.now) });
  const note = rowNote(d.p, row);
  if (note) noteLink(area, "Open", note, d.ctx);
}

/** What the side sheet is given for the element `el` picks: its row as it is now, and how to take the pick back. */
function sheetPick(el: Element, pick: Picker): SheetPick {
  const { p, ctx, root } = pick;
  return {
    row: pick.row, el, label: pick.label, record: pick.record,
    clear() {
      if (p.select !== undefined) ctx.select(p.select, undefined);
      else if (root) OWN.get(root)!.pick = undefined;
      markAll(root ?? el);
    },
  };
}

/**
 * After a panel is drawn again, the side sheet showing its pick shows the row as the panel shows it
 * now, or closes when the panel doesn't show it any more (deleted, filtered out).
 */
function reopen(root: Element): void {
  const d = OWN.get(root)!;
  const shown = shownIn(root, pickedIn(d.p, d.ctx, root));
  d.ctx.open!(shown && sheetPick(shown, PICKS.get(shown)!), true);
}

/**
 * Mounts a view in its panel's element. A panel with `detail` gets its detail area drawn again,
 * under the rows, each time the view draws them; a row it picked stays picked across those draws.
 * In an app with a side sheet, the detail is the sheet's, and the sheet follows each draw instead.
 */
export function mountView(def: ViewDef, el: HTMLElement, p: Panel, ctx: PanelCtx, key: string): PanelHandle {
  const sheet = ctx.open !== undefined;
  if (p.detail === undefined && !sheet) {
    OWN.delete(el);
    return def.mount(el, p, ctx, key);
  }
  OWN.set(el, { p, ctx, pick: OWN.get(el)?.pick });
  const handle = def.mount(el, p, ctx, key);
  const after = () => (sheet ? reopen(el) : drawDetail(el));
  const resize = handle.resize;
  return {
    ...handle,
    update(data) {
      handle.update(data);
      after();
    },
    ...(resize ? { resize(width: number) { resize.call(handle, width); after(); } } : {}),
  };
}

/**
 * When another device set this cell at the same time as the value shown, a chip offering its value:
 * picking it keeps that one instead. Drawn again with each new row, so a settled cell drops it.
 */
export function conflictChip(box: HTMLElement, row: Row, field: string, pick: (value: unknown) => unknown): void {
  box.querySelector(":scope > .gz-conflict")?.remove();
  const other = conflictsOf(row).filter((c) => c.field === field).at(-1);
  if (!other) return;
  const shown = typeof other.value === "string" ? other.value : JSON.stringify(other.value);
  const chip = box.createEl("button", { cls: "gz-conflict", text: `or ${shown}`, attr: { title: "Another device set this at the same time; pick it to keep that instead" } });
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    void pick(other.value);
  });
}

/** What tells a row apart from the others of its panel across reloads: its id in the app's ledger, its place in a saved list, or its note. */
export function rowKey(r: Row): unknown {
  const id = rowIdOf(r);
  if (id) return id;
  const index = (r as Record<symbol, unknown>)[ROW_INDEX];
  if (typeof index === "number") return index;
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

function mark(el: Element, on: boolean, keyboard: boolean): void {
  el.classList.toggle("gz-selected", on);
  if (keyboard) el.setAttribute("aria-pressed", String(on));
}

/** A click or key that lands on a link, button or field inside the element is that control's. */
function fromControl(e: Event, el: Element): boolean {
  const control = (e.target as Element | null)?.closest?.("a, button, input, select, textarea, label");
  return !!control && control !== el && el.contains(control);
}

/**
 * Marks every selectable element in `el`'s panel against the current selections. The first one
 * picked in each roving group becomes the item Tab lands on there.
 */
function markAll(el: Element): void {
  // Outside an app (a view drawn on its own) the whole tree it hangs in stands in for the panel.
  let scope: Element = el.closest(".gz-panel") ?? el;
  if (scope === el) while (scope.parentElement) scope = scope.parentElement;
  const stopped = new Set<Group>();
  for (const item of scope.querySelectorAll(".gz-selectable")) {
    const pick = PICKS.get(item);
    if (!pick) continue;
    const on = sameRow(pick.p, pickedIn(pick.p, pick.ctx, pick.root), pick.row);
    mark(item, on, pick.keyboard);
    const group = MEMBERS.get(item);
    if (on && group && !stopped.has(group)) {
      stopped.add(group);
      setStop(group, item);
    }
  }
}

/**
 * Whether a panel's rows can be picked: it names a selection, or shows a detail of the picked row.
 * In an app with a side sheet (`ctx.open`), a `record` (a table row, list item, card or timeline
 * mark) can always be picked, to open it there.
 */
export function picks(p: Panel, ctx?: PanelCtx, record = false): boolean {
  return p.select !== undefined || p.detail !== undefined || (record && ctx?.open !== undefined);
}

/**
 * Makes `el` (a list item, a table row, a bar, a slice, a legend entry) pick `row` as the panel's
 * `select`, and for its `detail`: a button for the mouse and keyboard (Enter or Space), marked
 * `gz-selected` while its row is the one picked. Picking it again clears the pick. Every element
 * of the panel is marked again in place, so the panel isn't redrawn; its detail area is drawn
 * again. Does nothing when the panel has neither `select` nor `detail`, unless `el` is a `record`
 * in an app with a side sheet. There, a pick opens the sheet (with `label` as the element's name)
 * instead of drawing the detail, and picking it again closes it.
 * Inside a roving group (see `roving`) the element is one of the items its one Tab stop moves
 * between. With `keyboard` false only the pointer picks with it, for a mark whose pick another
 * element offers the keyboard and screen readers (a pie's slice, beside its legend entry).
 * Returns what a view that updates rows in place calls with the row's new values: the element then
 * picks those, and a selection of this row takes them too.
 */
export function selectable(el: Element, p: Panel, ctx: PanelCtx, row: Row, label?: string, record = false, keyboard = true): (row: Row) => void {
  if (!picks(p, ctx, record)) return () => {};
  const name = p.select;
  const root = ownerOf(el);
  const pick: Picker = { p, ctx, row, root, label, record, keyboard };
  PICKS.set(el, pick);
  el.classList.add("gz-selectable");
  if (keyboard) {
    el.setAttribute("role", "button");
    if (label) el.setAttribute("aria-label", label);
  }
  mark(el, sameRow(p, pickedIn(p, ctx, root), row), keyboard);
  if (keyboard) rove(el);
  const toggle = () => {
    const next = sameRow(p, pickedIn(p, ctx, root), pick.row) ? undefined : pick.row;
    if (name !== undefined) ctx.select(name, next);
    else if (root) OWN.get(root)!.pick = next;
    markAll(el);
    if (ctx.open) ctx.open(next && sheetPick(el, pick));
    else if (root) drawDetail(root);
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

// ---- One Tab stop per panel ----------------------------------------------------------------------

/**
 * Where an arrow key on `from` moves the focus among the items of its group (`from` itself at an
 * end, so the page doesn't scroll instead); undefined leaves the key to the browser.
 */
export type Step = (from: Element, key: string, items: Element[]) => Element | undefined;

/** Steps back and on through the items in their order, with the keys given. */
function along(back: string[], on: string[]): Step {
  return (from, key, items) => {
    const i = items.indexOf(from);
    if (back.includes(key)) return items[i - 1] ?? from;
    if (on.includes(key)) return items[i + 1] ?? from;
    return undefined;
  };
}

/** Rows and list items, one under another. Left and right are left to a table that scrolls sideways. */
export const UP_DOWN = along(["ArrowUp"], ["ArrowDown"]);
/** Bars and dots, along the x axis. */
export const LEFT_RIGHT = along(["ArrowLeft"], ["ArrowRight"]);
/** Items that wrap in rows (cards, a legend): every arrow steps back or on. */
export const ANY_ARROW = along(["ArrowUp", "ArrowLeft"], ["ArrowDown", "ArrowRight"]);

interface Group {
  root: Element;
  step?: Step;
  /** The item Tab lands on, the one item with tabindex 0. */
  stop?: Element;
}

/** Roving groups by the element they were declared on, and each item's group. */
const GROUPS = new WeakMap<Element, Group>();
const MEMBERS = new WeakMap<Element, Group>();

function itemsOf(group: Group): Element[] {
  return [...group.root.querySelectorAll("[tabindex]")].filter((el) => MEMBERS.get(el) === group);
}

function setStop(group: Group, item: Element): void {
  if (group.stop && group.stop !== item) group.stop.setAttribute("tabindex", "-1");
  item.setAttribute("tabindex", "0");
  group.stop = item;
}

/**
 * Makes the items drawn in `root` (pickable rows, days, cards, bars, dots) one Tab stop, so the
 * keyboard can get past a panel of many: Tab lands on the item picked, else on the first, and on
 * the item last focused while the focus stays in the group. `step` moves the focus with the arrow
 * keys, and Home and End go to the first and last item. Moving the focus doesn't pick; Enter and
 * Space do, as before. Declare the group before its items are drawn; an item outside any group is
 * a Tab stop of its own. `root` is an HTML element, around a chart rather than the chart: Chromium
 * puts an SVG element that listens for the focus in the Tab order.
 */
export function roving(root: Element, step?: Step): void {
  const group: Group = { root, step };
  GROUPS.set(root, group);
  const member = (target: EventTarget | null) => (MEMBERS.get(target as Element) === group ? (target as Element) : undefined);
  root.addEventListener("focusin", (e) => {
    const item = member(e.target);
    if (item) setStop(group, item);
  });
  // Leaving the group, Tab comes back to the item picked, wherever the arrows left the focus.
  root.addEventListener("focusout", (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && root.contains(to)) return;
    const picked = itemsOf(group).find((el) => el.classList.contains("gz-selected"));
    if (picked) setStop(group, picked);
  });
  root.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    const from = member(e.target);
    if (!from || k.altKey || k.ctrlKey || k.metaKey) return;
    const items = itemsOf(group);
    const to = k.key === "Home" ? items[0] : k.key === "End" ? items.at(-1) : step?.(from, k.key, items);
    if (!to) return;
    e.preventDefault();
    setStop(group, to);
    (to as HTMLElement).focus();
  });
}

/** The roving group `el` is drawn in, if any. */
function groupAround(el: Element): Group | undefined {
  for (let x = el.parentElement; x; x = x.parentElement) {
    const group = GROUPS.get(x);
    if (group) return group;
  }
  return undefined;
}

/**
 * Puts `el`, an element that takes the focus, in the roving group it is drawn in: it becomes the
 * group's Tab stop when it is the first item, or the first one picked; otherwise the arrow keys
 * reach it. Outside a group it is a Tab stop of its own. `selectable` does this for its elements.
 */
export function rove(el: Element): void {
  const group = groupAround(el);
  if (!group) {
    el.setAttribute("tabindex", "0");
    return;
  }
  MEMBERS.set(el, group);
  const stop = group.stop;
  if (!stop || !group.root.contains(stop) || (el.classList.contains("gz-selected") && !stop.classList.contains("gz-selected"))) setStop(group, el);
  else el.setAttribute("tabindex", "-1");
}

// ---- Charts for screen readers -------------------------------------------------------------------

/** A chart's values as a table: what it is called, a heading for x then one for each series, and a row for each point. */
export interface PointsTable {
  caption: string;
  head: string[];
  rows: string[][];
}

/**
 * Names a drawn chart for screen readers with `summary`, a sentence of what it shows. A chart
 * whose marks take the focus (bars to pick, dots) is a group of those marks, the rest of its
 * drawing hidden, since the marks and the summary say it; any other chart is one image. `points`,
 * when given, follows the chart as a visually hidden table, to step through every value.
 */
export function describeChart(root: SVGElement, summary: string, points?: PointsTable): void {
  root.setAttribute("aria-label", summary);
  const marks = root.querySelector("[tabindex]") !== null;
  root.setAttribute("role", marks ? "group" : "img");
  if (marks) for (const child of root.children) if (!child.hasAttribute("tabindex")) child.setAttribute("aria-hidden", "true");
  const parent = root.parentElement;
  if (!points || !parent) return;
  // A table grows to fit its cells whatever its width, so a box around it is what hides it.
  const box = parent.createDiv({ cls: "gz-sr-only" });
  parent.insertBefore(box, root.nextSibling);
  const table = box.createEl("table");
  table.createEl("caption", { text: points.caption });
  const head = table.createEl("thead").createEl("tr");
  for (const text of points.head) head.createEl("th", { text, attr: { scope: "col" } });
  const body = table.createEl("tbody");
  for (const row of points.rows) {
    const tr = body.createEl("tr");
    row.forEach((text, i) => (i === 0 ? tr.createEl("th", { text, attr: { scope: "row" } }) : tr.createEl("td", { text })));
  }
}

/** Names in a sentence: "a", "a and b", "a, b and c". */
export function listed(names: string[]): string {
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
    saved = v === undefined || v === null ? "" : textOf(v);
    input.value = saved;
  };
}

/**
 * Shown as it was (`ctx.readOnly`), a panel that is only there to write (a button, a form, a
 * checklist) stays in its place, faded, and takes no focus, typing or clicks.
 */
export function stillInPast(el: HTMLElement, ctx: PanelCtx): void {
  if (!ctx.readOnly) return;
  el.setAttribute("inert", "");
  el.classList.add("gz-readonly");
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
