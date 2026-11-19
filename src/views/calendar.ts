import { getPath, rowsOf, stampParts, toNumber, type Row } from "../data.ts";
import { display, formatErrors } from "../format.ts";
import type { Panel } from "../spec.ts";
import { svg } from "./chart.ts";
import { groupedTotals, heading, picks, selectable, seriesNames } from "./common.ts";
import { DATA_KEYS } from "../keys.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";

/** Shades a day can have besides none; the classes are gz-step-1 to gz-step-5. */
const SHADES = 5;
/** Year heatmap: gap between cells, smallest cell (narrower panels scroll), room for month names. */
const GAP = 2, MIN_CELL = 8, TOP = 16;
const KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 } as const;

/**
 * A shade from 1 to 5 for each distinct non-zero value: where it sits among all the non-zero
 * values (ties counted halfway), so the scale follows how the days are spread, not the largest day.
 */
export function shadeSteps(values: number[]): Map<number, number> {
  const sorted = values.filter((v) => v !== 0).sort((a, b) => a - b);
  const steps = new Map<number, number>();
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j] === sorted[i]) j++;
    steps.set(sorted[i], Math.min(SHADES, 1 + Math.floor((SHADES * (i + j)) / (2 * sorted.length))));
    i = j;
  }
  return steps;
}

const dayKey = (y: number, m: number, d: number) => stampParts(new Date(y, m, d)).date;

/** The date `n` days from a YYYY-MM-DD one. */
function shiftDay(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return dayKey(y, m - 1, d + n);
}

/** What the panel's days show: each day's row, its value (count, or the one y), and its shade. */
interface Days {
  row(date: string): Row;
  value(date: string): number | undefined;
  /** The day's value as text, in the panel's `values` and `format`. */
  show(date: string): string;
  step(date: string): number;
  label(date: string): string;
}

function daysOf(p: Panel, data: unknown, now: Date): Days {
  const y = seriesNames(p)[0];
  const byDay = new Map<string, Row>();
  for (const r of rowsOf(data)) byDay.set(String(getPath(r, p.group)), r);
  const row = (date: string): Row => byDay.get(date) ?? { [p.group!]: date, count: 0, ...(y ? { [y]: p.agg === "sum" ? 0 : null } : {}) };
  const value = (date: string) => toNumber(getPath(row(date), y ?? "count"));
  const steps = shadeSteps([...byDay.keys()].map(value).filter((v): v is number => v !== undefined));
  const show = (date: string) => display(p, y ?? "count", value(date), now);
  return {
    row,
    value,
    show,
    step: (date) => steps.get(value(date) ?? 0) ?? 0,
    label: (date) => `${date}: ${value(date) === undefined ? "no data" : show(date)}`,
  };
}

/** Moves focus between days with the arrow keys; `across` is how many days a step to the right or left is. */
function arrowKeys(root: Element, across: number, down: number): void {
  root.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key as keyof typeof KEYS;
    const from = (e.target as Element).closest?.("[data-date]")?.getAttribute("data-date");
    if (!from || !(key in KEYS)) return;
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const next = root.querySelector(`[data-date="${shiftDay(from, KEYS[key] * (horizontal ? across : down))}"]`) as HTMLElement | null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
}

/** A day's own look and what it picks: its tooltip text, its shade, today's outline, and its row for `select`. */
function markDay(el: Element, p: Panel, ctx: PanelCtx, days: Days, date: string, today: string): void {
  const label = days.label(date);
  el.setAttribute("data-date", date);
  const step = days.step(date);
  if (step) el.classList.add(`gz-step-${step}`);
  if (date === today) el.classList.add("gz-today");
  if (picks(p)) {
    selectable(el, p, ctx, days.row(date), label);
  } else {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
  }
}

function drawMonth(el: HTMLElement, p: Panel, ctx: PanelCtx, days: Days, year: number, month: number): void {
  const grid = el.createDiv({ cls: "gz-cal-grid" });
  // 5 January 2026 is a Monday.
  for (let i = 0; i < 7; i++) grid.createDiv({ cls: "gz-cal-dow", text: new Date(2026, 0, 5 + i).toLocaleDateString(undefined, { weekday: "short" }) });
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) grid.createDiv({ cls: "gz-cal-blank" });
  const today = stampParts(ctx.now).date;
  for (let d = 1, last = new Date(year, month + 1, 0).getDate(); d <= last; d++) {
    const date = dayKey(year, month, d);
    const cell = grid.createDiv({ cls: "gz-cal-day", attr: { title: days.label(date) } });
    cell.createSpan({ cls: "gz-cal-num", text: String(d) });
    const v = days.value(date);
    if (v) cell.createSpan({ cls: "gz-cal-val", text: days.show(date) });
    markDay(cell, p, ctx, days, date, today);
  }
  arrowKeys(grid, 1, 7);
}

