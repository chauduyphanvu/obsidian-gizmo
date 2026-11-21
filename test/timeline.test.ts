import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Row } from "../src/data.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { timeline } from "../src/views/timeline.ts";

const NOW = new Date(2026, 10, 18, 12);
const text = (el: Element | null | undefined) => el?.textContent ?? "";

function fakeCtx(width = 800) {
  const picked: (Row | undefined)[] = [];
  const opened: string[] = [];
  const selections = new Map<string, Row>();
  const ctx = {
    now: NOW,
    width: () => width,
    openNote: (path: string) => { opened.push(path); },
    select: (name: string, row: Row | undefined) => {
      picked.push(row);
      if (row) selections.set(name, row);
      else selections.delete(name);
    },
    selected: (name: string) => selections.get(name),
  } as unknown as PanelCtx;
  return { ctx, picked, opened };
}

function mount(keys: Record<string, unknown>, data: unknown, ctx = fakeCtx().ctx) {
  const { panel, errors } = checkPanel({ view: "timeline", source: "s", start: "start", end: "due", ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handle = timeline.mount(el, panel as Panel, ctx, "k");
  handle.update(data);
  return { el, handle };
}

const ROWS = [
  { name: "Garden", path: "Projects/Garden.md", start: "2026-11-01", due: "2026-11-30" },
  { name: "Kitchen remodel with a very long name indeed", path: "Projects/Kitchen.md", start: "2026-10-05", due: "2026-12-15" },
  { name: "Milestone", start: "2026-11-20" },
  { name: "Backwards", start: "2026-11-10", due: "2026-11-02" },
  { name: "No date", due: "2026-12-01" },
  { name: "Bad date", start: "someday", due: "2026-12-01" },
];
const labels = (el: Element) => [...el.querySelectorAll(".gz-tl-label")].map((l) => l.getAttribute("title"));
const marks = (el: Element) => [...el.querySelectorAll(".gz-tl-bar, .gz-tl-dot")] as HTMLElement[];
const percent = (el: Element, prop: string) => Number(new RegExp(`${prop}: ([\\d.]+)%`).exec(el.getAttribute("style") ?? "")?.[1]);
const ticks = (el: Element) => [...el.querySelectorAll(".gz-tl-tick")].map((t) => text(t));

test("one row per item, in order of start; bars run from start to end on a shared axis", () => {
  const { el } = mount({ item: "{name}" }, ROWS);
  assert.deepEqual(labels(el), ["Kitchen remodel with a very long name indeed", "Garden", "Backwards", "Milestone"]);
  const [kitchen, garden] = marks(el);
  assert.ok(kitchen.classList.contains("gz-tl-bar") && garden.classList.contains("gz-tl-bar"));
  // Kitchen starts first and ends last; Garden sits inside its span.
  assert.ok(percent(kitchen, "left") < percent(garden, "left"));
  assert.ok(percent(garden, "left") + percent(garden, "width") < percent(kitchen, "left") + percent(kitchen, "width"));
  for (const m of marks(el)) assert.ok(percent(m, "left") >= 0 && percent(m, "left") <= 100);
});

test("an item with no end, or an end before its start, is a dot at its start", () => {
  const { el } = mount({ item: "{name}" }, ROWS);
  assert.deepEqual(marks(el).map((m) => m.classList.contains("gz-tl-dot")), [false, false, true, true]);
  assert.equal(marks(el)[2].getAttribute("title"), "Backwards: 2026-11-10");
  assert.equal(marks(el)[0].getAttribute("title"), "Kitchen remodel with a very long name indeed: 2026-10-05 to 2026-12-15");
});

test("items without a valid start are left out and counted in a muted note", () => {
  const { el } = mount({}, ROWS);
  assert.equal(marks(el).length, 4);
  assert.equal(text(el.querySelector(".gz-label")), "2 without a date");
  assert.equal(mount({}, ROWS.slice(0, 2)).el.querySelector(".gz-label"), null);
  const none = mount({}, [{ name: "x" }]);
  assert.equal(text(none.el.querySelector(".gz-empty")), "Nothing here yet.");
  assert.equal(text(none.el.querySelector(".gz-label")), "1 without a date");
});

test("a label is the item template, else name, else title; it is cut short by the page, so the full text is in its title", () => {
  const { el } = mount({}, [{ name: "A", start: "2026-11-01" }, { title: "B", start: "2026-11-02" }, { room: "C", start: "2026-11-03" }]);
  assert.deepEqual(labels(el), ["A", "B", "C"]);
  assert.deepEqual(labels(mount({ item: "{name} ({due})" }, ROWS.slice(0, 1)).el), ["Garden (2026-11-30)"]);
  assert.equal(text(el.querySelector(".gz-tl-label")), "A");
});

test("a note's label is a link that opens it", () => {
  const { ctx, opened } = fakeCtx();
  const { el } = mount({ source: "notes", from: "Projects" }, ROWS, ctx);
  const links = [...el.querySelectorAll(".gz-tl-label a.internal-link")] as HTMLElement[];
  assert.deepEqual(links.map((a) => text(a)), ["Kitchen remodel with a very long name indeed", "Garden"]);
  links[1].click();
  assert.deepEqual(opened, ["Projects/Garden.md"]);
});

test("a today line shows when today is inside the axis, and not otherwise", () => {
  assert.equal(mount({}, ROWS).el.querySelectorAll(".gz-tl-today").length, 1);
  const past = mount({}, [{ name: "Old", start: "2025-01-01", due: "2025-02-01" }]);
  assert.equal(past.el.querySelector(".gz-tl-today"), null);
  const { el } = mount({}, [{ name: "Due today", start: "2026-11-18" }, { name: "Later", start: "2026-12-18" }]);
  assert.ok(percent(el.querySelector(".gz-tl-today")!, "left") > 0);
});

test("ticks are days on a short span and months on a long one, and fewer when narrow", () => {
  const short = mount({}, [{ name: "a", start: "2026-11-01", due: "2026-11-11" }]);
  assert.ok(ticks(short.el).every((t) => /^Nov \d+$/.test(t)), ticks(short.el).join());
  const year = [{ name: "a", start: "2026-03-01", due: "2027-02-01" }];
  const long = mount({}, year);
  assert.ok(ticks(long.el).every((t) => /^[A-Z][a-z]{2}( ’\d{2})?$/.test(t)), ticks(long.el).join());
  assert.ok(ticks(long.el).includes("Jan ’27"));
  assert.ok(ticks(long.el).includes("Mar ’26"));
  const narrow = mount({}, year, fakeCtx(300).ctx);
  assert.ok(ticks(narrow.el).length < ticks(long.el).length);
  long.handle.resize!(300);
  assert.equal(ticks(long.el).length, ticks(narrow.el).length);
});

test("bars are focusable with a text label, and with select they pick their row", () => {
  const plain = mount({}, ROWS);
  const first = marks(plain.el)[0];
  assert.deepEqual([first.getAttribute("tabindex"), first.getAttribute("role")], ["0", "img"]);
  const { ctx, picked } = fakeCtx();
  const { el } = mount({ select: "project", item: "{name}" }, ROWS, ctx);
  const garden = marks(el)[1];
  assert.deepEqual([garden.getAttribute("role"), garden.getAttribute("tabindex")], ["button", "0"]);
  assert.equal(garden.getAttribute("aria-label"), "Garden: 2026-11-01 to 2026-11-30");
  garden.click();
  assert.deepEqual(picked, [ROWS[0]]);
  assert.ok(garden.classList.contains("gz-selected"));
  garden.click();
  assert.equal(picked.at(-1), undefined);
});

test("at most 200 rows are drawn, then a Show all button draws the rest", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `n${i}`, start: `2026-${String(1 + (i % 12)).padStart(2, "0")}-01` }));
  const { el } = mount({}, many);
  assert.equal(el.querySelectorAll(".gz-tl-row").length, 200);
  const more = el.querySelector("button.gz-more") as HTMLButtonElement;
  assert.equal(text(more), "Show all 250");
  more.click();
  assert.equal(el.querySelectorAll(".gz-tl-row").length, 250);
  assert.equal(el.querySelector("button.gz-more"), null);
});

