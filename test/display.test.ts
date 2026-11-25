import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel, type Panel } from "../src/spec.ts";
import { bar, line } from "../src/views/chart.ts";
import { pie } from "../src/views/pie.ts";
import type { PanelCtx, ViewDef } from "../src/views/registry.ts";
import { list, table } from "../src/views/rows.ts";
import { number, text } from "../src/views/value.ts";

const NOW = new Date(2026, 10, 18, 12, 0);
const ctx = { now: NOW, width: () => 600 } as unknown as PanelCtx;
const plain = (s: string) => s.replace(/[  ]/g, " ");
const text_ = (el: Element | null | undefined) => plain(el?.textContent ?? "");

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown, c: PanelCtx = ctx): HTMLElement {
  const { panel, errors } = checkPanel({ view: def.id, ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, c, "k").update(data);
  return el;
}

const daily = [
  { time: "2026-11-16", weathercode: 0, hi: 12, lo: 4 },
  { time: "2026-11-17", weathercode: 3, hi: 9, lo: 2 },
  { time: "2026-11-18", weathercode: 1, hi: 10, lo: 3 },
];
const SKY = { weathercode: { 0: "Clear", 1: "Mostly clear", 3: "Overcast" } };

// ---- labels ---------------------------------------------------------------------------------------

test("labels name series in a chart's legend, beside their values; one labelled series gets a legend, an unlabelled one none", () => {
  for (const def of [line, bar]) {
    const two = draw(def, { source: "s", x: "time", y: ["hi", "lo"], labels: { hi: "High", lo: "Low" } }, daily);
    const names = (el: Element) => [...el.querySelectorAll(".gz-legend-name")].map(text_);
    assert.deepEqual(names(two), ["High", "Low"]);
    assert.match(text_(two.querySelector(".gz-legend")), /High10Low3$/);
    const part = draw(def, { source: "s", x: "time", y: ["hi", "lo"], labels: { hi: "High" } }, daily);
    assert.deepEqual(names(part), ["High", "lo"]);
    const one = draw(def, { source: "s", x: "time", y: "hi", labels: { hi: "High" } }, daily);
    assert.deepEqual(names(one), ["High"]);
    assert.equal(draw(def, { source: "s", x: "time", y: "hi" }, daily).querySelector(".gz-legend"), null);
  }
});

test("labels on a grouped chart name the count", () => {
  const el = draw(bar, { source: "s", group: "genre", labels: { count: "Books" } }, [{ genre: "a", count: 2 }, { genre: "b", count: 1 }]);
  assert.deepEqual([...el.querySelectorAll(".gz-legend-name")].map(text_), ["Books"]);
});

test("labels are the table's column headers", () => {
  const el = draw(table, { source: "s", columns: ["time", "hi", "lo"], labels: { hi: "High", lo: "Low" } }, daily);
  assert.deepEqual([...el.querySelectorAll("th")].map((th) => text_(th)), ["time", "High", "Low"]);
});

test("a grouped list's default item counts what the count label says", () => {
  const rows = [{ genre: "fantasy", count: 3 }, { genre: "poetry", count: 1 }];
  assert.deepEqual([...draw(list, { source: "s", group: "genre", labels: { count: "books" } }, rows).querySelectorAll("li")].map((li) => text_(li)),
    ["fantasy · 3 books", "poetry · 1 books"]);
  assert.deepEqual([...draw(list, { source: "s", group: "genre" }, rows).querySelectorAll("li")].map((li) => text_(li)), ["fantasy · 3", "poetry · 1"]);
  // An item of the panel's own is left as typed.
  assert.equal(text_(draw(list, { source: "s", group: "genre", item: "{genre}: {count}", labels: { count: "books" } }, rows).querySelector("li")), "fantasy: 3");
});

test("a pie's total is named after the field it totals, when the panel labels it", () => {
  const rows = [{ c: "food", v: 30 }, { c: "rent", v: 70 }];
  assert.equal(text_(draw(pie, { source: "s", x: "c", y: "v", labels: { v: "Spent" } }, rows).querySelector(".gz-readout")), "Spent · 100");
  assert.equal(text_(draw(pie, { source: "s", x: "c", y: "v" }, rows).querySelector(".gz-readout")), "Total · 100");
});

// ---- values ---------------------------------------------------------------------------------------

test("values show a field's value as text in a table and in a list", () => {
  const t = draw(table, { source: "s", columns: ["time", "weathercode", "hi"], values: SKY }, daily);
  assert.deepEqual([...t.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => text_(td)).join("|")),
    ["2026-11-16|Clear|12", "2026-11-17|Overcast|9", "2026-11-18|Mostly clear|10"]);
  const rows = [...daily, { time: "2026-11-19", weathercode: 99, hi: 1, lo: 0 }];
  const l = draw(list, { source: "s", item: "{time}: {weathercode}, {hi}°", values: SKY }, rows);
  assert.deepEqual([...l.querySelectorAll("li")].map((li) => text_(li)),
    ["2026-11-16: Clear, 12°", "2026-11-17: Overcast, 9°", "2026-11-18: Mostly clear, 10°", "2026-11-19: 99, 1°"]);
});

test("a list with no item shows its name, title or value through values", () => {
  const rows = [{ name: "a" }, { title: "b" }, { value: 3.14159 }, { value: "x" }];
  const l = draw(list, { source: "s", values: { name: { a: "Alpha" }, value: { x: "Ex" } } }, rows);
  assert.deepEqual([...l.querySelectorAll("li")].map((li) => text_(li)), ["Alpha", "b", "3.14159", "Ex"]);
});

