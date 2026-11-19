import assert from "node:assert/strict";
import { test } from "node:test";
import { AGGS, PERIODS } from "../src/data.ts";
import { BLOCK_KEYS, BLOCK_ONLY } from "../src/expand.ts";
import { sourceDef } from "../src/sources/registry.ts";
import { SOURCE_WORDS } from "../src/store.ts";
import { KEY_HINTS, VALUE_HINTS, VIEW_HINTS, completion, suggestionsAt, suggestionsFor, type Suggestion } from "../src/hints.ts";
import { COMMON_KEYS, FIELD_TYPES, KEY_TYPES } from "../src/views/common.ts";
import { VIEW_DEFS } from "../src/views/registry.ts";
import { contextAt, type Context } from "../src/yamlpos.ts";

const MARK = "‸";

/** What is suggested at the ‸ in a note: the texts, in order. */
function suggested(snippet: string, isComponent = false): string[] {
  const lines = snippet.split("\n");
  const line = lines.findIndex((l) => l.includes(MARK));
  const ch = lines[line].indexOf(MARK);
  lines[line] = lines[line].replace(MARK, "");
  const ctx = contextAt(lines, line, ch);
  return ctx ? suggestionsFor(ctx, isComponent).map((s) => s.text) : [];
}

const app = (body: string) => `---\napp: A\n${body}\n---`;

// ---- The tables ------------------------------------------------------------------------------------

test("every key a panel can hold has a hint, so a new key can't be added without one", () => {
  for (const key of Object.keys(KEY_TYPES)) assert.ok(KEY_HINTS[key], `no hint for ${key}`);
});

test("every key a view takes, a data block holds, or a note starts with has a hint", () => {
  for (const def of VIEW_DEFS) for (const key of [...COMMON_KEYS, ...def.keys]) assert.ok(KEY_HINTS[key], `${def.id} takes ${key}, which has no hint`);
  for (const key of [...BLOCK_KEYS, ...BLOCK_ONLY]) assert.ok(KEY_HINTS[key], `no hint for block key ${key}`);
  const top = ["app", "spec", "refresh", "store", "data", "inputs", "panels", "use", "with", "component", "params", "for"];
  for (const key of top) assert.ok(KEY_HINTS[key], `no hint for ${key}`);
});

test("hints are one short line", () => {
  for (const [key, hint] of Object.entries(KEY_HINTS)) {
    assert.ok(hint.length > 8 && hint.length <= 120 && !hint.includes("\n"), `${key}: ${hint}`);
  }
  for (const [view, hint] of Object.entries(VIEW_HINTS)) assert.ok(hint.length > 8 && hint.length <= 80 && !hint.includes("\n"), `${view}: ${hint}`);
});

test("every view that exists has a hint, and the views being added have theirs ready", () => {
  for (const def of VIEW_DEFS) assert.ok(VIEW_HINTS[def.id], `no hint for view ${def.id}`);
  for (const id of ["calendar", "board", "scatter", "timeline", "alerts"]) assert.ok(VIEW_HINTS[id], id);
});

test("the values a key takes come from the registries", () => {
  assert.deepEqual(Object.keys(VALUE_HINTS.view), VIEW_DEFS.map((d) => d.id));
  assert.deepEqual(Object.keys(VALUE_HINTS.agg), [...AGGS]);
  assert.deepEqual(Object.keys(VALUE_HINTS.per), [...PERIODS]);
  assert.deepEqual(Object.keys(VALUE_HINTS.fields), FIELD_TYPES);
  assert.deepEqual(Object.keys(VALUE_HINTS.layout), ["cards", "year"]);
  assert.deepEqual(Object.keys(VALUE_HINTS.compare), ["previous"]);
  assert.deepEqual(Object.keys(VALUE_HINTS.pin), ["status"]);
  assert.deepEqual(Object.keys(VALUE_HINTS.source), ["notes", "tasks", "this"]);
  for (const [key, values] of Object.entries(VALUE_HINTS)) for (const [v, hint] of Object.entries(values)) assert.ok(hint, `${key}: ${v}`);
});

