import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runActions, type ActionDeps } from "../src/actions.ts";
import { AppController } from "../src/app.ts";
import type { NoteReader } from "../src/expand.ts";
import { checkFlows, violationText, type FlowContext } from "../src/flows.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readPolicy } from "../src/policy.ts";
import { readSpec, resolvePanel, type AppSpec } from "../src/spec.ts";
import { addLine, said } from "./support/addline.ts";
import { fakeBackground, fakeEnv, savedAt } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12, 0);
const APP = "Apps/Trip.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

const reader = (notes: Record<string, Record<string, unknown>>): NoteReader => ({
  resolve: (l) => (`${l}.md` in notes ? `${l}.md` : undefined),
  frontmatter: (p) => notes[p],
});

const FORM = {
  view: "form", title: "Spent abroad", save: "spend", label: "Add",
  fields: { item: "text", yen: "number" },
  row: { item: "{item}", yen: "{yen}", dollars: "=round(yen / $this.rate, 2)" },
};
const TRIP = { app: "t", rate: 150, panels: [FORM] };

function specOf(fm: Record<string, unknown>, notes: Record<string, Record<string, unknown>> = {}): { spec?: AppSpec; errors: string[] } {
  return readSpec(fm, { now: NOW, path: APP, notes: reader(notes) })!;
}

/** Deps that keep what a run saves in `data`. */
function deps() {
  const data: Record<string, unknown> = {};
  const told: string[] = [];
  const d: ActionDeps = {
    now: () => NOW, dataPath: "Apps/Trip data.md", appPath: APP,
    writeFrontmatter: async (_path, fn) => { fn(data); },
    appendLine: async () => {}, createNote: async () => true, readBody: async () => "",
    notify: (m) => { told.push(m); }, openNote: () => {},
  };
  return { d, data, told };
}

test("a row value that starts with = is a formula, worked out from the form's fields and $this when the row is saved", async () => {
  const r = specOf(TRIP);
  assert.deepEqual(r.errors, []);
  const p = resolvePanel(r.spec!.panels[0], { this: { rate: 150 } }).panel!;
  const { d, data } = deps();
  assert.equal((await runActions({ ...p, notify: "{dollars} for {item}" }, { item: "ramen", yen: 1200 }, d)).ok, true);
  assert.deepEqual(data.spend, [{ item: "ramen", yen: 1200, dollars: 8, at: savedAt("2026-11-18T12:00") }]);
  const other = resolvePanel(r.spec!.panels[0], { this: { rate: 160 } }).panel!;
  const again = deps();
  await runActions(other, { item: "train", yen: 500 }, again.d);
  assert.equal((again.data.spend as Record<string, unknown>[])[0].dollars, 3.13, "the note's rate as it is now");
});

test("a row formula that works out to nothing refuses the save, naming the field and what it reads that is empty", async () => {
  const r = specOf(TRIP);
  const p = (rate: unknown) => resolvePanel(r.spec!.panels[0], { this: rate === undefined ? {} : { rate } }).panel!;
  const missing = deps();
  const res = await runActions(p(undefined), { item: "ramen", yen: 1200 }, missing.d);
  assert.deepEqual([res.ok, res.error], [false, "dollars works out to nothing, since $this.rate has no value"]);
  assert.deepEqual(missing.told, ["Not saved: dollars works out to nothing, since $this.rate has no value"]);
  assert.equal(missing.data.spend, undefined, "nothing saved");
  const zero = deps();
  const byZero = await runActions(p(0), { item: "ramen", yen: 1200 }, zero.d);
  assert.deepEqual([byZero.ok, byZero.error], [false, "dollars works out to nothing (=round(yen / $this.rate, 2))"]);
  assert.equal(zero.data.spend, undefined);
  const blank = deps();
  assert.equal((await runActions(p(150), { item: "ramen" }, blank.d)).error, "dollars works out to nothing, since yen has no value");
  // Text that works out empty is still text, and is saved.
  const text = specOf({ app: "t", panels: [{ view: "form", save: "spend", fields: { item: "text" }, row: { label: "=trim(item)" } }] });
  const saved = deps();
  assert.equal((await runActions(text.spec!.panels[0].panel, { item: "" }, saved.d)).ok, true);
  assert.equal((saved.data.spend as Record<string, unknown>[])[0].label, "");
});

