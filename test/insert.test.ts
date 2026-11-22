import assert from "node:assert/strict";
import { test } from "node:test";
import { insertPanel, refusalFor, skeleton, withPanels, type Edit } from "../src/insert.ts";
import { checkPanel } from "../src/spec.ts";
import { VIEW_DEFS, viewDef } from "../src/views/registry.ts";
import { parseYaml } from "./support/yaml.ts";
import { kindIn } from "./support/fakes.ts";

const ITEM = ["view: table", "source: spending", "columns: [at, amount]"];

/** The text with the edit applied, found by line and column as an editor would. */
function apply(text: string, edit: Edit): string {
  const starts = [0];
  for (const m of text.matchAll(/\r?\n/g)) starts.push(m.index + m[0].length);
  const offset = (p: { line: number; ch: number }) => starts[p.line] + p.ch;
  return text.slice(0, offset(edit.from)) + edit.text + text.slice(offset(edit.to));
}

/** Inserts into the lines joined, and gives back the new lines and the line and value the cursor is on. */
function insert(lines: string[], item = ITEM, eol = "\n") {
  const text = lines.join(eol);
  const found = insertPanel(text, item);
  assert.ok("edit" in found, JSON.stringify(found));
  const after = apply(text, found.edit);
  const out = after.split(/\r?\n/);
  return { out, after, edit: found.edit, cursor: found.cursor, onCursor: out[found.cursor.line].slice(found.cursor.ch) };
}

const HEAD = ["---", "app: Money"];

test("the cursor lands on the first value to change, after view:; a panel of view: alone leaves it at the end of that line", () => {
  const first = insert([...HEAD, "panels:", "  - view: number", "    source: spending", "---"]);
  assert.deepEqual([first.out[first.cursor.line], first.onCursor], ["    source: spending", "spending"]);
  const quoted = insert([...HEAD, "---"], skeleton(viewDef("countdown")!));
  assert.deepEqual([quoted.out[quoted.cursor.line], quoted.onCursor], ['    to: "2027-10-03"', '"2027-10-03"']);
  for (const lines of [[...HEAD, "panels:", "  - view: number", "---"], [...HEAD, "panels: []", "---"], [...HEAD, "---"]]) {
    const alone = insert(lines, ["view: alerts"]);
    assert.equal(alone.out[alone.cursor.line], "  - view: alerts");
    assert.equal(alone.cursor.ch, "  - view: alerts".length);
  }
});

test("a list with items gets the panel after the last one, written like the others", () => {
  const { out, onCursor } = insert([...HEAD, "panels:", "  - view: number", "    source: spending", "  - view: text", "    text: hi", "---", "Body"]);
  assert.deepEqual(out, [...HEAD, "panels:", "  - view: number", "    source: spending", "  - view: text", "    text: hi",
    "  - view: table", "    source: spending", "    columns: [at, amount]", "---", "Body"]);
  assert.equal(onCursor, "spending");
});

test("an empty list, with the key alone or with brackets, gets two spaces before the dash", () => {
  for (const key of ["panels:", "panels: []", "panels: [ ]"]) {
    const { out, onCursor } = insert([...HEAD, key, "---"]);
    assert.deepEqual(out, [...HEAD, "panels:", "  - view: table", "    source: spending", "    columns: [at, amount]", "---"]);
    assert.equal(onCursor, "spending");
  }
});

test("a comment after empty brackets stays on the key's line", () => {
  const { out } = insert([...HEAD, "panels: [] # none yet", "---"]);
  assert.deepEqual(out.slice(0, 4), [...HEAD, "panels: # none yet", "  - view: table"]);
});

test("a list followed by other top-level keys gets the panel before them, blank lines and comments after it staying", () => {
  const { out } = insert([...HEAD, "panels:", "  - view: number", "    source: spending", "", "# the data", "data:", "  spending:", "    source: spending", "---"]);
  assert.deepEqual(out, [...HEAD, "panels:", "  - view: number", "    source: spending",
    "  - view: table", "    source: spending", "    columns: [at, amount]", "", "# the data", "data:", "  spending:", "    source: spending", "---"]);
});

