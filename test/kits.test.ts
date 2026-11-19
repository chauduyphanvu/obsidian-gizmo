import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import type { NoteReader } from "../src/expand.ts";
import { askersOf, permissionsOf, readSpec, resolvePanel } from "../src/spec.ts";
import { fakeEnv } from "./support/fakes.ts";

// Kits: a component param typed literally (its default, or a `with` value holding no `$name`) may
// say what the app reads and writes; one that carries a run-time value (an input, a selection,
// `$this`, or a param that carries one) may not. Permissions are those of the expanded app.

const APP = "Apps/Mine.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** A whole app as a component: a folder of notes, a form that adds one, a table that changes them. */
const KIT = {
  component: "Keep notes in a folder, add one, and mark how each went",
  params: { folder: "Decisions" },
  data: { items: { source: "notes", from: "$folder", fields: { outcome: { type: ["open", "right"], default: "open" } } } },
  panels: [
    { view: "form", title: "Add", fields: { name: "text" }, save: "items" },
    { view: "table", title: "All", source: "items", edit: ["outcome"] },
  ],
};

/** A component that uses the kit, passing on what it is given. */
const OUTER = {
  component: "o",
  params: ["dir"],
  panels: [{ use: "[[Kit]]", with: { folder: "$dir" } }],
};

function reader(notes: Record<string, Record<string, unknown>>): NoteReader {
  return {
    resolve: (link) => Object.keys(notes).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
    frontmatter: (path) => notes[path],
  };
}

const COMPONENTS = { "Components/Kit.md": KIT, "Components/Outer.md": OUTER };
const read = (fm: Record<string, unknown>, notes: Record<string, Record<string, unknown>> = COMPONENTS) =>
  readSpec({ app: "x", ...fm }, { notes: reader(notes), path: APP, now: new Date(2026, 10, 18) })!;

test("a kit's folder typed in with, or its default, settles what it reads, creates and changes; the prompt names the kit", () => {
  const own = read({ use: "[[Kit]]" });
  assert.deepEqual(own.errors, []);
  assert.deepEqual(permissionsOf(own.spec!, APP), ["create:Decisions", "edit:Decisions", "read:Decisions"]);
  const bets = read({ use: "[[Kit]]", with: { folder: "Bets" } });
  assert.deepEqual(bets.errors, []);
  assert.deepEqual(permissionsOf(bets.spec!, APP), ["create:Bets", "edit:Bets", "read:Bets"]);
  for (const perm of permissionsOf(bets.spec!, APP)) assert.deepEqual([...askersOf(bets.spec!, APP).get(perm)!], ["Components/Kit.md"], perm);
  assert.deepEqual(bets.spec!.panels.map((ps) => [ps.panel.from, ps.panel.target]), [
    [undefined, { kind: "folder", folder: "Bets" }],
    ["Bets", undefined],
  ]);
  // Passed through a component that uses the kit, a typed value is still typed text.
  const nested = read({ panels: [{ use: "[[Outer]]", with: { dir: "Bets" } }] });
  assert.deepEqual(nested.errors, []);
  assert.deepEqual(permissionsOf(nested.spec!, APP), ["create:Bets", "edit:Bets", "read:Bets"]);
});

test("a with value fed by an input, a selection or $this can't choose where a kit reads or writes", () => {
  // Told once, though both panels read and write through the block's from.
  assert.deepEqual(read({ inputs: { q: ["Bets", "Decisions"] }, use: "[[Kit]]", with: { folder: "$q" } }).errors, [
    'with.folder: an input can\'t choose what "from" reads; type the value itself',
    'input "q" isn\'t used by any panel',
  ]);
  assert.deepEqual(read({ inputs: { q: "text" }, panels: [{ use: "[[Kit]]", with: { folder: "Notes/$q" } }] }).errors.slice(0, 1), [
    'panel 1: with.folder: an input can\'t choose what "from" reads; type the value itself',
  ]);
  const picked = read({
    panels: [
      { view: "list", source: "notes", from: "Projects", select: "pick" },
      { use: "[[Kit]]", with: { folder: "$pick.folder" } },
    ],
  });
  assert.deepEqual(picked.errors.slice(0, 1), ['panel 2: with.folder: a selection can\'t choose what "from" reads; type the value itself']);
  assert.deepEqual(read({ use: "[[Kit]]", with: { folder: "$this.folder" } }).errors, ['with.folder: $this can\'t choose what "from" reads; type the value itself']);
});

