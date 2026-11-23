import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteReader } from "../src/expand.ts";
import { carriedOps, convertible, planKind, yamlInline } from "../src/kind-convert.ts";
import { ROW_ID } from "../src/ledger-store.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import gallery from "../scripts/gallery-notes.ts";
import { parseYaml } from "./support/yaml.ts";

/** Budget as the gallery wrote it while it kept its own list, before it saved into the Spend kind. */
const BUDGET = [
  "---",
  "app: Log what I spend and get told when the month runs past my limit",
  "data:",
  "  spend:",
  "    source: spend",
  "    fields:",
  "      amount: {type: number, label: Spent, format: \"$0,0.00\"}",
  "      category: [food, home, transport, fun, other]",
  "      note: text",
  "  month:",
  "    source: spend",
  "    where: {at: this month}",
  "panels:",
  "  - view: form",
  "    title: Spent something",
  "    save: spend",
  "    label: Add",
  "    alias: spend",
  "  - view: number",
  "    title: This month",
  "    source: month",
  "    field: amount",
  "    agg: sum",
  "    compare: previous",
  "    label: spent so far",
  "    shortcut: spent",
  "  - view: progress",
  "    title: Against my limit",
  "    source: month",
  "    field: amount",
  "    agg: sum",
  "    max: 2000",
  "    format: \"$0,0\"",
  "    alert: \">= 2000\"",
  "  - view: bar",
  "    title: Each week against my budget",
  "    source: spend",
  "    compute:",
  "      food: if(category == 'food', amount, 0)",
  "      home: if(category == 'home', amount, 0)",
  "      transport: if(category == 'transport', amount, 0)",
  "      fun: if(category == 'fun', amount, 0)",
  "      other: if(category == 'other', amount, 0)",
  "    where: {at: last 8 weeks}",
  "    group: at",
  "    per: week",
  "    y: [food, home, transport, fun, other]",
  "    agg: sum",
  "    stack: true",
  "    goal: 500",
  "    format: \"$0,0\"",
  "    labels: {food: Food, home: Home, transport: Transport, fun: Fun, other: Other}",
  "  - view: table",
  "    title: Recent",
  "    source: spend",
  "    sort: -at",
  "    limit: 10",
  "    columns: [at, amount, category, note]",
  "    labels: {at: When}",
  "    format: {at: relative}",
  "    edit: true",
  "---",
  "Add each purchase as you make it. You get a notice once the month's total reaches the limit (the",
  "2000 in `max` and `alert`), and the bars stack each week by category against the `goal` line;",
  "change those numbers to your own budget, and fix a wrong amount or category in the table. The link",
  "\"Copy link to an app shortcut\" gives for This month answers with what you've spent so far, for a",
  "phone shortcut to read out. That is all it asks for; entries are saved in Budget data.",
  "",
].join("\n");

const NONE: NoteReader = { resolve: () => undefined, frontmatter: () => undefined };
const fmOf = (text: string) => parseYaml(text.split("\n").slice(1, text.split("\n").indexOf("---", 1)).join("\n")) as Record<string, unknown>;

function plan(appPath: string, appText: string, list: string, taken: string[] = [], notes = NONE) {
  const fm = fmOf(appText);
  const spec = readSpec(fm, { notes, path: appPath })!.spec!;
  return planKind({ appPath, appText, fm, spec, list, notes, parse: parseYaml, taken: (p) => taken.includes(p) });
}

test("values are typed the way the gallery types them, quoted only when YAML would read them as something else", () => {
  assert.equal(yamlInline({ type: "number", label: "Spent", format: "$0,0.00" }), '{type: number, label: Spent, format: "$0,0.00"}');
  assert.equal(yamlInline(["food", "to read", "yes", "a: b"]), '[food, to read, "yes", "a: b"]');
  assert.equal(yamlInline({ default: 2, on: true }), '{default: 2, "on": true}');
});

