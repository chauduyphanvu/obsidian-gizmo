import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Placement } from "../src/compose.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { daysUntil } from "../src/time.ts";
import { mountView } from "../src/views/common.ts";
import { viewDef, type PanelCtx, type PanelHandle } from "../src/views/registry.ts";
import { windowName } from "../src/views/value.ts";

// Friday 20 November 2026, 19:42.
const NOW = new Date(2026, 10, 20, 19, 42);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/[  ]/g, " ");
const classes = (el: Element | null | undefined) => [...(el?.classList ?? [])];
const kids = (el: Element) => [...el.children].map((c) => c.className);

type Slot = Placement["slot"] | undefined;

/** Mounts a panel as the app would, with `place()` saying where it sits in the composed layout. */
function mount(keys: Record<string, unknown>, slot: Slot, now = NOW, internal: Partial<Panel> = {}): { el: HTMLElement; handle: PanelHandle } {
  const { panel, errors } = checkPanel(keys, true, internal);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  const ctx = { now, width: () => 600, place: () => (slot ? { role: "answer", slot } : undefined) } as unknown as PanelCtx;
  return { el, handle: mountView(viewDef(keys.view as string)!, el, panel as Panel, ctx, "k") };
}

function draw(keys: Record<string, unknown>, slot: Slot, data?: unknown, now = NOW, internal: Partial<Panel> = {}): HTMLElement {
  const { el, handle } = mount(keys, slot, now, internal);
  handle.update(data);
  return el;
}

// ---- number ---------------------------------------------------------------------------------------

const MONTH = { view: "number", title: "This month", source: "s", field: "amount", agg: "sum", where: { at: "this month" }, compare: "previous", format: "$0,0.00", label: "spent so far" };
const SPEND = [
  { at: "2026-10-05T09:00", amount: 600 },
  { at: "2026-10-18T12:00", amount: 546.9 },
  // After October 20 at 19:42, so not in the window this month is set against.
  { at: "2026-10-25T12:00", amount: 900 },
  { at: "2026-11-03T09:00", amount: 700 },
  { at: "2026-11-19T10:00", amount: 584.5 },
];

test("number headline: an eyebrow, the figure with its caption on one row, then the change against the same days last month", () => {
  const el = draw(MONTH, "headline", SPEND);
  assert.deepEqual(kids(el), ["gz-title gz-eyebrow", "gz-fig-row", "gz-compare gz-ans-sub"]);
  assert.equal(text(el.querySelector(".gz-eyebrow")), "This month");
  const row = el.querySelector(".gz-fig-row")!;
  assert.deepEqual(kids(row), ["gz-big gz-fig", "gz-label gz-fig-cap"]);
  assert.equal(text(row.querySelector(".gz-big")), "$1,284.50");
  assert.equal(text(row.querySelector(".gz-fig-cap")), "spent so far");
  const change = el.querySelector(".gz-compare")!;
  assert.equal(text(change), "↑ 12% more than Oct 1–20 · $1,146.90");
  assert.equal(text(change.querySelector(".gz-faint")), " · $1,146.90");
  assert.equal(change.getAttribute("role"), "img");
  assert.equal(change.getAttribute("aria-label"), "12 percent more than Oct 1–20, which was $1,146.90");
});

test("number headline: a unit sits in the figure, beside the value", () => {
  const el = draw({ view: "number", title: "Latest", source: "s", field: "value", agg: "last", unit: "kg" }, "headline", [{ value: 80.2 }]);
  const big = el.querySelector(".gz-big.gz-fig")!;
  assert.equal(text(big), "80.2kg");
  assert.equal(text(big.querySelector(".gz-unit")), "kg");
  assert.equal(el.querySelector(".gz-compare"), null);
  assert.equal(el.querySelector(".gz-fig-cap"), null);
});

