import assert from "node:assert/strict";
import { test } from "node:test";
import { readSpec, resolvePanel } from "../src/spec.ts";
import { InputRef, nearMisses, parseInputs, readInputs, refusedPlaces, resolveInputs } from "../src/template.ts";

const NAMES = new Set(["symbol", "day", "n"]);
const VALUES = { symbol: "New York", day: "2026-12-04", n: 5 };
const NOW = new Date(2026, 10, 18, 9);

test("filling in: whole values keep their type, text gets text, URLs get encoding", () => {
  const cases: [unknown, string, unknown][] = [
    ["$n", "limit", 5],
    ["$day", "where", "2026-12-04"],
    ["Price of $symbol", "title", "Price of New York"],
    ["https://api.example.com/q?s=$symbol&n=$n", "source", "https://api.example.com/q?s=New%20York&n=5"],
    ["https://api.example.com/odata?$filter=x&s=$symbol", "source", "https://api.example.com/odata?$filter=x&s=New%20York"],
    ["$symbols and ${price} and $5", "text", "$symbols and ${price} and $5"],
    [{ at: "$day", kind: "$n" }, "where", { at: "2026-12-04", kind: 5 }],
    [["$symbol", "count"], "columns", ["New York", "count"]],
  ];
  for (const [raw, key, want] of cases) {
    assert.deepEqual(resolveInputs(parseInputs(raw, NAMES, key), VALUES), want, JSON.stringify(raw));
  }
});

test("a value is never scanned again, so it can't add references", () => {
  const t = parseInputs("$symbol", NAMES, "title");
  assert.ok(t instanceof InputRef);
  assert.equal(resolveInputs(t, { symbol: "$day" }), "$day");
  assert.equal(resolveInputs(parseInputs("https://a.example/$symbol", NAMES, "source"), { symbol: "a&b=c/{secret:x}" }),
    "https://a.example/a%26b%3Dc%2F%7Bsecret%3Ax%7D");
});

test("places a $name can't go", () => {
  const cases: [Record<string, unknown>, "input" | "param", string[]][] = [
    [{ from: "#$symbol" }, "input", ['$symbol can\'t be used in "from"']],
    [{ append: "Daily $day" }, "param", ['$day can\'t be used in "append"']],
    [{ tab: "$symbol" }, "input", ['$symbol can\'t be used in "tab"']],
    [{ source: "https://$symbol.example.com/v1" }, "input", ["$symbol can't be part of a URL's host"]],
    [{ source: "https://api.example.com$symbol/v1" }, "param", ["$symbol can't be part of a URL's host"]],
    [{ source: "https://api.example.com/v1?k={secret:$symbol}" }, "param", ["$symbol can't name a secret"]],
    [{ source: "https://api.example.com/v1/$symbol?days=$n" }, "input", []],
    [{ source: "$symbol" }, "input", ["$symbol can't choose the source; use it in a URL's path or query, or in where"]],
    [{ save: "$symbol" }, "input", ["$symbol can't choose where data is saved; use it in a URL's path or query, or in where"]],
    [{ source: "$symbol" }, "param", []],
    [{ save: "log_$symbol" }, "param", ["$symbol can only be the whole save, naming a list"]],
    [{ headers: { Authorization: "Bearer {secret:$symbol}" } }, "param", ["$symbol can't name a secret"]],
    [{ headers: { "X-Symbol": "$symbol" } }, "input", []],
    [{ where: { $symbol: "x" } }, "input", []],
  ];
  for (const [raw, kind, want] of cases) assert.deepEqual(refusedPlaces(raw, NAMES, kind), want, JSON.stringify(raw));
});

test("near misses are pointed out", () => {
  assert.deepEqual(nearMisses({ title: "$sybmol $dya $nn $filter" }, NAMES, "input"), [
    '"$sybmol" isn\'t an input (did you mean $symbol?)',
    '"$dya" isn\'t an input (did you mean $day?)',
    '"$nn" isn\'t an input (did you mean $n?)',
  ]);
  assert.deepEqual(nearMisses({ title: "$sybmol" }, new Set(), "input"), []);
});

test("inputs are a list of choices or date", () => {
  const errors: string[] = [];
  const defs = readInputs({ symbol: ["SPY", "QQQ"], day: "date", "bad name": ["a"], week: "week", empty: [], key: ["{secret:k}"] }, errors);
  assert.deepEqual(defs.map((d) => [d.name, d.kind, d.options]), [["symbol", "choice", ["SPY", "QQQ"]], ["day", "date", []]]);
  assert.deepEqual(errors, [
    'inputs: "bad name" can only use letters, digits and _',
    "inputs.week must be a list of choices or date",
    "inputs.empty must be a list of choices or date",
    "inputs.key: a choice can't hold a secret or a line break",
  ]);
});

test("an app's panels start at the first choice and today, and know which inputs they use", () => {
  const r = readSpec({
    app: "x",
    inputs: { symbol: ["SPY", "QQQ"], day: "date" },
    data: { chart: { source: "https://api.example.com/chart/$symbol?range=1mo" } },
    panels: [
      { view: "number", title: "$symbol", source: "chart", field: "close" },
      { view: "list", source: "notes", from: "Health", where: { date: "$day" } },
      { view: "countdown", to: "2027-01-01" },
    ],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, []);
  const [a, b, c] = r.spec!.panels;
  assert.deepEqual([a.inputs, b.inputs, c.inputs], [["symbol"], ["day"], []]);
  assert.equal(a.panel.source, "https://api.example.com/chart/SPY?range=1mo");
  assert.deepEqual(b.panel.where, { date: "2026-11-18" });
  assert.equal(resolvePanel(a, { symbol: "QQQ", day: "2026-11-18" }).panel?.title, "QQQ");
});

test("every choice is checked; refused places stop the panel; unused inputs are pointed out", () => {
  const r = readSpec({
    app: "x",
    inputs: { n: [5, "all"], tag: ["a", "b"], spare: "date" },
    panels: [
      { view: "list", source: "notes", from: "Books", limit: "$n" },
      { view: "list", source: "notes", from: "#$tag" },
    ],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, [
    'panel 1: "limit" has the wrong type (expected number) (when $n is all)',
    'panel 2: $tag can\'t be used in "from"',
    'input "tag" isn\'t used by any panel',
    'input "spare" isn\'t used by any panel',
  ]);
  assert.equal(r.spec!.panels.length, 1);
});
