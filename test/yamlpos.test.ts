import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readSpec } from "../src/spec.ts";
import { contextAt, labelOf, lineOf, noteKind, type Context } from "../src/yamlpos.ts";
import { parseYaml } from "./support/yaml.ts";

const MARK = "‸";

/** A note with the cursor marked by ‸, as the lines an editor holds and the cursor's place. */
function marked(snippet: string, eol = "") {
  const lines = snippet.split("\n");
  const line = lines.findIndex((l) => l.includes(MARK));
  const ch = lines[line].indexOf(MARK);
  lines[line] = lines[line].replace(MARK, "");
  return { lines: lines.map((l) => l + eol), line, ch };
}

type Expected = Omit<Context, "from">;

/** Checks what the cursor is in; the text to replace always ends at the cursor, and starts a prefix before it. */
function check(snippet: string, expected: Expected | undefined, eol = ""): void {
  const { lines, line, ch } = marked(snippet, eol);
  const got = contextAt(lines, line, ch);
  if (expected === undefined) return assert.equal(got, undefined, snippet);
  assert.ok(got, snippet);
  const { from, ...rest } = got;
  assert.deepEqual(rest, expected, snippet);
  assert.deepEqual(from, { line, ch: ch - expected.prefix.length }, snippet);
}

const none: Expected = { where: "other", position: "key", prefix: "", present: [] };
const key = (where: Expected["where"], prefix: string, present: string[], view?: string): Expected =>
  ({ where, position: "key", prefix, present, ...(view ? { view } : {}) });
const value = (where: Expected["where"], k: string, prefix: string, present: string[], view?: string): Expected =>
  ({ where, position: "value", key: k, prefix, present, ...(view ? { view } : {}) });

// ---- Real notes ------------------------------------------------------------------------------------

const note = (name: string) => readFileSync(new URL(`./vault/${name}`, import.meta.url), "utf8").split("\n");
const PLANET = note("Apps/Planet Earth.md");
const LIBRARY = note("Apps/Library.md");
const MOVERS = note("Apps/Movers.md");

/** The cursor at the end of the nth line that reads exactly `text`, or just after `at` in it. */
function onLine(lines: string[], text: string, at?: string, nth = 1) {
  let line = -1;
  for (let seen = 0; seen < nth; seen++) line = lines.indexOf(text, line + 1);
  assert.ok(line >= 0, `no line ${text}`);
  return { line, ch: at === undefined ? text.length : text.indexOf(at) + at.length };
}

function at(lines: string[], text: string, where?: string, nth = 1) {
  const pos = onLine(lines, text, where, nth);
  return contextAt(lines, pos.line, pos.ch);
}

test("Planet Earth: a panel's keys and values, with its view and the keys beside it", () => {
  assert.deepEqual(rest(at(PLANET, "  - view: number", "number")), value("panel", "view", "number", ["title", "source", "label"]));
  assert.deepEqual(rest(at(PLANET, "    source: quakes", "quakes")), { ...value("panel", "source", "quakes", ["view", "title", "label"], "number") });
  assert.deepEqual(rest(at(PLANET, "    agg: max", "max")), value("panel", "agg", "max", ["view", "title", "source", "field", "decimals", "label"], "number"));
  assert.deepEqual(rest(at(PLANET, "    title: Earthquakes, past $period", "past $period")), value("panel", "title", "Earthquakes, past $period", ["view", "source", "label"], "number"));
  assert.deepEqual(rest(at(PLANET, "    per: day")), value("panel", "per", "day", ["view", "tab", "title", "source", "group"], "bar"));
  assert.deepEqual(rest(at(PLANET, "    tab: Earthquakes", "tab", 2)), { ...key("panel", "tab", ["view", "span", "title", "source", "sort", "limit", "item"], "list") });
});