test("the change reads by the amount when the window before is under three days, or was nothing", () => {
  // November 1 at 15:00: the window before is October 1, midnight to 15:00.
  const early = new Date(2026, 10, 1, 15, 0);
  const rows = [{ at: "2026-10-01T09:00", amount: 155.09 }, { at: "2026-10-01T18:00", amount: 1000 }, { at: "2026-11-01T10:00", amount: 300 }];
  const el = draw(MONTH, "headline", rows, early);
  assert.equal(text(el.querySelector(".gz-compare")), "↑ $144.91 more than Oct 1 · $155.09");
  assert.equal(el.querySelector(".gz-compare")!.getAttribute("aria-label"), "$144.91 more than Oct 1, which was $155.09");
  const fromNothing = draw(MONTH, "headline", [{ at: "2026-10-04", amount: 0 }, { at: "2026-11-04", amount: 40 }]);
  assert.equal(text(fromNothing.querySelector(".gz-compare")), "↑ $40.00 more than Oct 1–20 · $0.00");
});

test("the change: less, under one percent, the same, and nothing to compare with; never coloured", () => {
  const change = (rows: unknown[]) => draw(MONTH, "headline", rows).querySelector(".gz-compare");
  const down = change([{ at: "2026-10-04", amount: 200 }, { at: "2026-11-04", amount: 190 }])!;
  assert.equal(text(down), "↓ 5% less than Oct 1–20 · $200.00");
  assert.deepEqual(classes(down), ["gz-compare", "gz-ans-sub"]);
  assert.equal(text(change([{ at: "2026-10-04", amount: 1000 }, { at: "2026-11-04", amount: 1001 }])), "↑ <1% more than Oct 1–20 · $1,000.00");
  const same = change([{ at: "2026-10-04", amount: 200 }, { at: "2026-11-04", amount: 200 }])!;
  assert.equal(text(same), "Same as Oct 1–20");
  assert.equal(same.hasAttribute("aria-label"), false);
  assert.equal(text(change([{ at: "2026-11-04", amount: 200 }])), "Nothing to compare with yet");
  assert.equal(text(change([])), "Nothing to compare with yet");
  // Nothing this month: the figure is a dash and there is no change to tell.
  const empty = draw(MONTH, "headline", [{ at: "2026-10-04", amount: 200 }]);
  assert.equal(text(empty.querySelector(".gz-big")), "—");
  assert.equal(empty.querySelector(".gz-compare"), null);
  // A missing value is a faint dash, without the unit.
  const none = draw({ view: "number", title: "Latest", source: "s", field: "value", agg: "last", unit: "kg" }, "fact", []);
  assert.equal(text(none.querySelector(".gz-big")), "—");
  assert.deepEqual(classes(none.querySelector(".gz-big span")), ["gz-none"]);
});

test("windows are named by their dates: a day, days in one month, days across two; another year says which", () => {
  const t = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m, d, h, mi).getTime();
  assert.equal(windowName([t(2026, 9, 1), t(2026, 9, 2)], NOW), "Oct 1");
  assert.equal(windowName([t(2026, 9, 1), t(2026, 9, 1, 15)], NOW), "Oct 1");
  assert.equal(windowName([t(2026, 9, 1), t(2026, 9, 20, 19, 42)], NOW), "Oct 1–20");
  assert.equal(windowName([t(2026, 9, 1), t(2026, 10, 1)], NOW), "Oct 1–31");
  assert.equal(windowName([t(2026, 8, 28), t(2026, 9, 5)], NOW), "Sep 28 – Oct 4");
  assert.equal(windowName([t(2025, 11, 1), t(2025, 11, 20, 9)], new Date(2026, 0, 20)), "Dec 1–20, 2025");
  // Read at midnight, the window before has no time in it yet: it is named by the day it starts.
  assert.equal(windowName([t(2026, 9, 20), t(2026, 9, 20)], NOW), "Oct 20");
});

const WEEK = { view: "number", title: "This week", source: "s", where: { at: "this week" }, field: "value", agg: "avg", compare: "previous", unit: "kg", decimals: 1, label: "average" };
const WEIGHTS = [
  { at: "2026-11-10T07:30", value: 81.2 }, { at: "2026-11-12T07:30", value: 81.0 },
  // Saturday: past Friday 19:42, so not in last week's part.
  { at: "2026-11-14T07:30", value: 99 },
  { at: "2026-11-17T07:30", value: 80.6 }, { at: "2026-11-19T07:30", value: 80.2 },
];

