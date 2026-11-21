import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { compareWindows, splitByWindow, widenForCompare } from "../src/compare.ts";
import { stampParts } from "../src/time.ts";
import { compilePipeline } from "../src/pipeline.ts";
import { checkPanel, readSpec, type Panel } from "../src/spec.ts";
import { bar, line, renderChart } from "../src/views/chart.ts";
import type { PanelCtx, ViewDef } from "../src/views/registry.ts";
import { number } from "../src/views/value.ts";
import { fakeEnv } from "./support/fakes.ts";

// Wednesday 18 November 2026.
const NOW = new Date(2026, 10, 18, 12, 0);
const ctx = { now: NOW, width: () => 600 } as unknown as PanelCtx;
const text_ = (el: Element | null | undefined) => el?.textContent ?? "";
const day = (t: number) => stampParts(new Date(t)).date;
const minute = (t: number) => stampParts(new Date(t)).at;
const span = (w: [number, number] | undefined) => w && [day(w[0]), day(w[1])];
const spanAt = (w: [number, number] | undefined) => w && [minute(w[0]), minute(w[1])];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown): HTMLElement {
  const { panel, errors } = checkPanel({ view: def.id, ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, ctx, "k").update(data);
  return el;
}

// ---- compare --------------------------------------------------------------------------------------

test("the window before steps back by calendar units; one still running is compared up to the same point in it", () => {
  const w = (cond: string) => {
    const r = compareWindows({ at: cond }, NOW);
    return r && [span(r.current), spanAt(r.previous)];
  };
  // Running at Wednesday noon: the window before ends as far into itself as now is into this one.
  assert.deepEqual(w("this week"), [["2026-11-16", "2026-11-23"], ["2026-11-09T00:00", "2026-11-11T12:00"]]);
  assert.deepEqual(w("this month"), [["2026-11-01", "2026-12-01"], ["2026-10-01T00:00", "2026-10-18T12:00"]]);
  assert.deepEqual(w("this year"), [["2026-01-01", "2027-01-01"], ["2025-01-01T00:00", "2025-11-18T12:00"]]);
  assert.deepEqual(w("today"), [["2026-11-18", "2026-11-19"], ["2026-11-17T00:00", "2026-11-17T12:00"]]);
  assert.deepEqual(w("last 7 days"), [["2026-11-12", "2026-11-19"], ["2026-11-05T00:00", "2026-11-11T12:00"]]);
  assert.deepEqual(w("last 3 months"), [["2026-09-01", "2026-12-01"], ["2026-06-01T00:00", "2026-08-18T12:00"]]);
  assert.deepEqual(w("last 2 weeks"), [["2026-11-09", "2026-11-23"], ["2026-10-26T00:00", "2026-11-04T12:00"]]);
  // Finished, the window before is the whole one of the same length just before.
  assert.deepEqual(w("yesterday"), [["2026-11-17", "2026-11-18"], ["2026-11-16T00:00", "2026-11-17T00:00"]]);
  assert.deepEqual(w("2026-11-10"), [["2026-11-10", "2026-11-11"], ["2026-11-09T00:00", "2026-11-10T00:00"]]);
  // A look ahead is compared whole.
  assert.deepEqual(w("next 3 days"), [["2026-11-18", "2026-11-22"], ["2026-11-14T00:00", "2026-11-18T00:00"]]);
});

test("like with like: the middle of a month against the same days of the last, and the middle of a week the same", () => {
  const previous = (cond: string, now: Date) => spanAt(compareWindows({ at: cond }, now)!.previous);
  // Friday 20 November, 19:42: not all of October, but October 1 to the 20th at 19:42.
  assert.deepEqual(previous("this month", new Date(2026, 10, 20, 19, 42)), ["2026-10-01T00:00", "2026-10-20T19:42"]);
  // Wednesday at 10:00: last week from Monday to Wednesday at 10:00.
  assert.deepEqual(previous("this week", new Date(2026, 10, 18, 10, 0)), ["2026-11-09T00:00", "2026-11-11T10:00"]);
  // The current window keeps its end: rows after now aren't there to count.
  assert.deepEqual(span(compareWindows({ at: "this month" }, new Date(2026, 10, 20, 19, 42))!.current), ["2026-11-01", "2026-12-01"]);
});

test("a day of the month past the end of a shorter month steps back to its last day", () => {
  const previous = (now: Date) => spanAt(compareWindows({ at: "this month" }, now)!.previous);
  assert.deepEqual(previous(new Date(2027, 2, 31, 9, 15)), ["2027-02-01T00:00", "2027-02-28T09:15"]);
  assert.deepEqual(previous(new Date(2028, 2, 31, 9, 15)), ["2028-02-01T00:00", "2028-02-29T09:15"]);
  assert.deepEqual(previous(new Date(2026, 9, 31, 23, 59)), ["2026-09-01T00:00", "2026-09-30T23:59"]);
  // A year back from a leap day is February 28.
  assert.deepEqual(spanAt(compareWindows({ at: "this year" }, new Date(2028, 1, 29, 8, 0))!.previous), ["2027-01-01T00:00", "2027-02-28T08:00"]);
});

test("a finished window is compared with the whole window before it", () => {
  const windows = (cond: string) => {
    const r = compareWindows({ at: cond }, NOW)!;
    return [spanAt(r.current), spanAt(r.previous)];
  };
  assert.deepEqual(windows("2026-10-31"), [["2026-10-31T00:00", "2026-11-01T00:00"], ["2026-10-30T00:00", "2026-10-31T00:00"]]);
  assert.deepEqual(windows("yesterday"), [["2026-11-17T00:00", "2026-11-18T00:00"], ["2026-11-16T00:00", "2026-11-17T00:00"]]);
  // One that hasn't started yet is compared whole too.
  assert.deepEqual(windows("2026-12-01"), [["2026-12-01T00:00", "2026-12-02T00:00"], ["2026-11-30T00:00", "2026-12-01T00:00"]]);
});

test("only a date window with both ends can be compared; the first one in where is used", () => {
  for (const cond of ["upcoming", "past", "> 5", "food", "2026-11-10T09:00"]) assert.equal(compareWindows({ at: cond }, NOW), undefined, cond);
  assert.equal(compareWindows({ n: 5, ok: true }, NOW), undefined);
  assert.equal(compareWindows(undefined, NOW), undefined);
  const both = compareWindows({ category: "food", at: "this week", done: "yesterday" }, NOW)!;
  assert.equal(both.field, "at");
});

test("widening opens the window's condition up to the start of the previous one, and nothing else", () => {
  const where = { at: "this week", category: "food" };
  assert.deepEqual(widenForCompare(where, "previous", NOW), { at: ">= 2026-11-09", category: "food" });
  assert.deepEqual(widenForCompare({ at: "this month" }, "previous", NOW), { at: ">= 2026-10-01" });
  assert.equal(widenForCompare(where, undefined, NOW), where);
  assert.equal(widenForCompare({ n: "> 5" }, "previous", NOW).n, "> 5");
});

test("a window in a block above the panel's own where can't be compared, and says so", () => {
  const data = {
    spend: { source: "buys" },
    week: { source: "spend", where: { at: "this week" } },
    food: { source: "week", where: { category: "food" } },
  };
  const errors = (panel: Record<string, unknown>) =>
    readSpec({ app: "x", data, panels: [{ view: "number", field: "amount", agg: "sum", compare: "previous", ...panel }] })!.errors;
  const upstream = ["panel 1: compare needs the date window in this panel's own where"];
  // The window is a stage above the panel, which compare can't open up to the window before.
  assert.deepEqual(errors({ source: "food" }), upstream);
  assert.deepEqual(errors({ source: "food", where: { category: "food" } }), upstream);
  // A window of the panel's own works, whatever is above it; so does the block it names, which is a preset.
  assert.deepEqual(errors({ source: "food", where: { at: "this month" } }), []);
  assert.deepEqual(errors({ source: "week" }), []);
  // No window anywhere is the same error as before.
  assert.deepEqual(errors({ source: "spend" }), ["panel 1: compare needs a date window in where, e.g. where: {at: this week}"]);
});

const SPEND = [
  { at: "2026-11-02T09:00", amount: 999 },
  { at: "2026-11-10T09:00", amount: 100 },
  { at: "2026-11-15T18:00", amount: 50 },
  { at: "2026-11-16T08:00", amount: 90 },
  { at: "2026-11-18T10:00", amount: 72 },
  { at: "2026-11-25T10:00", amount: 5 },
];

test("the pipeline loads both windows, nothing older; rows split back by window", () => {
  const p = checkPanel({ view: "number", source: "s", field: "amount", agg: "sum", where: { at: "this week" }, compare: "previous" }, true).panel as Panel;
  const rows = compilePipeline(p, NOW)(SPEND) as typeof SPEND;
  assert.deepEqual(rows.map((r) => r.amount), [100, 50, 90, 72, 5]);
  const { current, previous } = splitByWindow(p, rows, NOW);
  assert.deepEqual((current as typeof SPEND).map((r) => r.amount), [90, 72]);
  // At Wednesday noon last week counts up to Wednesday noon: Sunday's 50 is past that point.
  assert.deepEqual(previous!.map((r) => (r as typeof SPEND[0]).amount), [100]);
  // Without compare the pipeline and the split leave the rows alone.
  const plain = checkPanel({ view: "number", source: "s", field: "amount", agg: "sum", where: { at: "this week" } }, true).panel as Panel;
  assert.deepEqual((compilePipeline(plain, NOW)(SPEND) as typeof SPEND).map((r) => r.amount), [90, 72]);
  assert.deepEqual(splitByWindow(plain, SPEND, NOW), { current: SPEND });
  assert.deepEqual(splitByWindow(p, { not: "rows" }, NOW), { current: { not: "rows" } });
});

const compare = (extra: Record<string, unknown> = {}, rows: unknown[] = SPEND) =>
  draw(number, { source: "s", field: "amount", agg: "sum", where: { at: "this week" }, compare: "previous", ...extra }, rows);
const note = (el: Element) => el.querySelector(".gz-compare");

test("number compare: the value is this window's, with an arrow, the difference and the percent", () => {
  const up = compare();
  assert.equal(text_(up.querySelector(".gz-big")), "162");
  assert.equal(text_(note(up)), "▲ 62 (62%) vs previous");
  assert.equal(note(up)!.getAttribute("aria-label"), "up 62, 62 percent, versus previous");
  assert.equal(note(up)!.getAttribute("role"), "img");

  const down = compare({}, [{ at: "2026-11-10", amount: 150 }, { at: "2026-11-17", amount: 147 }]);
  assert.equal(text_(note(down)), "▼ 3 (2%) vs previous");
  assert.equal(note(down)!.getAttribute("aria-label"), "down 3, 2 percent, versus previous");

  const same = compare({}, [{ at: "2026-11-10", amount: 150 }, { at: "2026-11-17", amount: 150 }]);
  assert.equal(text_(note(same)), "no change vs previous");
  assert.equal(note(same)!.getAttribute("aria-label"), "no change, versus previous");
});

test("number compare: no previous data, and a change from nothing has no percent", () => {
  assert.equal(text_(note(compare({}, [{ at: "2026-11-17", amount: 40 }]))), "no previous data");
  assert.equal(text_(note(compare({}, []))), "no previous data");
  const zero = compare({}, [{ at: "2026-11-10", amount: 0 }, { at: "2026-11-17", amount: 40 }]);
  assert.equal(text_(note(zero)), "▲ 40 vs previous");
  assert.equal(note(zero)!.getAttribute("aria-label"), "up 40, versus previous");
  const tiny = compare({}, [{ at: "2026-11-10", amount: 1000 }, { at: "2026-11-17", amount: 1001 }]);
  assert.equal(text_(note(tiny)), "▲ 1 (<1%) vs previous");
  assert.equal(note(tiny)!.getAttribute("aria-label"), "up 1, less than 1 percent, versus previous");
  // Nothing in this window: the value shows its dash and no comparison is made against it.
  const empty = compare({}, [{ at: "2026-11-10", amount: 100 }]);
  assert.equal(text_(empty.querySelector(".gz-big")), "—");
  assert.equal(note(empty), null);
});

test("number compare: the difference reads in the panel's format or unit; counts compare too", () => {
  const money = compare({ format: "$0,0.00" });
  assert.equal(text_(money.querySelector(".gz-big")), "$162.00");
  assert.equal(text_(note(money)), "▲ $62.00 (62%) vs previous");
  assert.equal(note(money)!.getAttribute("aria-label"), "up $62.00, 62 percent, versus previous");
  assert.equal(text_(note(compare({ unit: "USD" }))), "▲ 62 USD (62%) vs previous");
  const count = draw(number, { source: "s", where: { at: "last 7 days" }, compare: "previous" }, SPEND);
  assert.equal(text_(count.querySelector(".gz-big")), "3");
  assert.equal(text_(note(count)), "▲ 2 (200%) vs previous");
  const plain = draw(number, { source: "s", field: "amount", agg: "sum", where: { at: "this week" } }, SPEND.slice(1, 5));
  assert.equal(note(plain), null);
});

test("an app loads one window's data once and compares it with the one before", async () => {
  const fm = {
    app: "Spending",
    panels: [{ view: "number", source: "spend", field: "amount", agg: "sum", where: { at: "this week" }, compare: "previous", format: "$0,0.00" }],
  };
  const t = fakeEnv({ "Apps/Spend.md": { fm }, "Apps/Spend data.md": { fm: { spend: SPEND } } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Spend.md", t.env).load();
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.equal(text_(root.querySelector(".gz-big")), "$162.00");
  // The app lays its number out as the headline, which names the window before: Monday to Wednesday noon.
  assert.equal(text_(root.querySelector(".gz-compare")), "↑ $62.00 more than Nov 9–11 · $100.00");
  assert.deepEqual(t.f.requests, []);
});

test("compare is checked", () => {
  const errors = (keys: Record<string, unknown>) => checkPanel({ view: "number", source: "s", ...keys }, true).errors;
  assert.deepEqual(errors({ compare: "previous", where: { at: "this week" } }), []);
  assert.deepEqual(errors({ compare: "last year", where: { at: "this week" } }), ["compare must be previous"]);
  assert.deepEqual(errors({ compare: "previous" }), ["compare needs a date window in where, e.g. where: {at: this week}"]);
  assert.deepEqual(errors({ compare: "previous", where: { at: "upcoming" } }), ["compare needs a date window in where, e.g. where: {at: this week}"]);
  assert.deepEqual(errors({ compare: "previous", group: "at", per: "day", agg: "streak", where: { at: "this week" } }), ["compare doesn't work with streak"]);
  assert.deepEqual(checkPanel({ view: "progress", source: "s", compare: "previous" }, true).errors, ['"compare" doesn\'t apply to progress']);
});

// ---- goal -----------------------------------------------------------------------------------------

const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** A bar path's x, its baseline, and its far end: a square bar's V, a rounded bar's curve. */
const geometry = (el: Element) => {
  const d = el.getAttribute("d")!;
  const n = nums(d);
  return { x: n[0], base: n[1], far: d.includes("Q") ? nums(d.slice(d.indexOf("Q")))[1] : n[2], rounded: d.includes("Q") };
};
const barsOf = (el: Element, s: number) => [...el.querySelectorAll(`path.gz-bar.gz-s${s}`)].map(geometry);
const goalY = (el: Element) => Number(el.querySelector("line.gz-goal")!.getAttribute("y1"));
const weights = [{ at: "2026-11-16", w: 10 }, { at: "2026-11-17", w: 40 }, { at: "2026-11-18", w: 60 }];

test("goal draws a dashed line with its label above the data, inside the plot", () => {
  const bars = draw(bar, { source: "s", x: "at", y: "w", goal: 80 }, weights);
  const lines = draw(line, { source: "s", x: "at", y: "w", goal: 80 }, weights);
  for (const [el, label] of [[bars, "80 goal"], [lines, "Goal 80"]] as const) {
    assert.equal(el.querySelectorAll("line.gz-goal").length, 1);
    assert.equal(text_(el.querySelector("text.gz-goal-label")), label);
    assert.equal(el.querySelector("svg")!.getAttribute("aria-label"), "goal 80");
    // The plot starts 14 down: a goal beyond the data still fits.
    assert.ok(goalY(el) >= 14, String(goalY(el)));
  }
  assert.ok(goalY(bars) < Math.min(...barsOf(bars, 1).map((b) => b.far)), "above the tallest bar");
  assert.ok(goalY(lines) < Number(lines.querySelector("circle.gz-dot")!.getAttribute("cy")), "above the highest point");
  for (const def of [line, bar]) {
    const without = draw(def, { source: "s", x: "at", y: "w" }, weights);
    assert.equal(without.querySelector(".gz-goal"), null);
    assert.equal(without.querySelector("svg")!.hasAttribute("aria-label"), false);
  }
});

test("a goal below the data reaches down to it; it reads in the panel's unit or format", () => {
  const low = draw(line, { source: "s", x: "at", y: "w", goal: -30 }, weights);
  // The plot ends at y 194 (220 less the axis labels); the goal is inside it, below every point.
  assert.ok(goalY(low) <= 194 && goalY(low) >= 14, String(goalY(low)));
  assert.ok(goalY(low) > Number(low.querySelector("circle.gz-dot")!.getAttribute("cy")));
  assert.equal(text_(draw(bar, { source: "s", x: "at", y: "w", goal: 80, unit: "kg" }, weights).querySelector("text.gz-goal-label")), "80 kg goal");
  assert.equal(text_(draw(bar, { source: "s", x: "at", y: "w", goal: 1234.5, format: "$0,0" }, weights).querySelector("text.gz-goal-label")), "$1,235 goal");
  const many = draw(line, { source: "s", x: "at", y: ["w", "v"], goal: 80, format: { w: "0.0 kg" } }, weights);
  assert.equal(text_(many.querySelector("text.gz-goal-label")), "Goal 80.0 kg");
});

// ---- stack ----------------------------------------------------------------------------------------

const parts = [
  { g: "wk1", food: 30, rent: 100, fun: 20 },
  { g: "wk2", food: 10, rent: 0, fun: 5 },
  { g: "wk3", food: 25, rent: 100, fun: -15 },
];

/** A bar path's near and far ends, whichever way it points. */
const heightOf = (el: Element) => { const g = geometry(el); return Math.abs(g.base - g.far); };
const names = (el: Element, cls: string) => [...el.querySelectorAll(cls)].map((e) => text_(e));

test("a stack is one bar per x, the total of its series, rounded at the top", () => {
  const el = draw(bar, { source: "s", x: "g", y: ["food", "rent", "fun"], stack: true }, parts);
  const all = [...el.querySelectorAll("path.gz-bar")];
  assert.equal(all.length, 3, "one bar for each of the three weeks");
  assert.ok(all.every((b) => b.getAttribute("class") === "gz-bar" && geometry(b).rounded), "no series colour: pencil like a single series");
  // The totals are 150, 15 and 110 (the 15 refunded in week 3 comes off): the heights keep that proportion.
  const [one, two, three] = all.map(heightOf);
  assert.ok(Math.abs(one / two - 10) < 0.01, `${one} / ${two}`);
  assert.ok(Math.abs(one / three - 150 / 110) < 0.01);
  assert.equal(new Set(all.map((b) => geometry(b).x)).size, 3);
  assert.ok(all.every((b) => geometry(b).far < geometry(b).base), "every total is above the baseline");
});

test("a stack tells the composition of the last bar above the plot: when, total, a strip of its parts, each part", () => {
  const el = draw(bar, { source: "s", x: "g", y: ["food", "rent", "fun"], stack: true }, parts);
  assert.equal(text_(el.querySelector(".gz-stack-when")), "wk3");
  assert.equal(text_(el.querySelector(".gz-stack-total")), "110");
  assert.equal(el.querySelector(".gz-readout"), null);
  // Week 3: food 25, rent 100 and a refund of 15, which has no share of the strip.
  const strip = [...el.querySelectorAll(".gz-strip span")] as HTMLElement[];
  assert.deepEqual(strip.map((s) => [s.getAttribute("class"), s.style.flexGrow]), [["gz-s1", "25"], ["gz-s2", "100"]]);
  assert.deepEqual(names(el, ".gz-legend-name"), ["food", "rent", "fun"]);
  assert.deepEqual(names(el, ".gz-legend-value"), ["25", "100", "-15"]);
  assert.equal(el.querySelector(".gz-legend-at"), null);
  // Week 2 has no rent: its swatch is faint and its share is left out of the strip.
  el.querySelectorAll("path.gz-bar")[1].dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  assert.deepEqual(names(el, ".gz-legend-value"), ["10", "0", "5"]);
  assert.deepEqual([...el.querySelectorAll(".gz-legend-item")].map((i) => i.classList.contains("gz-zero")), [false, true, false]);
  assert.deepEqual([...el.querySelectorAll(".gz-strip span")].map((s) => s.getAttribute("class")), ["gz-s1", "gz-s3"]);
});

test("the axis covers the tallest total, not the tallest segment", () => {
  const rows = [{ g: "a", x: 3, y: 4 }, { g: "b", x: 1, y: 1 }];
  const el = draw(bar, { source: "s", x: "g", y: ["x", "y"], stack: true }, rows);
  const [a, b] = [...el.querySelectorAll("path.gz-bar")];
  assert.ok(geometry(a).far >= 14, "the total of 7 fits in the plot");
  assert.ok(Math.abs(heightOf(a) / heightOf(b) - 7 / 2) < 0.01);
  assert.equal(el.querySelectorAll("path.gz-bar").length, 2);
  // Side by side the same data is four bars in two columns, with no strip.
  const side = draw(bar, { source: "s", x: "g", y: ["x", "y"] }, rows);
  assert.equal(side.querySelector(".gz-strip"), null);
  assert.equal(side.querySelectorAll("path.gz-bar").length, 4);
  assert.notEqual(barsOf(side, 1)[0].x, barsOf(side, 2)[0].x);
});

test("a stack's bar calls the selection hook with its x", () => {
  const marks: unknown[] = [];
  const host = document.createElement("div");
  renderChart(host, [
    { name: "a", points: [{ x: "wk1", y: 1 }, { x: "wk2", y: 2 }] },
    { name: "b", points: [{ x: "wk1", y: 3 }, { x: "wk2", y: 0 }] },
  ], { kind: "bar", width: 600, stack: true, mark: (_el, x) => marks.push(x) });
  assert.deepEqual(marks, ["wk1", "wk2"]);
});

test("a stacked bar can be selected like any other, by its x", () => {
  const picked: unknown[] = [];
  const c = { ...ctx, select: (_: string, row: unknown) => picked.push(row), selected: () => undefined } as unknown as PanelCtx;
  const { panel } = checkPanel({ view: "bar", source: "s", x: "g", y: ["food", "rent"], stack: true, select: "week" }, true);
  const el = document.createElement("div");
  bar.mount(el, panel as Panel, c, "k").update(parts);
  const bars = [...el.querySelectorAll("path.gz-bar")] as HTMLElement[];
  assert.equal(bars.length, 3);
  assert.ok(bars.every((b) => b.classList.contains("gz-selectable")));
  bars[0].dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(picked, [parts[0]]);
});

test("a stack of one series is drawn as an ordinary chart", () => {
  const host = document.createElement("div");
  renderChart(host, [{ name: "a", points: [{ x: "wk1", y: 1 }] }], { kind: "bar", width: 600, stack: true });
  assert.equal(host.querySelector(".gz-stack-head"), null);
  assert.equal(host.querySelector(".gz-strip"), null);
  assert.equal(host.querySelectorAll("path.gz-bar").length, 1);
});

test("goal works on a stack too, above the tallest stack", () => {
  const el = draw(bar, { source: "s", x: "g", y: ["food", "rent"], stack: true, goal: 200 }, parts);
  assert.equal(text_(el.querySelector("text.gz-goal-label")), "200 goal");
  assert.ok(goalY(el) >= 14);
  assert.ok(goalY(el) < Math.min(...[...el.querySelectorAll("path.gz-bar")].map((b) => geometry(b).far)));
  assert.equal(text_(el.querySelector(".gz-stack-total")), "125 of 200");
});
