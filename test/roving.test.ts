import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../src/data.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { board } from "../src/views/board.ts";
import { calendar } from "../src/views/calendar.ts";
import { bar } from "../src/views/chart.ts";
import { mountView, selectable } from "../src/views/common.ts";
import { pie } from "../src/views/pie.ts";
import type { PanelCtx, SheetPick, ViewDef } from "../src/views/registry.ts";
import { list, table } from "../src/views/rows.ts";
import { timeline } from "../src/views/timeline.ts";

// One Tab stop per panel: the pickable items of a panel take one Tab stop between them, and the arrow
// keys, Home and End move the focus among them without picking.

const NOW = new Date(2026, 10, 18, 12);

/** A key pressed on `el`, as the browser sends it; returns the event, to see whether it was taken. */
function press(el: Element, key: string, mods: { metaKey?: boolean } = {}): Event {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, ...mods });
  el.dispatchEvent(e);
  return e;
}

/** Focus moved to `el` by the user, with the event a browser sends; the test DOM sends none itself. */
function focus(el: Element): void {
  (el as HTMLElement).focus();
  el.dispatchEvent(new window.Event("focusin", { bubbles: true }));
}

/** The focus leaving `el` for `to`. */
function leave(el: Element, to: Element): void {
  el.dispatchEvent(Object.assign(new window.Event("focusout", { bubbles: true }), { relatedTarget: to }));
  focus(to);
}

const focused = () => document.activeElement;
const stops = (els: Element[]) => els.map((e) => e.getAttribute("tabindex"));

/** A ctx that remembers selections, as the app does; `open`, when given, stands for the side sheet. */
function fakeCtx(more: Partial<PanelCtx> = {}) {
  const picked: (Row | undefined)[] = [];
  const selections = new Map<string, Row>();
  const ctx = {
    now: NOW,
    width: () => 600,
    openNote() {},
    editRow: async () => {},
    select: (name: string, row: Row | undefined) => {
      picked.push(row);
      if (row) selections.set(name, row);
      else selections.delete(name);
    },
    selected: (name: string) => selections.get(name),
    ...more,
  } as unknown as PanelCtx;
  return { ctx, picked, selections };
}

function mount(def: ViewDef, keys: Record<string, unknown>, data: unknown, ctx: PanelCtx, internal?: Partial<Panel>) {
  const { panel, errors } = checkPanel({ view: def.id, ...keys }, true, internal);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handle = def.mount(el, panel as Panel, ctx, "k");
  handle.update(data);
  return { el, handle, panel: panel as Panel };
}

const ROWS = ["Ash", "Birch", "Cedar", "Dogwood"].map((name) => ({ name }));

test("a list that picks is one Tab stop, on its first item; the arrows, Home and End move the focus and don't pick", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount(list, { source: "s", select: "tree" }, ROWS, ctx);
  const items = [...el.querySelectorAll("li")];
  assert.deepEqual(stops(items), ["0", "-1", "-1", "-1"]);
  focus(items[0]);
  assert.ok(press(items[0], "ArrowDown").defaultPrevented);
  assert.equal(focused(), items[1]);
  assert.deepEqual(stops(items), ["-1", "0", "-1", "-1"], "the Tab stop goes with the focus");
  press(items[1], "End");
  assert.equal(focused(), items[3]);
  press(items[3], "Home");
  assert.equal(focused(), items[0]);
  // At an end the focus stays, and the page doesn't scroll instead.
  assert.ok(press(items[0], "ArrowUp").defaultPrevented);
  assert.equal(focused(), items[0]);
  // Keys the list doesn't use are the browser's: left and right, and arrows with a modifier.
  assert.ok(!press(items[0], "ArrowRight").defaultPrevented);
  assert.ok(!press(items[0], "ArrowDown", { metaKey: true }).defaultPrevented);
  assert.equal(focused(), items[0]);
  assert.deepEqual(picked, [], "moving the focus picks nothing");
});

test("Enter picks the focused item, which Tab comes back to after the arrows wander off and the focus leaves", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount(list, { source: "s", select: "tree" }, ROWS, ctx);
  const items = [...el.querySelectorAll("li")];
  focus(items[0]);
  press(items[0], "ArrowDown");
  press(items[1], "ArrowDown");
  press(items[2], "Enter");
  assert.deepEqual(picked, [ROWS[2]]);
  assert.ok(items[2].classList.contains("gz-selected"));
  assert.deepEqual(stops(items), ["-1", "-1", "0", "-1"]);
  press(items[2], "Home");
  assert.deepEqual(stops(items), ["0", "-1", "-1", "-1"]);
  // Inside the list the stop stays where the focus is; out of it, it goes back to the pick.
  leave(items[0], items[1]);
  assert.deepEqual(stops(items), ["-1", "0", "-1", "-1"]);
  leave(items[1], document.body);
  assert.deepEqual(stops(items), ["-1", "-1", "0", "-1"]);
  // Space picks again, which clears it; the stop stays on that item.
  press(items[2], " ");
  assert.equal(picked.at(-1), undefined);
  assert.deepEqual(stops(items), ["-1", "-1", "0", "-1"]);
});