test("a run-time value passed on through a component is told where it came in", () => {
  // The app's input reaches the kit through Outer: the app's with is where it came in.
  const r = read({ inputs: { q: ["Bets"] }, panels: [{ use: "[[Outer]]", with: { dir: "$q" } }] });
  assert.deepEqual(r.errors, ['panel 1: with.dir: an input can\'t choose what "from" reads; type the value itself', 'input "q" isn\'t used by any panel']);
  // A component that hands the kit its own selection, or the note it sits in, is where that came in.
  const picking = {
    component: "p",
    panels: [{ view: "list", source: "notes", from: "Projects", select: "pick" }, { use: "[[Kit]]", with: { folder: "$pick.folder" } }],
  };
  const self = { component: "s", panels: [{ use: "[[Kit]]", with: { folder: "$this.folder" } }] };
  const notes = { ...COMPONENTS, "Components/Picking.md": picking, "Components/Self.md": self };
  assert.deepEqual(read({ use: "[[Picking]]" }, notes).errors.slice(0, 1), [
    '[[Picking]] panel 2: with.folder: a selection can\'t choose what "from" reads; type the value itself',
  ]);
  assert.deepEqual(read({ panels: [{ use: "[[Self]]" }] }, notes).errors.slice(0, 1), [
    'panel 1 (from [[Self]] panel 1): with.folder: $this can\'t choose what "from" reads; type the value itself',
  ]);
});

test("a literal param still can't name a secret or go in view, or anywhere a name never goes", () => {
  const component = (panels: Record<string, unknown>[], params: Record<string, unknown> = { key: "demo", kind: "number", f: "outcome" }) =>
    ({ "Components/K.md": { component: "k", params, panels } });
  const errors = (panels: Record<string, unknown>[], params?: Record<string, unknown>) => read({ use: "[[K]]" }, component(panels, params)).errors;
  assert.deepEqual(errors([{ view: "number", source: "https://api.example.com/v1?k={secret:$key}" }]), ["[[K]] panel 1: $key can't name a secret"]);
  assert.deepEqual(errors([{ view: "number", source: "https://api.example.com/v1", headers: { authorization: "Bearer {secret:$key}" } }]), ["[[K]] panel 1: $key can't name a secret"]);
  // Nor finish a placeholder the component began, with text of its own.
  const half = { base: "https://api.example.com/v1?k=", key: "secret:demo}" };
  assert.deepEqual(errors([{ view: "number", source: "$base{$key" }], half), ["[[K]] panel 1: $key can't name a secret"]);
  assert.deepEqual(errors([{ view: "number", source: "https://api.example.com/v1", headers: { authorization: "Bearer {$key" } }], half), ["[[K]] panel 1: $key can't name a secret"]);
  assert.deepEqual(errors([{ view: "number", source: "$base{secret:demo}" }], half), []);
  assert.deepEqual(errors([{ view: "$kind", source: "doses" }]), ['[[K]] panel 1: $kind can\'t be used in "view"']);
  assert.deepEqual(errors([{ view: "table", source: "notes", from: "X", columns: ["outcome"], edit: ["$f"] }]), ['[[K]] panel 1: $f can\'t be used in "edit"']);
  assert.deepEqual(errors([{ view: "number", source: "doses", pin: "$kind" }]), ['[[K]] panel 1: $kind can\'t be used in "pin"']);
  // Its value can't carry a secret or a line break in, whether typed in with or as the default.
  assert.deepEqual(read({ use: "[[K]]", with: { key: "{secret:demo}" } }, component([{ view: "number", source: "https://a.example.com/$key" }])).errors,
    ["with.key can't hold a secret or a line break"]);
  assert.deepEqual(errors([{ view: "number", source: "doses" }], { key: "a\nb" }), ['[[K]]: param "key" can\'t hold a secret or a line break']);
});