test("item placeholders and the default text go through values and format", () => {
  const rows = [
    { name: "Garden", start: "2026-11-01", due: "2026-11-30", status: "doing", budget: 1234.5 },
    { name: "Trip", start: "2026-11-20", status: "idea", budget: 90 },
  ];
  const { el } = mount({ item: "{name} · {status} · {budget}", values: { status: { doing: "In progress" } }, format: { budget: "$0,0.00" } }, rows);
  assert.deepEqual(labels(el), ["Garden · In progress · $1,234.50", "Trip · idea · $90.00"]);
  assert.equal(marks(el)[0].getAttribute("title"), "Garden · In progress · $1,234.50: 2026-11-01 to 2026-11-30");
  // With no item the row's name is shown as the panel's values say.
  assert.deepEqual(labels(mount({ values: { name: { Garden: "The garden" } } }, rows).el), ["The garden", "Trip"]);
  assert.deepEqual(checkPanel({ view: "timeline", source: "s", start: "start", format: "dollars" }, true).errors, [
    'format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes',
  ]);
});

const classes = (el: Element) => marks(el).map((m) => [...m.classList].filter((c) => /^gz-tl-(done|future)$/.test(c)).map((c) => c.slice(6)));

test("a bar that ended before today is finished (pencil) and an item that starts after it is an outline; the rest are ink", () => {
  const { el } = mount({ item: "{name}" }, [
    { name: "Finished", start: "2026-10-01", due: "2026-10-20" },
    { name: "Past dot", start: "2026-10-05" },
    { name: "Running", start: "2026-11-10", due: "2026-11-30" },
    { name: "Ends today", start: "2026-11-01", due: "2026-11-18" },
    { name: "Starts today", start: "2026-11-18T09:00", due: "2026-11-19" },
    { name: "Later", start: "2026-11-25", due: "2026-12-10" },
    { name: "Soon dot", start: "2026-11-30" },
  ]);
  assert.deepEqual(labels(el), ["Finished", "Past dot", "Ends today", "Running", "Starts today", "Later", "Soon dot"]);
  assert.deepEqual(classes(el), [["done"], [], [], [], [], ["future"], ["future"]]);
  assert.deepEqual(marks(el).map((m) => m.classList.contains("gz-tl-bar")), [true, false, true, true, true, true, false]);
});

