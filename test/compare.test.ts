import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { compareWindows, splitByWindow, widenForCompare } from "../src/compare.ts";
import { stampParts } from "../src/data.ts";
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
const span = (w: [number, number] | undefined) => w && [day(w[0]), day(w[1])];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown): HTMLElement {
  const { panel, errors } = checkPanel({ view: def.id, ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, ctx, "k").update(data);
  return el;
}

// ---- compare --------------------------------------------------------------------------------------

test("the previous window is the same length just before; calendar windows step by calendar units", () => {
  const w = (cond: string) => {
    const r = compareWindows({ at: cond }, NOW);
    return r && [span(r.current), span(r.previous)];
  };
  assert.deepEqual(w("this week"), [["2026-11-16", "2026-11-23"], ["2026-11-09", "2026-11-16"]]);
  assert.deepEqual(w("this month"), [["2026-11-01", "2026-12-01"], ["2026-10-01", "2026-11-01"]]);
  assert.deepEqual(w("this year"), [["2026-01-01", "2027-01-01"], ["2025-01-01", "2026-01-01"]]);
  assert.deepEqual(w("today"), [["2026-11-18", "2026-11-19"], ["2026-11-17", "2026-11-18"]]);
  assert.deepEqual(w("yesterday"), [["2026-11-17", "2026-11-18"], ["2026-11-16", "2026-11-17"]]);
  assert.deepEqual(w("last 7 days"), [["2026-11-12", "2026-11-19"], ["2026-11-05", "2026-11-12"]]);
  assert.deepEqual(w("last 3 months"), [["2026-09-01", "2026-12-01"], ["2026-06-01", "2026-09-01"]]);
  assert.deepEqual(w("last 2 weeks"), [["2026-11-09", "2026-11-23"], ["2026-10-26", "2026-11-09"]]);
  assert.deepEqual(w("next 3 days"), [["2026-11-18", "2026-11-22"], ["2026-11-14", "2026-11-18"]]);
  assert.deepEqual(w("2026-11-10"), [["2026-11-10", "2026-11-11"], ["2026-11-09", "2026-11-10"]]);
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
  assert.deepEqual(previous!.map((r) => (r as typeof SPEND[0]).amount), [100, 50]);
  // Without compare the pipeline and the split leave the rows alone.
  const plain = checkPanel({ view: "number", source: "s", field: "amount", agg: "sum", where: { at: "this week" } }, true).panel as Panel;
  assert.deepEqual((compilePipeline(plain, NOW)(SPEND) as typeof SPEND).map((r) => r.amount), [90, 72]);
  assert.deepEqual(splitByWindow(plain, SPEND, NOW), { current: SPEND });
  assert.deepEqual(splitByWindow(p, { not: "rows" }, NOW), { current: { not: "rows" } });
});

const compare = (extra: Record<string, unknown> = {}, rows: unknown[] = SPEND) =>
  draw(number, { source: "s", field: "amount", agg: "sum", where: { at: "this week" }, compare: "previous", ...extra }, rows);
const note = (el: Element) => el.querySelector(".na-compare");

test("number compare: the value is this window's, with an arrow, the difference and the percent", () => {
  const up = compare();
  assert.equal(text_(up.querySelector(".na-big")), "162");
  assert.equal(text_(note(up)), "▲ 12 (8%) vs previous");
  assert.equal(note(up)!.getAttribute("aria-label"), "up 12, 8 percent, versus previous");
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
  assert.equal(text_(empty.querySelector(".na-big")), "—");
  assert.equal(note(empty), null);
});

test("number compare: the difference reads in the panel's format or unit; counts compare too", () => {
  const money = compare({ format: "$0,0.00" });
  assert.equal(text_(money.querySelector(".na-big")), "$162.00");
  assert.equal(text_(note(money)), "▲ $12.00 (8%) vs previous");
  assert.equal(note(money)!.getAttribute("aria-label"), "up $12.00, 8 percent, versus previous");
  assert.equal(text_(note(compare({ unit: "USD" }))), "▲ 12 USD (8%) vs previous");
  const count = draw(number, { source: "s", where: { at: "last 7 days" }, compare: "previous" }, SPEND);
  assert.equal(text_(count.querySelector(".na-big")), "3");
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
  assert.equal(root.querySelector(".na-error"), null);
  assert.equal(text_(root.querySelector(".na-big")), "$162.00");
  assert.equal(text_(root.querySelector(".na-compare")), "▲ $12.00 (8%) vs previous");
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
const barsOf = (el: Element, s: number) => [...el.querySelectorAll(`path.na-bar.na-s${s}`)].map(geometry);
const goalY = (el: Element) => Number(el.querySelector("line.na-goal")!.getAttribute("y1"));
const weights = [{ at: "2026-11-16", w: 10 }, { at: "2026-11-17", w: 40 }, { at: "2026-11-18", w: 60 }];

test("goal draws a dashed line with its label above the data, inside the plot", () => {
  const bars = draw(bar, { source: "s", x: "at", y: "w", goal: 80 }, weights);
  const lines = draw(line, { source: "s", x: "at", y: "w", goal: 80 }, weights);
  for (const el of [bars, lines]) {
    assert.equal(el.querySelectorAll("line.na-goal").length, 1);
    assert.equal(text_(el.querySelector("text.na-goal-label")), "goal 80");
    assert.equal(el.querySelector("svg")!.getAttribute("aria-label"), "goal 80");
    // The plot starts 14 down: a goal beyond the data still fits.
    assert.ok(goalY(el) >= 14, String(goalY(el)));
  }
  assert.ok(goalY(bars) < Math.min(...barsOf(bars, 1).map((b) => b.far)), "above the tallest bar");
  assert.ok(goalY(lines) < Number(lines.querySelector("circle.na-dot")!.getAttribute("cy")), "above the highest point");
  for (const def of [line, bar]) {
    const without = draw(def, { source: "s", x: "at", y: "w" }, weights);
    assert.equal(without.querySelector(".na-goal"), null);
    assert.equal(without.querySelector("svg")!.hasAttribute("aria-label"), false);
  }
});

test("a goal below the data reaches down to it; it reads in the panel's unit or format", () => {
  const low = draw(line, { source: "s", x: "at", y: "w", goal: -30 }, weights);
  // The plot ends at y 194 (220 less the axis labels); the goal is inside it, below every point.
  assert.ok(goalY(low) <= 194 && goalY(low) >= 14, String(goalY(low)));
  assert.ok(goalY(low) > Number(low.querySelector("circle.na-dot")!.getAttribute("cy")));
  assert.equal(text_(draw(bar, { source: "s", x: "at", y: "w", goal: 80, unit: "kg" }, weights).querySelector("text.na-goal-label")), "goal 80 kg");
  assert.equal(text_(draw(bar, { source: "s", x: "at", y: "w", goal: 1234.5, format: "$0,0" }, weights).querySelector("text.na-goal-label")), "goal $1,235");
  const many = draw(line, { source: "s", x: "at", y: ["w", "v"], goal: 80, format: { w: "0.0 kg" } }, weights);
  assert.equal(text_(many.querySelector("text.na-goal-label")), "goal 80.0 kg");
});

// ---- stack ----------------------------------------------------------------------------------------

const parts = [
  { g: "wk1", food: 30, rent: 100, fun: 20 },
  { g: "wk2", food: 10, rent: 0, fun: 5 },
  { g: "wk3", food: 25, rent: 100, fun: -15 },
];

test("stacked bars pile positive values up and negative ones down, rounded only at the outer end", () => {
  const el = draw(bar, { source: "s", x: "g", y: ["food", "rent", "fun"], stack: true }, parts);
  const all = [...el.querySelectorAll("path.na-bar")];
  assert.equal(all.length, 8, "a zero draws nothing");
  assert.ok(all.every((b) => b.classList.contains("na-stacked")));
  const [food, rent, fun] = [1, 2, 3].map((s) => barsOf(el, s));
  assert.deepEqual([food.length, rent.length, fun.length], [3, 2, 3]);
  // A week is one column.
  assert.equal(food[0].x, rent[0].x);
  assert.equal(food[0].x, fun[0].x);
  assert.equal(food[1].x, fun[1].x);
  assert.equal(food[2].x, rent[1].x);
  assert.equal(food[2].x, fun[2].x);
  assert.notEqual(food[0].x, food[1].x);
  // Each segment starts where the one under it ends; negative values start at the same baseline and go down.
  assert.ok(Math.abs(rent[0].base - food[0].far) < 0.01);
  assert.ok(Math.abs(fun[0].base - rent[0].far) < 0.01);
  assert.ok(Math.abs(fun[1].base - food[1].far) < 0.01);
  assert.ok(Math.abs(rent[1].base - food[2].far) < 0.01);
  assert.equal(fun[2].base, food[2].base);
  assert.ok(fun[2].far > fun[2].base, "week 3's negative segment hangs below the baseline");
  assert.ok(food[0].far < food[0].base);
  // Only the segment that ends a stack is rounded: week 1 and 2 end in fun, week 3 in rent, and its negative stack in fun.
  assert.deepEqual(food.map((b) => b.rounded), [false, false, false]);
  assert.deepEqual(rent.map((b) => b.rounded), [false, true]);
  assert.deepEqual(fun.map((b) => b.rounded), [true, true, true]);
});

test("the axis covers the tallest stack, not the tallest segment", () => {
  const rows = [{ g: "a", x: 3, y: 4 }, { g: "b", x: 1, y: 1 }];
  const el = draw(bar, { source: "s", x: "g", y: ["x", "y"], stack: true }, rows);
  const [x, y] = [barsOf(el, 1), barsOf(el, 2)];
  assert.ok(Math.abs(y[0].base - x[0].far) < 0.01, "y stands on x");
  assert.ok(y[0].far >= 14, "the stack of 7 fits in the plot");
  // The scale is shared: 4 on top of 3 is taller than 4 on its own in the side-by-side chart.
  const side = draw(bar, { source: "s", x: "g", y: ["x", "y"] }, rows);
  assert.notEqual(barsOf(side, 1)[0].x, barsOf(side, 2)[0].x, "side by side the same data sits in two columns");
  assert.equal(side.querySelector(".na-stacked"), null);
  assert.ok(y[0].base - y[0].far > 0);
});

test("each segment of a stack calls the selection hook with its x", () => {
  const marks: unknown[] = [];
  const host = document.createElement("div");
  renderChart(host, [
    { name: "a", points: [{ x: "wk1", y: 1 }, { x: "wk2", y: 2 }] },
    { name: "b", points: [{ x: "wk1", y: 3 }, { x: "wk2", y: 0 }] },
  ], { kind: "bar", width: 600, stack: true, mark: (_el, x) => marks.push(x) });
  assert.deepEqual(marks, ["wk1", "wk2", "wk1"]);
});

test("a stacked bar can be selected like any other, by its x", () => {
  const picked: unknown[] = [];
  const c = { ...ctx, select: (_: string, row: unknown) => picked.push(row), selected: () => undefined } as unknown as PanelCtx;
  const { panel } = checkPanel({ view: "bar", source: "s", x: "g", y: ["food", "rent"], stack: true, select: "week" }, true);
  const el = document.createElement("div");
  bar.mount(el, panel as Panel, c, "k").update(parts);
  const segments = [...el.querySelectorAll("path.na-bar")] as HTMLElement[];
  assert.ok(segments.every((b) => b.classList.contains("na-selectable")));
  // Segments are drawn series by series: food ×3, then rent's first is week 1's.
  segments[3].dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(picked, [parts[0]]);
});

test("a stack of one series is drawn as an ordinary chart", () => {
  const host = document.createElement("div");
  renderChart(host, [{ name: "a", points: [{ x: "wk1", y: 1 }] }], { kind: "bar", width: 600, stack: true });
  assert.equal(host.querySelector(".na-stacked"), null);
  assert.equal(host.querySelectorAll("path.na-bar").length, 1);
});

test("goal works on a stack too, above the tallest stack", () => {
  const el = draw(bar, { source: "s", x: "g", y: ["food", "rent"], stack: true, goal: 200 }, parts);
  assert.equal(text_(el.querySelector("text.na-goal-label")), "goal 200");
  assert.ok(goalY(el) >= 14);
  assert.ok(goalY(el) < Math.min(...[1, 2].flatMap((s) => barsOf(el, s).map((b) => b.far))));
});