test("in an app with a side sheet, the arrows don't open it; Enter does", () => {
  const opened: (Row | undefined)[] = [];
  const { ctx } = fakeCtx({ open: (pick: SheetPick | undefined, redraw?: boolean) => { if (!redraw) opened.push(pick?.row); } });
  const { panel } = checkPanel({ view: "list", source: "s" }, true);
  const el = document.createElement("div");
  document.body.appendChild(el);
  mountView(list, el, panel as Panel, ctx, "k").update(ROWS);
  const items = [...el.querySelectorAll("li")];
  assert.deepEqual(stops(items), ["0", "-1", "-1", "-1"], "a record picks there without select");
  focus(items[0]);
  press(items[0], "ArrowDown");
  press(items[1], "ArrowDown");
  assert.deepEqual(opened, []);
  press(items[2], "Enter");
  assert.deepEqual(opened, [ROWS[2]]);
});

test("a row picked before the table is drawn is where Tab lands", () => {
  const { ctx, selections } = fakeCtx();
  selections.set("tree", ROWS[2]);
  const { el } = mount(table, { source: "s", select: "tree" }, ROWS, ctx);
  assert.deepEqual(stops([...el.querySelectorAll("tbody tr")]), ["-1", "-1", "0", "-1"]);
});

const NOTES = [
  { name: "Ash", path: "Trees/Ash.md", height: 20 },
  { name: "Birch", path: "Trees/Birch.md", height: 15 },
  { name: "Cedar", path: "Trees/Cedar.md", height: 30 },
];

test("table rows move up and down; left and right, and keys in a field of a row, are left alone", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount(table, { source: "notes", from: "Trees", columns: ["name", "height"], edit: ["height"], select: "tree" }, NOTES, ctx);
  const rows = [...el.querySelectorAll("tbody tr")];
  focus(rows[0]);
  press(rows[0], "ArrowDown");
  assert.equal(focused(), rows[1]);
  assert.ok(!press(rows[1], "ArrowRight").defaultPrevented, "a wide table scrolls sideways");
  const field = rows[1].querySelector("input")!;
  focus(field);
  for (const key of ["ArrowDown", "Home", "End"]) assert.ok(!press(field, key).defaultPrevented, key);
  assert.equal(focused(), field);
  assert.deepEqual(stops(rows), ["-1", "0", "-1"], "a field's focus isn't a row's");
  assert.deepEqual(picked, []);
});

test("a table that shows new values in place keeps the row picked as its Tab stop", () => {
  const { ctx } = fakeCtx();
  const { el, handle } = mount(table, { source: "notes", from: "Trees", columns: ["name", "height"], edit: ["height"], select: "tree" }, NOTES, ctx);
  const rows = [...el.querySelectorAll("tbody tr")];
  (rows[1] as HTMLElement).click();
  assert.deepEqual(stops(rows), ["-1", "0", "-1"]);
  handle.update(NOTES.map((r) => ({ ...r, height: r.height + 1 })));
  const after = [...el.querySelectorAll("tbody tr")];
  assert.ok(after.every((r, i) => r === rows[i]), "the same rows, updated in place");
  assert.deepEqual(stops(after), ["-1", "0", "-1"]);
  (after[2] as HTMLElement).click();
  assert.deepEqual(stops(after), ["-1", "-1", "0"]);
});

const SCHEMA = { status: ["idea", "doing", "done"] };
const PROJECTS: Row[] = [
  { name: "Garden", path: "P/Garden.md", status: "doing" },
  { name: "Rust", path: "P/Rust.md", status: "idea" },
  { name: "Taxes", path: "P/Taxes.md", status: "done" },
  { name: "Kitchen", path: "P/Kitchen.md", status: "doing" },
  { name: "Trip", path: "P/Trip.md", status: "blocked" },
];

