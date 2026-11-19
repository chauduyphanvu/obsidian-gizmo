import { extent, getPath, periodStart, stampParts, toTime, type Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import { timeTicks } from "./axis.ts";
import { itemText } from "./board.ts";
import { DATA_KEYS, heading, noteLink, rowsOf, selectable, shownRows } from "./common.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";

/** Width of the label column, kept in step with styles.css. */
const LABEL = 140;
const DAY = 86_400_000;

interface Item { start: number; end?: number }

/** The rows with a start, in order of it, and how many had none. An end before its start isn't one. */
function itemsOf(p: Panel, rows: Row[]): { rows: Row[]; items: Map<Row, Item>; skipped: number } {
  const items = new Map<Row, Item>();
  for (const row of rows) {
    const start = toTime(getPath(row, p.start));
    if (start === undefined) continue;
    const end = p.end ? toTime(getPath(row, p.end)) : undefined;
    items.set(row, { start, end: end !== undefined && end > start ? end : undefined });
  }
  const sorted = [...items.keys()].sort((a, b) => items.get(a)!.start - items.get(b)!.start);
  return { rows: sorted, items, skipped: rows.length - items.size };
}

/** A date, with the time when it isn't midnight. */
function when(t: number): string {
  const s = stampParts(new Date(t));
  return s.time === "00:00" ? s.date : `${s.date} ${s.time}`;
}

function drawTimeline(el: HTMLElement, p: Panel, ctx: PanelCtx, data: unknown, width: number): void {
  const { rows, items, skipped } = itemsOf(p, rowsOf(data));
  const skippedNote = () => {
    if (skipped) el.createDiv({ cls: "na-label", text: `${skipped} without a date` });
  };
  if (rows.length === 0) {
    el.createDiv({ cls: "na-empty", text: "Nothing here yet." });
    skippedNote();
    return;
  }
  const [lo, hi] = extent(rows.flatMap((r) => { const { start, end } = items.get(r)!; return end === undefined ? [start] : [start, end]; }));
  const margin = hi === lo ? DAY : (hi - lo) * 0.04;
  const [from, to] = [lo - margin, hi + margin];
  const left = (t: number) => `left: ${(((t - from) / (to - from)) * 100).toFixed(3)}%`;
  const ticks = timeTicks(from, to, Math.max(2, Math.floor((width - LABEL) / 80)));

  const root = el.createDiv({ cls: "na-timeline" });
  const axis = root.createDiv({ cls: "na-tl-axis" });
  for (const t of ticks) axis.createSpan({ cls: "na-tl-tick", text: t.label, attr: { style: left(t.at) } });
  const body = root.createDiv({ cls: "na-tl-body" });
  const lines = body.createDiv({ cls: "na-tl-grid", attr: { "aria-hidden": "true" } });
  for (const t of ticks) lines.createDiv({ cls: "na-tl-line", attr: { style: left(t.at) } });
  const list = body.createDiv({ cls: "na-tl-rows" });

  shownRows(el, rows, (row) => {
    const { start, end } = items.get(row)!;
    const text = itemText(p, row);
    const line = list.createDiv({ cls: "na-tl-row" });
    const label = line.createDiv({ cls: "na-tl-label", attr: { title: text } });
    if (typeof row.path === "string") noteLink(label, text, row.path, ctx);
    else label.setText(text);
    const detail = `${text}: ${end === undefined ? when(start) : `${when(start)} to ${when(end)}`}`;
    const mark = line.createDiv({ cls: "na-tl-track" }).createDiv({
      cls: end === undefined ? "na-tl-dot" : "na-tl-bar",
      attr: { style: end === undefined ? left(start) : `${left(start)}; width: ${(((end - start) / (to - from)) * 100).toFixed(3)}%`, title: detail, tabindex: 0 },
    });
    if (p.select) {
      selectable(mark, p, ctx, row, detail);
    } else {
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", detail);
    }
  });

  const today = periodStart(ctx.now.getTime(), "day");
  if (today >= from && today <= to) {
    body.createDiv({ cls: "na-tl-grid", attr: { "aria-hidden": "true" } }).createDiv({ cls: "na-tl-today", attr: { style: left(today) } });
  }
  skippedNote();
}

export const timeline: ViewDef = {
  id: "timeline",
  keys: [...DATA_KEYS, "start", "end", "item", "label", "select"],
  span: 4,
  needsSource: true,
  validate: (p) => (p.start ? [] : ["timeline needs start (a date field)"]),
  examples: [
    { panel: { view: "timeline", source: "notes", from: "Projects", start: "start", end: "due", item: "{name}", select: "project" } },
    { panel: { view: "timeline", source: "trips", start: "date", sort: "date" } },
    { panel: { view: "timeline", source: "notes", from: "Projects" }, errors: ["timeline needs start (a date field)"] },
    { panel: { view: "timeline", source: "notes", from: "Projects", end: "due" }, errors: ["timeline needs start (a date field)"] },
    { panel: { view: "timeline", source: "notes", from: "Projects", start: "start", group: "area" }, errors: ['"group" doesn\'t apply to timeline'] },
  ],
  mount(el, p, ctx, key): PanelHandle {
    let last: unknown;
    let width: number | undefined;
    const draw = () => {
      el.empty();
      heading(el, p, p.label);
      drawTimeline(el, p, ctx, last, width ?? ctx.width(key));
    };
    return {
      update(data) { last = data; draw(); },
      resize(w) { width = w; draw(); },
    };
  },
};