test("a literal param may name a URL's host, a vault file, a base, a template, a note to add to and a tab", () => {
  const notes = {
    "Components/Site.md": {
      component: "s",
      params: { host: "api.example.com", file: "Finance/My bank.csv", folder: "My Finance", base: "Books", daily: "Daily", where: "Money" },
      panels: [
        { view: "number", source: "https://$host/v1/rate", tab: "$where" },
        { view: "table", source: "$file" },
        { view: "table", source: "$folder/bank.csv" },
        { view: "table", source: "[[$base.base]]" },
        { view: "button", label: "Log", save: "$folder/", template: "Templates/$base", append: "$daily", line: "- logged" },
      ],
    },
  };
  const r = read({ use: "[[Site]]" }, notes);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel.source ?? ps.panel.save), [
    "https://api.example.com/v1/rate", "Finance/My bank.csv", "My Finance/bank.csv", "[[Books.base]]", "My Finance/",
  ]);
  assert.equal(r.spec!.panels[0].panel.tab, "Money");
  assert.deepEqual(permissionsOf(r.spec!, APP), [
    "create:My Finance", "net:api.example.com", "read:*", "read:Finance/My bank.csv", "read:My Finance/bank.csv", "read:Templates/Books.md", "write:Daily.md",
  ]);
  // The same places refuse a value that comes from an input.
  const live = read({ inputs: { h: ["api.example.com"] }, use: "[[Site]]", with: { host: "$h", file: "$h" } }, notes);
  assert.deepEqual(live.errors.slice(0, 2), [
    'with.host: an input can\'t choose what "source" reads; type the value itself',
    'with.file: an input can\'t choose what "source" reads; type the value itself',
  ]);
});

test("a run-time value may still fill a URL's path or query, encoded, and is checked as it comes", () => {
  const notes = {
    "Components/Q.md": { component: "q", params: ["term", "host"], panels: [{ view: "list", source: "https://$host/search?q=$term" }] },
  };
  const r = read({ inputs: { t: "text" }, use: "[[Q]]", with: { term: "$t", host: "books.example.com" } }, notes);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, APP), ["net:books.example.com"]);
  const ps = r.spec!.panels[0];
  assert.equal(resolvePanel(ps, { t: "a b/c" }).panel!.source, "https://books.example.com/search?q=a%20b%2Fc");
  assert.deepEqual(resolvePanel(ps, { t: "x\ny" }).errors, ["$t can't hold a secret or a line break"]);
  assert.deepEqual(resolvePanel(ps, { t: "{secret:demo}" }).errors, ["$t can't hold a secret or a line break"]);
});

test("changing a kit's with value changes what it asks, and it asks again", async () => {
  const appFm = { app: "Bets", use: "[[Kit]]", with: { folder: "Bets" } };
  const t = fakeEnv({ [APP]: { fm: appFm }, "Components/Kit.md": { fm: KIT }, "Bets/Lunch.md": { fm: { outcome: "open" } } });
  const grants: Record<string, string[]> = {};
  t.env.isGranted = (key, wanted) => wanted.length === 0 || (grants[key] ?? []).join("\n") === wanted.join("\n");
  t.env.granted = (key) => grants[key];
  t.env.grant = async (key, wanted) => { grants[key] = wanted; };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, APP, t.env);
  started.push(app);
  app.load();
  await settle();
  const prompt = () => [...root.querySelectorAll(".na-card li")].map(text);
  assert.deepEqual(prompt(), [
    "Create notes in Bets — for [[Kit]]", "Change properties of notes in Bets — for [[Kit]]", "Read notes in Bets — for [[Kit]]",
  ]);
  [...root.querySelectorAll("button")].find((b) => text(b) === "Allow")!.dispatchEvent(new window.Event("click"));
  await settle();
  assert.equal(root.querySelectorAll(".na-panel").length, 2);
  appFm.with.folder = "Wagers";
  t.changed(APP);
  await settle();
  assert.equal(root.querySelectorAll(".na-panel").length, 0);
  assert.deepEqual(prompt(), [
    "NewCreate notes in Wagers — for [[Kit]]", "NewChange properties of notes in Wagers — for [[Kit]]", "NewRead notes in Wagers — for [[Kit]]",
  ]);
});