test("Planet Earth: data blocks, inputs, flow maps and components", () => {
  assert.deepEqual(rest(at(PLANET, "    pick: features", "pick")), key("block", "pick", ["source"]));
  assert.deepEqual(rest(at(PLANET, "    pick: features")), value("block", "pick", "features", ["source"]));
  assert.deepEqual(rest(at(PLANET, "    sort: time_tag")), value("block", "sort", "time_tag", ["source", "where"]));
  assert.equal(at(PLANET, "    where: {active: true}")?.where, "other");
  assert.equal(at(PLANET, "  period: [week, day, month]", "[week, d")?.where, "other");
  assert.equal(at(PLANET, "  period: [week, day, month]")?.where, "other");
  assert.equal(at(PLANET, '  - use: "[[City]]"', '"[[Ci')?.where, "other");
  assert.equal(at(PLANET, "    with: {name: Philadelphia, lat: 39.95, lon: -75.17}")?.where, "other");
  assert.deepEqual(rest(at(PLANET, "    tab: Philadelphia")), value("panel", "tab", "Philadelphia", ["use", "with"]));
  assert.deepEqual(rest(at(PLANET, "refresh: 10m")), value("top", "refresh", "10m", ["app", "spec", "inputs", "data", "panels"]));
  assert.deepEqual(rest(at(PLANET, "app: Planet Earth, right now", "app")), key("top", "app", ["spec", "refresh", "inputs", "data", "panels"]));
});

test("Planet Earth: half-typed lines in the middle of an app", () => {
  const lines = [...PLANET];
  const i = lines.indexOf("    title: Strongest");
  lines.splice(i + 1, 0, "    fie");
  assert.deepEqual(rest(contextAt(lines, i + 1, 7)), key("panel", "fie", ["view", "title", "source", "field", "agg", "decimals", "label"], "number"));
  lines[i + 1] = "    agg: ";
  assert.deepEqual(rest(contextAt(lines, i + 1, 9)), value("panel", "agg", "", ["view", "title", "source", "field", "agg", "decimals", "label"], "number"));
  lines[i + 1] = "  - ";
  // A new item takes the keys that follow it, so they count as its own.
  assert.deepEqual(rest(contextAt(lines, i + 1, 4)), key("panel", "", ["source", "field", "agg", "decimals", "label"]));
});

test("Library: data blocks with a schema, a form's row map, a note's body of keys", () => {
  assert.deepEqual(rest(at(LIBRARY, "    source: notes")), value("block", "source", "notes", ["from", "fields"]));
  assert.equal(at(LIBRARY, "      status: [to read, reading, done]", "[to ")?.where, "other");
  assert.equal(at(LIBRARY, "      title: \"{title}\"", "title", 1)?.where, "other");
  assert.deepEqual(rest(at(LIBRARY, "    save: Books/")), value("panel", "save", "Books/", ["view", "title", "source", "pick", "item", "select", "action", "name", "row", "notify"], "list"));
  assert.equal(at(LIBRARY, "    columns: [name, author, status, finished]")?.where, "other");
  assert.deepEqual(rest(at(LIBRARY, "  - view: table", "table")), value("panel", "view", "table", ["title", "source", "sort", "columns", "edit"]));
});

test("Movers: computed columns and chained blocks", () => {
  assert.equal(at(MOVERS, '      session: "coalesce(prev(session), 0) + 1"', "ses")?.where, "other");
  assert.deepEqual(rest(at(MOVERS, "    source: days")), value("block", "source", "days", ["where"]));
  assert.deepEqual(rest(at(MOVERS, "    source: big")), value("panel", "source", "big", ["view", "title", "label"], "number"));
  assert.equal(at(MOVERS, "      when: '\"session \" + session'", "wh")?.where, "other");
  assert.deepEqual(rest(at(MOVERS, "    columns: [when, close, change]", "columns")), key("panel", "columns", ["view", "title", "source", "compute", "sort", "limit", "decimals", "select"], "table"));
});

function rest(c: Context | undefined): Expected | undefined {
  if (!c) return undefined;
  const { from, ...others } = c;
  assert.ok(from.line >= 0);
  return others;
}

// ---- Hand-typed text -------------------------------------------------------------------------------