test("the source words are the kinds of source that are one word, and each has its hint", () => {
  for (const word of Object.keys(VALUE_HINTS.source)) assert.equal(sourceDef(word).id, word, `${word} isn't a kind of source`);
  for (const word of SOURCE_WORDS) assert.ok(VALUE_HINTS.source[word], `no hint for source: ${word}`);
  assert.ok(KEY_HINTS.source.includes("tasks") && KEY_HINTS.source.includes("this"));
});

// ---- Suggestions -----------------------------------------------------------------------------------

test("top-level keys depend on whether the note is an app or a component, and leave out what is typed", () => {
  assert.deepEqual(suggested("---\n‸\n---"), ["app", "spec", "refresh", "store", "data", "inputs", "panels", "tabs", "use", "with", "view"]);
  assert.deepEqual(suggested("---\n‸\n---", true), ["component", "params", "data", "panels", "tabs", "for", "spec"]);
  assert.deepEqual(suggested("---\napp: A\nspec: 1\ndata:\n  x:\n    source: y\n‸\n---"), ["refresh", "store", "inputs", "panels", "tabs", "use", "with", "view"]);
  assert.deepEqual(suggested("---\ncomponent: C\nparams: [a]\n‸\n---", true), ["data", "panels", "tabs", "for", "spec"]);
  assert.deepEqual(suggested(app("p‸")), ["panels", "spec", "inputs"]);
});

test("a top-level key is matched by what it starts with, then by what it contains", () => {
  assert.deepEqual(suggested("---\nap‸\n---"), ["app"]);
  assert.deepEqual(suggested("---\nre‸\n---"), ["refresh", "store"]);
  assert.deepEqual(suggested("---\nRE‸\n---"), ["refresh", "store"]);
  assert.deepEqual(suggested("---\nzzz‸\n---"), []);
});

test("a single panel written at the top takes its view's keys too", () => {
  const keys = suggested("---\napp: A\nview: countdown\n‸\n---");
  assert.deepEqual(keys, ["spec", "refresh", "store", "data", "inputs", "panels", "tabs", "use", "with", "title", "tab", "span", "to", "label"]);
  assert.deepEqual(suggested("---\ncomponent: C\nview: countdown\n‸\n---", true), ["params", "data", "panels", "tabs", "for", "spec"]);
});

test("in a panel with a view: the common keys and that view's, minus what is typed", () => {
  const keys = suggested(app("panels:\n  - view: countdown\n    ‸"));
  assert.deepEqual(keys, ["title", "tab", "span", "to", "label"]);
  assert.deepEqual(suggested(app("panels:\n  - view: countdown\n    title: T\n    ‸\n    label: L")), ["tab", "span", "to"]);
  assert.deepEqual(suggested(app("panels:\n  - view: countdown\n    la‸")), ["label"]);
  assert.deepEqual(suggested(app("panels:\n  - view: countdown\n    t‸")), ["title", "tab", "to"]);
  // The view may be typed after the cursor.
  assert.deepEqual(suggested(app("panels:\n  - title: T\n    ‸\n    view: countdown")), ["tab", "span", "to", "label"]);
  const table = suggested(app("panels:\n  - view: table\n    ‸"));
  for (const k of ["source", "pick", "from", "where", "sort", "limit", "compute", "columns", "edit", "action", "select"]) assert.ok(table.includes(k), k);
  assert.ok(!table.includes("to") && !table.includes("minutes") && !table.includes("view"));
});

test("in a panel with no view yet: view first, then use and with", () => {
  assert.deepEqual(suggested(app("panels:\n  - ‸")), ["view", "use", "with"]);
  assert.deepEqual(suggested(app("panels:\n  - title: T\n    ‸")), ["view", "use", "with"]);
  assert.deepEqual(suggested(app("panels:\n  - use: \"[[T]]\"\n    ‸")), ["view", "with"]);
  assert.deepEqual(suggested(app("panels:\n  - view: gauge\n    ‸")), ["use", "with"]);
  assert.deepEqual(suggested(app("panels:\n  - v‸")), ["view"]);
  assert.deepEqual(suggested(app("panels:\n  - w‸")), ["with", "view"]);
});

