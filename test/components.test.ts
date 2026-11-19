import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteReader } from "../src/expand.ts";
import { askersOf, permissionsOf, readSpec, resolvePanel } from "../src/spec.ts";

const APP = "Apps/W.md";

/** Notes by path; links resolve by name or by path, as Obsidian's link resolution does. */
function reader(notes: Record<string, Record<string, unknown>>): NoteReader {
  return {
    resolve: (link) => Object.keys(notes).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
    frontmatter: (path) => notes[path],
  };
}

const TICKER = {
  component: "Price and chart for one stock",
  params: { symbol: null, range: "6mo" },
  data: { chart: { source: "https://query.example.com/chart/$symbol?range=$range" } },
  panels: [
    { view: "number", title: "$symbol", source: "chart", pick: "meta", field: "price" },
    { view: "line", source: "chart", pick: "result", x: "t", y: "close" },
  ],
};

const read = (fm: Record<string, unknown>, notes: Record<string, Record<string, unknown>> = { "Components/Ticker.md": TICKER }) =>
  readSpec(fm, { notes: reader(notes), path: APP, now: new Date(2026, 10, 18) })!;

test("a component's panels come in with their params filled", () => {
  const r = read({ app: "x", panels: [{ use: "[[Ticker]]", with: { symbol: "AAPL" } }, { view: "countdown", to: "2027-01-01" }] });
  assert.deepEqual(r.errors, []);
  const [price, chart, countdown] = r.spec!.panels;
  assert.deepEqual(price.panel, { view: "number", title: "AAPL", pick: "meta", field: "price", source: "https://query.example.com/chart/AAPL?range=6mo" });
  assert.equal(chart.panel.source, "https://query.example.com/chart/AAPL?range=6mo");
  assert.deepEqual([price.label, chart.label, countdown.label], ["panel 1 (from [[Ticker]] panel 1)", "panel 1 (from [[Ticker]] panel 2)", "panel 2"]);
  assert.equal(price.writtenIn.source, "Components/Ticker.md");
  assert.deepEqual(r.spec!.links, ["Ticker"]);
  assert.deepEqual(Object.keys(r.spec!.read), ["Components/Ticker.md"]);
});

test("links work quoted, unquoted, by name or by path; a whole note can be one component", () => {
  for (const use of ["[[Ticker]]", [["Ticker"]], "Ticker", "Components/Ticker", "[[Ticker|my ticker]]"]) {
    assert.equal(read({ app: "x", panels: [{ use, with: { symbol: "A" } }] }).spec!.panels.length, 2, JSON.stringify(use));
  }
  const whole = read({ app: true, use: "[[Ticker]]", with: { symbol: "MSFT" } });
  assert.deepEqual(whole.errors, []);
  assert.equal(whole.spec!.description, "Price and chart for one stock");
  assert.equal(whole.spec!.panels[0].label, "[[Ticker]] panel 1");
  assert.deepEqual(read({ app: "x", use: "[[Ticker]]", panels: [] }).errors, ["put - use: … inside panels to mix a component with other panels"]);
});

test("keys beside use replace keys in every panel that takes them; empty removes", () => {
  const r = read({ app: "x", panels: [{ use: "[[Ticker]]", with: { symbol: "A" }, tab: "Tech", field: "close", pick: null, items: ["x"] }] });
  assert.deepEqual(r.errors, ['panel 1: "items" doesn\'t apply to any panel of [[Ticker]]']);
  const [price, chart] = r.spec!.panels;
  assert.deepEqual([price.panel.tab, chart.panel.tab], ["Tech", "Tech"]);
  assert.equal(price.panel.field, "close");
  assert.equal(chart.panel.field, undefined);
  assert.equal(price.panel.pick, undefined);
  assert.equal(price.writtenIn.tab, APP);
});

test("problems with a use are named, and its panels are left out", () => {
  const notes = {
    "Components/Ticker.md": TICKER,
    "Notes/Plain.md": { tags: ["x"] },
    "Components/Bad.md": { component: "x", inputs: { a: ["1"] }, store: "[[Elsewhere]]", panels: [{ view: "countdown", to: "2027-01-01" }] },
  };
  const r = read({ app: "x", panels: [
    { use: "[[Ticker]]", with: { symbl: "A" } },
    { use: "[[Ticker]]" },
    { use: "https://example.com/Ticker.md" },
    { use: "[[Missing]]" },
    { use: "[[Plain]]" },
    { use: "[[Ticker]]", view: "number" },
    { use: "[[Bad]]" },
    { view: "countdown", to: "2027-01-01", with: { a: 1 } },
  ] }, notes);
  assert.deepEqual(r.errors, [
    'panel 1: [[Ticker]] has no param "symbl" (it takes symbol, range)',
    "panel 1: [[Ticker]] needs symbol",
    "panel 2: [[Ticker]] needs symbol",
    "panel 3: components come from notes in this vault; copy the note in",
    "panel 4: can't find [[Missing]]",
    "panel 5: [[Plain]] isn't a component (it has no component: line)",
    'panel 6: "view" can\'t go beside "use"; the component decides its views',
    "panel 7: [[Bad]]: inputs belong in the app; take a param, and let the app pass with: {name: $name}",
    "panel 7: [[Bad]]: store belongs in the app that uses it",
    'panel 8: "with" needs "use"',
  ]);
  // Bad still draws: its problems are about keys it ignores.
  assert.equal(r.spec!.panels.length, 2);
});

