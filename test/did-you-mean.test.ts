import assert from "node:assert/strict";
import { test } from "node:test";
import { appNames, suggestionsAt } from "../src/hints.ts";
import { checkPanel, readSpec } from "../src/spec.ts";
import { nearMiss } from "../src/template.ts";
import { VIEW_DEFS } from "../src/views/registry.ts";
import { parseYaml } from "./support/yaml.ts";

const errors = (fm: Record<string, unknown>) => readSpec({ app: "x", ...fm })!.errors;

// ---- Keys and views ----------------------------------------------------------------------------------

test("an unknown key one typo away from a key the view takes says which", () => {
  assert.deepEqual(errors({ panels: [{ view: "number", source: "s", lable: "spent" }] }), ['panel 1: unknown key "lable" (did you mean label?)']);
  assert.deepEqual(errors({ panels: [{ view: "table", source: "s", sotr: "-at" }] }), ['panel 1: unknown key "sotr" (did you mean sort?)']);
  // Nothing close: the key is only named.
  assert.deepEqual(errors({ panels: [{ view: "number", source: "s", colour: "red" }] }), ['panel 1: unknown key "colour"']);
});

test("an unknown view one typo away from a view says which; otherwise every view is listed", () => {
  assert.deepEqual(errors({ panels: [{ view: "tabel", source: "s" }] }), ['panel 1: "tabel" isn\'t a view (did you mean table?)']);
  assert.deepEqual(errors({ panels: [{ view: "gauge" }] }), [`panel 1: view must be one of ${VIEW_DEFS.map((d) => d.id).join(", ")}`]);
  assert.deepEqual(checkPanel({ view: "nubmer", source: "s" }, true).errors, ['"nubmer" isn\'t a view (did you mean number?)']);
});

test("a key the view doesn't take names the few views it works on", () => {
  assert.deepEqual(errors({ panels: [{ view: "number", source: "s", goal: 80 }] }), ['panel 1: "goal" doesn\'t apply to number; it works on line and bar']);
  assert.deepEqual(errors({ panels: [{ view: "line", source: "s", x: "at", y: "v", stack: true }] }), ['panel 1: "stack" doesn\'t apply to line; it works on bar']);
  // A key most views take reads better without a list of them.
  assert.deepEqual(errors({ panels: [{ view: "table", source: "s", unit: "kg" }] }), ['panel 1: "unit" doesn\'t apply to table']);
  // Each view's examples spell out checkPanel's own words, which stay as they are.
  assert.deepEqual(checkPanel({ view: "number", source: "s", goal: 80 }, true).errors, ['"goal" doesn\'t apply to number']);
});

test("an unknown key in a data block one typo away from a block key says which", () => {
  assert.deepEqual(errors({ data: { a: { sourse: "x", source: "a" } }, panels: [{ view: "table", source: "a" }] }), ['data.a: unknown key "sourse" (did you mean source?)']);
});

test("a typo is one letter changed, added, dropped or two swapped, and no more", () => {
  const names = ["amount", "category"];
  for (const word of ["amoutn", "amout", "amounts", "amaunt"]) assert.equal(nearMiss(word, names), "amount", word);
  for (const word of ["amt", "price", "amount"]) assert.equal(nearMiss(word, names), undefined, word);
});

// ---- Field names -------------------------------------------------------------------------------------

const BUDGET = {
  data: {
    spend: { source: "spend", fields: { amount: "number", category: ["food", "home"], note: "text" } },
    month: { source: "spend", where: { at: "this month" } },
  },
};

test("a field one typo away from a field of the block's fields is an error, and the panel still shows", () => {
  const r = readSpec({ app: "x", ...BUDGET, panels: [{ view: "number", source: "month", field: "amout", agg: "sum" }] })!;
  assert.deepEqual(r.errors, ['panel 1: field: "amout" isn\'t a field (did you mean amount?)']);
  assert.equal(r.spec!.panels.length, 1);
});

test("each key that names a field is checked: x, y, group, sort, columns and edit", () => {
  assert.deepEqual(errors({ ...BUDGET, panels: [
    { view: "bar", source: "spend", y: ["amonut"], group: "categroy", agg: "sum" },
    { view: "table", source: "spend", sort: "-dat", columns: ["at", "amount", "nots"], edit: ["amount", "nots"] },
    { view: "scatter", source: "spend", x: "amuont", y: "amount" },
  ] }), [
    'panel 1: y: "amonut" isn\'t a field (did you mean amount?)',
    'panel 1: group: "categroy" isn\'t a field (did you mean category?)',
    'panel 2: sort: "dat" isn\'t a field (did you mean -at?)',
    'panel 2: columns: "nots" isn\'t a field (did you mean note?)',
    'panel 2: edit: "nots" isn\'t a field (did you mean note?)',
    'panel 3: x: "amuont" isn\'t a field (did you mean amount?)',
  ]);
});