test("values look a value up by its text: numbers, booleans and numbers typed as text alike", () => {
  const rows = [{ ok: true, n: 1, s: "1", f: 1.5 }];
  const el = draw(table, { source: "s", values: { ok: { true: "Yes" }, n: { 1: "One" }, s: { 1: "One" }, f: { "1.5": "One and a half" } } }, rows);
  assert.deepEqual([...el.querySelectorAll("td")].map((td) => text_(td)), ["Yes", "One", "One", "One and a half"]);
});

test("values win over format; an unmapped value is shown as usual", () => {
  const el = draw(table, { source: "s", columns: ["code"], values: { code: { 0: "Clear" } }, format: { code: "0.00" } }, [{ code: 0 }, { code: 2 }]);
  assert.deepEqual([...el.querySelectorAll("td")].map((td) => text_(td)), ["Clear", "2.00"]);
});

test("a number shown as words sits on the left; a column of numbers is right-aligned, its heading too", () => {
  const el = draw(table, { source: "s", columns: ["time", "weathercode", "hi"], values: SKY }, daily);
  const head = [...el.querySelectorAll("th")].map((th) => th.classList.contains("gz-num"));
  const first = [...el.querySelector("tbody tr")!.querySelectorAll("td")].map((td) => [text_(td), td.classList.contains("gz-num")]);
  assert.deepEqual(head, [false, false, true]);
  assert.deepEqual(first, [["2026-11-16", false], ["Clear", false], ["12", true]]);
});

test("values apply to the field of a number panel and the placeholders of a text panel", () => {
  const n = draw(number, { source: "s", field: "weathercode", values: SKY, unit: "code" }, { weathercode: 3 });
  assert.equal(text_(n.querySelector(".gz-big")), "Overcast");
  assert.equal(n.querySelector(".gz-unit"), null);
  const unmapped = draw(number, { source: "s", field: "weathercode", values: SKY, unit: "code" }, { weathercode: 45 });
  assert.equal(text_(unmapped.querySelector(".gz-big")), "45code");
  const t = draw(text, { source: "s", text: "{weathercode} today", values: SKY }, { weathercode: 0 });
  assert.equal(text_(t.querySelector(".gz-text")), "Clear today");
});

test("values name the group keys on a chart's axis, in its readout, and a pie's slices", () => {
  const grouped = [{ weathercode: 0, count: 5 }, { weathercode: 3, count: 2 }];
  const b = draw(bar, { source: "s", group: "weathercode", values: SKY }, grouped);
  assert.deepEqual([...b.querySelectorAll("text.gz-axis")].map((t) => text_(t)).filter((t) => /[A-Za-z]/.test(t)), ["Clear", "Overcast"]);
  assert.match(text_(b.querySelector(".gz-readout")), /^Overcast · 2$/);
  const p = draw(pie, { source: "s", group: "weathercode", values: SKY }, grouped);
  assert.match(text_(p.querySelector(".gz-pie-legend")), /Clear5 · 71%.*Overcast2 · 29%/);
});

test("a selectable bar or slice is named by what it shows", () => {
  const grouped = [{ weathercode: 0, count: 5 }, { weathercode: 3, count: 2 }];
  const picked: unknown[] = [];
  const c = { ...ctx, select: (_: string, row: unknown) => picked.push(row), selected: () => undefined } as unknown as PanelCtx;
  const p = draw(pie, { source: "s", group: "weathercode", values: SKY, select: "w" }, grouped, c);
  // The legend entries are what the keyboard and screen readers pick with; the slices are for the pointer.
  assert.deepEqual([...p.querySelectorAll(".gz-legend-item")].map((s) => s.getAttribute("aria-label")), ["Clear: 5, 71%", "Overcast: 2, 29%"]);
  assert.equal(p.querySelector("svg")!.getAttribute("aria-label"), "count by weathercode: Clear 71%, Overcast 29%; total 7");
  (p.querySelector("path.gz-slice") as HTMLElement).dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(picked, [{ weathercode: 0, count: 5 }]);
});

test("a table of more than 20 rows has a box that filters them by what their cells say; Escape clears it; 20 rows have none", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ name: i % 5 === 0 ? `Coffee ${i}` : `Lunch ${i}`, amount: i + 0.5 }));
  const el = draw(table, { source: "s", columns: ["name", "amount"] }, rows);
  document.body.appendChild(el);
  const input = () => el.querySelector<HTMLInputElement>("input.gz-filter-input");
  assert.ok(input());
  assert.equal(input()!.getAttribute("placeholder"), "Filter 25 rows");
  const names = () => [...el.querySelectorAll("tbody tr")].map((tr) => text_(tr.querySelector("td")));
  assert.equal(names().length, 25);
  input()!.focus();
  input()!.value = "coffee";
  input()!.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(names(), ["Coffee 0", "Coffee 5", "Coffee 10", "Coffee 15", "Coffee 20"]);
  assert.equal(text_(el.querySelector(".gz-filter-count")), "5 of 25");
  assert.equal(document.activeElement === input(), true, "typing goes on in the box drawn again");
  input()!.value = "coffee 1";
  input()!.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(names(), ["Coffee 10", "Coffee 15"], "every word, anywhere in the row");
  input()!.value = "tea";
  input()!.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(text_(el.querySelector(".gz-empty")), "No row says “tea”.");
  const esc = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
  input()!.dispatchEvent(esc);
  assert.ok(esc.defaultPrevented);
  assert.equal(names().length, 25);
  assert.equal(input()!.value, "");
  el.remove();

  assert.equal(draw(table, { source: "s", columns: ["name"] }, rows.slice(0, 20)).querySelector(".gz-filter"), null);
});