test("number fact: its name, a smaller figure with its unit, and one line: the change in short", () => {
  const el = draw(WEEK, "fact", WEIGHTS);
  assert.deepEqual(kids(el), ["gz-title gz-fact-title", "gz-big gz-fact-fig", "gz-compare gz-fact-note"]);
  assert.equal(text(el.querySelector(".gz-fact-title")), "This week");
  assert.equal(text(el.querySelector(".gz-big")), "80.4kg");
  assert.equal(text(el.querySelector(".gz-fact-fig .gz-unit")), "kg");
  const note = el.querySelector(".gz-fact-note")!;
  assert.equal(text(note), "↓ 0.7 kg vs last week");
  assert.equal(note.getAttribute("aria-label"), "down 0.7 kg, versus last week");
  // The change takes the line; the label is left out.
  assert.equal(el.querySelector(".gz-label"), null);
});

test("a number whose alert is on says so under it, as headline or fact; an alert on rows says how many", () => {
  const ready = { view: "number", title: "Ready to score", source: "s", agg: "count", label: "decisions whose day has come", alert: "> 0" };
  const on = draw(ready, "headline", [{}, {}]);
  assert.deepEqual(kids(on), ["gz-title gz-eyebrow", "gz-fig-row", "gz-ans-status"]);
  const status = on.querySelector(".gz-ans-status")!;
  assert.equal(text(status), "The alert is on");
  assert.equal(status.querySelector("svg")!.getAttribute("aria-hidden"), "true");
  assert.ok(!draw(ready, "headline", []).querySelector(".gz-ans-status"));
  const fact = draw({ ...WEEK, alert: ">= 80" }, "fact", WEIGHTS);
  assert.deepEqual(kids(fact), ["gz-title gz-fact-title", "gz-big gz-fact-fig", "gz-compare gz-fact-note", "gz-ans-status"]);
  // Only this window's rows count, not the week before that compare reads.
  const calls = { view: "number", title: "Calls", source: "s", where: { at: "this week" }, compare: "previous", agg: "count", alert: { back: "past" } };
  const rows = [{ at: "2026-11-10", back: "2026-11-11" }, { at: "2026-11-17", back: "2026-11-18" }, { at: "2026-11-18", back: "2026-11-30" }];
  assert.equal(text(draw(calls, "headline", rows).querySelector(".gz-ans-status")), "The alert is on for 1 row");
  assert.ok(!draw({ ...calls, alert: { back: "upcoming" } }, "headline", rows.slice(0, 2)).querySelector(".gz-ans-status"));
});

test("number fact: without compare its line is the label", () => {
  const el = draw({ view: "number", title: "Streak", source: "s", agg: "count", unit: "days", label: "in a row" }, "fact", [{}, {}, {}]);
  assert.deepEqual(kids(el), ["gz-title gz-fact-title", "gz-big gz-fact-fig", "gz-label gz-fact-note"]);
  assert.equal(text(el.querySelector(".gz-big")), "3days");
  assert.equal(text(el.querySelector(".gz-fact-note")), "in a row");
});

test("a fact names the window before in a word where one fits, else by its dates", () => {
  const note = (where: string, rows: unknown[], now = NOW) =>
    text(draw({ ...WEEK, where: { at: where } }, "fact", rows, now).querySelector(".gz-fact-note"));
  assert.equal(note("this month", [{ at: "2026-10-02", value: 80 }, { at: "2026-11-02", value: 81 }]), "↑ 1.0 kg vs last month");
  assert.equal(note("today", [{ at: "2026-11-19T08:00", value: 80 }, { at: "2026-11-20T08:00", value: 79.5 }]), "↓ 0.5 kg vs the day before");
  assert.equal(note("this year", [{ at: "2025-03-01", value: 80 }, { at: "2026-03-01", value: 78 }]), "↓ 2.0 kg vs last year");
  // Two weeks back from the 9th, to as far in as Friday 19:42 is.
  assert.equal(note("last 2 weeks", [{ at: "2026-10-27", value: 80 }, { at: "2026-11-10", value: 80.5 }]), "↑ 0.5 kg vs Oct 26 – Nov 6");
  assert.equal(note("this week", [{ at: "2026-11-10", value: 80 }, { at: "2026-11-17", value: 80 }]), "Same as last week");
  assert.equal(note("this week", [{ at: "2026-11-17", value: 80 }]), "Nothing to compare with yet");
});

