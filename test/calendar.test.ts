import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataLayer } from "../src/datalayer.ts";
import type { Row } from "../src/data.ts";
import { compilePipeline } from "../src/pipeline.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { calendar, shadeSteps } from "../src/views/calendar.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { fakeHost } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12);
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const key = (el: Element, name: string) => {
  const e = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
  e.key = name;
  el.dispatchEvent(e);
};

/** A ctx that remembers selections, as the app does. */
function fakeCtx(width = 600) {
  const selections = new Map<string, Row>();
  const picked: (Row | undefined)[] = [];
  const ctx = {
    now: NOW,
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
  const { panel, errors } = checkPanel({ view: "calendar", source: "s", group: "at", ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handle = calendar.mount(el, panel as Panel, ctx, "k");
  handle.update(data);
  return { el, handle };
}

// What the pipeline hands the view: one row per day with data.
const DAYS = [
  { at: "2026-11-03", count: 2 },
  { at: "2026-11-04", count: 1 },
  { at: "2026-11-05", count: 4 },
  { at: "2026-11-06", count: 0 },
  { at: "2026-11-17", count: 3 },
];
const cell = (el: Element, date: string) => el.querySelector(`[data-date="${date}"]`) as HTMLElement;
const step = (el: Element | null) => /gz-step-(\d)/.exec(el?.getAttribute("class") ?? "")?.[1];

test("shades are five steps by where a value sits among the non-zero ones; zero has none", () => {
  assert.deepEqual([...shadeSteps([1, 2, 3, 4, 5, 0, 0])], [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  // Ties count halfway, so a plain 0/1 habit sits in the middle and 1 and 2 still differ.
  assert.deepEqual([...shadeSteps([1, 1, 1])], [[1, 3]]);
  assert.deepEqual([...shadeSteps([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2])], [[1, 3], [2, 5]]);
  assert.deepEqual([...shadeSteps([0, 0])], []);
});

test("a calendar always groups per day, even when per isn't typed", () => {
  const rows = [{ at: "2026-11-03T08:00" }, { at: "2026-11-03T20:00" }, { at: "2026-11-05T07:00" }];
  const p = checkPanel({ view: "calendar", source: "s", group: "at" }, true).panel as Panel;
  assert.equal(p.per, undefined);
  assert.deepEqual(compilePipeline(p, NOW)(rows), [
    { at: "2026-11-03", count: 2 }, { at: "2026-11-04", count: 0 }, { at: "2026-11-05", count: 1 },
  ]);
  const summed = checkPanel({ view: "calendar", source: "s", group: "at", y: "n", agg: "sum" }, true).panel as Panel;
  assert.deepEqual(compilePipeline(summed, NOW)([{ at: "2026-11-03T08:00", n: 3 }, { at: "2026-11-03T09:00", n: 4 }]), [{ at: "2026-11-03", count: 2, n: 7 }]);
});

test("a calendar's rows reach the view per day through the data layer", async () => {
  const f = fakeHost({ "A data.md": { fm: { log: [{ at: "2026-11-03T08:00" }, { at: "2026-11-03T20:00" }, { at: "2026-11-05T07:00" }] } } });
  const p = checkPanel({ view: "calendar", source: "log", group: "at" }, true).panel as Panel;
  const rows = await new DataLayer(f.host).panelData(p.source, p, { appPath: "A.md", dataPath: "A data.md" }, { ttlMs: 0, now: NOW });
  assert.deepEqual((rows as Row[]).map((r) => [r.at, r.count]), [["2026-11-03", 2], ["2026-11-04", 0], ["2026-11-05", 1]]);
});

test("the month grid starts on Monday, lines the 1st up under its weekday and outlines today", () => {
  const { el } = mount({}, DAYS);
  assert.equal(text(el.querySelector(".gz-cal-title")), "November 2026");
  assert.deepEqual([...el.querySelectorAll(".gz-cal-dow")].map((d) => text(d)), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  // 1 November 2026 is a Sunday: six blanks, then thirty days.
  assert.equal(el.querySelectorAll(".gz-cal-blank").length, 6);
  assert.equal(el.querySelectorAll(".gz-cal-day").length, 30);
  const [first, today] = [cell(el, "2026-11-01"), cell(el, "2026-11-18")];
  assert.equal(text(first.querySelector(".gz-cal-num")), "1");
  assert.ok(today.classList.contains("gz-today"));
  assert.equal(el.querySelectorAll(".gz-today").length, 1);
});

test("each day shows its value and is shaded by quantile; zero and missing days are not", () => {
  const { el } = mount({}, DAYS);
  assert.equal(text(cell(el, "2026-11-05").querySelector(".gz-cal-val")), "4");
  assert.deepEqual(["2026-11-04", "2026-11-03", "2026-11-17", "2026-11-05"].map((d) => step(cell(el, d))), ["1", "2", "4", "5"]);
  for (const d of ["2026-11-06", "2026-11-10"]) {
    assert.equal(step(cell(el, d)), undefined);
    assert.equal(cell(el, d).querySelector(".gz-cal-val"), null);
  }
  assert.equal(cell(el, "2026-11-03").getAttribute("title"), "2026-11-03: 2");
  assert.equal(cell(el, "2026-11-10").getAttribute("aria-label"), "2026-11-10: 0");
});

test("with y and agg a day shows its total", () => {
  const { el } = mount({ y: "amount", agg: "sum", label: "spent" }, [{ at: "2026-11-03", count: 2, amount: 12.5 }, { at: "2026-11-04", count: 1, amount: 40 }]);
  assert.equal(text(cell(el, "2026-11-03").querySelector(".gz-cal-val")), "12.5");
  assert.equal(cell(el, "2026-11-04").getAttribute("aria-label"), "2026-11-04: 40");
  assert.equal(text(el.querySelector(".gz-title")), "spent");
});

test("prev, next and Today move the month; the month survives a data reload and keeps the button focused", () => {
  const { el, handle } = mount({}, DAYS);
  const button = (name: string) => el.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;
  assert.deepEqual([...el.querySelectorAll("button")].map((b) => text(b)), ["‹", "›", "Today"]);
  button("Previous month").click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "October 2026");
  assert.equal(document.activeElement, button("Previous month"));
  handle.update([{ at: "2026-10-31", count: 5 }]);
  assert.equal(text(el.querySelector(".gz-cal-title")), "October 2026");
  assert.equal(text(cell(el, "2026-10-31").querySelector(".gz-cal-val")), "5");
  button("Next month").click();
  button("Next month").click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "December 2026");
  button("Next month").click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "January 2027");
  (el.querySelector("button.gz-cal-today") as HTMLButtonElement).click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "November 2026");
});

test("days are buttons that pick their row, days without data included; picking again clears", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount({ select: "day" }, DAYS, ctx);
  const day = cell(el, "2026-11-04");
  assert.deepEqual([day.getAttribute("role"), day.getAttribute("tabindex")], ["button", "0"]);
  day.click();
  assert.deepEqual(picked, [{ at: "2026-11-04", count: 1 }]);
  assert.ok(day.classList.contains("gz-selected"));
  cell(el, "2026-11-10").click();
  assert.deepEqual(picked.at(-1), { at: "2026-11-10", count: 0 });
  assert.ok(!day.classList.contains("gz-selected"));
  cell(el, "2026-11-10").click();
  assert.equal(picked.at(-1), undefined);
});

test("a day with no data picks zero for each total", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount({ select: "day", y: "amount", agg: "sum" }, [{ at: "2026-11-03", count: 1, amount: 9 }], ctx);
  cell(el, "2026-11-10").click();
  assert.deepEqual(picked, [{ at: "2026-11-10", count: 0, amount: 0 }]);
  const avg = mount({ select: "day", y: "amount", agg: "avg" }, [], ctx);
  assert.equal(cell(avg.el, "2026-11-10").getAttribute("aria-label"), "2026-11-10: no data");
});