test("Budget's spend becomes a kind: its fields go to the kind note, and only the block that reads the list changes", () => {
  const p = plan("Apps/Budget.md", BUDGET, "spend");
  assert.ok(!("error" in p), JSON.stringify(p));
  assert.equal(p.path, "Apps/Spend.md");
  assert.deepEqual(fmOf(p.text), {
    kind: "spend",
    fields: { amount: { type: "number", label: "Spent", format: "$0,0.00" }, category: ["food", "home", "transport", "fun", "other"], note: "text" },
  });
  assert.deepEqual(p.changed.map((c) => [c.from.trim(), c.to.trim()]), [["source: spend", 'source: "[[Spend]]"']], "month reads the spend block, so it stays");
  // The panels still name the blocks; the form's `save: spend` saves through the block, into the kind.
  assert.match(p.appText, /save: spend\n/);
  const notes: NoteReader = { resolve: (l) => (l === "Spend" ? p.path : undefined), frontmatter: (path) => (path === p.path ? fmOf(p.text) : undefined) };
  const after = readSpec(fmOf(p.appText), { notes, path: "Apps/Budget.md" })!;
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.spec!.panels[0].panel.target, { kind: "list", name: "spend", at: "Apps/Spend.md" });
  assert.ok(permissionsOf(after.spec!, "Apps/Budget.md").includes("kind-write:Apps/Spend.md"));
});

test("with no block of that name, the panels' own source and save point at the kind", () => {
  const text = "---\napp: Chores\npanels:\n  - view: form\n    fields: {task: text, who: [me, you]}\n    save: chores\n  - view: table\n    source: chores\n---\nBody\n";
  const p = plan("Chores.md", text, "chores", ["Chores.md"]);
  assert.ok(!("error" in p), JSON.stringify(p));
  assert.equal(p.path, "Chores rows.md", "the app has the name, so the kind is its rows");
  assert.deepEqual(p.changed.map((c) => c.to), ['    save: "[[Chores rows]]"', '    source: "[[Chores rows]]"']);
  assert.match(p.text, /^---\nkind: chores\nfields:\n {2}task: text\n {2}who: \[me, you\]\n---\n/);
  assert.ok(p.appText.endsWith("---\nBody\n"));
});

test("what can't be done safely is said, and nothing is offered", () => {
  const flow = "---\napp: Chores\npanels:\n  - {view: form, fields: {task: text}, save: chores}\n---\n";
  const p = plan("Apps/Chores.md", flow, "chores");
  assert.ok("error" in p);
  assert.match(p.error, /aren't each on a line of their own/);
  const ticks = "---\napp: Pack\nview: checklist\nitems: [socks]\nsave: packed\n---\n";
  assert.deepEqual(convertible(readSpec(fmOf(ticks))!.spec!), [], "a checklist's ticks aren't rows");
  const none = plan("Apps/Chores.md", "---\napp: c\npanels:\n  - view: button\n    label: Did it\n    save: done\n---\n", "done");
  assert.ok("error" in none);
  assert.match(none.error, /^no fields describe the rows of done/);
  const kit = gallery.find((n) => n.path === "Apps/Practice.md")!;
  const notes: NoteReader = {
    resolve: (l) => gallery.find((n) => n.path.endsWith(`/${l}.md`))?.path,
    frontmatter: (path) => { const n = gallery.find((g) => g.path === path); return n && fmOf(n.text); },
  };
  const w = plan("Apps/Practice.md", kit.text, "practice", [], notes);
  assert.ok("error" in w);
  assert.match(w.error, /come from a component/);
});

test("a list with a field called line, matched or by can't become a kind until the field is renamed", () => {
  const text = "---\napp: Runs\npanels:\n  - view: form\n    save: runs\n    fields: {km: number, line: text}\n---\n";
  assert.deepEqual(plan("Apps/Runs.md", text, "runs"), { error: 'fields can\'t have "line": Gizmo keeps line, matched, by, writer, imported on each row of a kind; rename that field of runs first' });
});

test("the rows carried into a new kind keep their ids, and leave behind any field Gizmo keeps on a kind's rows", () => {
  const a = { amount: 5, memo: "Coffee", line: "planned", matched: "x", by: "Mai", writer: "aaaaaaaaaaaaaaaa" };
  Object.defineProperty(a, ROW_ID, { value: "r1" });
  let n = 0;
  assert.deepEqual(carriedOps("spend", [a, { amount: 7 }], () => `new${++n}`), [
    { op: "add", l: "spend", row: "r1", v: { amount: 5, memo: "Coffee" } },
    { op: "add", l: "spend", row: "new1", v: { amount: 7 } },
  ]);
});