test("a number never draws as a meter, and on the grid it draws as it always has", () => {
  const grid = draw(MONTH, undefined, SPEND);
  assert.equal(draw(MONTH, "meter", SPEND).innerHTML, grid.innerHTML);
  assert.deepEqual(kids(grid), ["gz-title", "gz-big", "gz-label", "gz-compare"]);
  assert.equal(text(grid.querySelector(".gz-compare")), "▲ $137.60 (12%) vs previous");
});

// ---- progress -------------------------------------------------------------------------------------

const LIMIT = { view: "progress", title: "Against my limit", source: "s", field: "amount", agg: "sum", where: { at: "this month" }, max: 2000, format: "$0,0", alert: ">= 2000" };
/** The amount field's own format, finer than the panel's, as a block's `fields` give it. */
const MONEY: Partial<Panel> = { fieldInfo: { amount: { format: "$0,0.00" } } };
const spent = (amount: number) => [{ at: "2026-12-02T10:00", amount }];
// Friday 11 December 2026, noon: 10.5 of December's 31 days gone, 20 whole days after today. No clock change in December.
const DEC = new Date(2026, 11, 11, 12, 0);

test("progress as a meter: no title or figure; an ink fill, a tick at even pace with its amount, and a legend with what is left a day", () => {
  const el = draw(LIMIT, "meter", spent(700), DEC, MONEY);
  assert.deepEqual(kids(el), ["gz-meter-track", "gz-meter-legend"]);
  assert.equal(el.querySelector(".gz-title"), null);
  assert.equal(el.querySelector(".gz-big"), null);
  const fill = el.querySelector(".gz-meter-fill") as HTMLElement;
  assert.deepEqual(classes(fill), ["gz-meter-fill"]);
  assert.equal(fill.style.width, "35%");
  const tick = el.querySelector(".gz-meter-pace") as HTMLElement;
  assert.deepEqual(classes(tick), ["gz-meter-pace"]);
  assert.equal(tick.style.left, `${(10.5 / 31) * 100}%`);
  assert.equal(text(tick.querySelector(".gz-meter-pace-label")), "Even pace $677");
  const [left, right] = [...el.querySelector(".gz-meter-legend")!.children];
  assert.equal(text(left), "35% of $2,000");
  assert.equal(text(left.querySelector("b")), "35%");
  assert.equal(text(right), "$1,300.00 left · $65.00 a day for 20 days");
  assert.deepEqual([...right.querySelectorAll("b")].map(text), ["$1,300.00", "$65.00"]);
});

test("days left are the whole days after today: on November 20, ten", () => {
  const el = draw(LIMIT, "meter", [{ at: "2026-11-03", amount: 1284.6 }], NOW, MONEY);
  assert.equal(text(el.querySelector(".gz-meter-legend span:last-child")), "$715.40 left · $71.54 a day for 10 days");
  // The last day has none after it, so there is no amount a day.
  const last = draw(LIMIT, "meter", [{ at: "2026-11-03", amount: 1284.6 }], new Date(2026, 10, 30, 9, 0), MONEY);
  assert.equal(text(last.querySelector(".gz-meter-legend span:last-child")), "$715.40 left");
});

test("the even-pace label stays inside the track's ends", () => {
  const tick = (now: Date) => draw(LIMIT, "meter", spent(10), now).querySelector(".gz-meter-pace")!;
  assert.deepEqual(classes(tick(new Date(2026, 11, 2, 12, 0))), ["gz-meter-pace", "gz-pace-start"]);
  assert.deepEqual(classes(tick(new Date(2026, 11, 29, 12, 0))), ["gz-meter-pace", "gz-pace-end"]);
  assert.deepEqual(classes(tick(DEC)), ["gz-meter-pace"]);
});