test("without select a day isn't a control but still has its text", () => {
  const { el } = mount({}, DAYS);
  const day = cell(el, "2026-11-03");
  assert.deepEqual([day.getAttribute("role"), day.getAttribute("tabindex")], ["img", null]);
});

test("arrow keys move by day and by week inside the month, and stop at its edges", () => {
  const { el } = mount({ select: "day" }, DAYS);
  const press = (from: string, k: string) => {
    cell(el, from).focus();
    key(cell(el, from), k);
    return document.activeElement?.getAttribute("data-date");
  };
  assert.equal(press("2026-11-04", "ArrowRight"), "2026-11-05");
  assert.equal(press("2026-11-04", "ArrowLeft"), "2026-11-03");
  assert.equal(press("2026-11-04", "ArrowDown"), "2026-11-11");
  assert.equal(press("2026-11-11", "ArrowUp"), "2026-11-04");
  assert.equal(press("2026-11-01", "ArrowLeft"), "2026-11-01");
  assert.equal(press("2026-11-30", "ArrowDown"), "2026-11-30");
});

test("year layout: 53 week columns of 7 days, month names on top, each day labelled", () => {
  const { el } = mount({ layout: "year", select: "day" }, [{ at: "2026-03-14", count: 3 }, { at: "2026-03-15", count: 1 }]);
  assert.equal(text(el.querySelector(".gz-cal-title")), "2026");
  const rects = [...el.querySelectorAll("rect")];
  assert.equal(rects.length, 365);
  assert.deepEqual([...el.querySelectorAll("text")].map((t) => text(t)), ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  const day = cell(el, "2026-03-14");
  assert.equal(day.getAttribute("aria-label"), "2026-03-14: 3");
  assert.equal(text(day.querySelector("title")), "2026-03-14: 3");
  assert.equal(step(day), "4");
  assert.ok(cell(el, "2026-11-18").classList.contains("gz-today"));
  // 1 January 2026 is a Thursday, so it is the fourth row of the first column; Monday is the first row.
  const [jan1, jan5, dec31] = ["2026-01-01", "2026-01-05", "2026-12-31"].map((d) => cell(el, d));
  const at = (r: Element) => [Number(r.getAttribute("x")), Number(r.getAttribute("y"))];
  assert.equal(at(jan1)[0], 0);
  assert.equal(at(jan5)[0] > 0, true);
  assert.equal(at(jan5)[1], at(cell(el, "2026-01-12"))[1]);
  assert.equal(new Set(rects.map((r) => r.getAttribute("x"))).size, 53);
  assert.equal(at(dec31)[0], Math.max(...rects.map((r) => at(r)[0])));
});

test("year cells fit the panel width, never below 8px, and scroll when they can't", () => {
  const widest = (el: Element) => Number(el.querySelector("rect")!.getAttribute("width"));
  const { el, handle } = mount({ layout: "year" }, [], fakeCtx(600).ctx);
  assert.equal(widest(el), 9);
  assert.ok(Number(el.querySelector("svg")!.getAttribute("width")) <= 600);
  handle.resize!(900);
  assert.equal(widest(el), 15);
  handle.resize!(300);
  assert.equal(widest(el), 8);
  assert.ok(Number(el.querySelector("svg")!.getAttribute("width")) > 300);
  assert.ok(el.querySelector(".gz-cal-scroll"));
});

test("a year too wide for its panel opens scrolled to today; a whole year that fits doesn't scroll", () => {
  const narrow = mount({ layout: "year" }, [], fakeCtx(300).ctx).el;
  const scroller = narrow.querySelector(".gz-cal-scroll") as HTMLElement;
  // 18 November 2026 is in column 46 of 10 px columns: up to its end and four weeks more, less the 300 px shown.
  assert.equal(scroller.scrollLeft, (47 + 4) * 10 - 300);
  const wide = mount({ layout: "year" }, [], fakeCtx(600).ctx).el;
  assert.equal((wide.querySelector(".gz-cal-scroll") as HTMLElement).scrollLeft, 0);
});

test("year layout moves by year and arrows go a day up or down and a week across", () => {
  const { el } = mount({ layout: "year", select: "day" }, []);
  const press = (from: string, k: string) => {
    cell(el, from).focus();
    key(cell(el, from), k);
    return document.activeElement?.getAttribute("data-date");
  };
  assert.equal(press("2026-03-14", "ArrowDown"), "2026-03-15");
  assert.equal(press("2026-03-14", "ArrowRight"), "2026-03-21");
  assert.equal(press("2026-03-14", "ArrowLeft"), "2026-03-07");
  (el.querySelector('button[aria-label="Next year"]') as HTMLButtonElement).click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "2027");
  assert.equal(el.querySelectorAll("rect").length, 365);
  for (let i = 0; i < 3; i++) (el.querySelector('button[aria-label="Previous year"]') as HTMLButtonElement).click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "2024");
  assert.equal(el.querySelectorAll("rect").length, 366);
  (el.querySelector("button.gz-cal-today") as HTMLButtonElement).click();
  assert.equal(text(el.querySelector(".gz-cal-title")), "2026");
});