const TABLE: [string, string, Expected | undefined][] = [
  ["a new key in a panel", "---\napp: Meds\npanels:\n  - view: number\n    title: Doses\n    sou‸\n---", key("panel", "sou", ["view", "title"], "number")],
  ["a key right at the colon", "---\napp: Meds\npanels:\n  - view‸: number\n    title: Doses\n---", key("panel", "view", ["title"])],
  ["a value after the colon and a space", "---\napp: Meds\npanels:\n  - view: ‸\n---", value("panel", "view", "", [])],
  ["a value part-typed", "---\napp: Meds\npanels:\n  - view: li‸\n---", value("panel", "view", "li", [])],
  ["the view comes after the cursor in the item", "---\napp: Meds\npanels:\n  - title: X\n    ‸\n    view: bar\n---", key("panel", "", ["title", "view"], "bar")],
  ["only the same item's view counts", "---\napp: Meds\npanels:\n  - view: bar\n  - title: X\n    ‸\n  - view: list\n---", key("panel", "", ["title"])],
  ["a list item with just its dash", "---\napp: Meds\npanels:\n  - ‸\n---", key("panel", "", [])],
  ["a half-typed first key of an item", "---\napp: Meds\npanels:\n  - vi‸\n    title: X\n---", key("panel", "vi", ["title"])],
  ["a use item", "---\napp: Meds\npanels:\n  - use: \"[[Ticker]]\"\n    wi‸\n---", key("panel", "wi", ["use"])],
  ["a list at the same indent as its key", "---\napp: Meds\npanels:\n- view: line\n  x‸\n---", key("panel", "x", ["view"], "line")],
  ["a single panel at the top", "---\napp: Countdown\nview: countdown\n‸\n---", key("top", "", ["app", "view"], "countdown")],
  ["a single panel's value at the top", "---\napp: Countdown\nview: line\nagg: su‸\n---", value("top", "agg", "su", ["app", "view"], "line")],
  ["a top-level key", "---\napp: Meds\nre‸\n---", key("top", "re", ["app"])],
  ["a top-level key on a blank line after panels", "---\napp: Meds\npanels:\n  - view: number\n‸\n---", key("top", "", ["app", "panels"])],
  ["the first line of the note's keys", "---\n‸\napp: Meds\n---", key("top", "", ["app"])],
  ["a refresh value", "---\napp: Meds\nrefresh: 5‸\n---", value("top", "refresh", "5", ["app"])],
  ["a data block's key", "---\napp: Meds\ndata:\n  doses:\n    source: doses\n    so‸\n---", key("block", "so", ["source"])],
  ["a data block's blank line", "---\napp: Meds\ndata:\n  doses:\n    source: doses\n    ‸\n---", key("block", "", ["source"])],
  ["a data block's value", "---\napp: Meds\ndata:\n  doses:\n    per: ‸\n---", value("block", "per", "", [])],
  ["the name of a data block is free text", "---\napp: Meds\ndata:\n  do‸\n---", none],
  ["an input's name is free text", "---\napp: Meds\ninputs:\n  period: [week, day]\n  sy‸\n---", key("inputs", "sy", ["period"])],
  ["an input's value", "---\napp: Meds\ninputs:\n  q: te‸\n---", value("inputs", "q", "te", [])],
  ["a component's keys", "---\ncomponent: Ticker\nparams:\n  symbol:\ndata:\n  chart:\n    sour‸\npanels:\n  - view: number\n---", key("block", "sour", [])],
  ["a component's params are free text", "---\ncomponent: Ticker\nparams:\n  sym‸\n---", none],
  ["a component's panels", "---\ncomponent: Ticker\npanels:\n  - view: number\n    fie‸\n---", key("panel", "fie", ["view"], "number")],
  ["the top-level with", "---\napp: Meds\nuse: \"[[Ticker]]\"\nwith:\n  symbol: A‸\n---", value("with", "symbol", "A", [])],
  ["a panel's with", "---\napp: Meds\npanels:\n  - use: \"[[Ticker]]\"\n    with:\n      symbol: A‸\n---", value("with", "symbol", "A", [])],
  ["a form's fields: a field's type", "---\napp: Meds\npanels:\n  - view: form\n    fields:\n      weight: nu‸\n---", value("fields", "weight", "nu", [])],
  ["a form's fields: a field's name", "---\napp: Meds\npanels:\n  - view: form\n    fields:\n      weight: number\n      no‸\n---", key("fields", "no", ["weight"])],
  ["a block's fields", "---\napp: Meds\ndata:\n  shelf:\n    source: notes\n    fields:\n      status: da‸\n---", value("fields", "status", "da", [])],
  ["a panel's other maps", "---\napp: Meds\npanels:\n  - view: table\n    where:\n      status: do‸\n---", none],
  ["a panel's formulas", "---\napp: Meds\npanels:\n  - view: table\n    compute:\n      dub: x * 2\n      ‸\n---", none],
  ["a list of columns is not a list of panels", "---\napp: Meds\npanels:\n  - view: table\n    columns:\n      - na‸\n---", none],
  ["a dash in a list of columns", "---\napp: Meds\npanels:\n  - view: table\n    columns:\n      - name\n      - ‸\n---", none],
  ["a panel key after a list of columns", "---\napp: Meds\npanels:\n  - view: table\n    columns:\n      - name\n      - status\n    sou‸\n---", key("panel", "sou", ["view", "columns"], "table")],
  ["items of a nested list of maps", "---\napp: Meds\npanels:\n  - view: table\n    columns:\n      - name: x\n        ‸\n---", none],
  ["a flow map", "---\napp: Meds\npanels:\n  - view: table\n    where: {status: do‸\n---", none],
  ["after a flow map", "---\napp: Meds\npanels:\n  - view: table\n    where: {status: done}‸\n---", none],
  ["a flow list that runs over lines", "---\napp: Meds\npanels:\n  - view: table\n    columns: [name,\n      sta‸\n---", none],
  ["the line after a flow list that ran over lines", "---\napp: Meds\npanels:\n  - view: table\n    columns: [name,\n      status]\n    sou‸\n---", key("panel", "sou", ["view", "columns"], "table")],
  ["a quoted value", "---\napp: Meds\npanels:\n  - view: table\n    title: \"Hel‸\n---", none],
  ["a quote that runs over lines", "---\napp: Meds\npanels:\n  - view: table\n    title: \"Hello\n      wor‸\n---", none],
  ["a block string", "---\napp: |\n  Track my ‸meds\npanels:\n  - view: table\n---", none],
  ["the line after a block string", "---\napp: |\n  Track my meds\n\n  and more\nre‸\n---", key("top", "re", ["app"])],
  ["a folded string", "---\napp: Meds\npanels:\n  - view: text\n    text: >-\n      a long\n      sen‸\n---", none],
  ["a plain value that runs over lines", "---\napp: Meds\npanels:\n  - view: text\n    text: one\n      tw‸\n---", none],
  ["an apostrophe inside a word isn't a quote", "---\napp: Meds\npanels:\n  - view: text\n    where: {a: don't}\n    sou‸\n---", key("panel", "sou", ["view", "where"], "text")],
  ["a comment line", "---\napp: Meds\n# a com‸ment\n---", none],
  ["a comment after a value", "---\napp: Meds\npanels:\n  - view: number # no‸te\n---", none],
  ["a tab-indented line", "---\napp: Meds\npanels:\n  - view: number\n\ttitle: x‸\n---", none],
  ["only a tab", "---\napp: Meds\npanels:\n  - view: number\n\t‸\n---", none],
  ["right after the colon, before the space", "---\napp: Meds\npanels:\n  - view:‸\n---", none],
  ["in the middle of a key", "---\napp: Meds\npanels:\n  - vi‸ew: number\n---", none],
  ["in the middle of a value", "---\napp: Meds\npanels:\n  - view: nu‸mber\n---", none],
  ["in the indentation", "---\napp: Meds\npanels:\n ‸ - view: number\n---", none],
  ["before the dash", "---\napp: Meds\npanels:\n  ‸- view: number\n---", none],
  ["between the dash and its space", "---\napp: Meds\npanels:\n  -‸\n---", none],
  ["a quoted key", "---\napp: Meds\n\"ti‸tle\": x\n---", none],
  ["a key with an odd character", "---\napp: Meds\nti tle‸\n---", none],
  ["a stray indented line with nothing above it", "---\n  ‸\napp: Meds\n---", none],
  ["a stray indented key under a plain value", "---\napp: Meds\n  sou‸\n---", none],
  ["a name's URL value", "---\napp: Meds\ndata:\n  x:\n    source: https://a.b/c?d=1‸\n---", value("block", "source", "https://a.b/c?d=1", [])],
  // Outside the frontmatter
  ["the body", "---\napp: Meds\n---\nsome ‸text", undefined],
  ["no frontmatter", "app: Meds\nvi‸", undefined],
  ["no closing fence", "---\napp: Meds\nvi‸", undefined],
  ["the opening fence", "‸---\napp: Meds\n---", undefined],
  ["the closing fence", "---\napp: Meds\n---‸", undefined],
  ["a horizontal rule in the body", "---\napp: Meds\n---\ntext\n---\nvi‸", undefined],
];

