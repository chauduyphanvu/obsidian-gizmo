import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { describePermission, permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { checkFlows, violationText } from "../src/flows.ts";
import { readPolicy } from "../src/policy.ts";
import { previewInstall } from "../src/bundle.ts";
import { parseYaml } from "./support/yaml.ts";
import { KEY_HINTS, suggestionsAt } from "../src/hints.ts";
import { KIND_KEYS } from "../src/store.ts";
import { kindDataPaths } from "../src/sources/kind.ts";
import { isKind, runsAsApp, withoutDefinition } from "../src/store.ts";
import { addLine } from "./support/addline.ts";
import { fakeBackground, fakeEnv, listsIn } from "./support/fakes.ts";

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const BUDGET = "Apps/Budget.md";
const TRIP = "Apps/Trip.md";

const SPEND = { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home", "travel"], memo: "text" } };
const BUDGET_FM = {
  app: "What I spend",
  panels: [
    { view: "form", title: "Spent", save: "[[Spend]]", label: "Add" },
    { view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum" },
  ],
};
const TRIP_FM = {
  app: "What the trip cost",
  panels: [{ view: "table", title: "Travel", source: "[[Spend]]", where: { category: "travel" }, columns: ["amount", "memo"], edit: ["memo"] }],
};

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

function vault(extra: Record<string, { fm: Record<string, unknown> }> = {}) {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, [BUDGET]: { fm: BUDGET_FM }, [TRIP]: { fm: TRIP_FM }, ...extra });
  const open = (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const c = new AppController(root, path, t.env);
    started.push(c);
    c.load();
    return root;
  };
  const spec = (path: string) => readSpec(t.f.files.get(path)!.fm, { notes: t.env.notes, path });
  return { ...t, open, spec };
}

test("a note with kind and fields is a kind; a note with only a property called kind stays a note", () => {
  assert.equal(isKind(SPEND), true);
  assert.equal(runsAsApp(SPEND), true);
  assert.equal(isKind({ kind: "book", author: "Le Guin" }), false);
  assert.equal(runsAsApp({ kind: "book" }), false);
  assert.equal(isKind({ kind: "spend", fields: ["amount"] }), false, "fields as a list isn't a schema");
  assert.equal(isKind({ app: "x", kind: "spend", fields: {} }), false, "an app stays an app");
  assert.equal(readSpec({ kind: "book" }), undefined);
});

test("data can set a property called kind, but never makes a note a kind", () => {
  assert.deepEqual(withoutDefinition({ title: "x", kind: "book" }), { title: "x", kind: "book" });
  assert.deepEqual(withoutDefinition({ title: "x", kind: "spend", fields: { a: "text" } }), { title: "x", kind: "spend" });
});

test("a kind note reads as an app: a line to add a row and its rows", () => {
  const t = vault();
  const r = t.spec(KIND)!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel.view), ["form", "table"]);
  assert.equal(r.spec!.panels[0].panel.shortcut, "spend");
  assert.deepEqual(permissionsOf(r.spec!, KIND), [], "its own rows need no permission");
});

test("a kind's name is letters, digits and _, and not a word an app already uses", () => {
  assert.deepEqual(readSpec({ kind: "my spend", fields: { a: "text" } })!.errors, ['kind: "my spend" can only use letters, digits and _']);
  assert.deepEqual(readSpec({ kind: "panels", fields: { a: "text" } })!.errors, ['kind can\'t be "panels", which names part of an app']);
  assert.deepEqual(readSpec({ kind: "notes", fields: { a: "text" } })!.errors, ['kind can\'t be "notes", which names a kind of source']);
});

test("an app asks to read a kind it links to, and to change it when it saves or edits", () => {
  const t = vault();
  const budget = t.spec(BUDGET)!;
  const trip = t.spec(TRIP)!;
  assert.deepEqual(budget.errors, []);
  assert.deepEqual(trip.errors, []);
  assert.deepEqual(permissionsOf(budget.spec!, BUDGET), [`kind-write:${KIND}`, `kind:${KIND}`]);
  assert.deepEqual(permissionsOf(trip.spec!, TRIP), [`kind-write:${KIND}`, `kind:${KIND}`]);
  assert.equal(describePermission(`kind:${KIND}`), "Read the rows of Spend");
  assert.equal(describePermission(`kind-write:${KIND}`), "Add and change rows of Spend");
  const reader = readSpec({ app: "r", view: "number", source: "[[Spend]]", field: "amount", agg: "sum" }, { notes: t.env.notes, path: "Apps/R.md" })!;
  assert.deepEqual(permissionsOf(reader.spec!, "Apps/R.md"), [`kind:${KIND}`]);
});

