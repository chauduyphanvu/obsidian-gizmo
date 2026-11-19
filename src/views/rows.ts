import { fillTemplate, formatValue, getPath, type Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import {
  ACTION_KEYS, DATA_KEYS, GROUP_KEYS, busy, editErrors, groupedTotals, heading, noteLink, redraw, rowActionErrors, rowKey, rowsOf,
  selectable, shownRows,
} from "./common.ts";
import type { PanelCtx, ViewDef } from "./registry.ts";

const HIDDEN_COLUMNS = new Set(["path", "mtime", "ctime", "tags", "position"]);

/** A row's own button, running the panel's actions with that row. */
function rowAction(parent: HTMLElement, p: Panel, ctx: PanelCtx, row: () => Row): void {
  if (!p.action) return;
  const b = parent.createEl("button", { cls: "na-small na-row-action", text: p.action });
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

/** A cell's value as text; a note's name links to the note. */
function fillCell(td: HTMLElement, p: Panel, ctx: PanelCtx, r: Row, c: string): void {
  const v = getPath(r, c);
  const text = formatValue(v, p.decimals);
  if (c === "name" && typeof r.path === "string") noteLink(td, text, r.path, ctx);
  else td.setText(text);
  td.classList.toggle("na-num", typeof v === "number");
}

/** How an edited column is typed in: the block's field type when it has `fields`, else what its values are. */
function editType(p: Panel, field: string, rows: Row[]): string | string[] {
  const typed = p.schema?.[field];
  if (typed !== undefined) return typed;
  const sample = rows.map((r) => getPath(r, field)).find((v) => v !== undefined && v !== null);
  return typeof sample === "boolean" ? "checkbox" : typeof sample === "number" ? "number" : "text";
}

type Control = HTMLInputElement | HTMLSelectElement;

/**
 * An input in one cell. A checkbox or dropdown writes at once; text, numbers and dates when
 * changed (leaving the cell, or Enter). The control is disabled while its write runs. Returns what
 * shows a new value, which leaves text being typed (focused, or changed and not yet saved) alone.
 */
function editCell(td: HTMLElement, field: string, type: string | string[], write: (value: unknown) => Promise<void>): (value: unknown) => void {
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
    const select = td.createEl("select", { cls: "dropdown na-edit" });
    select.setAttr("aria-label", field);
    let options: unknown[] = [];
    select.addEventListener("change", () => void run(select, options[Number(select.value)]));
    return (v) => {
      // A value that isn't one of the choices is still shown as it is.
      options = type.some((c) => c === v) ? type : [v ?? "", ...type];
      select.empty();
      options.forEach((o, i) => {
        const option = select.createEl("option", { text: String(o), value: String(i) });
        if (o === (v ?? "")) option.setAttr("selected", "");
      });
    };
  }
  if (type === "checkbox") {
    const box = td.createEl("input", { type: "checkbox", cls: "na-edit" });
    box.setAttr("aria-label", field);
    box.addEventListener("change", () => void run(box, box.checked));
    return (v) => { box.checked = v === true; };
  }
  const kind = ["number", "date", "time"].includes(type) ? type : "text";
  const input = td.createEl("input", { type: kind, cls: "na-edit" });
  input.setAttr("aria-label", field);
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

/** A drawn table: what it shows, and how to show new values of the same rows in place. */
interface Drawn {
  columns: string[];
  keys: unknown[];
  patch(rows: Row[]): void;
}

const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function drawTable(el: HTMLElement, p: Panel, ctx: PanelCtx, rows: Row[]): Drawn | undefined {
  heading(el, p, p.label);
  if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return undefined; }
  const columns = columnsOf(p, rows);
  const edited = new Map((p.edit ?? []).map((f) => [f, editType(p, f, rows)]));
  const table = el.createDiv({ cls: "na-table-wrap" }).createEl("table", { cls: "na-table" });
  const head = table.createEl("thead").createEl("tr");
  for (const c of columns) head.createEl("th", { text: c });
  if (p.action) head.createEl("th");
  const body = table.createEl("tbody");
  // The rows as last shown: buttons and inputs read their row here, so it stays current.
  const current = [...rows];
  const updates: ((r: Row) => void)[] = [];
  shownRows(el, current, (r) => {
    const i = updates.length;
    const tr = body.createEl("tr");
    const cells = columns.map((c) => {
      const td = tr.createEl("td");
      const type = edited.get(c);
      if (type === undefined) return (row: Row) => { td.empty(); fillCell(td, p, ctx, row, c); };
      const show = editCell(td, c, type, (value) => ctx.editRow(current[i], c, value));
      return (row: Row) => show(getPath(row, c));
    });
    for (const cell of cells) cell(r);
    if (p.action) rowAction(tr.createEl("td", { cls: "na-row-actions" }), p, ctx, () => current[i]);
    const repick = selectable(tr, p, ctx, r);
    updates.push((row) => {
      for (const cell of cells) cell(row);
      repick(row);
    });
  });
  return {
    columns,
    keys: rows.map(rowKey),
    patch(next) {
      current.splice(0, current.length, ...next);
      next.forEach((r, i) => updates[i]?.(r));
    },
  };
}

export const table: ViewDef = {
  id: "table",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "columns", "agg", "label", "decimals", "select", "action", ...ACTION_KEYS, "edit"],
  span: 4,
  needsSource: true,
  validate: (p) => [...groupedTotals(p, p.columns ?? [], "columns"), ...rowActionErrors("table", p), ...editProblems(p)],
  examples: [
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
    {
      panel: { view: "table", source: "notes", from: "Books", compute: { left: "pages - read" }, edit: ["left", "path"] },
      errors: ['edit: "left" is computed', 'edit: "path" comes from the note\'s file, not its properties'],
    },
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
        drawn = drawTable(el, p, ctx, rows);
      },
    };
  },
};

export const list: ViewDef = {
  id: "list",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "item", "label", "decimals", "select", "action", ...ACTION_KEYS],
  span: 4,
  needsSource: true,
  validate: (p) => rowActionErrors("list", p),
  examples: [
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
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p, p.label);
    const rows = rowsOf(data);
    if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return; }
    const ul = el.createEl("ul", { cls: "na-list" });
    shownRows(el, rows, (r) => {
      const item = p.item ?? (p.group ? `{${p.group}} · {count}` : undefined);
      const text = item ? fillTemplate(item, r, p.decimals) : String(r.name ?? r.title ?? r.value ?? JSON.stringify(r));
      const li = ul.createEl("li");
      if (typeof r.path === "string") noteLink(li, text, r.path, ctx);
      else li.setText(text);
      rowAction(li, p, ctx, () => r);
      selectable(li, p, ctx, r);
    });
  }),
};