for (const [name, snippet, expected] of TABLE) {
  test(`hand-typed: ${name}`, () => {
    check(snippet, expected);
    // Files with Windows line endings leave a \r on every line.
    check(snippet, expected, "\r");
  });
}

test("the cursor can be anywhere past the end of a line or before the first one", () => {
  const lines = ["---", "app: Meds", "---"];
  assert.equal(contextAt(lines, 5, 0), undefined);
  assert.equal(contextAt(lines, -1, 0), undefined);
  assert.equal(contextAt([], 0, 0), undefined);
  assert.deepEqual(rest(contextAt(lines, 1, 99)), value("top", "app", "Meds", []));
});

// ---- Kind of note ----------------------------------------------------------------------------------

test("noteKind reads the top-level app and component keys from the text", () => {
  assert.equal(noteKind(PLANET), "app");
  assert.equal(noteKind(note("Components/City.md")), "component");
  assert.equal(noteKind(["---", "app:", "---"]), "app");
  assert.equal(noteKind(["---", "app: A", "component: B", "---"]), "app");
  assert.equal(noteKind(["---", "title: x", "---", "app: y"]), undefined);
  assert.equal(noteKind(["---", "panels:", "  - app: x", "---"]), undefined);
  assert.equal(noteKind(["---", "# app: x", "---"]), undefined);
  assert.equal(noteKind(["app: A"]), undefined);
  assert.equal(noteKind(["---", "app: A\r", "---\r"]), "app");
});

