import assert from "node:assert/strict";
import { test } from "node:test";
import { copyRow } from "../src/data.ts";
import { DataLayer } from "../src/datalayer.ts";
import type { NoteReader } from "../src/expand.ts";
import { compilePipeline } from "../src/pipeline.ts";
import { checkPanel, readSpec, resolvePanel, type Panel } from "../src/spec.ts";
import { fakeHost } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12);
const APP = "Apps/X.md";
const ITEMS = { items: [{ name: "a", price: 2, qty: 3 }, { name: "b", price: 5, qty: 4 }, { name: "c", price: 12, qty: 1 }] };

function panelOf(raw: Record<string, unknown>): Panel {
  const r = checkPanel(raw, true);
  assert.deepEqual(r.errors, []);
  return r.panel!;
}

const reader = (notes: Record<string, Record<string, unknown>>): NoteReader => ({
  resolve: (l) => (`${l}.md` in notes ? `${l}.md` : undefined),
  frontmatter: (p) => notes[p],
});

test("compute runs after pick and before where, so later keys can use its columns", () => {
  const p = panelOf({
    view: "table", source: "s", pick: "items",
    compute: { total: "price * qty", label: 'name + ": " + total' },
    where: { total: "> 10" }, sort: "-total", columns: ["label", "total"],
  });
  assert.deepEqual(compilePipeline(p, NOW)(ITEMS), [
    { name: "c", price: 12, qty: 1, total: 12, label: "c: 12" },
    { name: "b", price: 5, qty: 4, total: 20, label: "b: 20" },
  ].reverse());
  const grouped = panelOf({ view: "bar", source: "s", pick: "items", compute: { big: "price > 4" }, group: "big", y: "qty", agg: "sum" });
  assert.deepEqual(compilePipeline(grouped, NOW)(ITEMS), [{ big: false, count: 1, qty: 3 }, { big: true, count: 2, qty: 5 }]);
});

test("rows are copies: a cached response is never changed", () => {
  const input = structuredClone(ITEMS);
  const run = compilePipeline(panelOf({ view: "table", source: "s", pick: "items", compute: { total: "price * qty" } }), NOW);
  const first = run(input) as Record<string, unknown>[];
  const second = run(input) as Record<string, unknown>[];
  assert.deepEqual(input, ITEMS);
  assert.notEqual(first[0], input.items[0]);
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(first, second);
});

test("symbol-keyed properties survive the copy and the rest of the pipeline", () => {
  const ID = Symbol("row");
  const HIDDEN = Symbol("hidden");
  const rows = [3, 1, 2].map((n) => {
    const row: Record<string | symbol, unknown> = { n, [ID]: `row${n}` };
    Object.defineProperty(row, HIDDEN, { value: n * 10, enumerable: false });
    return row;
  });
  const copy = copyRow(rows[0] as Record<string, unknown>) as Record<symbol, unknown>;
  assert.deepEqual([copy[ID], copy[HIDDEN]], ["row3", 30]);
  const p = panelOf({ view: "table", source: "s", compute: { twice: "n * 2" }, where: { twice: "> 2" }, sort: "n", limit: 5 });
  const out = compilePipeline(p, NOW)(rows) as Record<string | symbol, unknown>[];
  assert.deepEqual(out.map((r) => [r.n, r.twice, r[ID], r[HIDDEN]]), [[2, 4, "row2", 20], [3, 6, "row3", 30]]);
});

test("with compute, an object of equal-length lists becomes rows; anything else is one row", () => {
  const daily = { time: ["2026-01-05", "2026-01-20", "2026-02-03"], max: [10, 12, 8], min: [2, 4, 5] };
  const rows = compilePipeline(panelOf({ view: "table", source: "s", compute: { range: "max - min" } }), NOW)(daily);
  assert.deepEqual(rows, [
    { time: "2026-01-05", max: 10, min: 2, range: 8 },
    { time: "2026-01-20", max: 12, min: 4, range: 8 },
    { time: "2026-02-03", max: 8, min: 5, range: 3 },
  ]);
  const monthly = panelOf({ view: "bar", source: "s", compute: { range: "max - min" }, group: "time", per: "month", y: "range", agg: "avg" });
  assert.deepEqual(compilePipeline(monthly, NOW)(daily), [{ time: "2026-01-01", count: 2, range: 8 }, { time: "2026-02-01", count: 1, range: 3 }]);

  const one = panelOf({ view: "text", source: "s", pick: "meta", compute: { change: "price - previous" }, text: "{change}" });
  assert.deepEqual(compilePipeline(one, NOW)({ meta: { price: 105, previous: 100, ranges: ["1d", "5d", "1mo"] } }),
    { price: 105, previous: 100, ranges: ["1d", "5d", "1mo"], change: 5 });
  const uneven = { a: [1, 2], b: [1] };
  assert.deepEqual(compilePipeline(panelOf({ view: "text", source: "s", compute: { n: "1" }, text: "x" }), NOW)(uneven), { a: [1, 2], b: [1], n: 1 });
  // Without compute or group, data stays as the source gave it.
  assert.equal(compilePipeline(panelOf({ view: "text", source: "s", text: "x" }), NOW)(daily), daily);
});