test("format and values show in each day's value and in its tooltip and label", () => {
  const rows = [{ at: "2026-11-03", count: 2, amount: 1234.5 }, { at: "2026-11-04", count: 1, amount: 40 }];
  const money = mount({ y: "amount", agg: "sum", format: "$0,0" }, rows).el;
  assert.equal(text(cell(money, "2026-11-03").querySelector(".gz-cal-val")), "$1,235");
  assert.equal(cell(money, "2026-11-03").getAttribute("title"), "2026-11-03: $1,235");
  assert.equal(cell(money, "2026-11-04").getAttribute("aria-label"), "2026-11-04: $40");
  // A day with no data still says so, whatever the format.
  assert.equal(cell(money, "2026-11-10").getAttribute("aria-label"), "2026-11-10: $0");

  const named = mount({ values: { count: { 2: "twice", 1: "once" } }, select: "day" }, rows).el;
  assert.equal(text(cell(named, "2026-11-03").querySelector(".gz-cal-val")), "twice");
  assert.equal(cell(named, "2026-11-04").getAttribute("aria-label"), "2026-11-04: once");
  assert.equal(cell(named, "2026-11-10").getAttribute("aria-label"), "2026-11-10: 0");

  const year = mount({ layout: "year", y: "amount", agg: "sum", format: "$0.00" }, rows).el;
  assert.equal(text(cell(year, "2026-11-03").querySelector("title")), "2026-11-03: $1234.50");
  assert.deepEqual(checkPanel({ view: "calendar", source: "s", group: "at", format: "dollars" }, true).errors, [
    'format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes',
  ]);
});