// ---- Errors that name a place ----------------------------------------------------------------------

test("labelOf names the panel, block or input at the start of a message", () => {
  assert.deepEqual(labelOf('panel 2: "unit" doesn\'t apply to bar'), { kind: "panel", n: 2 });
  assert.deepEqual(labelOf("panel 12"), { kind: "panel", n: 12 });
  assert.deepEqual(labelOf("panel 2 (from [[Ticker]] panel 1): unknown key \"x\""), { kind: "panel", n: 2 });
  assert.deepEqual(labelOf("panel 3 (from [[A (old)]] panel 1 → [[B]] panel 2)"), { kind: "panel", n: 3 });
  assert.deepEqual(labelOf("panel 4: data.quakes: \"per\" needs \"group\""), { kind: "panel", n: 4 });
  assert.deepEqual(labelOf('panel 2: compute.change: unknown function "foo"'), { kind: "panel", n: 2 });
  assert.deepEqual(labelOf('data.quakes: unknown key "x"'), { kind: "data", name: "quakes" });
  assert.deepEqual(labelOf("data.quakes needs a source"), { kind: "data", name: "quakes" });
  assert.deepEqual(labelOf("data.kp must be a set of keys"), { kind: "data", name: "kp" });
  assert.deepEqual(labelOf("data.my block: compute.x: bad"), { kind: "data", name: "my block" });
  assert.deepEqual(labelOf("data.a → data.b → data.a use each other"), { kind: "data", name: "a" });
  assert.deepEqual(labelOf("data.a → data.b → data.c → data.d → data.e is more than 4 blocks deep"), { kind: "data", name: "a" });
  assert.deepEqual(labelOf("data.big: \"from\" belongs on data.quote, where the source is"), { kind: "data", name: "big" });
  assert.deepEqual(labelOf("inputs.period must be a list of choices or date"), { kind: "input", name: "period" });
  assert.deepEqual(labelOf("inputs.period: a choice can't hold a secret or a line break"), { kind: "input", name: "period" });
  assert.deepEqual(labelOf('inputs: "my period" can only use letters, digits and _'), { kind: "input", name: "my period" });
  assert.deepEqual(labelOf('input "period" isn\'t used by any panel'), { kind: "input", name: "period" });
  for (const none of [
    "unknown key \"x\"", "this app has more than 100 panels; only the first 100 are drawn", "refresh must look like 30s, 5m, 1h",
    "[[Ticker]] panel 1: \"unit\" doesn't apply to bar", "panel two: x", 'data: "notes" can\'t be a name', "data must be a set of named sources",
    "inputs must be named, e.g. inputs: {symbol: [SPY, QQQ]}", "the data.quakes block", "",
  ]) assert.equal(labelOf(none), undefined, none);
});