test("past the limit: the fill turns to the error colour, a status line says by how much, and whether the alert is on", () => {
  const el = draw(LIMIT, "meter", spent(2085), DEC, MONEY);
  assert.deepEqual(kids(el), ["gz-meter-track", "gz-meter-legend", "gz-ans-status"]);
  assert.deepEqual(classes(el.querySelector(".gz-meter-fill")), ["gz-meter-fill", "gz-over"]);
  assert.equal((el.querySelector(".gz-meter-fill") as HTMLElement).style.width, "100%");
  assert.equal(text(el.querySelector(".gz-meter-legend span:last-child")), "$85.00 over");
  const status = el.querySelector(".gz-ans-status")!;
  assert.equal(text(status), "Over the limit by $85.00 · the alert is on");
  assert.equal(status.querySelector("svg")!.getAttribute("aria-hidden"), "true");
  const quiet = draw({ ...LIMIT, alert: undefined }, "meter", spent(2085), DEC, MONEY);
  assert.equal(text(quiet.querySelector(".gz-ans-status")), "Over the limit by $85.00");
  // At the limit nothing is past it yet: no colour, nothing left; the alert, at >= 2000, is on.
  const at = draw(LIMIT, "meter", spent(2000), DEC, MONEY);
  assert.deepEqual(classes(at.querySelector(".gz-meter-fill")), ["gz-meter-fill"]);
  assert.equal(text(at.querySelector(".gz-ans-status")), "The alert is on");
  assert.equal(text(at.querySelector(".gz-meter-legend")), "100% of $2,000$0.00 left");
  const under = draw(LIMIT, "meter", spent(1999), DEC, MONEY);
  assert.ok(!under.querySelector(".gz-ans-status"));
});

test("a progress with no date window that holds now has no tick and no amount a day", () => {
  const books = { view: "progress", title: "Reading goal", source: "s", max: 24, unit: "books" };
  const el = draw(books, "meter", Array.from({ length: 12 }, () => ({})));
  assert.equal(el.querySelector(".gz-meter-pace"), null);
  assert.equal(text(el.querySelector(".gz-meter-legend")), "50% of 24 books12 books left");
  const lastMonth = draw({ ...LIMIT, where: { at: "2026-10-15" } }, "meter", [{ at: "2026-10-15", amount: 50 }], DEC, MONEY);
  assert.equal(lastMonth.querySelector(".gz-meter-pace"), null);
  assert.equal(text(lastMonth.querySelector(".gz-meter-legend span:last-child")), "$1,950.00 left");
});

test("progress on its own: the title, the figure out of max, then the same meter and legend", () => {
  const head = draw({ ...LIMIT, label: "this month" }, "headline", spent(700), DEC, MONEY);
  assert.deepEqual(kids(head), ["gz-title gz-eyebrow", "gz-fig-row", "gz-meter-track", "gz-meter-legend"]);
  assert.equal(text(head.querySelector(".gz-big.gz-fig")), "$700/ $2,000");
  assert.equal(text(head.querySelector(".gz-fig .gz-unit")), "/ $2,000");
  assert.equal(text(head.querySelector(".gz-fig-cap")), "this month");
  const fact = draw(LIMIT, "fact", spent(700), DEC, MONEY);
  assert.deepEqual(kids(fact), ["gz-title gz-fact-title", "gz-big gz-fact-fig", "gz-meter-track", "gz-meter-legend"]);
  assert.equal(text(fact.querySelector(".gz-big")), "$700/ $2,000");
  // On the grid, as it always was.
  const grid = draw(LIMIT, undefined, spent(700), DEC, MONEY);
  assert.deepEqual(kids(grid), ["gz-title", "gz-big", "gz-progress"]);
});

// ---- countdown and text ---------------------------------------------------------------------------