test("a dry run shows the same refusal, and saves nothing", async () => {
  const t = fakeBackground({ [APP]: { fm: { app: "t", panels: [{ ...FORM, shortcut: "spent" }] } } });
  await t.bg.start();
  assert.deepEqual(await t.bg.previewLine("spent ramen 1200").then((r) => r.effects), ["Tell you: “Add” didn't run: dollars works out to nothing, since $this.rate has no value"]);
  assert.equal(t.f.files.get("Apps/Trip data.md"), undefined);
});

test("only a value that starts with = is a formula: every other value keeps its meaning", async () => {
  const r = specOf({
    app: "t", rate: 150,
    panels: [{
      view: "form", save: "spend", fields: { yen: "number" },
      row: { yen: "{yen}", said: "1 = 1", rate: "$this.rate", label: "{yen} yen", text: '="=== a heading"', fixed: "=2 * 3" },
    }],
  });
  assert.deepEqual(r.errors, []);
  const p = resolvePanel(r.spec!.panels[0], { this: { rate: 150 } }).panel!;
  const { d, data } = deps();
  await runActions(p, { yen: 900 }, d);
  assert.deepEqual(data.spend, [{ yen: 900, said: "1 = 1", rate: 150, label: "900 yen", text: "=== a heading", fixed: 6, at: savedAt("2026-11-18T12:00") }]);
});

test("a row formula reads an input, the time of the row, and a component's params where the component typed it", async () => {
  const r = specOf({
    app: "t", inputs: { rate: [150, 160] },
    panels: [
      { view: "form", save: "spend", fields: { yen: "number" }, row: { dollars: "=yen / $rate", day: "=date(at)" } },
      { use: "[[Kit]]", with: { rate: 100 } },
    ],
  }, { "Kit.md": { component: "k", params: { rate: null }, panels: [{ view: "form", save: "spend", fields: { yen: "number" }, row: { dollars: "=yen / $rate" } }] } });
  assert.deepEqual(r.errors, []);
  const [own, kit] = r.spec!.panels;
  assert.deepEqual(own.inputs, ["rate"]);
  const first = deps();
  await runActions(resolvePanel(own, { rate: 160 }).panel!, { yen: 800 }, { ...first.d, at: new Date(2026, 10, 17, 9, 0) });
  assert.deepEqual(first.data.spend, [{ dollars: 5, day: "2026-11-17", at: savedAt("2026-11-17T09:00") }]);
  assert.deepEqual(kit.inputs, [], "a param typed in the app is fixed");
  const second = deps();
  await runActions(kit.panel, { yen: 800 }, second.d);
  assert.equal((second.data.spend as Record<string, unknown>[])[0].dollars, 8);
});

test("a row formula is checked with the app: a function, a name, a field or prev it can't use stops the panel", () => {
  const form = (dollars: string) => specOf({ app: "t", panels: [{ ...FORM, row: { item: "{item}", dollars } }] });
  const cases: [string, string][] = [
    ["=rond(yen / $this.rate)", 'panel 1: row.dollars: unknown function "rond"'],
    ["=yen / ", "panel 1: row.dollars: the formula ends where a value should be"],
    ["=yen / $rat", "panel 1: row.dollars: $rat isn't an input or param"],
    ["=yen - prev(yen)", "panel 1: row.dollars: prev reads the row before, and a row being saved has none"],
    ["=round(yn / $this.rate, 2)", 'panel 1: row.dollars: "yn" isn\'t a field of the form (did you mean yen?)'],
    ["=cost * 2", 'panel 1: row.dollars: "cost" isn\'t a field of the form; it has item, yen, date, time and at'],
  ];
  for (const [dollars, error] of cases) {
    const r = form(dollars);
    assert.deepEqual(r.errors, [error], dollars);
    assert.equal(r.spec!.panels.length, 0, `${dollars}: the panel would save the wrong row, so it isn't drawn`);
  }
  const button = specOf({ app: "t", panels: [{ view: "button", label: "Coffee", save: "spend", row: { amount: "=price" } }] });
  assert.deepEqual(button.errors, ['panel 1: row.amount: "price" isn\'t a field here; a button\'s row has only date, time and at']);
  const action = specOf({ app: "t", panels: [{ view: "table", source: "s", action: "Keep", save: "kept", row: { twice: "=price * 2" } }] });
  assert.deepEqual(action.errors, [], "a row action's row holds whatever its source gives");
});