test("lineOf finds the line of panel N, with or without where it came from", () => {
  // Planet Earth's panels start at these 0-based lines.
  const starts = [17, 21, 28, 35, 43, 49, 57, 67, 74, 81, 88, 91, 94];
  starts.forEach((line, i) => {
    assert.equal(lineOf(PLANET, `panel ${i + 1}`), line);
    assert.equal(lineOf(PLANET, `panel ${i + 1}: "unit" doesn't apply to bar`), line);
    assert.equal(PLANET[line].startsWith("  - "), true);
  });
  assert.equal(lineOf(PLANET, "panel 12 (from [[City]] panel 3): \"unit\" doesn't apply to bar"), 91);
  assert.equal(lineOf(PLANET, "panel 12 (from [[City]] panel 3 → [[Loop A]] panel 1): x"), 91);
  assert.equal(lineOf(PLANET, "panel 14: x"), undefined);
  assert.equal(lineOf(PLANET, "panel 0: x"), undefined);
  assert.equal(lineOf(PLANET, 'panel 2: compute.change: unknown function "foo"'), 21);
  assert.equal(lineOf(PLANET, 'panel 2: data.quakes: "per" needs "group"'), 21);
});

test("lineOf finds a data block and an input by name", () => {
  assert.equal(lineOf(PLANET, 'data.quakes: unknown key "x"'), 7);
  assert.equal(lineOf(PLANET, "data.wind needs a source"), 10);
  assert.equal(lineOf(PLANET, "data.kp must be a set of keys"), 14);
  assert.equal(lineOf(PLANET, "data.nope: x"), undefined);
  assert.equal(lineOf(PLANET, "inputs.period must be a list of choices or date"), 5);
  assert.equal(lineOf(PLANET, 'input "period" isn\'t used by any panel'), 5);
  assert.equal(lineOf(PLANET, "inputs.other: x"), undefined);
  assert.equal(lineOf(MOVERS, "data.big → data.days → data.big use each other"), 14);
  assert.equal(lineOf(MOVERS, "data.days: compute.change: unknown function \"foo\""), 8);
  assert.equal(lineOf(MOVERS, 'input "symbol" isn\'t used by any panel'), 3);
  assert.equal(lineOf(LIBRARY, "data.shelf: field \"status\" type must be one of text"), 5);
});

test("lineOf copes with other layouts and says nothing it can't place", () => {
  const sameIndent = ["---", "app: A", "panels:", "- view: bar", "  title: x", "- view: list", "refresh: 5m", "---"];
  assert.equal(lineOf(sameIndent, "panel 1"), 3);
  assert.equal(lineOf(sameIndent, "panel 2"), 5);
  assert.equal(lineOf(sameIndent, "panel 3"), undefined);
  assert.equal(lineOf(sameIndent.map((l) => `${l}\r`), "panel 2"), 5);
  const nested = ["---", "app: A", "panels:", "  - view: table", "    columns:", "      - a", "      - b", "  - view: list", "---"];
  assert.equal(lineOf(nested, "panel 2"), 7);
  const flowBlocks = ["---", "app: A", "data: {a: {source: x}}", "panels: []", "---"];
  assert.equal(lineOf(flowBlocks, "data.a: x"), 2);
  assert.equal(lineOf(flowBlocks, "panel 1"), undefined);
  assert.equal(lineOf(["---", "app: A", "---"], "panel 1"), undefined);
  assert.equal(lineOf(["---", "app: A", "data:", "panels:", "  - view: bar", "---"], "data.a: x"), undefined);
  assert.equal(lineOf(["---", "app: A", "data:", "  - a", "panels:", "---"], "data.a: x"), undefined);
  assert.equal(lineOf(["app: A", "panels:", "  - view: bar"], "panel 1"), undefined);
  assert.equal(lineOf(PLANET, 'unknown key "x"'), undefined);
  assert.equal(lineOf(["---", "app: A", "data:", "  a:", "    - x", "    - y", "  b:", "    source: q", "---"], "data.b needs a source"), 6);
});

// ---- The labels readSpec really produces ------------------------------------------------------------