test("a note with tabs: after panels: gets the panel at the end of panels:", () => {
  const { out } = insert([...HEAD, "panels:", "  - view: number", "    source: a", "tabs:", "  Score:", "    - view: text", "      text: ok", "---"]);
  assert.deepEqual(out, [...HEAD, "panels:", "  - view: number", "    source: a",
    "  - view: table", "    source: spending", "    columns: [at, amount]", "tabs:", "  Score:", "    - view: text", "      text: ok", "---"]);
});

test("a note with tabs: before panels: is no different", () => {
  const { out } = insert([...HEAD, "tabs:", "  Score:", "    - view: text", "      text: ok", "panels:", "  - view: number", "---"]);
  assert.deepEqual(out.slice(-6), ["panels:", "  - view: number", "  - view: table", "    source: spending", "    columns: [at, amount]", "---"]);
});

test("no panels: key adds it, with the panel, just before the closing fence", () => {
  const { out, cursor, onCursor } = insert([...HEAD, "refresh: 5m", "data:", "  a:", "    source: x", "---", "Body"]);
  assert.deepEqual(out, [...HEAD, "refresh: 5m", "data:", "  a:", "    source: x",
    "panels:", "  - view: table", "    source: spending", "    columns: [at, amount]", "---", "Body"]);
  assert.deepEqual([out[cursor.line - 2], out[cursor.line]], ["panels:", "    source: spending"]);
  assert.equal(onCursor, "spending");
});

test("a note with nothing but app: gets panels: too", () => {
  const { out } = insert([...HEAD, "---"]);
  assert.deepEqual(out, [...HEAD, "panels:", "  - view: table", "    source: spending", "    columns: [at, amount]", "---"]);
});

test("line endings stay as the note has them", () => {
  const text = ["---", "app: Money", "panels:", "  - view: number", "    source: a", "tabs:", "  A: []", "---", "Body"].join("\r\n");
  const found = insertPanel(text, ITEM);
  assert.ok("edit" in found);
  const after = apply(text, found.edit);
  assert.equal(after, ["---", "app: Money", "panels:", "  - view: number", "    source: a", "  - view: table", "    source: spending", "    columns: [at, amount]", "tabs:", "  A: []", "---", "Body"].join("\r\n"));
  assert.equal(after.split("\r\n")[found.cursor.line].slice(found.cursor.ch), "spending");

  const bare = insertPanel(["---", "app: Money", "---"].join("\r\n"), ITEM);
  assert.ok("edit" in bare);
  assert.equal(apply(["---", "app: Money", "---"].join("\r\n"), bare.edit), ["---", "app: Money", "panels:", "  - view: table", "    source: spending", "    columns: [at, amount]", "---"].join("\r\n"));
});

test("odd indentation is matched: four spaces, a dash at the left edge, a wide gap after the dash", () => {
  const four = insert([...HEAD, "panels:", "    - view: number", "      source: a", "---"]);
  assert.deepEqual(four.out.slice(3), ["    - view: number", "      source: a", "    - view: table", "      source: spending", "      columns: [at, amount]", "---"]);
  assert.equal(four.onCursor, "spending");

  const flush = insert([...HEAD, "panels:", "- view: number", "  source: a", "refresh: 5m", "---"]);
  assert.deepEqual(flush.out.slice(2), ["panels:", "- view: number", "  source: a", "- view: table", "  source: spending", "  columns: [at, amount]", "refresh: 5m", "---"]);

  const wide = insert([...HEAD, "panels:", "  -   view: number", "      source: a", "---"]);
  assert.deepEqual(wide.out.slice(3), ["  -   view: number", "      source: a", "  -   view: table", "      source: spending", "      columns: [at, amount]", "---"]);
  assert.equal(wide.onCursor, "spending");
});

test("a note with one panel typed at the top level is refused, and left alone", () => {
  const text = ["---", "app: Money", "view: number", "source: spending", "---"].join("\n");
  const found = insertPanel(text, ITEM);
  assert.deepEqual(found, { refusal: "This note has one panel typed at the top level; move it under panels: to add more" });
  assert.equal(refusalFor(text), "This note has one panel typed at the top level; move it under panels: to add more");
  assert.equal(refusalFor(["---", "app: Money", "panels:", "  - view: number", "---"].join("\n")), undefined);
});