test("a row formula can't choose where a row is saved: the app asks for exactly what it asks for without one", () => {
  const plain = specOf({ ...TRIP, panels: [{ ...FORM, row: { item: "{item}", yen: "{yen}" } }] }).spec!;
  assert.deepEqual(permissionsOf(specOf(TRIP).spec!, APP), permissionsOf(plain, APP));
  const kind = { "Spend.md": { kind: "spend", fields: { amount: "number", note: "text" } } };
  const toKind = specOf({ app: "t", rate: 150, panels: [{ view: "form", save: "[[Spend]]", fields: { yen: "number" }, row: { amount: "=yen / $this.rate" } }] }, kind);
  assert.deepEqual(toKind.errors, []);
  assert.deepEqual(permissionsOf(toKind.spec!, APP), ["kind-write:Spend.md", "kind:Spend.md"]);
});

test("the data policy labels a formula's value by what it reads, as it labels a compute column", () => {
  const policy = readPolicy({ labels: { "Health/**": "private" } }).policy!;
  const flows = (row: Record<string, string>) => {
    const spec = readSpec({ app: "l", panels: [{ view: "form", title: "Took", fields: { n: "number" }, save: "doses", row }] }, { now: NOW, path: "Apps/Lens.md" })!.spec!;
    const ctx: FlowContext = { policy, appPath: "Apps/Lens.md", dataPath: "Apps/Lens data.md", hostPath: "Health/Meds.md", tags: () => [], thenTarget: () => undefined };
    return checkFlows(spec, permissionsOf(spec, "Apps/Lens.md"), ctx).violations.map(violationText);
  };
  assert.deepEqual(flows({ mg: "=n * $this.mg" }), ["Took: what you type: mg (private) → Lens data (personal)"]);
  assert.deepEqual(flows({ mg: "$this.mg" }), flows({ mg: "=n * $this.mg" }), "the same as the property saved as it is");
  assert.deepEqual(flows({ mg: "=n * 2" }), [], "what is typed is public unless the policy says");
  const log = readSpec({ app: "g", panels: [{ view: "form", shortcut: "log", fields: { med: "text" }, save: "doses", row: { twice: "=med + med", plain: "=1" } }] }, { now: NOW, path: "Apps/Log.md" })!.spec!;
  const watch = readSpec({
    app: "w", panels: [{ view: "number", title: "Due", source: "notes", from: "Health", alert: { due: "past" }, then: { app: "[[Log]]", do: "log", fill: { med: "{med}" } } }],
  }, { now: NOW, path: "Apps/Watch.md" })!.spec!;
  const released = readPolicy({ labels: { "Health/**": "private" }, release: [{ app: "Apps/Watch", panel: "Due", to: ["notify"] }] }).policy!;
  const ctx: FlowContext = {
    policy: released, appPath: "Apps/Watch.md", dataPath: "Apps/Watch data.md", hostPath: "Apps/Watch.md", tags: () => [],
    thenTarget: () => ({ path: "Apps/Log.md", dataPath: "Apps/Log data.md", spec: log }),
  };
  assert.deepEqual(checkFlows(watch, permissionsOf(watch, "Apps/Watch.md"), ctx).violations.map(violationText), [
    "Due: notes in Health: med (private) → Log (through then) (personal)",
  ], "through then, a formula that reads a filled field carries its label");
});

test("a dry run, and the add line's notice, show the value the formula works out", async () => {
  const t = fakeBackground({ [APP]: { fm: { ...TRIP, panels: [{ ...FORM, shortcut: "spent", row: { dollars: "=round(yen / $this.rate, 2)", item: "{item}" } }] } } });
  await t.bg.start();
  assert.deepEqual(await t.bg.previewLine("spent ramen 1200").then((r) => r.effects), ["Save dollars 8, item ramen to spend in Trip data"]);
  const env = fakeEnv({ [APP]: { fm: { ...TRIP, panels: [{ ...FORM, notify: "Spent ${dollars}" }] } } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, APP, env.env);
  started.push(c);
  c.load();
  await settle();
  addLine(root, "ramen 1200");
  await settle();
  assert.equal(said(root), "Spent $8");
  assert.deepEqual((await env.env.store!("Apps/Trip data.md", APP).rows("spend")).map((r) => r.dollars), [8]);
});