test("at, computed columns and a group's count and share are fields too", () => {
  assert.deepEqual(errors({ ...BUDGET, panels: [
    { view: "table", source: "spend", compute: { food: "if(category == 'food', amount, 0)" }, sort: "-at", columns: ["at", "food"] },
    { view: "table", source: "spend", group: "category", columns: ["category", "count"], sort: "-count" },
  ] }), []);
  // A computed column is a field others can be a typo of.
  assert.deepEqual(errors({ ...BUDGET, panels: [{ view: "table", source: "spend", compute: { left: "amount - 1" }, columns: ["lft"] }] }), ['panel 1: columns: "lft" isn\'t a field (did you mean left?)']);
});

test("without a block's fields, the fields the app's forms save into the list are its fields", () => {
  const form = { view: "form", fields: { value: "number", note: "text" }, save: "weight", label: "Log" };
  assert.deepEqual(errors({ panels: [form, { view: "number", source: "weight", field: "vlaue", agg: "last" }] }), ['panel 2: field: "vlaue" isn\'t a field (did you mean value?)']);
  // A button's row and a timer's minutes are saved fields too.
  const button = { view: "button", label: "Hydrate", save: "water", row: { glasses: 1 } };
  assert.deepEqual(errors({ panels: [button, { view: "number", source: "water", field: "glasess", agg: "sum" }] }), ['panel 2: field: "glasess" isn\'t a field (did you mean glasses?)']);
});

test("a field far from every known field, or exactly one, isn't an error", () => {
  const form = { view: "form", fields: { value: "number" }, save: "weight", label: "Log" };
  assert.deepEqual(errors({ panels: [form, { view: "number", source: "weight", field: "temperature", agg: "last" }] }), []);
  assert.deepEqual(errors({ panels: [form, { view: "number", source: "weight", field: "value", agg: "last" }] }), []);
});

test("rows no key describes are never checked: web, notes, files, and lists saved whole or recorded", () => {
  const near = { field: "amout", agg: "sum" };
  // Web rows, even with fields on their block.
  assert.deepEqual(errors({ data: { q: { source: "https://api.example.com/q", fields: { amount: "number" } } }, panels: [{ view: "number", source: "q", ...near }] }), []);
  // Notes rows.
  assert.deepEqual(errors({ data: { books: { source: "notes", from: "Books", fields: { amount: "number" } } }, panels: [{ view: "number", source: "books", ...near }] }), []);
  // A list nothing in the app saves into, with no fields: nothing is known of it.
  assert.deepEqual(errors({ panels: [{ view: "number", source: "spend", ...near }] }), []);
  // A row action without row saves the whole row it sits on, so the list holds whatever that had.
  const whole = { view: "list", source: "https://api.example.com/items", item: "{name}", action: "Keep", save: "spend" };
  const form = { view: "form", fields: { amount: "number" }, save: "spend", label: "Add" };
  assert.deepEqual(errors({ panels: [whole, form, { view: "number", source: "spend", ...near }] }), []);
  assert.deepEqual(errors({ ...BUDGET, panels: [whole, { view: "number", source: "spend", ...near }] }), []);
  // A recorded block fills its list with web rows.
  const recorded = { data: { kp: { source: "https://api.example.com/kp", record: "1h", into: "spend" } } };
  assert.deepEqual(errors({ ...recorded, panels: [form, { view: "number", source: "spend", ...near }] }), []);
});

test("with a store other apps may share, only a block's fields say what the rows hold", () => {
  const form = { view: "form", fields: { amount: "number" }, save: "spend", label: "Add" };
  assert.deepEqual(errors({ store: "[[Money]]", panels: [form, { view: "number", source: "spend", field: "amout", agg: "sum" }] }), []);
  assert.deepEqual(errors({ store: "[[Money]]", ...BUDGET, panels: [{ view: "number", source: "spend", field: "amout", agg: "sum" }] }), ['panel 1: field: "amout" isn\'t a field (did you mean amount?)']);
});

test("a field an input names is only known once it is picked, so it isn't checked", () => {
  const r = errors({ ...BUDGET, inputs: { what: ["amout", "amount"] }, panels: [{ view: "number", source: "spend", field: "$what", agg: "sum" }] });
  assert.deepEqual(r, []);
});