test("in a data block: the block's keys", () => {
  assert.deepEqual(suggested(app("data:\n  q:\n    ‸")), [...BLOCK_KEYS]);
  assert.deepEqual(suggested(app("data:\n  q:\n    source: x\n    pick: y\n    so‸")), ["sort"]);
  assert.deepEqual(suggested(app("data:\n  q:\n    source: x\n    pi‸")), ["pick"]);
  assert.deepEqual(suggested("---\ncomponent: C\ndata:\n  q:\n    sou‸\n---", true), ["source"]);
  assert.ok(!suggested(app("data:\n  q:\n    ‸")).includes("view"));
});

test("the values of view, agg, per, layout, compare and pin", () => {
  assert.deepEqual(suggested(app("panels:\n  - view: ‸")), VIEW_DEFS.map((d) => d.id));
  assert.deepEqual(suggested(app("panels:\n  - view: ta‸")), ["table"]);
  const li = suggested(app("panels:\n  - view: li‸"));
  assert.deepEqual(li.slice(0, 2), ["line", "list"]);
  assert.ok(li.every((v) => v.includes("li")));
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    agg: ‸")), [...AGGS]);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    agg: s‸")), ["sum", "streak", "share", "first", "last"]);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    group: at\n    per: ‸")), [...PERIODS]);
  assert.deepEqual(suggested(app("panels:\n  - view: table\n    layout: ‸")), ["cards", "year"]);
  assert.deepEqual(suggested(app("panels:\n  - view: number\n    compare: ‸")), ["previous"]);
  assert.deepEqual(suggested(app("panels:\n  - view: number\n    pin: ‸")), ["status"]);
  assert.deepEqual(suggested(app("data:\n  q:\n    group: at\n    per: ‸")), [...PERIODS]);
  assert.deepEqual(suggested("---\napp: A\nview: bar\nagg: ‸\n---"), [...AGGS]);
});

test("source offers the kinds that are words, in a panel, a data block and at the top", () => {
  const words = ["notes", "tasks", "this"];
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: ‸")), words);
  assert.deepEqual(suggested(app("data:\n  q:\n    source: ‸")), words);
  assert.deepEqual(suggested("---\napp: A\nview: list\nsource: ‸\n---"), words);
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: ta‸")), ["tasks"]);
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: t‸")), ["tasks", "this", "notes"]);
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: n‸")), ["notes"]);
  // What isn't one of them (an address, a file, a list or a block) is typed freely, and nothing is offered once it can't be one.
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: https://api.example.com/q?a=1‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: weights‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    source: notes‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: list\n    sou‸")), ["source"]);
});

test("a view value is for panels, not for data blocks", () => {
  assert.deepEqual(suggested(app("data:\n  q:\n    view: ‸")), []);
  assert.deepEqual(suggested(app("data:\n  q:\n    layout: ‸")), []);
  assert.deepEqual(suggested(app("data:\n  q:\n    agg: ‸")), [...AGGS]);
});

test("the types of a form's fields, and of a data block's", () => {
  assert.deepEqual(suggested(app("panels:\n  - view: form\n    fields:\n      weight: ‸")), FIELD_TYPES);
  assert.deepEqual(suggested(app("panels:\n  - view: form\n    fields:\n      weight: te‸")), ["text", "textarea", "date"]);
  assert.deepEqual(suggested(app("data:\n  shelf:\n    fields:\n      status: ‸")), FIELD_TYPES);
  // A field's name is its own.
  assert.deepEqual(suggested(app("panels:\n  - view: form\n    fields:\n      wei‸")), []);
});