test("countdown: days as the figure, and a caption with the date, today, or how long ago", () => {
  const caption = (keys: Record<string, unknown>, slot: Slot = "headline") => {
    const el = draw({ view: "countdown", title: "Renewal", ...keys }, slot);
    return [text(el.querySelector(".gz-big")), text(el.querySelector(".gz-label"))];
  };
  assert.deepEqual(caption({ to: "2027-10-03" }), [`${daysUntil("2027-10-03", NOW)}days`, "until Oct 3, 2027"]);
  assert.deepEqual(caption({ to: "2027-10-03", label: "Benefits renewal" }), [`${daysUntil("2027-10-03", NOW)}days`, "Benefits renewal · Oct 3, 2027"]);
  assert.deepEqual(caption({ to: "2026-11-21" }), ["1day", "until Nov 21, 2026"]);
  assert.deepEqual(caption({ to: "2026-11-20" }), ["0days", "today"]);
  assert.deepEqual(caption({ to: "2026-11-17" }), ["3days", "ago · Nov 17, 2026"]);
  assert.deepEqual(caption({ to: "2026-11-17", label: "Filed" }, "fact"), ["3days", "Filed · ago · Nov 17, 2026"]);
});

test("countdown: a headline has its caption in the figure's row; a fact under its figure", () => {
  const head = draw({ view: "countdown", title: "Days to go", to: "2026-11-23" }, "headline");
  assert.deepEqual(kids(head), ["gz-title gz-eyebrow", "gz-fig-row"]);
  assert.deepEqual(kids(head.querySelector(".gz-fig-row")!), ["gz-big gz-fig", "gz-label gz-fig-cap"]);
  assert.equal(text(head.querySelector(".gz-fig .gz-unit")), "days");
  const fact = draw({ view: "countdown", title: "Days to go", to: "2026-11-23" }, "fact");
  assert.deepEqual(kids(fact), ["gz-title gz-fact-title", "gz-big gz-fact-fig", "gz-label gz-fact-note"]);
  assert.equal(text(fact.querySelector(".gz-fact-note")), "until Nov 23, 2026");
});

test("text: large as the headline, smaller as a fact, its label under it", () => {
  const keys = { view: "text", title: "Weather", text: "Clear, 12°C", label: "in Tokyo" };
  const head = draw(keys, "headline");
  assert.deepEqual(kids(head), ["gz-title gz-eyebrow", "gz-text gz-ans-text", "gz-label gz-ans-label"]);
  assert.equal(text(head.querySelector(".gz-text")), "Clear, 12°C");
  assert.equal(text(head.querySelector(".gz-label")), "in Tokyo");
  const fact = draw(keys, "fact");
  assert.deepEqual(kids(fact), ["gz-title gz-fact-title", "gz-text gz-fact-text", "gz-label gz-ans-label"]);
  assert.deepEqual(kids(draw(keys, undefined)), ["gz-title", "gz-text", "gz-label"]);
});

// ---- count-up -------------------------------------------------------------------------------------

const COUNT = { view: "number", title: "Doses today", source: "s", agg: "count" };
const rows = (n: number) => Array.from({ length: n }, () => ({}));

test("count-up: where the window can't animate (the test DOM), a new value is shown at once", () => {
  const { el, handle } = mount(COUNT, "headline");
  handle.update(rows(1));
  handle.update(rows(5));
  assert.equal(text(el.querySelector(".gz-big")), "5");
  const meter = mount(LIMIT, "meter", DEC);
  meter.handle.update(spent(200));
  meter.handle.update(spent(700));
  assert.equal((meter.el.querySelector(".gz-meter-fill") as HTMLElement).style.width, "35%");
  meter.handle.destroy!();
});

/** A window that draws frames when told to, with the reader's motion setting. */
function frames(reduce = false) {
  const queue = new Map<number, (t: number) => void>();
  let next = 1;
  const win = window as unknown as Record<string, unknown>;
  win.requestAnimationFrame = (cb: (t: number) => void) => { queue.set(next, cb); return next++; };
  win.cancelAnimationFrame = (id: number) => { queue.delete(id); };
  win.matchMedia = (q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)" });
  return {
    pending: () => queue.size,
    run(t: number) {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(t);
    },
    restore() { for (const k of ["requestAnimationFrame", "cancelAnimationFrame", "matchMedia"]) delete win[k]; },
  };
}