test("today is a line with its name above it in the label row, at the same place, and no tick label sits under it", () => {
  const { el } = mount({}, ROWS);
  const now = el.querySelector(".gz-tl-axis .gz-tl-now")!;
  assert.equal(text(now), "Today");
  assert.equal(el.querySelectorAll(".gz-tl-now").length, 1);
  const line = el.querySelector(".gz-tl-body .gz-tl-today")!;
  assert.equal(percent(now, "left"), percent(line, "left"));
  assert.equal(mount({}, [{ name: "Old", start: "2025-01-01", due: "2025-02-01" }]).el.querySelector(".gz-tl-now"), null);
  // November is a tick on this axis, close to 18 November; its label gives way to Today, its line stays.
  const { el: year } = mount({}, [{ name: "a", start: "2026-03-01", due: "2027-02-01" }]);
  assert.ok(!ticks(year).includes("Nov"));
  assert.equal(year.querySelectorAll(".gz-tl-line").length, year.querySelectorAll(".gz-tl-tick").length + 1);
});

test("the styles draw today's line in the accent and have no red or dashed line on the timeline", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const rules = css.split("\n").filter((l) => /\.gz-tl-/.test(l));
  assert.ok(rules.some((l) => /\.gz-tl-today\b.*--interactive-accent/.test(l)));
  assert.deepEqual(rules.filter((l) => /red|dashed/.test(l)), []);
});