test("a link that names no kind is told, and the panel isn't drawn", () => {
  const t = vault();
  const missing = readSpec({ app: "x", view: "table", source: "[[Nope]]" }, { notes: t.env.notes, path: "Apps/X.md" })!;
  assert.deepEqual(missing.errors, ["can't find [[Nope]]"]);
  const plain = readSpec({ app: "x", panels: [{ view: "form", save: "[[Budget]]", fields: { a: "text" } }] }, { notes: t.env.notes, path: "Apps/X.md" })!;
  assert.deepEqual(plain.errors, ["panel 1: [[Budget]] isn't a kind (a kind note has kind: and fields:)"]);
});

test("a form takes the kind's fields, and a table its columns", () => {
  const t = vault();
  const form = t.spec(BUDGET)!.spec!.panels[0].panel;
  assert.deepEqual(form.schema, SPEND.fields);
  assert.deepEqual(form.target, { kind: "list", name: "spend", at: KIND });
  const table = readSpec({ app: "x", view: "table", source: "[[Spend]]" }, { notes: t.env.notes, path: "Apps/X.md" })!.spec!.panels[0].panel;
  assert.deepEqual(table.columns, ["amount", "category", "memo"]);
  assert.deepEqual(table.kind, { path: KIND, name: "spend" });
});

test("a row saved in one app shows in every app that reads the kind, and is kept beside the kind", async () => {
  const t = vault();
  const budget = t.open(BUDGET);
  const trip = t.open(TRIP);
  await settle();
  addLine(budget, "900 travel flight");
  await settle();
  addLine(budget, "14 food lunch");
  await settle();
  assert.match(text(budget), /914/);
  assert.deepEqual([...trip.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelector("td"))), ["900"]);
  const kept = listsIn(t.f.files.get(KIND_DATA)!.fm)!.spend as { amount: number; category: string }[];
  assert.deepEqual(kept.map((r) => [r.amount, r.category]), [[900, "travel"], [14, "food"]]);
  assert.equal(t.f.files.has("Apps/Budget data.md"), false, "nothing is kept in the app's own data note");
  assert.equal(t.f.files.has("Apps/Trip data.md"), false);
});

test("the kind's own note shows the rows every app saved", async () => {
  const t = vault();
  const budget = t.open(BUDGET);
  await settle();
  addLine(budget, "900 travel flight");
  await settle();
  const kind = t.open(KIND);
  await settle();
  assert.equal(kind.querySelectorAll("tbody tr").length, 1);
  addLine(kind, "20 home soap");
  await settle();
  assert.match(text(budget), /920/);
});

test("every reader hands the ledger the kind's own note, so they share one fold", async () => {
  const t = vault();
  const owners = new Set<unknown>();
  const ledger = t.data.ledger!;
  const state = ledger.state.bind(ledger);
  ledger.state = (path, fm, old) => {
    if (path === KIND_DATA) owners.add(fm);
    return state(path, fm, old);
  };
  const budget = t.open(BUDGET);
  t.open(TRIP);
  t.open(KIND);
  await settle();
  addLine(budget, "900 travel flight");
  await settle();
  assert.deepEqual([...owners], [t.f.files.get(KIND)!.fm]);
});

test("a kind's shortcut adds a row from a capture line, with no app in the vault", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  const preview = await t.bg.previewLine("spend 14 food lunch");
  assert.equal(preview.parsed.ok, true);
  const ran = await t.bg.capture("spend 14 food lunch");
  assert.equal(ran.ok, true);
  const kept = listsIn(t.f.files.get(KIND_DATA)!.fm)!.spend as { amount: number; category: string; memo: string }[];
  assert.deepEqual(kept.map((r) => [r.amount, r.category, r.memo]), [[14, "food", "lunch"]]);
});

