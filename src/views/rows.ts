import { fillWith, getPath, rowsOf, type Row } from "../data.ts";
import { display, formatErrors, formatFor, labelOf, mapped } from "../format.ts";
import type { Panel } from "../spec.ts";
import { CELL_KINDS, drawCell } from "./cells.ts";
import {
  busy, fieldControl, groupedTotals, heading, noteLink, redraw, rowActionErrors, rowKey, rowNote, selectable, shownRows,
} from "./common.ts";
import { ACTION_KEYS, DATA_KEYS, GROUP_KEYS } from "../keys.ts";
import { editErrors } from "../edit.ts";
import type { PanelCtx, ViewDef } from "./registry.ts";

const HIDDEN_COLUMNS = new Set(["path", "mtime", "ctime", "tags", "position"]);

/** A row's own button, running the panel's actions with that row. */
function rowAction(parent: HTMLElement, p: Panel, ctx: PanelCtx, row: () => Row): void {
  if (!p.action) return;
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

/** A column of plain numbers (gaps allowed), whose heading sits over them on the right. */
function numericColumn(p: Panel, c: string, rows: Row[]): boolean {
  if (cellKind(p, c) || p.edit?.includes(c)) return false;
  const values = rows.map((r) => getPath(r, c)).filter((v) => v !== undefined && v !== null && v !== "");
  return values.length > 0 && values.every((v) => numeric(p, c, v));
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

/** A drawn table or set of cards: what it shows, and how to show new values of the same rows in place. */
interface Drawn {
  columns: string[];
  keys: unknown[];
  patch(rows: Row[]): void;
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
}

/** A drawn row: its element, and what shows the row's new values in it. */
interface DrawnRow {
  el: HTMLElement;
  show(row: Row): void;
}

/** One column of row `i` in `box` (a table cell, a card's line): an input when edited, else what the cell draws. */
function column(box: HTMLElement, env: RowEnv, c: string, i: number, title = false): (row: Row) => void {
  const type = env.edited.get(c);
  if (type === undefined) return (row) => { box.empty(); fillCell(box, env.p, env.ctx, row, c, title); };
  // A cell has no label of its own; anything but a number, date or time is edited as one line of text.
  const show = fieldControl(box, type, (value) => env.ctx.editRow(env.current[i], c, value), {
    cls: "gz-edit", label: c, input: (t) => (["number", "date", "time"].includes(t) ? t : "text"),
  });
  return (row) => show(getPath(row, c));
}

function tableRow(body: HTMLElement, env: RowEnv, r: Row, i: number): DrawnRow {
  const tr = body.createEl("tr");
  const cells = env.columns.map((c) => column(tr.createEl("td"), env, c, i));
  for (const cell of cells) cell(r);
  if (env.p.action) rowAction(tr.createEl("td", { cls: "gz-row-actions" }), env.p, env.ctx, () => env.current[i]);
  return { el: tr, show: (row) => cells.forEach((cell) => cell(row)) };
}

/** A card: the first picture on top, the next column as the title, the others as label and value lines. */
function card(grid: HTMLElement, env: RowEnv, r: Row, i: number): DrawnRow {
  const { p } = env;
  const el = grid.createDiv({ cls: "gz-rowcard" });
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

function drawRows(el: HTMLElement, p: Panel, ctx: PanelCtx, rows: Row[]): Drawn | undefined {
  heading(el, p, p.label);
  if (rows.length === 0) { el.createDiv({ cls: "gz-empty", text: "Nothing here yet." }); return undefined; }
  const env: RowEnv = {
    p, ctx, columns: columnsOf(p, rows), edited: new Map((p.edit ?? []).map((f) => [f, editType(p, f, rows)])), current: [...rows],
  };
  const cards = p.layout === "cards";
  let parent: HTMLElement;
  if (cards) {
    parent = el.createDiv({ cls: "gz-cards" });
  } else {
    const table = el.createDiv({ cls: "gz-table-wrap" }).createEl("table", { cls: "gz-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const c of env.columns) head.createEl("th", { text: labelOf(p, c), cls: numericColumn(p, c, rows) ? "gz-num" : undefined });
    if (p.action) head.createEl("th");
    parent = table.createEl("tbody");
  }
  const updates: ((r: Row) => void)[] = [];
  shownRows(el, env.current, (r) => {
    const drawn = (cards ? card : tableRow)(parent, env, r, updates.length);
    const repick = selectable(drawn.el, p, ctx, r);
    updates.push((row) => {
      drawn.show(row);
      repick(row);
    });
  });
  return {
    columns: env.columns,
    keys: rows.map(rowKey),
    patch(next) {
      env.current.splice(0, env.current.length, ...next);
      next.forEach((r, i) => updates[i]?.(r));
    },
  };
}

export const table: ViewDef = {
  id: "table",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "columns", "agg", "of", "max", "label", "decimals", "format", "labels", "values", "cells", "layout", "select", "detail", "action", ...ACTION_KEYS, "edit", "alert"],
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
    return {
      update(data) {
        const rows = rowsOf(data);
        // The same rows back after a write are updated in place, so focus and typing in other cells stay.
        const keys = rows.map(rowKey);
        if (drawn && p.edit && keys.every((k) => k !== undefined) && sameList(drawn.keys, keys) && sameList(drawn.columns, columnsOf(p, rows))) {
          drawn.patch(rows);
          return;
        }
        el.empty();
        drawn = drawRows(el, p, ctx, rows);
      },
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

export const list: ViewDef = {
  id: "list",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "item", "label", "decimals", "format", "labels", "values", "select", "detail", "action", ...ACTION_KEYS, "alert"],
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
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p, p.label);
    const rows = rowsOf(data);
    if (rows.length === 0) { el.createDiv({ cls: "gz-empty", text: "Nothing here yet." }); return; }
    const ul = el.createEl("ul", { cls: "gz-list" });
    shownRows(el, rows, (r) => {
      const item = p.item ?? (p.group ? `{${p.group}} · {count}` : undefined);
      const text = item ? fillWith(item, r, (path, v) => display(p, path, v, ctx.now, "text")) + countLabel(p) : plainItem(p, r, ctx.now);
      const li = ul.createEl("li");
      const note = rowNote(p, r);
      if (note) noteLink(li, text, note, ctx);
      else li.setText(text);
      rowAction(li, p, ctx, () => r);
      selectable(li, p, ctx, r);
    });
  }),
};
