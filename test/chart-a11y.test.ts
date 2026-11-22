import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel, type Panel } from "../src/spec.ts";
import { bar, line } from "../src/views/chart.ts";
import { pie } from "../src/views/pie.ts";
import { scatter } from "../src/views/scatter.ts";
import type { PanelCtx, ViewDef } from "../src/views/registry.ts";

// What a screen reader is given for a chart: a summary sentence as its name, and a hidden table of its points.

const NOW = new Date(2026, 10, 18, 12);

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown, ctx: Partial<PanelCtx> = {}): HTMLElement {
  const { panel, errors } = checkPanel({ view: def.id, source: "s", ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, { now: NOW, width: () => 600, ...ctx } as PanelCtx, "k").update(data);
  return el;
}

const name = (el: Element) => el.querySelector("svg")!.getAttribute("aria-label");
const role = (el: Element) => el.querySelector("svg")!.getAttribute("role");
/** The hidden table after the chart: its caption, then each row's cells. */
const table = (el: Element) => {
  const t = el.querySelector(".gz-sr-only table");
  if (!t) return undefined;
  return {
    caption: t.querySelector("caption")?.textContent,
    rows: [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => c.textContent)),
  };
};

const WEIGHTS = [
  { at: "2026-05-03", w: 82.1 },
  { at: "2026-07-10", w: 80.5 },
  { at: "2026-09-01", w: 79.1 },
  { at: "2026-11-02", w: 79.4 },
];

test("a line over time is named by what it covers: how many, first and last, the lowest not yet said, the goal", () => {
  const el = draw(line, { title: "Weight", x: "at", y: "w", unit: "kg", goal: 75, where: { at: "last 6 months" } }, WEIGHTS);
  assert.equal(name(el), "Weight, last 6 months: 4 entries from 82.1 kg on May 3 to 79.4 kg on Nov 2, lowest 79.1, goal 75");
  assert.equal(role(el), "img");
  // Every point, in a table after the chart: x, then the series.
  assert.deepEqual(table(el), {
    caption: "Weight",
    rows: [["at", "w"], ["May 3", "82.1 kg"], ["Jul 10", "80.5 kg"], ["Sep 1", "79.1 kg"], ["Nov 2", "79.4 kg"]],
  });
  assert.ok(el.querySelector("svg")!.nextElementSibling!.classList.contains("gz-sr-only"), "right after the chart");
});

test("a summary stays one short sentence however many points there are", () => {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const days = Array.from({ length: 180 }, (_, i) => ({ at: day(new Date(2026, 5, 1 + i)), w: 80 + Math.sin(i) * 2 }));
  const el = draw(line, { x: "at", y: "w", decimals: 1 }, days);
  assert.match(name(el)!, /^w: 180 entries from 80\.0 on Jun 1 to .* on Nov 27, lowest 78\.0, highest 82\.0$/);
  assert.equal(table(el)!.rows.length, 181);
});

test("a window that isn't a date, or a point on its own, is said plainly", () => {
  assert.equal(name(draw(line, { x: "at", y: "w", unit: "kg", where: { w: "> 80" } }, WEIGHTS)), "w: 4 entries from 82.1 kg on May 3 to 79.4 kg on Nov 2, lowest 79.1");
  assert.equal(name(draw(line, { x: "at", y: "w", unit: "kg" }, WEIGHTS.slice(0, 1))), "w: 1 entry, 82.1 kg on May 3");
});

test("a chart over the hours of one day names its points by the time; a span of years adds the year", () => {
  const hourly = { time: ["2026-11-18T00:00", "2026-11-18T01:00", "2026-11-18T02:00"], t: [4, 5, 6], feels: [2, 3, 3] };
  const el = draw(line, { x: "time", y: ["t", "feels"], labels: { t: "Temp", feels: "Feels like" } }, hourly);
  assert.equal(name(el), "Temp and Feels like: 3 entries from 12:00 AM to 2:00 AM; latest Temp 6, Feels like 3");
  assert.deepEqual(table(el)!.rows, [["time", "Temp", "Feels like"], ["12:00 AM", "4", "2"], ["1:00 AM", "5", "3"], ["2:00 AM", "6", "3"]]);
  const years = draw(line, { x: "at", y: "w" }, [{ at: "2025-12-30", w: 1 }, { at: "2026-01-02", w: 2 }]);
  assert.equal(name(years), "w: 2 entries from 1 on Dec 30, 2025 to 2 on Jan 2, 2026");
});

test("bars per week say weeks; a stack gives its totals, then the parts of the latest, and a Total column", () => {
  const weeks = [
    { at: "2026-11-02", food: 30, rent: 100 },
    { at: "2026-11-09", food: 60, rent: 150 },
    { at: "2026-11-16", food: 40, rent: 100 },
  ];
  const el = draw(bar, { title: "Spend", group: "at", per: "week", y: ["food", "rent"], agg: "sum", stack: true, format: "$0,0", goal: 200 }, weeks);
  assert.equal(name(el), "Spend: 3 weeks from $130 in the week of Nov 2 to $140 in the week of Nov 16, highest $210, goal $200; latest food $40, rent $100");
  assert.deepEqual(table(el)!.rows, [
    ["at", "food", "rent", "Total"],
    ["Week of Nov 2", "$30", "$100", "$130"],
    ["Week of Nov 9", "$60", "$150", "$210"],
    ["Week of Nov 16", "$40", "$100", "$140"],
  ]);
});

