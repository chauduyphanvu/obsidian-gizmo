import { extent, fillWith, getPath, rowsOf, toNumber, type Row } from "../data.ts";
import { display, formatErrors, formatFor, formatWith, labelOf, mapped } from "../format.ts";
import type { Panel } from "../spec.ts";
import { DAY, periodStart, toTime, wallTime } from "../time.ts";
import { CELL_KINDS, drawCell } from "./cells.ts";
import {
  ANY_ARROW, UP_DOWN, busy, conflictChip, emptyText, fieldControl, groupedTotals, heading, noteLink, roving, rowActionErrors, rowKey, rowNote, selectable, shownRows, whyEmpty,
} from "./common.ts";
import { ACTION_KEYS, DATA_KEYS, GROUP_KEYS } from "../keys.ts";
import { editErrors } from "../edit.ts";
import type { PanelCtx, ViewDef } from "./registry.ts";

const HIDDEN_COLUMNS = new Set(["path", "mtime", "ctime", "tags", "position"]);

/** A row's own button, running the panel's actions with that row. */
export function rowAction(parent: HTMLElement, p: Panel, ctx: PanelCtx, row: () => Row): void {
  if (!p.action || ctx.readOnly) return;
  const b = parent.createEl("button", { cls: "gz-small gz-row-action", text: p.action });
  busy(b, () => ctx.runActions(p, row()));
}

function editProblems(p: Panel): string[] {
  if (!p.edit) return [];
  if (p.group) return ["edit can't change grouped rows"];
  const hidden = p.columns ? p.edit.filter((f) => !p.columns!.includes(f)).map((f) => `edit: "${f}" isn't one of the columns`) : [];
  return [...editErrors(p, p.edit), ...hidden];
}

/** The columns a table shows: as typed, a group's key and count, or its rows' first fields and every edited one. */
function columnsOf(p: Panel, rows: Row[]): string[] {
  if (p.columns) return p.columns;
  if (p.group) return [p.group, "count"];
  const first = Object.keys(rows[0]).filter((k) => !HIDDEN_COLUMNS.has(k)).slice(0, 6);
  return [...first, ...(p.edit ?? []).filter((f) => !first.includes(f))];
}

const cellKind = (p: Panel, c: string) => (p.cells && Object.hasOwn(p.cells, c) ? p.cells[c] : undefined);

/** `cells` and `layout` problems: kinds that aren't one, and cells for columns that aren't shown. */
function cellProblems(p: Panel): string[] {
  const kinds = Object.entries(p.cells ?? {}).flatMap(([field, kind]) => [
    ...(CELL_KINDS.includes(kind) ? [] : [`cells.${field}: must be one of ${CELL_KINDS.join(", ")}`]),
    ...(p.columns && !p.columns.includes(field) ? [`cells: "${field}" isn't one of the columns`] : []),
  ]);
  return [...kinds, ...(p.layout !== undefined && p.layout !== "cards" ? ["layout must be cards"] : [])];
}

/** A value shown as a number, so set right-aligned: a number that `values` doesn't turn into words. */
function numeric(p: Panel, c: string, v: unknown): boolean {
  return typeof v === "number" && mapped(p, c, v) === undefined;
}

/** A column of plain numbers (gaps allowed), edited or not: what a ledger totals. */
function numbers(p: Panel, c: string, rows: Row[]): boolean {
  if (cellKind(p, c)) return false;
  const values = rows.map((r) => getPath(r, c)).filter((v) => v !== undefined && v !== null && v !== "");
  return values.length > 0 && values.every((v) => numeric(p, c, v));
}

/** A column of plain numbers that isn't edited, whose heading sits over them on the right. */
function numericColumn(p: Panel, c: string, rows: Row[], edited: Map<string, unknown>): boolean {
  return !edited.has(c) && numbers(p, c, rows);
}

// ---- Ledgers -------------------------------------------------------------------------------------

/** A ledger: rows in date order, grouped by the day or week of one date field. */
export interface Ledger {
  field: string;
  per: "day" | "week";
}

/** The share of a field's values that must be times for it to be a ledger's date. */
const DATED = 0.8;
/** Rows of a date-only field that span more than this are grouped by week. */
const WEEKLY_AFTER = 14 * DAY;
/** How long a row that just arrived is marked, in ms. */
const FRESH_MS = 1800;

const dateOnly = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A date field's own format: a text `format` is for numbers only, so it says nothing about a date. */
const dateFormat = (p: Panel, field: string) => (typeof p.format === "string" ? undefined : formatFor(p, field));

