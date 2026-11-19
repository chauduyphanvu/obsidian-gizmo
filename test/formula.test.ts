import assert from "node:assert/strict";
import { test } from "node:test";
import { FORMULA_FUNCTIONS, compileCompute, compileFormula, computeErrors, type FormulaEnv } from "../src/formula.ts";

const NOW = new Date(2026, 10, 18, 9, 30);
const ENV: FormulaEnv = { prev: undefined, vars: {}, now: NOW };

/** Runs one formula on one row; fails the test if it doesn't compile. */
function run(text: string, row: Record<string, unknown> = {}, env: Partial<FormulaEnv> = {}): unknown {
  const f = compileFormula(text);
  if ("error" in f) assert.fail(`${text}: ${f.error}`);
  return f.run(row, { ...ENV, ...env });
}

function error(text: string, known?: ReadonlySet<string>): string {
  const f = compileFormula(text, known);
  assert.ok("error" in f, `${text} compiled`);
  return f.error;
}

test("precedence and associativity", () => {
  const cases: [string, unknown][] = [
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 - 4 - 3", 3],
    ["100 / 10 / 5", 2],
    ["2 * 3 % 4", 2],
    ["7 % 4 * 2", 6],
    ["-2 * 3", -6],
    ["- (2 + 3)", -5],
    ["--4", 4],
    ["1 + 2 == 3", true],
    ["1 < 2 == true", true],
    ["2 >= 2 && 3 <= 2", false],
    ["true || false && false", true],
    ["(true || false) && false", false],
    ["!true || true", true],
    ["!(true || true)", false],
    ["1 + 2 > 2 && 3 < 4", true],
    ["1 != 2", true],
    [".5 + 1.25e1", 13],
  ];
  for (const [text, want] of cases) assert.equal(run(text), want, text);
});

test("+ joins when either side is text; numeric text still does arithmetic elsewhere", () => {
  const row = { name: "Ada", city: "London", n: "41", price: 12.5 };
  assert.equal(run('name + " (" + city + ")"', row), "Ada (London)");
  assert.equal(run('"x" + 1 + 2', row), "x12");
  assert.equal(run('1 + 2 + "x"', row), "3x");
  assert.equal(run("n + 1", row), "411");
  assert.equal(run("n - 1", row), 40);
  assert.equal(run("n * 2", row), 82);
  assert.equal(run('"£" + price', row), "£12.5");
  assert.equal(run("'it\\'s'"), "it's");
  assert.equal(run('"say \\"hi\\""'), 'say "hi"');
});

test("missing values give null; comparisons with them give null, == treats null as a value", () => {
  const row = { a: 1, t: "x", flag: true };
  const cases: [string, unknown][] = [
    ["nope + 1", null],
    ["nope * 2", null],
    ['"a" + nope', null],
    ["-nope", null],
    ["nope > 1", null],
    ["nope == null", true],
    ["a == null", false],
    ["null == null", true],
    ["a.b.c", null],
    ["t * 2", null],
    ["flag + 1", null],
    ["a < t", null],
    ["!nope", true],
    ["nope && true", false],
  ];
  for (const [text, want] of cases) assert.equal(run(text, row), want, text);
});

test("division by zero gives null", () => {
  assert.equal(run("1 / 0"), null);
  assert.equal(run("0 / 0"), null);
  assert.equal(run("5 % 0"), null);
  assert.equal(run("x / (y - y)", { x: 3, y: 2 }), null);
});

test("fields: dotted paths, list indexes, keys with dots, odd names", () => {
  const row = { properties: { mag: 5.2, "Adj. Close": 3 }, "Adj. Close": 101.5, list: [10, 20, 30], _x1: 2 };
  assert.equal(run("properties.mag * 2", row), 10.4);
  assert.equal(run("list.1 + list.2", row), 50);
  assert.equal(run('field("Adj. Close")', row), 101.5);
  assert.equal(run('field("properties") == null', row), false);
  assert.equal(run("_x1", row), 2);
});