test("categories are named one by one, or by the highest and lowest when there are many", () => {
  const books = [{ genre: "fiction", count: 3 }, { genre: "history", count: 1 }];
  assert.equal(name(draw(bar, { group: "genre", values: { genre: { fiction: "Fiction" } } }, books)), "count by genre: Fiction 3, history 1");
  const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((g, i) => ({ g, count: 10 - i }));
  assert.equal(name(draw(bar, { group: "g" }, many)), "count by g: 8 groups, highest a 10, lowest h 3");
  const budget = [{ category: "food", planned: 5, spent: 4 }, { category: "rent", planned: 9, spent: 9 }];
  assert.equal(name(draw(bar, { x: "category", y: ["planned", "spent"] }, budget)), "planned and spent by category: 2 groups: food and rent");
});

test("bars that pick are buttons named by x and value inside a group; the rest of the drawing is hidden", () => {
  const el = draw(bar, { group: "genre", select: "genre" }, [{ genre: "fiction", count: 3 }, { genre: "history", count: 1 }], {
    select() {}, selected: () => undefined,
  });
  const svg = el.querySelector("svg")!;
  assert.equal(role(el), "group");
  assert.match(name(el)!, /^count by genre: /);
  const bars = [...svg.querySelectorAll("path.gz-bar")];
  assert.deepEqual(bars.map((b) => [b.getAttribute("role"), b.getAttribute("aria-label"), b.getAttribute("aria-hidden")]), [["button", "fiction: 3", null], ["button", "history: 1", null]]);
  const others = [...svg.children].filter((c) => !c.classList.contains("gz-bar"));
  assert.ok(others.length > 0 && others.every((c) => c.getAttribute("aria-hidden") === "true"));
  assert.ok(table(el), "the table of points is still there");
});

test("a pie is one image named by its slices' shares; its legend entries pick, the slices only for the pointer", () => {
  const spend = [{ category: "food", amount: 50 }, { category: "home", amount: 30 }, { category: "fun", amount: 20 }];
  const plain = draw(pie, { title: "Spend by category", group: "category", y: "amount", agg: "sum", format: "$0,0" }, spend);
  assert.equal(name(plain), "Spend by category: food 50%, home 30%, fun 20%; total $100");
  assert.equal(role(plain), "img");
  assert.equal(table(plain), undefined, "the legend lists every slice already");
  assert.equal(name(draw(pie, { group: "category" }, [{ category: "a", count: 1 }])), "count by category: a 100%; total 1");

  const picking = draw(pie, { group: "category", y: "amount", agg: "sum", select: "category" }, spend, { select() {}, selected: () => undefined });
  assert.equal(role(picking), "img");
  const slice = picking.querySelector(".gz-slice")!;
  assert.ok(slice.classList.contains("gz-selectable"));
  assert.deepEqual(["role", "tabindex", "aria-label", "aria-pressed"].map((a) => slice.getAttribute(a)), [null, null, null, null]);
  const items = [...picking.querySelectorAll(".gz-legend-item")];
  assert.deepEqual(items.map((i) => [i.getAttribute("role"), i.getAttribute("tabindex"), i.getAttribute("aria-label")]), [
    ["button", "0", "food: 50, 50%"], ["button", "-1", "home: 30, 30%"], ["button", "-1", "fun: 20, 20%"],
  ]);
});

test("a scatter is a group of its labelled dots, one Tab stop, named by how many and the ranges they cover", () => {
  const cars = [{ w: 2100, mpg: 24 }, { w: 1200, mpg: 38.2 }, { w: 1500, mpg: 31 }];
  const el = draw(scatter, { x: "w", y: "mpg", unit: "mpg" }, cars);
  assert.equal(name(el), "mpg by w: 3 points, w from 1,200 to 2,100, mpg from 24 mpg to 38.2 mpg");
  assert.equal(role(el), "group");
  const dots = [...el.querySelectorAll("circle.gz-scatter-dot")];
  // Drawn left to right, so the arrows follow the x axis.
  assert.deepEqual(dots.map((d) => [d.getAttribute("role"), d.getAttribute("tabindex"), d.getAttribute("aria-label")]), [
    ["img", "0", "1,200, 38.2 mpg"], ["img", "-1", "1,500, 31 mpg"], ["img", "-1", "2,100, 24 mpg"],
  ]);
  assert.ok([...el.querySelectorAll("text.gz-axis")].every((t) => t.getAttribute("aria-hidden") === "true"));
  assert.equal(table(el), undefined, "the dots are read one by one");
  const many = Array.from({ length: 2500 }, (_, i) => ({ w: i, mpg: i % 50 }));
  assert.match(name(draw(scatter, { x: "w", y: "mpg" }, many))!, /^mpg by w: 2,500 points, 2,000 drawn, w from 0 to 1,999, mpg from 0 to 49$/);
});