test("panels written on one line are refused rather than rewritten", () => {
  const found = insertPanel(["---", "app: Money", "panels: [{view: text, text: hi}]", "---"].join("\n"), ITEM);
  assert.deepEqual(found, { refusal: "panels: is written on one line; put each panel on its own line under it to add more" });
});

test("indented lines that look like top-level keys are not", () => {
  const { out } = insert([...HEAD, "data:", "  view:", "    source: x", "panels:", "  - view: number", "    note: |", "      panels: no", "---"]);
  assert.deepEqual(out, [...HEAD, "data:", "  view:", "    source: x", "panels:", "  - view: number", "    note: |", "      panels: no",
    "  - view: table", "    source: spending", "    columns: [at, amount]", "---"]);
});

test("text with no frontmatter is refused", () => {
  assert.ok("refusal" in insertPanel("Just a note", ITEM));
});

// ---- The skeleton ------------------------------------------------------------------------------------

test("a skeleton is the view's first working example as plain lines", () => {
  assert.deepEqual(skeleton(viewDef("table")!).slice(0, 3), ["view: table", "source: spending", "columns: [at, amount, category]"]);
  assert.deepEqual(skeleton({ examples: [{ panel: { view: "x" }, errors: ["no"] }, { panel: { view: "yes sir", n: 3, ok: true } }] }), ["view: yes sir", "n: 3", "ok: true"]);
});

test("strings that YAML would read as something else, or that need quotes, are quoted", () => {
  const lines = skeleton({ examples: [{ panel: {
    a: "plain words", b: "2027-10-03", c: "true", d: "{title} · {author}", e: "> 5", f: "I expect: this", g: "#book", h: "$0,0.00", i: "7",
    j: "https://api.example.com/x?a=1", k: "- Took meds", l: "", m: { "1": "low", amount: "$0", "odd key": "x:y" }, n: ["a b", "c,d", "e"], o: [], p: {},
  } }] });
  assert.deepEqual(lines, [
    "a: plain words", 'b: "2027-10-03"', 'c: "true"', 'd: "{title} · {author}"', 'e: "> 5"', 'f: "I expect: this"', 'g: "#book"', 'h: "$0,0.00"', 'i: "7"',
    "j: https://api.example.com/x?a=1", 'k: "- Took meds"', 'l: ""', 'm: {1: low, amount: "$0", "odd key": "x:y"}', 'n: [a b, "c,d", e]', "o: []", "p: {}",
  ]);
});

test("several panels go in one after another, as Insert panel puts each, with the cursor in the first", () => {
  const text = ["---", "app: Water", "panels:", "- view: alerts", "---", "Notes"].join("\r\n");
  const out = withPanels(text, [["view: button", "label: Drank a glass"], ["view: countdown", "to: 2027-01-01"]]);
  assert.ok("text" in out);
  assert.equal(out.text, ["---", "app: Water", "panels:", "- view: alerts", "- view: button", "  label: Drank a glass", "- view: countdown", "  to: 2027-01-01", "---", "Notes"].join("\r\n"));
  assert.deepEqual(out.cursor, { line: 5, ch: "  label: ".length });
  assert.deepEqual(withPanels("---\napp: Water\nview: countdown\n---", [["view: button"]]), { refusal: refusalFor("---\napp: Water\nview: countdown\n---") });
});

for (const def of VIEW_DEFS) {
  test(`${def.id}: the skeleton, typed into a panels list, reads back as the example and checks out`, () => {
    const item = skeleton(def);
    const text = ["---", "app: Money", "---"].join("\n");
    const found = insertPanel(text, item);
    assert.ok("edit" in found);
    const fm = parseYaml(apply(text, found.edit).split("\n").slice(1, -1).join("\n")) as { panels: Record<string, unknown>[] };
    const example = def.examples.find((e) => !e.errors)!.panel;
    assert.deepEqual(fm.panels, [example]);
    assert.deepEqual(checkPanel(fm.panels[0], true, kindIn(fm.panels[0])).errors, []);
  });
}
