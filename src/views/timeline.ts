import { extent, getPath, rowsOf, type Row } from "../data.ts";
import { periodStart, shiftPeriod, stampParts, toTime } from "../time.ts";
import { formatErrors } from "../format.ts";
import type { Panel } from "../spec.ts";
import { timeTicks } from "./axis.ts";
import { itemText } from "./board.ts";
import { UP_DOWN, emptyText, heading, noteLink, picks, rove, roving, rowNote, selectable, shownRows, whyEmpty } from "./common.ts";
import { DATA_KEYS } from "../keys.ts";
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

/** A month tick's year in two digits, "Jan 2027" as "Jan ’27"; a tick that is only a year stays. */
const shortYear = (label: string) => label.replace(/^(\D.*?)\s+\d{2}(\d{2})$/, "$1 ’$2");

/** About how wide a tick's label is, in pixels, to keep the one for today clear of its neighbours. */
const labelWidth = (label: string) => label.length * 6.5;

/** A date, with the time when it isn't midnight. */
function when(t: number): string {
  const s = stampParts(new Date(t));
  return s.time === "00:00" ? s.date : `${s.date} ${s.time}`;
}

function drawTimeline(el: HTMLElement, p: Panel, ctx: PanelCtx, data: unknown, width: number): void {
  const { rows, items, skipped } = itemsOf(p, rowsOf(data));
  const skippedNote = () => {
    if (skipped) el.createDiv({ cls: "gz-label", text: `${skipped} without a date` });
  };
  if (rows.length === 0) {
    // Rows without a start are there, so the panel isn't empty: it has nothing it can draw.
    whyEmpty(el, p, ctx, el.createDiv({ cls: "gz-empty", text: skipped ? "Nothing here yet." : emptyText(p, ctx.now, "Nothing here yet.") }));
    skippedNote();
    return;
  }
  const [lo, hi] = extent(rows.flatMap((r) => { const { start, end } = items.get(r)!; return end === undefined ? [start] : [start, end]; }));
  const margin = hi === lo ? DAY : (hi - lo) * 0.04;
  const [from, to] = [lo - margin, hi + margin];
  const left = (t: number) => `left: ${(((t - from) / (to - from)) * 100).toFixed(3)}%`;
  const track = Math.max(1, width - LABEL);
  const ticks = timeTicks(from, to, Math.max(2, Math.floor(track / 80)));
  const today = periodStart(ctx.now.getTime(), "day");
  const tomorrow = shiftPeriod(today, "day", 1);
  const showToday = today >= from && today <= to;
  const px = (t: number) => ((t - from) / (to - from)) * track;

  const root = el.createDiv({ cls: "gz-timeline" });
  const axis = root.createDiv({ cls: "gz-tl-axis" });
  for (const t of ticks) {
    const label = shortYear(t.label);
    // A label under "Today" is left out; its gridline stays.
    if (showToday && px(t.at) < px(today) + 23 && px(t.at) + labelWidth(label) + 4 > px(today) - 23) continue;
    axis.createSpan({ cls: "gz-tl-tick", text: label, attr: { style: left(t.at) } });
  }
  if (showToday) axis.createSpan({ cls: "gz-tl-now", text: "Today", attr: { style: left(today) } });
  const body = root.createDiv({ cls: "gz-tl-body" });
  const lines = body.createDiv({ cls: "gz-tl-grid", attr: { "aria-hidden": "true" } });
  for (const t of ticks) lines.createDiv({ cls: "gz-tl-line", attr: { style: left(t.at) } });
  const list = body.createDiv({ cls: "gz-tl-rows" });
  roving(list, UP_DOWN);

  shownRows(el, rows, (row) => {
    const { start, end } = items.get(row)!;
    const text = itemText(p, row, ctx.now);
    const line = list.createDiv({ cls: "gz-tl-row" });
    const label = line.createDiv({ cls: "gz-tl-label", attr: { title: text } });
    const note = rowNote(p, row);
    if (note) noteLink(label, text, note, ctx);
    else label.setText(text);
    const detail = `${text}: ${end === undefined ? when(start) : `${when(start)} to ${when(end)}`}`;
    const kind = end === undefined ? "gz-tl-dot" : "gz-tl-bar";
    const mark = line.createDiv({ cls: "gz-tl-track" }).createDiv({
      // A bar that ended before today is finished; an item that starts after today is drawn as an outline.
      cls: [kind, ...(end !== undefined && end < today ? ["gz-tl-done"] : []), ...(start >= tomorrow ? ["gz-tl-future"] : [])],
      attr: { style: end === undefined ? left(start) : `${left(start)}; width: ${(((end - start) / (to - from)) * 100).toFixed(3)}%`, title: detail },
    });
    if (picks(p, ctx, true)) {
      selectable(mark, p, ctx, row, detail, true);
    } else {
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", detail);
      rove(mark);
    }
  });

  if (showToday) {
    body.createDiv({ cls: "gz-tl-grid", attr: { "aria-hidden": "true" } }).createDiv({ cls: "gz-tl-today", attr: { style: left(today) } });
  }
  skippedNote();
}

export const timeline: ViewDef = {
  id: "timeline",
  keys: [...DATA_KEYS, "start", "end", "item", "label", "format", "values", "select", "detail", "empty"],
  span: 4,
  needsSource: true,
  validate: (p) => [...(p.start ? [] : ["timeline needs start (a date field)"]), ...formatErrors(p)],
  examples: [
    { panel: { view: "timeline", source: "notes", from: "Projects", start: "start", end: "due", item: "{name}", select: "project" } },
    { panel: { view: "timeline", source: "trips", start: "date", sort: "date" } },
    { panel: { view: "timeline", source: "notes", from: "Decisions", start: "made", end: "review", detail: "I expected: {expect}. I'll know by {review}." } },
    { panel: { view: "timeline", source: "notes", from: "Projects", start: "start", end: "due", item: "{name} · {status} · {budget}", format: { budget: "$0,0" }, values: { status: { doing: "In progress" } } } },
    { panel: { view: "timeline", source: "trips", start: "date", format: "dollars" }, errors: ['format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
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