test("count-up: a new value counts up from the old over 240 ms, easing out, in whole steps between whole numbers", () => {
  const f = frames();
  try {
    const { el, handle } = mount(COUNT, "headline");
    const fig = () => text(el.querySelector(".gz-big"));
    handle.update(rows(1));
    assert.equal(f.pending(), 0, "the first value is drawn as it is");
    handle.update(rows(9));
    assert.equal(fig(), "1");
    // Its digits are tabular only while it counts.
    assert.ok(el.classList.contains("gz-counting"));
    f.run(1000);
    assert.equal(fig(), "1");
    // Half way in time is seven eighths of the way: 1 + 8 × 0.875.
    f.run(1120);
    assert.equal(fig(), "8");
    f.run(1240);
    assert.equal(fig(), "9");
    assert.equal(f.pending(), 0);
    assert.ok(!el.classList.contains("gz-counting"));
  } finally {
    f.restore();
  }
});

test("count-up: a value that arrives mid-count starts from the figure shown; destroying the view stops it", () => {
  const f = frames();
  try {
    const { el, handle } = mount({ ...MONTH, compare: undefined, where: undefined }, "fact");
    const fig = () => text(el.querySelector(".gz-big"));
    handle.update([{ amount: 100 }]);
    handle.update([{ amount: 200 }]);
    f.run(0);
    f.run(120);
    assert.equal(fig(), "$187.50");
    handle.update([{ amount: 100 }]);
    assert.equal(fig(), "$187.50");
    assert.equal(f.pending(), 1, "the count in flight was stopped for the new one");
    handle.destroy!();
    assert.equal(f.pending(), 0);
    assert.ok(!el.classList.contains("gz-counting"));
  } finally {
    f.restore();
  }
});

test("count-up is skipped with reduced motion, for words from values, for a date, and on the grid", () => {
  const settle = (keys: Record<string, unknown>, slot: Slot, a: unknown, b: unknown, reduce = false) => {
    const f = frames(reduce);
    try {
      const { handle } = mount(keys, slot);
      handle.update(a);
      handle.update(b);
      return f.pending();
    } finally {
      f.restore();
    }
  };
  assert.equal(settle(COUNT, "headline", rows(1), rows(4)), 1, "it counts otherwise");
  assert.equal(settle(COUNT, "headline", rows(1), rows(4), true), 0);
  assert.equal(settle(COUNT, undefined, rows(1), rows(4)), 0);
  const sky = { view: "number", title: "Sky", source: "s", field: "code", values: { code: { 0: "Clear", 3: "Overcast" } } };
  assert.equal(settle(sky, "headline", { code: 0 }, { code: 3 }), 0);
  const due = { view: "number", title: "Due", source: "s", field: "at", format: "date" };
  assert.equal(settle(due, "headline", { at: 1.79e12 }, { at: 1.8e12 }), 0);
  assert.equal(settle({ ...MONTH, compare: undefined, where: undefined }, "headline", [], [{ amount: 5 }]), 0, "from nothing shown");
});

test("count-up: a countdown and a progress figure count too", () => {
  const f = frames();
  try {
    // The countdown draws again when the day turns.
    const clock = { now: NOW };
    const ctx = { get now() { return clock.now; }, width: () => 600, place: () => ({ role: "answer", slot: "headline" }) } as unknown as PanelCtx;
    const el = document.createElement("div");
    const { panel } = checkPanel({ view: "countdown", title: "Days to go", to: "2026-11-30" }, true);
    const days = mountView(viewDef("countdown")!, el, panel as Panel, ctx, "k");
    days.update(undefined);
    assert.equal(text(el.querySelector(".gz-big")), "10days");
    clock.now = new Date(2026, 10, 25, 9, 0);
    days.update(undefined);
    assert.equal(text(el.querySelector(".gz-big")), "10days");
    f.run(0);
    f.run(240);
    assert.equal(text(el.querySelector(".gz-big")), "5days");

    const goal = mount({ view: "progress", title: "Reading goal", source: "s", max: 24, unit: "books" }, "fact");
    goal.handle.update(rows(10));
    goal.handle.update(rows(12));
    assert.equal(text(goal.el.querySelector(".gz-big")), "10/ 24 books");
    assert.equal((goal.el.querySelector(".gz-meter-fill") as HTMLElement).style.width, "50%");
    f.run(0);
    f.run(240);
    assert.equal(text(goal.el.querySelector(".gz-big")), "12/ 24 books");
  } finally {
    f.restore();
  }
});
