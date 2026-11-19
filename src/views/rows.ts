import { fillTemplate, formatValue, getPath } from "../data.ts";
import { DATA_KEYS, heading, noteLink, redraw, rowsOf, shownRows } from "./common.ts";
import type { ViewDef } from "./registry.ts";

const HIDDEN_COLUMNS = new Set(["path", "mtime", "ctime", "tags", "position"]);

export const table: ViewDef = {
  id: "table",
  keys: [...DATA_KEYS, "columns", "label", "decimals"],
  wide: true,
  needsSource: true,
  examples: [
    { panel: { view: "table", source: "notes", from: "Health", sort: "-date", columns: ["name", "date", "who"] } },
    { panel: { view: "table", source: "notes" }, errors: ['source "notes" needs "from" (a #tag or folder)'] },
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p, p.label);
    const rows = rowsOf(data);
    if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return; }
    const columns = p.columns ?? Object.keys(rows[0]).filter((k) => !HIDDEN_COLUMNS.has(k)).slice(0, 6);
    const table = el.createDiv({ cls: "na-table-wrap" }).createEl("table", { cls: "na-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const c of columns) head.createEl("th", { text: c });
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
    });
  }),
};

export const list: ViewDef = {
  id: "list",
  keys: [...DATA_KEYS, "item", "label", "decimals"],
  wide: true,
  needsSource: true,
  examples: [
    { panel: { view: "list", source: "notes", from: "#health/appointment", where: { date: "upcoming" }, sort: "date", item: "{date} · {name}" } },
    { panel: { view: "list", source: "http://example.com/feed.json" }, errors: ["source must use https"] },
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p, p.label);
    const rows = rowsOf(data);
    if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return; }
    const ul = el.createEl("ul", { cls: "na-list" });
    shownRows(el, rows, (r) => {
      const text = p.item ? fillTemplate(p.item, r, p.decimals) : String(r.name ?? r.title ?? r.value ?? JSON.stringify(r));
      const li = ul.createEl("li");
      if (typeof r.path === "string") noteLink(li, text, r.path, ctx);
      else li.setText(text);
    });
  }),
};