test("a block's compute runs as a stage; the panel's own compute can use its columns", async () => {
  const f = fakeHost({ "Apps/X data.md": { fm: { quotes: [{ close: 100 }, { close: 103 }, { close: 101 }, { close: 106 }] } } });
  const r = readSpec({
    app: "x",
    data: {
      daily: { source: "quotes", compute: { change: "round((close - prev(close)) / prev(close) * 100, 1)" } },
      movers: { source: "daily", where: { change: "> 1" } },
    },
    panels: [{ view: "table", source: "movers", compute: { size: 'if(change > 3, "big", "small")' }, columns: ["close", "change", "size"] }],
  })!;
  assert.deepEqual(r.errors, []);
  const p = r.spec!.panels[0].panel;
  assert.deepEqual(p.upstream, [{ compute: { change: "round((close - prev(close)) / prev(close) * 100, 1)" } }]);
  const data = await new DataLayer(f.host).panelData(p.source, p, { appPath: APP, dataPath: "Apps/X data.md" }, { ttlMs: 0, now: NOW });
  assert.deepEqual(data, [{ close: 103, change: 3, size: "small" }, { close: 106, change: 5, size: "big" }]);
});

test("formula problems are check-time errors; the panel shows without its compute", () => {
  const r = readSpec({
    app: "x",
    data: { d: { source: "s", compute: { ok: "1", bad: "round(1, 2, 3)" } }, e: { source: "s", compute: { x: "$foo + 1" } } },
    panels: [
      { view: "table", source: "s", compute: { change: "foo(close)" } },
      { view: "table", source: "d" },
      { view: "table", source: "s", compute: { x: "$nope * 2" } },
    ],
  })!;
  assert.deepEqual(r.errors, [
    'data.d: compute.bad: "round" takes 1 or 2 arguments, not 3',
    "data.e: compute.x: $foo isn't an input or param",
    'panel 1: compute.change: unknown function "foo"',
    "panel 3: compute.x: $nope isn't an input or param",
  ]);
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel.compute), [undefined, undefined, undefined]);
  assert.deepEqual(r.spec!.blocks.d, { source: "s" });
});

test("an input in a formula is a value the panel depends on, never text in the formula", () => {
  const r = readSpec({
    app: "x",
    inputs: { min: [1, 2], q: ['") + 1 + ("', "plain"] },
    data: { flagged: { source: "s", compute: { over: "close > $min" } }, top: { source: "flagged", where: { over: true } } },
    panels: [
      { view: "table", source: "s", compute: { label: '$q + " " + close', over: "close > $min" }, columns: ["label"] },
      { view: "table", source: "top" },
    ],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, []);
  const [own, chained] = r.spec!.panels;
  assert.deepEqual(own.inputs.sort(), ["min", "q"]);
  assert.deepEqual(own.panel.compute, { label: '$q + " " + close', over: "close > $min" });
  assert.deepEqual(own.panel.vars, { q: '") + 1 + ("', min: 1 });
  const rows = [{ close: 1 }, { close: 2 }];
  assert.deepEqual(compilePipeline(own.panel, NOW)(rows), [
    { close: 1, label: '") + 1 + (" 1', over: false },
    { close: 2, label: '") + 1 + (" 2', over: true },
  ]);
  const two = resolvePanel(own, { min: 2, q: "plain" }).panel!;
  assert.deepEqual(two.vars, { q: "plain", min: 2 });
  assert.deepEqual(chained.inputs, ["min"]);
  assert.deepEqual(chained.panel.upstream, [{ compute: { over: "close > $min" }, vars: { min: 1 } }]);
  assert.deepEqual(compilePipeline(chained.panel, NOW)(rows), [{ close: 2, over: true }]);
  assert.deepEqual(compilePipeline(resolvePanel(chained, { min: 0, q: "plain" }).panel!, NOW)(rows), [
    { close: 1, over: true },
    { close: 2, over: true },
  ]);
});

test("a param in a formula is fixed when the component is used; an app input passed in stays live", () => {
  const notes = {
    "C.md": {
      component: "c",
      params: { limit: 5, name: null },
      data: { flagged: { source: "s", compute: { over: "v > $limit" } }, top: { source: "flagged", limit: 5 } },
      panels: [{ view: "table", source: "top", compute: { who: "$name" } }],
    },
  };
  const r = readSpec({
    app: "x",
    inputs: { t: [7, 9] },
    panels: [
      { use: "[[C]]", with: { name: '"; drop' } },
      { use: "[[C]]", with: { name: "B", limit: "$t" } },
      { use: "[[C]]", with: { name: "C" }, compute: { twice: "v * $t" } },
    ],
  }, { notes: reader(notes), path: APP, now: NOW })!;
  assert.deepEqual(r.errors, []);
  const [fixed, live, overridden] = r.spec!.panels;
  assert.deepEqual(fixed.panel.compute, { who: "$name" });
  assert.deepEqual(fixed.panel.vars, { name: '"; drop' });
  assert.deepEqual(fixed.panel.upstream, [{ compute: { over: "v > $limit" }, vars: { limit: 5 } }]);
  assert.deepEqual(fixed.inputs, []);
  assert.deepEqual(live.inputs, ["t"]);
  assert.deepEqual(resolvePanel(live, { t: 9 }).panel!.upstream, [{ compute: { over: "v > $limit" }, vars: { limit: 9 } }]);
  // A compute beside use replaces the component's, and its $names are the app's.
  assert.deepEqual(overridden.panel.compute, { twice: "v * $t" });
  assert.deepEqual(overridden.panel.vars, { t: 7 });
  assert.equal(overridden.writtenIn.vars, APP);
  assert.deepEqual(overridden.inputs, ["t"]);
});

test("a $name in a component formula must be one of its params", () => {
  const notes = { "C.md": { component: "c", params: ["a"], panels: [{ view: "table", source: "s", compute: { x: "$a + $b" } }] } };
  const r = readSpec({ app: "x", panels: [{ use: "[[C]]", with: { a: 1 } }] }, { notes: reader(notes), path: APP })!;
  assert.deepEqual(r.errors, ["panel 1 (from [[C]] panel 1): compute.x: $b isn't an input or param"]);
  assert.equal(r.spec!.panels[0].panel.compute, undefined);
});