test("nothing is suggested where the text is free", () => {
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    title: ‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    where:\n      ‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: table\n    columns:\n      - ‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    agg: [‸")), []);
  assert.deepEqual(suggested(app("inputs:\n  ‸")), []);
  assert.deepEqual(suggested(app("data:\n  ‸")), []);
  assert.deepEqual(suggested("---\ncomponent: C\nparams:\n  ‸\n---", true), []);
  assert.deepEqual(suggested(app("panels:\n  - use: x\n    with:\n      ‸")), []);
  assert.deepEqual(suggested(app("constructor: ‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    constructor: ‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    fields: ‸")), []);
});

test("a value that is already complete isn't offered back", () => {
  assert.deepEqual(suggested(app("panels:\n  - view: table‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: bar\n    agg: sum‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: bar‸")), []);
  assert.deepEqual(suggested(app("panels:\n  - view: tab‸")), ["table"]);
});

test("each suggestion carries its hint and kind", () => {
  const ctx: Context = { where: "panel", position: "key", prefix: "ag", present: [], from: { line: 1, ch: 0 }, view: "number" };
  assert.deepEqual(suggestionsFor(ctx, false), [{ kind: "key", text: "agg", hint: KEY_HINTS.agg }]);
  const value: Context = { where: "panel", position: "value", key: "agg", prefix: "str", present: [], from: { line: 1, ch: 0 }, view: "number" };
  assert.deepEqual(suggestionsFor(value, false), [{ kind: "value", text: "streak", hint: VALUE_HINTS.agg.streak }]);
  assert.equal(KEY_HINTS.agg, "How rows become one value: count, sum, avg, min, max, first, last, streak, share");
  assert.equal(KEY_HINTS.select, "Name the clicked row so other panels can read $name.field");
});

test("picking a key adds its colon and space unless a colon is already there; a value is just the value", () => {
  const key: Suggestion = { kind: "key", text: "title", hint: "" };
  const value: Suggestion = { kind: "value", text: "bar", hint: "" };
  assert.equal(completion(key, ""), "title: ");
  assert.equal(completion(key, "  "), "title: ");
  assert.equal(completion(key, ": Doses"), "title");
  assert.equal(completion(key, ":"), "title");
  assert.equal(completion(value, ""), "bar");
  assert.equal(completion(value, " # note"), "bar");
});

/** suggestionsAt at the ‸: where the replaced text starts, what was typed, and what is offered. */
function popup(snippet: string) {
  const lines = snippet.split("\n");
  const line = lines.findIndex((l) => l.includes(MARK));
  const ch = lines[line].indexOf(MARK);
  lines[line] = lines[line].replace(MARK, "");
  const found = suggestionsAt(lines, line, ch);
  return found && { from: found.from, prefix: found.prefix, texts: found.suggestions.map((s) => s.text) };
}

test("a pop-up opens only in an app or a component", () => {
  assert.deepEqual(popup(app("panels:\n  - vi‸")), { from: { line: 3, ch: 4 }, prefix: "vi", texts: ["view"] });
  assert.deepEqual(popup("---\ncomponent: C\npanels:\n  - vi‸\n---"), { from: { line: 3, ch: 4 }, prefix: "vi", texts: ["view"] });
  assert.equal(popup("---\ntitle: T\npanels:\n  - vi‸\n---"), undefined);
  assert.equal(popup("---\nvi‸\n---"), undefined);
  assert.equal(popup("vi‸"), undefined);
  assert.deepEqual(popup(app("panels:\n  - vi‸") + "\nbody"), popup(app("panels:\n  - vi‸")));
});

test("a key pops up once a letter is typed; a value as soon as it is asked for", () => {
  assert.equal(popup(app("panels:\n  - view: bar\n    ‸")), undefined);
  assert.equal(popup(app("panels:\n  - view: bar\n    t‸"))?.prefix, "t");
  assert.deepEqual(popup(app("panels:\n  - view: ‸"))?.from, { line: 3, ch: 10 });
  assert.equal(popup(app("panels:\n  - view: ‸"))?.texts.includes("table"), true);
});

test("nothing pops up where nothing is offered", () => {
  assert.equal(popup(app("panels:\n  - view: bar\n    title: Hel‸")), undefined);
  assert.equal(popup(app("panels:\n  - view: bar\n    zzz‸")), undefined);
  assert.equal(popup(app("panels:\n  - view: table‸")), undefined);
  assert.equal(popup("---\napp: A\n---\nvi‸"), undefined);
});