test("a board is one Tab stop: up and down in reading order, left and right to the same place in the next column", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount(board, { source: "notes", from: "P", group: "status", select: "project" }, PROJECTS, ctx, { schema: SCHEMA });
  const cards = [...el.querySelectorAll(".gz-board-card")];
  const card = (name: string) => cards.find((c) => c.getAttribute("aria-label") === name)!;
  const at = () => focused()?.getAttribute("aria-label");
  // Columns idea, doing, done, blocked: Rust | Garden, Kitchen | Taxes | Trip.
  assert.deepEqual(cards.map((c) => [c.getAttribute("aria-label"), c.getAttribute("tabindex")]), [
    ["Rust", "0"], ["Garden", "-1"], ["Kitchen", "-1"], ["Taxes", "-1"], ["Trip", "-1"],
  ]);
  focus(card("Rust"));
  press(card("Rust"), "ArrowDown");
  assert.equal(at(), "Garden");
  press(card("Garden"), "ArrowDown");
  assert.equal(at(), "Kitchen");
  press(card("Kitchen"), "ArrowRight");
  assert.equal(at(), "Taxes", "the second card's place, in a column of one: its last");
  press(card("Taxes"), "ArrowLeft");
  assert.equal(at(), "Garden");
  press(card("Garden"), "ArrowLeft");
  assert.equal(at(), "Rust");
  press(card("Rust"), "ArrowLeft");
  assert.equal(at(), "Rust", "the first column has nothing left of it");
  press(card("Rust"), "End");
  assert.equal(at(), "Trip");
  // The Move menu keeps its own keys.
  assert.ok(!press(card("Kitchen").querySelector("select")!, "ArrowDown").defaultPrevented);
  assert.deepEqual(picked, []);
});

test("bars that pick move left and right, along the axis; up and down are left to the page", () => {
  const { ctx } = fakeCtx();
  const budget = [{ category: "food", planned: 5, spent: 4 }, { category: "rent", planned: 9, spent: 9 }];
  const { el } = mount(bar, { source: "s", x: "category", y: ["planned", "spent"], select: "line" }, budget, ctx);
  const bars = [...el.querySelectorAll("path.gz-bar")];
  const at = () => focused()?.getAttribute("aria-label");
  assert.deepEqual(stops(bars), ["0", "-1", "-1", "-1"]);
  focus(bars[0]);
  press(bars[0], "ArrowRight");
  assert.equal(at(), "food, spent: 4");
  press(bars[1], "ArrowRight");
  assert.equal(at(), "rent, planned: 9");
  assert.ok(!press(bars[2], "ArrowDown").defaultPrevented);
  press(bars[2], "ArrowLeft");
  assert.equal(at(), "food, spent: 4");
});

test("one series' bars, or a stack's, step left to right along the axis, though the rows come newest first", () => {
  // As `sort: -at` hands them over: the latest day first.
  const days = [{ at: "2026-11-18", food: 3, home: 1 }, { at: "2026-11-17", food: 2, home: 2 }, { at: "2026-11-16", food: 1, home: 3 }];
  const at = () => focused()?.getAttribute("aria-label")?.split(":")[0];
  for (const y of ["food", ["food", "home"]]) {
    const { el } = mount(bar, { source: "s", x: "at", y, stack: Array.isArray(y) || undefined, select: "day" }, days, fakeCtx().ctx);
    const bars = [...el.querySelectorAll("path.gz-bar")];
    assert.deepEqual(bars.map((b) => b.getAttribute("aria-label")?.split(":")[0]), ["Nov 16", "Nov 17", "Nov 18"], String(y));
    assert.deepEqual(stops(bars), ["0", "-1", "-1"], String(y));
    focus(bars[0]);
    press(bars[0], "ArrowRight");
    assert.equal(at(), "Nov 17", `${y}: the right neighbour of the leftmost bar`);
  }
});

test("a year heatmap that picks is one Tab stop of 365 days; Home and End go to its first and last day", () => {
  const { ctx } = fakeCtx();
  const { el } = mount(calendar, { source: "s", group: "at", layout: "year", select: "day" }, [{ at: "2026-03-14", count: 3 }], ctx);
  const day = (date: string) => el.querySelector(`[data-date="${date}"]`)!;
  const tabStops = () => [...el.querySelectorAll('[tabindex="0"]')].map((d) => d.getAttribute("data-date"));
  assert.equal(el.querySelectorAll("rect[tabindex]").length, 365);
  assert.deepEqual(tabStops(), ["2026-01-01"]);
  focus(day("2026-03-14"));
  assert.deepEqual(tabStops(), ["2026-03-14"], "a day focused is where Tab comes back to");
  press(day("2026-03-14"), "End");
  assert.equal(focused()?.getAttribute("data-date"), "2026-12-31");
  press(day("2026-12-31"), "Home");
  assert.equal(focused()?.getAttribute("data-date"), "2026-01-01");
  // A day picked stays the Tab stop when the year is drawn again.
  day("2026-03-14").dispatchEvent(new window.Event("click", { bubbles: true }));
  (el.querySelector('button[aria-label="Next year"]') as HTMLButtonElement).click();
  (el.querySelector('button[aria-label="Previous year"]') as HTMLButtonElement).click();
  assert.deepEqual(tabStops(), ["2026-03-14"]);
});