test("a component's panels are checked with their params filled in", () => {
  const kit = {
    component: "A tracker", params: { what: "weight" },
    panels: [
      { view: "form", fields: { value: "number" }, save: "$what", label: "Log" },
      { view: "number", source: "$what", field: "valeu", agg: "last" },
    ],
  };
  const notes = { resolve: (link: string) => (link === "Kit" ? "Kit.md" : undefined), frontmatter: (path: string) => (path === "Kit.md" ? kit : undefined) };
  const r = readSpec({ app: "x", use: "[[Kit]]", with: { what: "sleep" } }, { notes, path: "App.md" })!;
  assert.deepEqual(r.errors, ['[[Kit]] panel 2: field: "valeu" isn\'t a field (did you mean value?)']);
});

// ---- Suggestions of the app's own names ----------------------------------------------------------------

const MARK = "‸";

/**
 * What is offered at the ‸, with the note's keys read as YAML but for the line being typed, as
 * Obsidian last read them before it (a half-typed line often isn't YAML yet).
 */
function offered(snippet: string): string[] {
  const lines = snippet.split("\n");
  const line = lines.findIndex((l) => l.includes(MARK));
  const ch = lines[line].indexOf(MARK);
  lines[line] = lines[line].replace(MARK, "");
  const end = lines.lastIndexOf("---");
  const fm = parseYaml(lines.slice(1, end).filter((l, i) => i + 1 !== line && l.trim() !== "").join("\n")) as Record<string, unknown>;
  return suggestionsAt(lines, line, ch, () => fm)?.suggestions.map((s) => s.text) ?? [];
}

const NOTE = [
  "---",
  "app: Budget",
  "data:",
  "  spend:",
  "    source: spend",
  "    fields:",
  "      amount: number",
  "      category: [food, home]",
  "  month:",
  "    source: spend",
  "    compute:",
  "      double: amount * 2",
  "panels:",
  "  - view: form",
  "    save: spend",
  "  - view: button",
  "    label: Drank",
  "    save: water",
  "    row:",
  "      glasses: 1",
];

const note = (...panel: string[]) => [...NOTE, ...panel, "---"].join("\n");

test("after source:, the app's blocks and saved lists come first, then the kinds of source", () => {
  assert.deepEqual(offered(note("  - view: number", `    source: ${MARK}`)), ["spend", "month", "water", "notes", "tasks", "this", "expect", "asks"]);
  assert.deepEqual(offered(note("  - view: number", `    source: m${MARK}`)), ["month"]);
});

test("after a key that names a field, the fields of the rows the panel's source gives", () => {
  assert.deepEqual(offered(note("  - view: number", "    source: spend", `    field: ${MARK}`)), ["amount", "category", "at"]);
  assert.deepEqual(offered(note("  - view: number", "    source: month", `    field: ${MARK}`)), ["amount", "category", "double", "at"]);
  assert.deepEqual(offered(note("  - view: number", "    source: water", `    field: g${MARK}`)), ["glasses"]);
  // The source may be written after the key.
  assert.deepEqual(offered(note("  - view: table", `    sort: ${MARK}`, "    source: water")), ["glasses", "at"]);
  // A sort once its - is typed offers them high to low.
  assert.deepEqual(offered(note("  - view: table", "    source: spend", `    sort: -a${MARK}`)), ["-amount", "-at"]);
  // A source the app doesn't name has no fields to offer.
  assert.deepEqual(offered(note("  - view: number", "    source: https://api.example.com/x", `    field: ${MARK}`)), []);
});

test("in a list typed on one line, each item is offered the fields, its bracket closed or not", () => {
  assert.deepEqual(offered(note("  - view: table", "    source: spend", `    columns: [at, ${MARK}]`)), ["amount", "category", "at"]);
  assert.deepEqual(offered(note("  - view: table", "    source: spend", `    columns: [at, ca${MARK}`)), ["category"]);
  // A key that isn't a list of fields offers nothing inside brackets.
  assert.deepEqual(offered(note("  - view: table", "    source: spend", `    agg: [${MARK}`)), []);
});

test("a component's saves are named as it types them, params and all", () => {
  const names = appNames({ component: "Kit", params: { what: "weight" }, panels: [{ view: "form", fields: { value: "number", note: "text" }, save: "$what" }] });
  assert.deepEqual(names.sources, { $what: "A list this app saves into" });
  assert.deepEqual(Object.keys(names.fields.$what), ["value", "note", "at"]);
});