/** Whether no value of a date field carries a time of day, so a day's rows need no clock. */
const datesOnly = (rows: Row[], field: string) => rows.every((r) => {
  const v = getPath(r, field);
  return toTime(v) === undefined || dateOnly(v);
});

function inOrder(times: number[]): boolean {
  let up = true, down = true;
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) up = false;
    if (times[i] > times[i - 1]) down = false;
  }
  return up || down;
}

/**
 * How a table or list is grouped as a ledger, or nothing when it isn't one. A ledger has no `group`
 * (grouped rows are totals already), isn't cards, has two rows or more, and is in date order by a
 * date field: the `sort` field when most of its values are times, else `at` when it is a shown
 * column (`columns` is undefined for a list, where any field of the rows will do). A date field with
 * no time of day (or formatted as `date`) over more than two weeks is grouped by week, else by day.
 */
export function ledgerBy(p: Panel, rows: Row[], columns?: readonly string[]): Ledger | undefined {
  if (p.group || p.layout === "cards" || rows.length < 2) return undefined;
  const sorted = p.sort?.replace(/^-/, "");
  const fields = new Set([sorted, !columns || columns.includes("at") ? "at" : undefined]);
  for (const field of fields) {
    if (field === undefined) continue;
    const times = rows.map((r) => toTime(getPath(r, field))).filter((t): t is number => t !== undefined);
    // Sorting by the field already puts the rows in its order.
    if (times.length < rows.length * DATED || (field !== sorted && !inOrder(times))) continue;
    const [first, last] = extent(times);
    const noClock = dateFormat(p, field) === "date" || datesOnly(rows, field);
    return { field, per: noClock && last - first > WEEKLY_AFTER ? "week" : "day" };
  }
  return undefined;
}

/** How a ledger draws its date column: as a clock (`clock`), or not at all when the group says it (`dropped`). */
interface LedgerLook {
  ledger?: Ledger;
  clock?: string;
  dropped?: string;
}

/**
 * A ledger's date column shows the time of day under a day's heading, or the date under a week's,
 * whatever the panel formats it as; with no time of day to show, the column goes. A column that is
 * edited or drawn as a `cells` kind stays as it is.
 */
function ledgerLook(p: Panel, rows: Row[], columns: string[], edited: Map<string, unknown>): LedgerLook {
  const ledger = ledgerBy(p, rows, columns);
  if (!ledger) return {};
  const clock = columns.includes(ledger.field) && !edited.has(ledger.field) && !cellKind(p, ledger.field) ? ledger.field : undefined;
  const dropped = clock && columns.length > 1 && ledger.per === "day" && datesOnly(rows, clock) ? clock : undefined;
  return { ledger, clock, dropped };
}

/** The start of the day or week a row's date falls in, as lived; undefined when it has none. */
function bucketOf(ledger: Ledger, row: Row): number | undefined {
  const t = wallTime(getPath(row, ledger.field));
  return t === undefined ? undefined : periodStart(t, ledger.per);
}