test("an app's shortcut that saves to a kind writes the kind's rows, through the ledger", async () => {
  const fm = { app: "b", panels: [{ view: "form", save: "[[Spend]]", alias: "paid" }] };
  const t = fakeBackground({ [KIND]: { fm: { ...SPEND, shortcut: undefined } }, [BUDGET]: { fm } });
  await t.bg.start();
  const ran = await t.bg.capture("paid 900 travel flight");
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.deepEqual((listsIn(t.f.files.get(KIND_DATA)!.fm)!.spend as { amount: number }[]).map((r) => r.amount), [900]);
  assert.equal(t.f.files.has("Apps/Budget data.md"), false);
  assert.ok([...t.f.others.keys()].some((p) => p.startsWith("Kinds/Spend data/log/")), "kept as events beside the kind");
});

test("an app can't take a kind's data note as its store", () => {
  const t = vault({ [KIND_DATA]: { fm: {} } });
  const r = readSpec({ app: "x", store: "[[Spend data]]", view: "table", source: "spend" }, { notes: t.env.notes, path: "Apps/X.md" })!;
  assert.deepEqual(r.errors, ['store can\'t be Spend data, which holds the rows of Spend; read them with source: "[[Spend]]"']);
  const direct = readSpec({ app: "x", store: "[[Spend]]", view: "table", source: "spend" }, { notes: t.env.notes, path: "Apps/X.md" })!;
  assert.deepEqual(direct.errors, ['store can\'t be a kind note; read its rows with source: "[[Spend]]"']);
});

test("what another app saved to a kind is in the activity of every app that reads it, and of the kind", async () => {
  const t = vault();
  const budget = t.open(BUDGET);
  await settle();
  addLine(budget, "900 travel flight");
  await settle();
  const trip = t.spec(TRIP)!.spec!;
  assert.deepEqual(kindDataPaths(trip.panels), [KIND_DATA]);
  assert.deepEqual((await t.activity.list(TRIP)).length, 0, "without the kind's rows, Trip did nothing");
  const shared = await t.activity.list(TRIP, kindDataPaths(trip.panels));
  assert.deepEqual(shared.map((e) => [e.app, e.changes[0].kind]), [[BUDGET, "row-added"]]);
  assert.equal((await t.activity.list(KIND, [KIND_DATA])).length, 1);
});