function drawYear(el: HTMLElement, p: Panel, ctx: PanelCtx, days: Days, year: number, width: number): void {
  // Weeks run Monday to Sunday down each column; the first column holds 1 January.
  const offset = (new Date(year, 0, 1).getDay() + 6) % 7;
  const cells: { date: string; col: number; row: number; month?: string }[] = [];
  for (let n = 0, d = new Date(year, 0, 1); d.getFullYear() === year; d = new Date(year, 0, 1 + ++n)) {
    cells.push({
      date: dayKey(year, d.getMonth(), d.getDate()),
      col: Math.floor((n + offset) / 7),
      row: (n + offset) % 7,
      month: d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: "short" }) : undefined,
    });
  }
  const weeks = cells[cells.length - 1].col + 1;
  const size = Math.max(MIN_CELL, Math.floor((width - (weeks - 1) * GAP) / weeks));
  const at = (i: number) => i * (size + GAP);
  const scroller = el.createDiv({ cls: "gz-cal-scroll" });
  const root = svg("svg", {
    width: at(weeks) - GAP, height: TOP + at(7) - GAP, class: "gz-cal-year", role: "group", "aria-label": String(year),
  }, scroller);
  const today = stampParts(ctx.now).date;
  for (const c of cells) {
    if (c.month) svg("text", { x: at(c.col), y: TOP - 5, class: "gz-axis" }, root).textContent = c.month;
    const rect = svg("rect", { x: at(c.col), y: TOP + at(c.row), width: size, height: size, rx: 2, class: "gz-cal-day" }, root);
    svg("title", {}, rect).textContent = days.label(c.date);
    markDay(rect, p, ctx, days, c.date, today);
  }
  // Up and down are days here, left and right whole weeks.
  arrowKeys(root, 7, 1);
  // Too narrow for the whole year (a phone), it opens scrolled to show today rather than January.
  const now = cells.find((c) => c.date === today);
  if (now) scroller.scrollLeft = Math.max(0, at(now.col + 1) + 4 * (size + GAP) - width);
}

type Nav = "prev" | "next" | "today";

export const calendar: ViewDef = {
  id: "calendar",
  keys: [...DATA_KEYS, "group", "per", "y", "agg", "of", "label", "layout", "format", "values", "select", "detail"],
  span: 4,
  needsSource: true,
  // Days are the only period, so the pipeline groups per day whatever was typed.
  pipeline: { per: "day" },
  validate(p: Panel) {
    const ys = seriesNames(p);
    return [
      ...(p.group ? [] : ["calendar needs group (a date field)"]),
      ...(p.per && p.per !== "day" ? ["calendar counts per day; leave out per"] : []),
      ...(p.layout && p.layout !== "year" ? ["layout must be year"] : []),
      ...(ys.length > 1 ? ["calendar takes one y"] : []),
      ...groupedTotals(p, ys, "y"),
      ...formatErrors(p),
    ];
  },
  examples: [
    { panel: { view: "calendar", source: "stretches", group: "at" } },
    { panel: { view: "calendar", source: "spending", group: "at", y: "amount", agg: "sum", where: { at: "this year" } } },
    { panel: { view: "calendar", source: "stretches", group: "at", layout: "year", select: "day" } },
    { panel: { view: "calendar", source: "spending", group: "at", y: "amount", agg: "sum", format: "$0,0" } },
    { panel: { view: "calendar", source: "moods", group: "at", y: "mood", agg: "last", values: { mood: { 1: "low", 5: "high" } } } },
    { panel: { view: "calendar", source: "spending", group: "at", y: "amount", agg: "sum", format: "dollars" }, errors: ['format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
    { panel: { view: "calendar", source: "stretches" }, errors: ["calendar needs group (a date field)"] },
    { panel: { view: "calendar", source: "stretches", group: "at", per: "week" }, errors: ["calendar counts per day; leave out per"] },
    { panel: { view: "calendar", source: "stretches", group: "at", layout: "month" }, errors: ["layout must be year"] },
    { panel: { view: "calendar", source: "spending", group: "at", y: ["amount", "tip"], agg: "sum" }, errors: ["calendar takes one y"] },
  ],
  mount(el, p, ctx, key): PanelHandle {
    let last: unknown;
    let width: number | undefined;
    // The month (or year) shown lives here, not in the page, so a data reload keeps it.
    let [year, month] = [ctx.now.getFullYear(), ctx.now.getMonth()];
    const yearly = p.layout === "year";
    const unit = yearly ? "year" : "month";
    const move = (n: number) => {
      const d = yearly ? new Date(year + n, 0, 1) : new Date(year, month + n, 1);
      [year, month] = [d.getFullYear(), d.getMonth()];
    };
    // `focus` names the header button to keep the focus on, since drawing again replaces them all.
    const draw = (focus?: Nav) => {
      el.empty();
      heading(el, p, p.label);
      const head = el.createDiv({ cls: "gz-cal-head" });
      const button = (nav: Nav, text: string, go: () => void, label?: string) => {
        const b = head.createEl("button", { cls: `gz-small gz-cal-${nav}`, text });
        if (label) b.setAttr("aria-label", label);
        b.addEventListener("click", () => { go(); draw(nav); });
        if (nav === focus) b.focus();
      };
      button("prev", "‹", () => move(-1), `Previous ${unit}`);
      head.createSpan({ cls: "gz-cal-title", text: yearly ? String(year) : new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
      button("next", "›", () => move(1), `Next ${unit}`);
      button("today", "Today", () => { [year, month] = [ctx.now.getFullYear(), ctx.now.getMonth()]; });
      const days = daysOf(p, last, ctx.now);
      if (yearly) drawYear(el, p, ctx, days, year, width ?? ctx.width(key));
      else drawMonth(el, p, ctx, days, year, month);
    };
    return {
      update(data) { last = data; draw(); },
      resize(w) { width = w; if (yearly) draw(); },
    };
  },
};