test("a month's days keep their arrows by day and week, with Home and End for its first and last day", () => {
  const { ctx } = fakeCtx();
  const { el } = mount(calendar, { source: "s", group: "at", select: "day" }, [], ctx);
  const day = (date: string) => el.querySelector(`[data-date="${date}"]`)!;
  focus(day("2026-11-04"));
  press(day("2026-11-04"), "ArrowDown");
  assert.equal(focused()?.getAttribute("data-date"), "2026-11-11");
  press(day("2026-11-11"), "End");
  assert.equal(focused()?.getAttribute("data-date"), "2026-11-30");
  press(day("2026-11-30"), "Home");
  assert.equal(focused()?.getAttribute("data-date"), "2026-11-01");
});

test("a pie's legend is one Tab stop that the arrows go round; its slices take no focus", () => {
  const { ctx } = fakeCtx();
  const { el } = mount(pie, { source: "s", group: "g", select: "g" }, [{ g: "a", count: 3 }, { g: "b", count: 2 }, { g: "c", count: 1 }], ctx);
  const items = [...el.querySelectorAll(".gz-legend-item")];
  assert.deepEqual(stops(items), ["0", "-1", "-1"]);
  assert.equal(el.querySelectorAll(".gz-slice[tabindex]").length, 0);
  focus(items[0]);
  press(items[0], "ArrowDown");
  press(items[1], "ArrowRight");
  assert.equal(focused(), items[2]);
  // A slice picked with the pointer makes its legend entry the Tab stop.
  el.querySelectorAll(".gz-slice")[1].dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(stops(items), ["-1", "0", "-1"]);
});

test("items outside a roving group keep a Tab stop each", () => {
  const { ctx } = fakeCtx();
  const { panel } = checkPanel({ view: "list", source: "s", select: "tree" }, true);
  const el = document.body.createDiv();
  const items = ROWS.slice(0, 2).map((row) => {
    const item = el.createDiv();
    selectable(item, panel as Panel, ctx, row);
    return item;
  });
  assert.deepEqual(stops(items), ["0", "0"]);
});

const PLANS = [
  { name: "Garden", start: "2026-11-01", due: "2026-11-10" },
  { name: "Kitchen", start: "2026-11-05", due: "2026-11-20" },
  { name: "Trip", start: "2026-11-12" },
];

test("a timeline is one Tab stop: up and down go from row to row, and marks that don't pick are in it too", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount(timeline, { source: "s", start: "start", end: "due", item: "{name}", select: "project" }, PLANS, ctx);
  const marks = [...el.querySelectorAll(".gz-tl-bar, .gz-tl-dot")];
  const at = () => focused()?.getAttribute("aria-label")?.split(":")[0];
  assert.deepEqual(stops(marks), ["0", "-1", "-1"]);
  focus(marks[0]);
  assert.ok(press(marks[0], "ArrowDown").defaultPrevented);
  assert.equal(at(), "Kitchen");
  assert.deepEqual(stops(marks), ["-1", "0", "-1"]);
  press(marks[1], "End");
  assert.equal(at(), "Trip");
  assert.ok(!press(marks[2], "ArrowLeft").defaultPrevented, "left and right are the page's");
  press(marks[2], "Enter");
  assert.deepEqual(picked, [PLANS[2]]);

  // Without select or a sheet the marks pick nothing, and still take one Tab stop between them.
  const plain = mount(timeline, { source: "s", start: "start", end: "due", item: "{name}" }, PLANS, fakeCtx().ctx).el;
  const still = [...plain.querySelectorAll(".gz-tl-bar, .gz-tl-dot")];
  assert.deepEqual(still.map((m) => m.getAttribute("role")), ["img", "img", "img"]);
  assert.deepEqual(stops(still), ["0", "-1", "-1"]);
  focus(still[0]);
  press(still[0], "ArrowDown");
  assert.equal(focused()?.getAttribute("aria-label")?.split(":")[0], "Kitchen");
});