/** `Fri Nov 20`, or `Nov 2` without the weekday; the year follows when it isn't this one. */
function shortDate(t: number, now: Date, weekday: boolean): string {
  const d = new Date(t);
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, o);
  const text = `${weekday ? `${part({ weekday: "short" })} ` : ""}${part({ month: "short" })} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? text : `${text}, ${d.getFullYear()}`;
}

/** A group's heading: Today, Yesterday, a weekday or a date; This week, Last week or the week's first day. */
function whenText(start: number, per: Ledger["per"], now: Date): string {
  const t = now.getTime();
  if (per === "week") {
    const weeks = Math.round((periodStart(t, "week") - start) / (7 * DAY));
    return weeks === 0 ? "This week" : weeks === 1 ? "Last week" : `Week of ${shortDate(start, now, false)}`;
  }
  const days = Math.round((periodStart(t, "day") - start) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return days > 1 && days <= 6 ? new Date(start).toLocaleDateString(undefined, { weekday: "long" }) : shortDate(start, now, true);
}

/**
 * What a group's heading says besides its day: a currency column's sum, or another number's
 * average; nothing when the group has no numbers. `kinds` are the shown columns whose field is a
 * choice: rows that differ in one are different things (a weight and a pulse), which no average
 * spans; money is money whatever its category, so a sum still does.
 */
function totalText(p: Panel, column: string, rows: Row[], now: Date, kinds: readonly string[] = []): string {
  const nums = rows.map((r) => toNumber(getPath(r, column))).filter((n): n is number => n !== undefined);
  if (nums.length === 0) return "";
  const differs = (k: string) => new Set(rows.map((r) => JSON.stringify(getPath(r, k) ?? null))).size > 1;
  // Rows in different units have no total, whether or not the field that gives their unit is shown.
  const unitBy = p.fieldInfo?.[column]?.unitBy?.field;
  if (unitBy !== undefined && differs(unitBy)) return "";
  const sum = nums.reduce((a, b) => a + b, 0);
  if (/[$€£¥]/.test(formatFor(p, column) ?? "")) return display(p, column, sum, now);
  if (kinds.some(differs)) return "";
  const mean = sum / nums.length;
  const wholes = nums.every(Number.isInteger) && Number.isInteger(Math.round(mean * 10) / 10);
  return `avg ${display({ ...p, decimals: p.decimals ?? (wholes ? 0 : 1) }, column, mean, now)}`;
}

/** The shown fields that are a choice in the fields the panel's rows were saved with. */
function choiceColumns(p: Panel, shown: readonly string[]): string[] {
  return shown.filter((c) => Array.isArray(p.schema?.[c]));
}

/** Draws a ledger's group headings as its rows arrive, and keeps each heading's total. */
interface Grouping {
  /** Before row `i` is drawn: the heading of its group, if it starts one. */
  enter(i: number): void;
  /** Every total again, from the rows as they are now. */
  retotal(): void;
  /** Whether these rows, as far as drawn, fall in the groups they were drawn in. */
  holds(rows: Row[]): boolean;
}

/** `rows` is read as it is when a total is drawn, so a view that updates rows in place keeps it current. */
function grouping(ledger: Ledger, now: Date, rows: Row[], heading: () => HTMLElement, totalOf: (rows: Row[]) => string): Grouping {
  const buckets: (number | undefined)[] = [];
  const groups: { total: HTMLElement; members: number[] }[] = [];
  const retotal = (g: (typeof groups)[number]) => g.total.setText(totalOf(g.members.map((i) => rows[i])));
  let at: number | undefined;
  return {
    enter(i) {
      const bucket = bucketOf(ledger, rows[i]);
      buckets.push(bucket);
      if (bucket !== undefined && bucket !== at) {
        at = bucket;
        const head = heading();
        head.createSpan({ cls: "gz-ledger-when", text: whenText(bucket, ledger.per, now) });
        groups.push({ total: head.createSpan({ cls: "gz-ledger-total" }), members: [] });
      }
      // Rows with no date before the first dated one have no group.
      const group = groups.at(-1);
      if (!group) return;
      group.members.push(i);
      retotal(group);
    },
    retotal() { groups.forEach(retotal); },
    holds: (next) => buckets.every((b, i) => bucketOf(ledger, next[i]) === b),
  };
}

/** What a draw knows of the rows that are new since the last one. */
interface Arrivals {
  keys: unknown[];
  /** Keys of rows not shown last time; nothing on a panel's first draw. */
  fresh: Set<unknown>;
  /** Marks a row's element as new for a moment. */
  mark(el: Element): void;
}

/** Remembers which rows were shown, so the next draw can tell the new ones; its timers end with `stop`. */
function rowMemory() {
  let seen: Set<unknown> | undefined;
  const timers = new Set<number>();
  return {
    arrive(rows: Row[]): Arrivals {
      const keys = rows.map(rowKey);
      const before = seen;
      seen = new Set(keys);
      return {
        keys,
        fresh: new Set(before ? keys.filter((k) => k !== undefined && !before.has(k)) : []),
        mark(el) {
          el.classList.add("gz-fresh");
          const timer = window.setTimeout(() => {
            el.classList.remove("gz-fresh");
            timers.delete(timer);
          }, FRESH_MS);
          timers.add(timer);
        },
      };
    },
    stop: () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    },
  };
}

/**
 * A cell's value: drawn as its `cells` kind, else as text. A note's name links to the note, and so
 * does a card's title, when the row is a note.
 */
function fillCell(box: HTMLElement, p: Panel, ctx: PanelCtx, r: Row, c: string, title = false): void {
  const v = getPath(r, c);
  const kind = cellKind(p, c);
  if (kind) return drawCell(box, kind, v, r, p, ctx, c);
  const text = display(p, c, v, ctx.now, "cell");
  const note = c === "name" || title ? rowNote(p, r) : undefined;
  if (note) noteLink(box, text, note, ctx);
  else box.setText(text);
  box.classList.toggle("gz-num", numeric(p, c, v));
}

/** How an edited column is typed in: the block's field type when it has `fields`, else what its values are. */
function editType(p: Panel, field: string, rows: Row[]): string | string[] {
  const typed = p.schema?.[field];
  if (typed !== undefined) return typed;
  const sample = rows.map((r) => getPath(r, field)).find((v) => v !== undefined && v !== null);
  return typeof sample === "boolean" ? "checkbox" : typeof sample === "number" ? "number" : "text";
}

/**
 * A drawn table or set of cards: what it shows, and how to show new values of the same rows in
 * place; false when they no longer fall in the same groups, and the rows are to be drawn again.
 */
interface Drawn {
  columns: string[];
  keys: unknown[];
  patch(rows: Row[]): boolean;
}

const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What drawing one row needs, whether it is a table row or a card. */
interface RowEnv {
  p: Panel;
  ctx: PanelCtx;
  columns: string[];
  edited: Map<string, string | string[]>;
  /** The rows as last shown: buttons and inputs read their row here, so it stays current. */
  current: Row[];
  ledger?: Ledger;
  /** The date column a ledger shows as a clock. */
  clock?: string;
  /** The column read as each row's name. */
  lead?: string;
}

/** A drawn row: its element, and what shows the row's new values in it. */
interface DrawnRow {
  el: HTMLElement;
  show(row: Row): void;
}

/** A ledger's date cell: the time of day under a day's heading, the date under a week's; undefined for a value that isn't a time. */
function clockText(env: RowEnv, row: Row, c: string): string | undefined {
  const v = getPath(row, c);
  const t = wallTime(v);
  if (t === undefined || !env.ledger) return undefined;
  return env.ledger.per === "week" ? shortDate(t, env.ctx.now, true) : formatWith(v, "time", env.ctx.now);
}

/** One column of row `i` in `box` (a table cell, a card's line): an input when edited, else what the cell draws. */
function column(box: HTMLElement, env: RowEnv, c: string, i: number, title = false): (row: Row) => void {
  const type = env.edited.get(c);
  if (c === env.lead) box.addClass("gz-lead");
  if (c === env.clock) {
    return (row) => {
      box.empty();
      const when = clockText(env, row, c);
      if (when === undefined) fillCell(box, env.p, env.ctx, row, c);
      else box.setText(when);
      box.classList.toggle("gz-ledger-time", when !== undefined);
    };
  }
  if (type === undefined) return (row) => { box.empty(); fillCell(box, env.p, env.ctx, row, c, title); };
  // A cell has no label of its own; anything but a number, date or time is edited as one line of text.
  const show = fieldControl(box, type, (value) => env.ctx.editRow(env.current[i], c, value), {
    cls: "gz-edit", label: c, input: (t) => (["number", "date", "time"].includes(t) ? t : "text"),
  });
  if (type === "number") box.addClass("gz-num");
  return (row) => {
    show(getPath(row, c));
    conflictChip(box, row, c, (value) => env.ctx.editRow(env.current[i], c, value));
  };
}

/**
 * The fields a record of this panel shows, for the side sheet, each the panel edits in place with
 * how it is typed in: a table's columns and its edited ones; a board's fields, with the one its
 * cards move between; a list's or a timeline's fields, less a note's file details.
 */
export function rowFields(p: Panel, row: Row): [field: string, type?: string | string[]][] {
  const fields = p.view === "table" ? columnsOf(p, [row]) : Object.keys(row).filter((k) => !HIDDEN_COLUMNS.has(k));
  if (p.view === "board" && p.group && !fields.includes(p.group)) fields.push(p.group);
  const edited = p.view === "board" ? [p.group] : p.view === "table" ? p.edit ?? [] : [];
  return fields.map((f) => (edited.includes(f) ? [f, editType(p, f, [row])] : [f]));
}

/**
 * One field of a row in `box`, for the side sheet: the control an edited cell gets when `type` is
 * given and the app isn't shown as it was, writing through the panel's editRow, else the value as
 * its cell draws it. Returns what shows the row's new values, which leaves a field being typed in alone.
 */
export function fieldBox(box: HTMLElement, p: Panel, ctx: PanelCtx, row: Row, field: string, type?: string | string[]): (row: Row) => void {
  const env: RowEnv = { p, ctx, columns: [field], edited: new Map(type === undefined || ctx.readOnly || ctx.theirs?.(row) ? [] : [[field, type]]), current: [row] };
  const show = column(box, env, field, 0);
  show(row);
  return (next) => {
    env.current[0] = next;
    show(next);
  };
}

/**
 * The env one row is drawn with: a row someone else wrote in a shared kind has no edited cell, and
 * says why on `el`. The same row keeps who wrote it, so a row drawn again in place keeps its env.
 */
function rowEnv(env: RowEnv, r: Row, el: HTMLElement): RowEnv {
  const theirs = env.edited.size ? env.ctx.theirs?.(r) : undefined;
  if (!theirs) return env;
  el.setAttribute("title", theirs);
  return { ...env, edited: new Map() };
}

function tableRow(body: HTMLElement, all: RowEnv, r: Row, i: number): DrawnRow {
  const tr = body.createEl("tr");
  const env = rowEnv(all, r, tr);
  const cells = env.columns.map((c) => column(tr.createEl("td"), env, c, i));
  for (const cell of cells) cell(r);
  if (env.p.action) rowAction(tr.createEl("td", { cls: "gz-row-actions" }), env.p, env.ctx, () => env.current[i]);
  return { el: tr, show: (row) => cells.forEach((cell) => cell(row)) };
}

/** A card: the first picture on top, the next column as the title, the others as label and value lines. */
function card(grid: HTMLElement, all: RowEnv, r: Row, i: number): DrawnRow {
  const el = grid.createDiv({ cls: "gz-rowcard" });
  const env = rowEnv(all, r, el);
  const { p } = env;
  const image = env.columns.find((c) => cellKind(p, c) === "image" && !env.edited.has(c));
  const [title, ...rest] = env.columns.filter((c) => c !== image);
  const shows: ((row: Row) => void)[] = [];
  if (image) shows.push(column(el.createDiv({ cls: "gz-rowcard-image" }), env, image, i));
  if (title) shows.push(column(el.createDiv({ cls: "gz-rowcard-title" }), env, title, i, true));
  for (const c of rest) {
    const line = el.createDiv({ cls: "gz-rowcard-line" });
    line.createSpan({ cls: "gz-rowcard-label", text: labelOf(p, c) });
    shows.push(column(line.createSpan({ cls: "gz-rowcard-value" }), env, c, i));
  }
  for (const show of shows) show(r);
  if (p.action) rowAction(el.createDiv({ cls: "gz-rowcard-actions" }), p, env.ctx, () => env.current[i]);
  return { el, show: (row) => shows.forEach((show) => show(row)) };
}

/** Rows past this many get a box that filters them, as they are drawn, by what their cells say. */
export const FILTER_FROM = 20;

/** What the filter box over a long table holds, and how it sets it. */
interface Filter {
  query: string;
  total: number;
  set(query: string): void;
}

/** Whether a row's cells, as shown or as kept, hold every word of the query. */
function matches(p: Panel, columns: string[], r: Row, query: string, now: Date): boolean {
  const said = columns.map((c) => {
    const v = getPath(r, c);
    if (v === undefined || v === null) return "";
    const raw = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    return `${raw} ${display(p, c, v, now, "text")}`;
  }).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => said.includes(w));
}

function drawRows(el: HTMLElement, p: Panel, ctx: PanelCtx, rows: Row[], news: Arrivals, filter?: Filter): Drawn | undefined {
  heading(el, p, p.label);
  if (filter) {
    const box = el.createDiv({ cls: "gz-filter" });
    const input = box.createEl("input", { type: "search", cls: "gz-filter-input", attr: { placeholder: `Filter ${filter.total} rows`, "aria-label": `Filter ${p.title ?? "rows"}` } });
    input.value = filter.query;
    input.addEventListener("input", () => filter.set(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !input.value) return;
      // A filter typed in goes first; Escape again leaves the box to the tab.
      e.preventDefault();
      e.stopPropagation();
      filter.set("");
    });
    if (filter.query) box.createSpan({ cls: "gz-filter-count gz-muted", text: `${rows.length} of ${filter.total}` });
  }
  if (rows.length === 0 && filter?.query) {
    el.createDiv({ cls: "gz-empty", text: `No row says “${filter.query}”.` });
    return undefined;
  }
  if (rows.length === 0) {
    whyEmpty(el, p, ctx, el.createDiv({ cls: "gz-empty", text: emptyText(p, ctx.now, "Nothing here yet.") }));
    return undefined;
  }
  const all = columnsOf(p, rows);
  // Shown as it was, nothing can be written: an edited column reads as its cells do.
  const edited = new Map(ctx.readOnly ? [] : (p.edit ?? []).map((f) => [f, editType(p, f, rows)] as const));
  const cards = p.layout === "cards";
  const look = cards ? {} : ledgerLook(p, rows, all, edited);
  const env: RowEnv = {
    p, ctx, columns: all.filter((c) => c !== look.dropped), edited, current: [...rows], ledger: look.ledger, clock: look.clock,
  };
  if (!cards) env.lead = env.columns.find((c) => c !== look.ledger?.field && !cellKind(p, c) && !edited.has(c) && !numericColumn(p, c, rows, edited));
  let parent: HTMLElement;
  let groups: Grouping | undefined;
  if (cards) {
    parent = el.createDiv({ cls: "gz-cards" });
    roving(parent, ANY_ARROW);
  } else {
    const table = el.createDiv({ cls: "gz-table-wrap" }).createEl("table", { cls: look.ledger ? "gz-table gz-ledger" : "gz-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const c of env.columns) head.createEl("th", { text: labelOf(p, c), cls: numericColumn(p, c, rows, edited) || edited.get(c) === "number" ? "gz-num" : undefined });
    if (p.action) head.createEl("th");
    parent = table.createEl("tbody");
    roving(parent, UP_DOWN);
    if (look.ledger) {
      const span = env.columns.length + (p.action ? 1 : 0);
      const by = env.columns.find((c) => c !== look.ledger!.field && numbers(p, c, rows));
      // The total ends under the column it adds up; the heading's line runs on under the columns after it.
      const upTo = by === undefined ? span : env.columns.indexOf(by) + 1;
      groups = grouping(
        look.ledger, ctx.now, env.current,
        () => {
          const tr = parent.createEl("tr", { cls: "gz-ledger-group" });
          const head = tr.createEl("th", { attr: { colspan: upTo } }).createDiv({ cls: "gz-ledger-head" });
          if (upTo < span) tr.createEl("th", { attr: { colspan: span - upTo } }).createDiv({ cls: "gz-ledger-head" });
          return head;
        },
        (of) => (by === undefined ? "" : totalText(p, by, of, ctx.now, choiceColumns(p, env.columns))),
      );
    }
  }
  const updates: ((r: Row) => void)[] = [];
  shownRows(el, env.current, (r) => {
    const i = updates.length;
    groups?.enter(i);
    const drawn = (cards ? card : tableRow)(parent, env, r, i);
    if (news.fresh.has(news.keys[i])) news.mark(drawn.el);
    const repick = selectable(drawn.el, p, ctx, r, undefined, true);
    updates.push((row) => {
      drawn.show(row);
      repick(row);
    });
  });
  // Rows shown later, behind "Show all", are not new then.
  news.fresh.clear();
  const shape = JSON.stringify(look);
  return {
    columns: all,
    keys: news.keys,
    patch(next) {
      if (JSON.stringify(cards ? {} : ledgerLook(p, next, all, edited)) !== shape || (groups && !groups.holds(next))) return false;
      env.current.splice(0, env.current.length, ...next);
      next.forEach((r, i) => updates[i]?.(r));
      groups?.retotal();
      return true;
    },
  };
}

export const table: ViewDef = {
  id: "table",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "columns", "agg", "of", "max", "label", "decimals", "format", "labels", "values", "cells", "layout", "select", "detail", "action", ...ACTION_KEYS, "edit", "alert", "empty"],
  span: 4,
  needsSource: true,
  validate: (p) => [...groupedTotals(p, p.columns ?? [], "columns"), ...rowActionErrors("table", p), ...editProblems(p), ...formatErrors(p), ...cellProblems(p)],
  examples: [
    { panel: { view: "table", source: "spending", columns: ["at", "amount", "category"], format: { amount: "$0,0.00", at: "date" } } },
    { panel: { view: "table", source: "spending", format: "0.0.0" }, errors: ['format "0.0.0" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
    { panel: { view: "table", source: "https://api.example.com/daily", pick: "daily", columns: ["time", "weathercode"], labels: { weathercode: "Sky" }, values: { weathercode: { 0: "Clear", 1: "Mostly clear" } } } },
    { panel: { view: "table", source: "spending", labels: "Amount" }, errors: ['"labels" has the wrong type (expected a set of name: text)'] },
    { panel: { view: "table", source: "spending", values: { category: "Food" } }, errors: ['"values" has the wrong type (expected a set of field: {value: text})'] },
    {
      panel: {
        view: "table", source: "notes", from: "Books", columns: ["name", "progress", "trend", "url", "cover", "done"], max: 100,
        cells: { progress: "progress", trend: "sparkline", url: "link", cover: "image", done: "check" },
      },
    },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name", "cover"], cells: { cover: "poster" } }, errors: ["cells.cover: must be one of progress, sparkline, link, image, check"] },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name"], cells: { x: "link" } }, errors: ['cells: "x" isn\'t one of the columns'] },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name", "cover", "status"], cells: { cover: "image" }, layout: "cards", select: "book" } },
    { panel: { view: "table", source: "notes", from: "Books", layout: "cards", action: "Open", open: "{path}", edit: ["status"] } },
    { panel: { view: "table", source: "notes", from: "Books", layout: "grid" }, errors: ["layout must be cards"] },
    { panel: { view: "table", source: "notes", from: "Books", group: "genre", columns: ["genre", "count", "pages"], agg: "sum", sort: "-count" } },
    { panel: { view: "table", source: "sessions", group: "at", per: "month", columns: ["at", "minutes"] }, errors: ["group with columns needs agg (sum, avg, min, max, first or last)"] },
    { panel: { view: "table", source: "notes", from: "Health", sort: "-date", columns: ["name", "date", "who"] } },
    { panel: { view: "table", source: "notes" }, errors: ['source "notes" needs "from" (a #tag or folder)'] },
    { panel: { view: "table", source: "notes", from: "Books", compute: { left: "pages - read" }, sort: "-left", columns: ["name", "left"] } },
    { panel: { view: "table", source: "quotes", compute: { change: "pct(close)" } }, errors: ['compute.change: unknown function "pct"'] },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name", "finished"], select: "book" } },
    { panel: { view: "table", source: "notes", from: "Inbox", columns: ["name"], action: "File", open: "{path}" } },
    { panel: { view: "table", source: "notes", from: "Books", save: "read" }, errors: ['"save" needs "action" on a table'] },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name", "status", "rating"], edit: ["status", "rating"] } },
    { panel: { view: "table", source: "chores", where: { done: false }, edit: ["done"] } },
    { panel: { view: "table", source: "https://api.example.com/tasks", edit: ["done"] }, errors: ["edit works on notes and saved lists"] },
    { panel: { view: "table", source: "notes", from: "Books", group: "status", edit: ["status"] }, errors: ["edit can't change grouped rows"] },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name"], edit: ["status"] }, errors: ['edit: "status" isn\'t one of the columns'] },
    { panel: { view: "table", source: "notes", from: "Books", columns: ["name", "status"], edit: true }, errors: ["edit: true needs fields on the block; or list the columns to edit"] },
    {
      panel: { view: "table", source: "notes", from: "Books", compute: { left: "pages - read" }, edit: ["left", "path"] },
      errors: ['edit: "left" is computed', 'edit: "path" comes from the note\'s file, not its properties'],
    },
    { panel: { view: "table", source: "spending", where: { at: "this month" }, alert: { amount: "> 100" } } },
    { panel: { view: "table", source: "spending", alert: "> 100" }, errors: ['alert on a table needs a field, e.g. alert: {amount: "> 100"}'] },
  ],
  mount(el, p, ctx) {
    let drawn: Drawn | undefined;
    const memory = rowMemory();
    let all: Row[] = [];
    let query = "";
    const draw = (rows: Row[], news: Arrivals) => {
      const long = rows.length > FILTER_FROM;
      if (!long) query = "";
      const shown = query ? rows.filter((r) => matches(p, columnsOf(p, rows), r, query, ctx.now)) : rows;
      const keys = shown.map(rowKey);
      const sees = { ...news, keys };
      // The same rows back after a write are updated in place, so focus and typing in other cells stay.
      if (drawn && p.edit && keys.every((k) => k !== undefined) && sameList(drawn.keys, keys) && sameList(drawn.columns, columnsOf(p, rows)) && drawn.patch(shown)) return;
      // Typing in the filter box, the box drawn again keeps the focus and the caret.
      const typing = el.ownerDocument.activeElement?.classList.contains("gz-filter-input") && el.contains(el.ownerDocument.activeElement);
      memory.stop();
      el.empty();
      drawn = drawRows(el, p, ctx, shown, sees, long ? { query, total: rows.length, set: (q) => { query = q; draw(all, { keys: all.map(rowKey), fresh: new Set(), mark: () => {} }); } } : undefined);
      if (typing) {
        const input = el.querySelector<HTMLInputElement>(".gz-filter-input");
        input?.focus();
        input?.setSelectionRange(query.length, query.length);
      }
    };
    return {
      update(data) {
        all = rowsOf(data);
        draw(all, memory.arrive(all));
      },
      destroy: memory.stop,
    };
  },
};

/** The grouped list's default item counts rows; a label for `count` names what is counted ("3 books"). */
function countLabel(p: Panel): string {
  return !p.item && p.group && p.labels?.count !== undefined ? ` ${labelOf(p, "count")}` : "";
}

/** The item of a list with no `item`: the row's name, title or value, shown as it is unless the panel says how. */
function plainItem(p: Panel, r: Row, now: Date): string {
  const field = ["name", "title", "value"].find((f) => r[f] !== undefined && r[f] !== null);
  if (field === undefined) return JSON.stringify(r);
  return mapped(p, field, r[field]) ?? (formatFor(p, field) !== undefined ? display(p, field, r[field], now, "text") : String(r[field]));
}

/** The fields a list's items show, in order: the paths its `item` fills in, or the one field a plain item shows. */
function itemFields(p: Panel, rows: Row[]): string[] {
  if (p.item) return [...new Set([...p.item.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].trim()))];
  const field = ["name", "title", "value"].find((f) => rows[0][f] !== undefined && rows[0][f] !== null);
  return field ? [field] : [];
}

/** A list item's text: its `item` filled in, a group's key and count, or the row's name, title or value. */
export function listItem(p: Panel, r: Row, now: Date): string {
  const item = p.item ?? (p.group ? `{${p.group}} · {count}` : undefined);
  return item ? fillWith(item, r, (path, v) => display(p, path, v, now, "text")) + countLabel(p) : plainItem(p, r, now);
}

export const list: ViewDef = {
  id: "list",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "item", "label", "decimals", "format", "labels", "values", "select", "detail", "action", ...ACTION_KEYS, "alert", "empty"],
  span: 4,
  needsSource: true,
  validate: (p) => [...rowActionErrors("list", p), ...formatErrors(p)],
  examples: [
    { panel: { view: "list", source: "spending", item: "{note} · {amount}", format: { amount: "$0,0.00" } } },
    { panel: { view: "list", source: "spending", item: "{amount}", format: { amount: "dollars" } }, errors: ['format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
    { panel: { view: "list", source: "notes", from: "#book", group: "tags", labels: { count: "books" }, values: { tags: { fiction: "Fiction" } } } },
    { panel: { view: "list", source: "spending", labels: "Amount" }, errors: ['"labels" has the wrong type (expected a set of name: text)'] },
    { panel: { view: "list", source: "spending", values: { category: "Food" } }, errors: ['"values" has the wrong type (expected a set of field: {value: text})'] },
    { panel: { view: "list", source: "notes", from: "#health/appointment", where: { date: "upcoming" }, sort: "date", item: "{date} · {name}" } },
    { panel: { view: "list", source: "http://example.com/feed.json" }, errors: ["source must use https"] },
    { panel: { view: "list", source: "notes", from: "#book", group: "tags", sort: "-count", limit: 5 } },
    { panel: { view: "list", source: "https://api.example.com/quakes", pick: "features", item: "{properties.place}", select: "quake" } },
    {
      panel: {
        view: "list", source: "https://openlibrary.org/search.json?q=dune", pick: "docs", item: "{title}",
        action: "Add", save: "Books/", name: "{title}", row: { title: "{title}", author: "{author_name.0}" }, notify: "Added {title}",
      },
    },
    { panel: { view: "list", source: "s", notify: "hi", row: { a: "{a}" } }, errors: ['"notify" needs "action" on a list', '"row" needs "action" on a list'] },
    { panel: { view: "list", source: "s", action: "Add" }, errors: ['"action" needs at least one of save, append, notify, open'] },
    { panel: { view: "list", source: "notes", from: "Books", detail: "{name} by {author}, {pages} pages" } },
  ],
  mount(el, p, ctx) {
    const memory = rowMemory();
    return {
      update(data) {
        memory.stop();
        el.empty();
        heading(el, p, p.label);
        const rows = rowsOf(data);
        const news = memory.arrive(rows);
        if (rows.length === 0) {
          whyEmpty(el, p, ctx, el.createDiv({ cls: "gz-empty", text: emptyText(p, ctx.now, "Nothing here yet.") }));
          return;
        }
        const ledger = ledgerBy(p, rows);
        const ul = el.createEl("ul", { cls: ledger ? "gz-list gz-ledger" : "gz-list" });
        roving(ul, UP_DOWN);
        const by = ledger && itemFields(p, rows).find((f) => f !== ledger.field && numbers(p, f, rows));
        const groups = ledger && grouping(
          ledger, ctx.now, rows, () => ul.createEl("li", { cls: "gz-ledger-group" }),
          (of) => (by === undefined ? "" : totalText(p, by, of, ctx.now, choiceColumns(p, itemFields(p, rows)))),
        );
        let i = 0;
        shownRows(el, rows, (r) => {
          groups?.enter(i);
          const text = listItem(p, r, ctx.now);
          const li = ul.createEl("li");
          if (news.fresh.has(news.keys[i++])) news.mark(li);
          const note = rowNote(p, r);
          if (note) noteLink(li, text, note, ctx);
          else li.setText(text);
          rowAction(li, p, ctx, () => r);
          selectable(li, p, ctx, r, undefined, true);
        });
        news.fresh.clear();
      },
      destroy: memory.stop,
    };
  },
};