test("cycles and depth are stopped with the chain named", () => {
  const loop = {
    "A.md": { component: "a", panels: [{ use: "[[B]]" }] },
    "B.md": { component: "b", panels: [{ use: "[[A]]" }] },
  };
  assert.deepEqual(read({ app: "x", panels: [{ use: "[[A]]" }] }, loop).errors, [
    "panel 1 (from [[A]] panel 1 → [[B]] panel 1): [[A]] → [[B]] → [[A]] uses itself",
  ]);
  const deep: Record<string, Record<string, unknown>> = { "L5.md": { component: "5", panels: [{ view: "countdown", to: "2027-01-01" }] } };
  for (let i = 1; i <= 4; i++) deep[`L${i}.md`] = { component: String(i), panels: [{ use: `[[L${i + 1}]]` }] };
  const r = read({ app: "x", panels: [{ use: "[[L1]]" }] }, deep);
  assert.deepEqual(r.errors, ["panel 1 (from [[L1]] panel 1 → [[L2]] panel 1 → [[L3]] panel 1 → [[L4]] panel 1): [[L5]] is more than 4 components deep"]);
  assert.equal(read({ app: "x", panels: [{ use: "[[L2]]" }] }, deep).spec!.panels.length, 1);
});

test("names don't cross into a component: neither the app's inputs nor its data blocks", () => {
  const notes = { "C.md": { component: "c", panels: [{ view: "text", text: "$sym is literal", source: "forecast" }] } };
  const r = read({
    app: "x",
    inputs: { sym: ["SPY"] },
    data: { forecast: { source: "https://api.example.com/f" } },
    panels: [{ use: "[[C]]" }, { view: "text", text: "$sym", source: "forecast" }],
  }, notes);
  assert.deepEqual(r.errors, []);
  const [inner, own] = r.spec!.panels;
  assert.deepEqual([inner.panel.text, inner.panel.source, inner.inputs], ["$sym is literal", "forecast", []]);
  assert.deepEqual([own.panel.text, own.panel.source, own.inputs], ["SPY", "https://api.example.com/f", ["sym"]]);
});

test("an app input passed through with stays live, whole or inside text", () => {
  const r = read({
    app: "x",
    inputs: { s: ["SPY", "QQQ"] },
    panels: [{ use: "[[Ticker]]", with: { symbol: "$s", range: "1 $s" } }],
  });
  assert.deepEqual(r.errors, []);
  const [price] = r.spec!.panels;
  assert.deepEqual(price.inputs, ["s"]);
  assert.equal(price.panel.source, "https://query.example.com/chart/SPY?range=1%20SPY");
  const qqq = resolvePanel(price, { s: "QQQ" }).panel!;
  assert.deepEqual([qqq.title, qqq.source], ["QQQ", "https://query.example.com/chart/QQQ?range=1%20QQQ"]);
});

test("a param typed in with may name a list, or a URL the prompt then names, for source and save; an input passed in may not", () => {
  const habit = { component: "habit", params: ["log"], panels: [
    { view: "button", label: "Done", save: "$log" },
    { view: "number", source: "$log", agg: "count" },
  ] };
  const ok = read({ app: "x", panels: [{ use: "[[Habit]]", with: { log: "stretches" } }] }, { "Habit.md": habit });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.spec!.panels.map((ps) => ps.panel.save ?? ps.panel.source), ["stretches", "stretches"]);
  // Typed in the note that uses it, a URL is as static as one typed in the component.
  const url = read({ app: "x", panels: [{ use: "[[Habit]]", with: { log: "https://evil.example.com/x" } }] }, { "Habit.md": habit });
  assert.deepEqual(url.errors, []);
  assert.deepEqual(permissionsOf(url.spec!, APP), ["net:evil.example.com"]);
  assert.deepEqual([...askersOf(url.spec!, APP).get("net:evil.example.com")!], ["Habit.md"]);
  const input = read({ app: "x", inputs: { l: ["a"] }, panels: [{ use: "[[Habit]]", with: { log: "$l" } }] }, { "Habit.md": habit });
  assert.deepEqual(input.errors, [
    'panel 1: with.log: an input can\'t choose where "save" writes; type the value itself',
    'panel 1: with.log: an input can\'t choose what "source" reads; type the value itself',
    'input "l" isn\'t used by any panel',
  ]);
});

test("a value passed through two components is encoded once", () => {
  const notes = {
    "Outer.md": { component: "o", params: ["q"], panels: [{ use: "[[Inner]]", with: { city: "$q" } }] },
    "Inner.md": { component: "i", params: ["city"], panels: [{ view: "number", source: "https://api.example.com/w?city=$city" }] },
  };
  const r = read({ app: "x", panels: [{ use: "[[Outer]]", with: { q: "New York" } }] }, notes);
  assert.equal(r.spec!.panels[0].panel.source, "https://api.example.com/w?city=New%20York");
});

test("permissions come from the expanded app and name the component that asks", () => {
  const r = read({ app: "x", panels: [
    { use: "[[Ticker]]", with: { symbol: "A" } },
    { view: "list", source: "notes", from: "Health" },
    { view: "number", source: "https://query.example.com/other" },
  ] });
  const spec = r.spec!;
  assert.deepEqual(permissionsOf(spec, APP), ["net:query.example.com", "read:Health"]);
  const askers = askersOf(spec, APP);
  assert.deepEqual([...askers.get("net:query.example.com")!].sort(), [APP, "Components/Ticker.md"]);
  assert.deepEqual([...askers.get("read:Health")!], [APP]);
});
