import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../src/data.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { timeTicks } from "../src/views/axis.ts";
import { niceTicks } from "../src/views/chart.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { MAX_DOTS, scatter } from "../src/views/scatter.ts";

const text = (el: Element | null | undefined) => el?.textContent ?? "";
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

function fakeCtx(width = 600) {
  const picked: (Row | undefined)[] = [];
  const selections = new Map<string, Row>();
  const ctx = {
    now: new Date(2026, 10, 18),
    width: () => width,
    select: (name: string, row: Row | undefined) => {
      picked.push(row);
      if (row) selections.set(name, row);
      else selections.delete(name);
    },
    selected: (name: string) => selections.get(name),
  } as unknown as PanelCtx;
  return { ctx, picked };
}

function mount(keys: Record<string, unknown>, data: unknown, ctx = fakeCtx().ctx) {
  const { panel, errors } = checkPanel({ view: "scatter", source: "s", x: "w", y: "mpg", ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handle = scatter.mount(el, panel as Panel, ctx, "k");
  handle.update(data);
  return { el, handle };
}

const CARS = [
  { name: "Mini", w: 1200, mpg: 38.2 },
  { name: "Golf", w: 1500, mpg: 31 },
  { name: "Volvo", w: 2100, mpg: 24 },
  { name: "No mileage", w: 1000 },
  { name: "No weight", mpg: 20 },
];
const dots = (el: Element) => [...el.querySelectorAll("circle.gz-scatter-dot")] as HTMLElement[];
const axisLabels = (el: Element) => [...el.querySelectorAll("text.gz-axis")].map((t) => text(t));

test("time ticks are hours, days or months, the finest step that fits", () => {
  assert.deepEqual(timeTicks(at(2026, 11, 1), at(2026, 11, 11), 8).map((t) => t.label), ["Nov 1", "Nov 3", "Nov 5", "Nov 7", "Nov 9", "Nov 11"]);
  assert.deepEqual(timeTicks(at(2026, 11, 3), at(2027, 4, 20), 8).map((t) => t.label), ["Dec 2026", "Jan 2027", "Feb", "Mar", "Apr"]);
  const hours = timeTicks(at(2026, 11, 18), at(2026, 11, 18, 12), 5);
  assert.deepEqual(hours.map((t) => t.at), [0, 3, 6, 9, 12].map((h) => at(2026, 11, 18, h)));
  assert.equal(hours[0].label, "Nov 18");
  assert.deepEqual(timeTicks(at(2021, 3, 1), at(2026, 3, 1), 6).map((t) => t.label), ["2022", "2023", "2024", "2025", "2026"]);
  assert.ok(timeTicks(at(1900, 1, 1), at(2026, 1, 1), 3).length <= 3);
  // Weekly steps start on a Monday.
  const weekly = timeTicks(at(2026, 11, 2), at(2027, 1, 20), 12);
  assert.equal(weekly.length, 12);
  assert.ok(weekly.every((t) => new Date(t.at).getDay() === 1));
});

test("number ticks are round values inside the range", () => {
  assert.deepEqual(niceTicks(0, 100), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(1.2, 3.9, 3), [2, 3]);
  assert.deepEqual(niceTicks(5, 5), [5]);
});

test("one dot per row that has numbers for x and y, r=4 in the first chart colour", () => {
  const { el } = mount({}, CARS);
  assert.equal(dots(el).length, 3);
  for (const d of dots(el)) {
    assert.equal(d.getAttribute("r"), "4");
    assert.ok(d.classList.contains("gz-s1"));
  }
  // Heavier cars sit further right and use less fuel, so lower.
  const [mini, golf, volvo] = dots(el).map((d) => [Number(d.getAttribute("cx")), Number(d.getAttribute("cy"))]);
  assert.ok(mini[0] < golf[0] && golf[0] < volvo[0]);
  assert.ok(mini[1] < golf[1] && golf[1] < volvo[1]);
  assert.ok(axisLabels(el).includes("1,400"));
});

test("a dot's title is item, or x and y with the unit, and it is focusable with a text label", () => {
  const { el } = mount({ unit: "mpg", decimals: 1 }, CARS);
  const [mini] = dots(el);
  assert.equal(text(mini.querySelector("title")), "1,200, 38.2 mpg");
  assert.equal(mini.getAttribute("aria-label"), "1,200, 38.2 mpg");
  assert.deepEqual([mini.getAttribute("tabindex"), mini.getAttribute("role")], ["0", "img"]);
  const named = mount({ item: "{name}: {mpg} mpg" }, CARS);
  assert.deepEqual(dots(named.el).map((d) => text(d.querySelector("title"))), ["Mini: 38.2 mpg", "Golf: 31 mpg", "Volvo: 24 mpg"]);
});

test("hovering or focusing a dot reads it out under the chart; leaving puts the axes back", () => {
  const { el } = mount({ item: "{name}" }, CARS);
  const readout = el.querySelector(".gz-readout")!;
  assert.equal(text(readout), "x: w · y: mpg");
  dots(el)[1].dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  assert.equal(text(readout), "Golf");
  el.querySelector("svg")!.dispatchEvent(new window.Event("pointerleave"));
  assert.equal(text(readout), "x: w · y: mpg");
  dots(el)[2].dispatchEvent(new window.Event("focusin", { bubbles: true }));
  assert.equal(text(readout), "Volvo");
});

test("a date x gets a time axis; an x that is a number gets a number axis", () => {
  const days = [
    { at: "2026-11-01", kg: 80 }, { at: "2026-11-05T12:00", kg: 79 }, { at: "2026-11-11", kg: 78.5 }, { at: "someday", kg: 90 },
  ];
  const timed = mount({ x: "at", y: "kg" }, days);
  assert.equal(dots(timed.el).length, 3);
  assert.deepEqual(axisLabels(timed.el).filter((l) => /^Nov/.test(l)).slice(0, 3), ["Nov 2", "Nov 4", "Nov 6"]);
  const numbered = mount({ x: "w", y: "mpg" }, CARS);
  assert.ok(axisLabels(numbered.el).every((l) => !/Nov/.test(l)));
});

test("an object of parallel arrays plots like rows", () => {
  const { el } = mount({ x: "time", y: "t", item: "{time}: {t}" }, { time: ["2026-11-18T00:00", "2026-11-18T06:00", "2026-11-18T12:00"], t: [4, 9, 7] });
  assert.deepEqual(dots(el).map((d) => text(d.querySelector("title"))), ["2026-11-18T00:00: 4", "2026-11-18T06:00: 9", "2026-11-18T12:00: 7"]);
});

test("with select a dot is a button that picks its data row", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount({ select: "car", item: "{name}" }, CARS, ctx);
  const golf = dots(el)[1];
  assert.deepEqual([golf.getAttribute("role"), golf.getAttribute("tabindex"), golf.getAttribute("aria-label")], ["button", "0", "Golf"]);
  const click = () => golf.dispatchEvent(new window.Event("click", { bubbles: true }));
  click();
  assert.deepEqual(picked, [CARS[1]]);
  assert.ok(golf.classList.contains("gz-selected"));
  click();
  assert.equal(picked.at(-1), undefined);
});

test("past 2,000 dots the first 2,000 are drawn and a note says how many there are", () => {
  const many = Array.from({ length: MAX_DOTS + 500 }, (_, i) => ({ w: i, mpg: i % 50 }));
  const { el } = mount({}, many);
  assert.equal(dots(el).length, MAX_DOTS);
  assert.equal(text(el.querySelector(".gz-label")), `Showing ${(2000).toLocaleString()} of ${(2500).toLocaleString()}`);
  assert.equal(mount({}, many.slice(0, 10)).el.querySelector(".gz-label"), null);
});

test("it draws at the panel's width, redraws on resize, and never narrower than 280", () => {
  const { el, handle } = mount({}, CARS, fakeCtx(500).ctx);
  const box = () => el.querySelector("svg")!.getAttribute("viewBox");
  assert.equal(box(), "0 0 500 220");
  handle.resize!(420);
  assert.equal(box(), "0 0 420 220");
  handle.resize!(100);
  assert.equal(box(), "0 0 280 220");
});

test("nothing to plot says so; one dot still draws", () => {
  assert.equal(text(mount({}, [{ name: "x" }]).el.querySelector(".gz-empty")), "No data to chart yet.");
  assert.equal(dots(mount({}, [{ w: 3, mpg: 3 }]).el).length, 1);
});

test("format sets the axis ticks, the default title and the readout; labels name the axes; values name x in an item", () => {
  const { el } = mount({ format: { w: "0,0 lb", mpg: "0.0 mpg" }, labels: { w: "Weight", mpg: "Efficiency" } }, CARS);
  assert.ok(axisLabels(el).includes("1,400 lb"));
  assert.ok(axisLabels(el).includes("30.0 mpg"));
  assert.equal(text(dots(el)[0].querySelector("title")), "1,200 lb, 38.2 mpg");
  assert.equal(el.querySelector("svg")!.getAttribute("aria-label"), "Efficiency by Weight");
  assert.equal(text(el.querySelector(".gz-readout")), "x: Weight · y: Efficiency");
  dots(el)[1].dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  assert.equal(text(el.querySelector(".gz-readout")), "1,500 lb, 31.0 mpg");
  // format wins over unit and decimals, as it does in the other views.
  assert.equal(text(mount({ format: { mpg: "0 mpg" }, unit: "kg", decimals: 3 }, CARS).el.querySelector("title")), "1,200, 38 mpg");

  const sized = [{ name: "Mini", w: 1200, mpg: 38, size: 1 }, { name: "Volvo", w: 2100, mpg: 24, size: 2 }];
  const named = mount({ item: "{name} ({size}, {w})", values: { size: { 1: "small", 2: "large" } }, format: { w: "0,0 lb" } }, sized).el;
  assert.deepEqual(dots(named).map((d) => text(d.querySelector("title"))), ["Mini (small, 1,200 lb)", "Volvo (large, 2,100 lb)"]);
  assert.deepEqual(checkPanel({ view: "scatter", source: "s", x: "w", y: "mpg", format: "dollars" }, true).errors, [
    'format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes',
  ]);
});