test("a kind's rows carry the labels of the kind's notes into every app that reads them", () => {
  const t = vault();
  const policy = readPolicy({ labels: { "Kinds/**": "private" } }).policy!;
  const fm = { app: "b", panels: [{ view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum", pin: "status" }] };
  const spec = readSpec(fm, { notes: t.env.notes, path: BUDGET })!.spec!;
  const wanted = permissionsOf(spec, BUDGET);
  const v = checkFlows(spec, wanted, { policy, appPath: BUDGET, dataPath: "Apps/Budget data.md", hostPath: BUDGET, tags: () => [], thenTarget: () => undefined });
  assert.deepEqual(v.violations.map(violationText), ["Total: Spend.amount (private) → the status bar (personal)"]);
  assert.deepEqual(v.covered, [`kind:${KIND}`], "reading a kind is the policy's to judge, not a prompt's");
});

test("a kind note is offered its own keys, each with a hint", () => {
  for (const key of KIND_KEYS) assert.ok(KEY_HINTS[key], `no hint for ${key}`);
  const lines = ["---", "kind: spend", "fields: {amount: number}", "sh", "---"];
  assert.deepEqual(suggestionsAt(lines, 3, 2)?.suggestions.map((s) => s.text), ["shortcut", "share"]);
  const plain = ["---", "kind: book", "sh", "---"];
  assert.equal(suggestionsAt(plain, 2, 2), undefined, "a note with only a property called kind is offered nothing");
});

test("an app is shared and installed with the kinds it links to, never their rows", () => {
  const t = vault();
  assert.deepEqual(Object.keys(t.spec(BUDGET)!.spec!.read), [KIND], "the kind's note goes along, as a component's does");
  const app = { name: "Budget", text: '---\napp: What I spend\npanels:\n  - view: form\n    save: "[[Spend]]"\n---\n' };
  const kind = { name: "Spend", text: "---\nkind: spend\nfields: {amount: number, memo: text}\n---\n" };
  const p = previewInstall([app, kind], { folder: "Inbox", existing: () => [], notes: { resolve: () => undefined, frontmatter: () => undefined }, parse: parseYaml });
  assert.ok(!("error" in p));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.asks, ["Add and change rows of Spend", "Read the rows of Spend"]);
  assert.deepEqual(p.extras, ["Spend is a kind: its rows start empty, and any app here can read and add to them"]);
});

test("a data block can read a kind, and a form that saves to the block adds to the kind", async () => {
  const fm = {
    app: "b",
    data: { spend: { source: "[[Spend]]" }, travel: { source: "spend", where: { category: "travel" } } },
    panels: [{ view: "form", save: "spend", label: "Add" }, { view: "number", title: "Travel", source: "travel", field: "amount", agg: "sum" }],
  };
  const t = vault({ [BUDGET]: { fm } });
  const r = t.spec(BUDGET)!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels[0].panel.target, { kind: "list", name: "spend", at: KIND });
  assert.deepEqual(r.spec!.panels[0].panel.schema, SPEND.fields);
  assert.deepEqual(permissionsOf(r.spec!, BUDGET), [`kind-write:${KIND}`, `kind:${KIND}`]);
  const budget = t.open(BUDGET);
  await settle();
  addLine(budget, "900 travel flight");
  await settle();
  addLine(budget, "14 food lunch");
  await settle();
  assert.match(text(budget), /Travel900/);
  assert.equal((listsIn(t.f.files.get(KIND_DATA)!.fm)!.spend as unknown[]).length, 2);
});

test("a row value that can't be a number, for a number field of the kind or block a panel saves to, is an error on the panel", () => {
  const t = vault();
  const errors = (row: Record<string, string>, more: Record<string, unknown> = {}) =>
    readSpec({ app: "x", panels: [{ view: "form", save: "[[Spend]]", fields: { what: "text", n: "number", when: "date" }, row, ...more }] }, { notes: t.env.notes, path: "Apps/X.md" })!.errors;
  assert.deepEqual(errors({ amount: "lunch" }), ['panel 1: row.amount: amount is a number field, and "lunch" isn\'t a number']);
  assert.deepEqual(errors({ amount: "{n} each" }), ['panel 1: row.amount: amount is a number field, and "{n} each" can\'t be a number']);
  assert.deepEqual(errors({ amount: "{when}" }), ['panel 1: row.amount: amount is a number field, and "{when}" can\'t be a number']);
  assert.deepEqual(errors({ amount: "{date}" }), ['panel 1: row.amount: amount is a number field, and "{date}" can\'t be a number']);
  for (const fine of ["12", "1,200.50", "{n}", "{what}", "-{n}", "=n * 2", "$this.price", "{n}{n}"]) assert.deepEqual(errors({ amount: fine }), [], fine);
  assert.deepEqual(errors({ memo: "lunch", category: "food" }), [], "only number fields are checked");
  const block = (row: Record<string, string>, data: Record<string, unknown>) => readSpec({ app: "x", data, panels: [{ view: "button", label: "Lift", save: "log", row }] }, { path: "Apps/X.md" })!.errors;
  assert.deepEqual(block({ kg: "heavy" }, { log: { source: "log", fields: { kg: "number" } } }), ['panel 1: row.kg: kg is a number field, and "heavy" isn\'t a number']);
  assert.deepEqual(block({ kg: "heavy" }, {}), [], "a list with no fields declares nothing");
  const other = readSpec({
    app: "x", data: { lifts: { source: "lifts", fields: { kg: "number" } } },
    panels: [{ view: "table", source: "lifts", action: "Keep", save: "kept", row: { kg: "heavy" } }],
  }, { path: "Apps/X.md" })!;
  assert.deepEqual(other.errors, [], "the fields of the rows it reads say nothing of the list it saves to");
});

test("a value known only when the row is saved must be a number for a number field: numeric text is saved as a number, other text refuses the save", async () => {
  const app = { app: "p", panels: [{ view: "form", title: "Paid", alias: "paid", save: "[[Spend]]", fields: { what: "text" }, row: { amount: "{what}", memo: "{what}" } }] };
  const t = fakeBackground({ [KIND]: { fm: SPEND }, "Apps/P.md": { fm: app } });
  await t.bg.start();
  const refused = await t.bg.capture("paid lunch");
  assert.deepEqual([refused.ok, refused.error], [false, "“Paid” didn't run: amount must be a number, not “lunch”"]);
  assert.deepEqual(await t.env.store!(KIND_DATA, KIND).rows("spend"), []);
  assert.ok((await t.bg.capture("paid 12.5")).ok);
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => [r.amount, r.memo]), [[12.5, "12.5"]]);
});
