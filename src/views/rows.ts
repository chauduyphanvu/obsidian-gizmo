import { fillTemplate, formatValue, getPath, type Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import {
  ACTION_KEYS, DATA_KEYS, GROUP_KEYS, busy, groupedTotals, heading, noteLink, redraw, rowActionErrors, rowsOf, selectable, shownRows,
} from "./common.ts";
import type { PanelCtx, ViewDef } from "./registry.ts";

const HIDDEN_COLUMNS = new Set(["path", "mtime", "ctime", "tags", "position"]);

/** A row's own button, running the panel's actions with that row. */
function rowAction(parent: HTMLElement, p: Panel, ctx: PanelCtx, r: Row): void {
  if (!p.action) return;
  const b = parent.createEl("button", { cls: "na-small na-row-action", text: p.action });
  busy(b, () => ctx.runActions(p, r));
}

export const table: ViewDef = {
  id: "table",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "columns", "agg", "label", "decimals", "select", "action", ...ACTION_KEYS],
  span: 4,
  needsSource: true,
  validate: (p) => [...groupedTotals(p, p.columns ?? [], "columns"), ...rowActionErrors("table", p)],
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
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p, p.label);
    const rows = rowsOf(data);
    if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return; }
    const columns = p.columns ?? (p.group ? [p.group, "count"] : Object.keys(rows[0]).filter((k) => !HIDDEN_COLUMNS.has(k)).slice(0, 6));
    const table = el.createDiv({ cls: "na-table-wrap" }).createEl("table", { cls: "na-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const c of columns) head.createEl("th", { text: c });
    if (p.action) head.createEl("th");
    const body = table.createEl("tbody");
    shownRows(el, rows, (r) => {
      const tr = body.createEl("tr");
      for (const c of columns) {
        const td = tr.createEl("td");
        const v = getPath(r, c);
        const text = formatValue(v, p.decimals);
        if (c === "name" && typeof r.path === "string") noteLink(td, text, r.path, ctx);
        else td.setText(text);
        if (typeof v === "number") td.addClass("na-num");
      }
      if (p.action) rowAction(tr.createEl("td", { cls: "na-row-actions" }), p, ctx, r);
      selectable(tr, p, ctx, r);
    });
  }),
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
      rowAction(li, p, ctx, r);
      selectable(li, p, ctx, r);
    });
  }),
};