test("every function", () => {
  const row = { tags: ["#book", "#sci-fi"], s: "  Hello World  ", ts: 1_790_000_000, d: "2026-11-16", t: "2026-11-18T21:45" };
  const cases: [string, unknown][] = [
    ["round(2.5)", 3],
    ["round(-2.5)", -3],
    ["round(1.005, 2)", 1.01],
    ["round(1234, -2)", 1200],
    ["round(-0.4)", 0],
    ["floor(2.7)", 2],
    ["ceil(2.1)", 3],
    ["abs(-4)", 4],
    ["min(3, 1, 2)", 1],
    ["max(3, nope, 2)", 3],
    ["min(nope)", null],
    ['if(1 > 0, "yes", "no")', "yes"],
    ['if(nope, "yes", "no")', "no"],
    ["coalesce(nope, null, 0, 5)", 0],
    ["coalesce(nope)", null],
    ['number("1,234.5")', 1234.5],
    ["number(true)", 1],
    ['number("abc")', null],
    ["text(5) + text(1)", "51"],
    ["text(nope)", null],
    ["lower(s)", "  hello world  "],
    ["upper(trim(s))", "HELLO WORLD"],
    ["len(trim(s))", 11],
    ["len(tags)", 2],
    ['contains(s, "World")', true],
    ['contains(tags, "#book")', true],
    ['contains(tags, "#bo")', false],
    ['startswith(trim(s), "Hell")', true],
    ['endswith(s, "x")', false],
    ['replace(s, "o", "0")', "  Hell0 W0rld  "],
    ['replace("a.b.c", ".", "")', "abc"],
    ['replace("abc", "", "-")', "abc"],
    ["date(t)", "2026-11-18"],
    ["date(nope)", null],
    ["year(d)", 2026],
    ["month(d)", 11],
    ["day(d)", 16],
    ["weekday(d)", 1],
    ['weekday("2026-11-22")', 7],
    ["hour(t)", 21],
    ["days(d, t)", 2],
    ["days(t, d)", -2],
    ["days(d, today())", 2],
    ["today()", "2026-11-18"],
    ["now()", "2026-11-18T09:30"],
    ["year(ts) >= 2026", true],
    ["prev(1)", null],
  ];
  for (const [text, want] of cases) assert.deepEqual(run(text, row), want, text);
  const used = new Set(cases.flatMap(([text]) => [...text.matchAll(/([a-z]+)\(/g)].map((m) => m[1])));
  for (const fn of Object.keys(FORMULA_FUNCTIONS)) if (fn !== "field") assert.ok(used.has(fn), `${fn} isn't tried`);
});

test("prev reads the row before, after its own columns were added", () => {
  const compute = compileCompute({
    n: "coalesce(prev(n), 0) + 1",
    change: "round((close - prev(close)) / prev(close) * 100, 1)",
    up: "change > 0",
  }, {}, NOW);
  const rows = compute([{ close: 100 }, { close: 110 }, { close: 99 }, "not a row", { close: 99 }]) as Record<string, unknown>[];
  assert.deepEqual(rows, [
    { close: 100, n: 1, change: null, up: null },
    { close: 110, n: 2, change: 10, up: true },
    { close: 99, n: 3, change: -10, up: false },
    "not a row",
    { close: 99, n: 4, change: 0, up: false },
  ]);
  assert.equal(run("prev(prev(x))", {}, { prev: { x: 1 } }), null);
});

test("errors name what's wrong in plain words", () => {
  const cases: [string, string][] = [
    ["foo(1)", 'unknown function "foo"'],
    ["a.b(1)", 'unknown function "a.b"'],
    ["round(1, 2, 3)", '"round" takes 1 or 2 arguments, not 3'],
    ["if(1, 2)", '"if" takes 3 arguments, not 2'],
    ["abs()", '"abs" takes 1 argument, not 0'],
    ["today(1)", '"today" takes no arguments, not 1'],
    ["min()", '"min" takes at least 1 argument, not 0'],
    ["", "the formula is empty"],
    ["   ", "the formula is empty"],
    ["1 +", "the formula ends where a value should be"],
    ["(1 + 2", 'expected ")" at the end'],
    ["round(1, 2", 'expected ")" to close round( from character 1, at the end'],
    ["1 2", "unexpected value at character 3"],
    ["1 + )", 'expected a value at character 5, not ")"'],
    ["(1))", 'unexpected ")" at character 4'],
    ["a = 1", 'can\'t read "=" at character 3; compare with =='],
    ["a & b", 'can\'t read "&" at character 3; use && for and'],
    ["a | b", 'can\'t read "|" at character 3; use || for or'],
    ["a @ b", 'can\'t read "@" at character 3'],
    ["a. + 1", 'can\'t read "." at character 2'],
    ['"abc', 'the text starting at character 1 needs a closing "'],
    ["'abc", "the text starting at character 1 needs a closing '"],
    ["$ + 1", '"$" at character 1 needs a name after it, e.g. $symbol'],
  ];
  for (const [text, want] of cases) assert.equal(error(text), want, text);
  assert.equal(error("$symbol + $sybmol", new Set(["symbol"])), "$sybmol isn't an input or param");
  assert.deepEqual(computeErrors({ ok: "1", change: "foo(close)", n: 5 }), ['compute.change: unknown function "foo"']);
});

test("a $name is a value: quotes and operators in it are never read as formula", () => {
  const vars = { q: '") + 1 + ("', expr: "1 + 1", n: 3, quake: { id: "us7000", properties: { mag: 6.1 } }, list: ["a", "b"] };
  const env = { vars };
  assert.equal(run("$q", {}, env), '") + 1 + ("');
  assert.equal(run('"x" + $q', {}, env), 'x") + 1 + ("');
  assert.equal(run("$expr + 1", {}, env), "1 + 11");
  assert.equal(run("$expr == 2", {}, env), false);
  assert.equal(run("$n * 2", {}, env), 6);
  assert.equal(run("$quake.properties.mag > 6", {}, env), true);
  assert.equal(run("$list.1", {}, env), "b");
  assert.equal(run("$missing", {}, env), null);
  assert.equal(run("$quake.nope", {}, env), null);
  const f = compileFormula("$a + $b.c + $a", new Set(["a", "b"]));
  assert.ok("vars" in f);
  assert.deepEqual(f.vars, ["a", "b"]);
});

test("pathological formulas fail cleanly and quickly", () => {
  const started = performance.now();
  assert.equal(error("1+".repeat(5000) + "1"), "the formula is longer than 2000 characters");
  assert.equal(error("(".repeat(900) + "1" + ")".repeat(900)), "the formula nests more than 32 levels deep");
  assert.equal(error("-".repeat(1500) + "1"), "the formula nests more than 32 levels deep");
  assert.equal(error("round(".repeat(50) + "1" + ")".repeat(50)), "the formula nests more than 32 levels deep");
  assert.equal(error('"'.repeat(1999)), 'the text starting at character 1999 needs a closing "');
  // The longest formula allowed: a thousand additions in a row, left to right.
  assert.equal(run("1+".repeat(999) + "1"), 1000);
  assert.equal(run("(".repeat(32) + "1" + ")".repeat(32)), 1);
  assert.ok(performance.now() - started < 200, "took too long");
});

test("10,000 rows × 3 formulas in well under 100 ms", () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ close: 100 + Math.sin(i) * 5, volume: 1000 + i, day: "2026-11-18" }));
  const compute = compileCompute({
    change: "round((close - prev(close)) / prev(close) * 100, 2)",
    big: "abs(change) > 3 && volume > 5000",
    label: 'text(round(close, 1)) + " on " + day',
  }, {}, NOW);
  compute(rows.slice(0, 100));
  const started = performance.now();
  const out = compute(rows) as Record<string, unknown>[];
  const ms = performance.now() - started;
  assert.equal(out.length, 10_000);
  assert.equal(typeof out[1].change, "number");
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
});