function errorsOf(text: string): string[] {
  const m = text.match(/^---\n([\s\S]*?)\n---/)!;
  return readSpec(parseYaml(m[1]) as Record<string, unknown>, { path: "A.md" })?.errors ?? [];
}

test("every error shape readSpec gives for a panel, block or input is placed on its line", () => {
  const text = [
    "---",
    "app: Broken",
    "inputs:",
    "  period: [week, day]",
    "  unused: [a, b]",
    "  bad: nope",
    "data:",
    "  quakes:",
    "    pick: features",
    "  days:",
    "    source: https://a.b/c",
    "    compute:",
    "      x: foo(1)",
    "    wat: 1",
    "  loop1:",
    "    source: loop2",
    "  loop2:",
    "    source: loop1",
    "panels:",
    "  - view: gauge",
    "  - view: bar",
    "    source: days",
    "    unit: kg",
    "    compute:",
    "      y: bar(2)",
    "  - view: number",
    "    source: days",
    "    per: day",
    "  - use: \"[[Missing]]\"",
    "  - view: number",
    "    source: days",
    "    field: $period",
    "---",
  ].join("\n");
  const lines = text.split("\n");
  const errors = errorsOf(text);
  const placed = errors.map((e) => [e, lineOf(lines, e)] as const);
  const expect = (prefix: string, line: number) => {
    const hit = placed.filter(([e]) => e.startsWith(prefix));
    assert.ok(hit.length > 0, `no error starting ${prefix} in ${JSON.stringify(errors)}`);
    for (const [e, l] of hit) assert.equal(l, line, e);
  };
  const where = (text: string, nth = 1) => lines.flatMap((l, i) => (l === text ? [i] : []))[nth - 1];
  expect("panel 1:", where("  - view: gauge"));
  expect("panel 2:", where("  - view: bar"));
  expect("panel 3:", where("  - view: number"));
  expect("panel 4:", where('  - use: "[[Missing]]"'));
  expect("data.quakes", where("  quakes:"));
  expect("data.days", where("  days:"));
  expect("input \"unused\"", where("  unused: [a, b]"));
  expect("inputs.bad", where("  bad: nope"));
  expect("data.loop1", where("  loop1:"));
  // Messages with no place stay unplaced.
  for (const [e, l] of placed) if (!/^(panel \d|data\.|input)/.test(e)) assert.equal(l, undefined, e);
});

test("an error from a component is placed on the app's panel that uses it", () => {
  const ticker = { component: "T", params: ["symbol"], panels: [{ view: "gauge" }, { view: "number", source: "x", unit: 1 }] };
  const text = "---\napp: A\npanels:\n  - view: number\n    text: x\n  - use: \"[[Ticker]]\"\n    with: {symbol: A}\n---";
  const fm = parseYaml(text.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
  const notes = {
    resolve: (l: string) => (l === "Ticker" ? "Ticker.md" : undefined),
    frontmatter: (p: string) => (p === "Ticker.md" ? ticker : undefined),
  };
  const errors = readSpec(fm, { path: "A.md", notes })!.errors;
  const fromComponent = errors.filter((e) => e.startsWith("panel 2 (from [[Ticker]] panel"));
  assert.equal(fromComponent.length >= 1, true, JSON.stringify(errors));
  for (const e of fromComponent) assert.equal(lineOf(text.split("\n"), e), 5, e);
});

test("Broken: each of its errors, even the one from a loop of components, lands on its panel", () => {
  const frontmatterOf = (name: string) => {
    const lines = note(name);
    return parseYaml(lines.slice(1, lines.lastIndexOf("---")).join("\n")) as Record<string, unknown>;
  };
  const lines = note("Apps/Broken.md");
  const notes = {
    resolve: (l: string) => (/^Loop [AB]$/.test(l) ? `Components/${l}.md` : undefined),
    frontmatter: frontmatterOf,
  };
  const errors = readSpec(frontmatterOf("Apps/Broken.md"), { path: "Apps/Broken.md", notes })!.errors;
  assert.equal(errors.length, 4);
  const panels = lines.flatMap((l, i) => (l.startsWith("  - ") ? [i] : []));
  errors.forEach((e, i) => assert.equal(lineOf(lines, e), panels[i], e));
});
