import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runActions, type ActionDeps } from "../src/actions.ts";
import { AppController } from "../src/app.ts";
import { checkPanel, readSpec, type Panel } from "../src/spec.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";

// Fields that carry their own label, format and default, and a form that lists fields by name. The
// fake clock reads 2026-11-18 12:00.

const APP = "Apps/Journal.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** The decisions block the tests share: rich fields over notes in Decisions. */
const DECISIONS = {
  source: "notes",
  from: "Decisions",
  fields: {
    name: { label: "Decision" },
    expect: { label: "I expected" },
    confidence: { type: [60, 70, 80], label: "% sure" },
    review: { type: "date", label: "Due", format: "date" },
    outcome: { type: ["open", "right", "wrong"], label: "It went", default: "open" },
    made: { type: "date", default: "today" },
    cost: { type: "number", format: "$0,0.00" },
  },
};

function read(fm: Record<string, unknown>) {
  return readSpec({ app: "x", ...fm }, { path: APP })!;
}

function open(fm: Record<string, unknown>, notes: Parameters<typeof fakeEnv>[0] = {}) {
  const t = fakeEnv({ [APP]: { fm: { app: "x", ...fm } }, ...notes });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, APP, t.env);
  started.push(app);
  app.load();
  return { ...t, root, panels: () => [...root.querySelectorAll(".na-panel")] };
}

test("a field written as a map gives its type, and its label and format to every panel over the block", () => {
  const r = read({
    data: { decisions: DECISIONS },
    panels: [
      { view: "table", source: "decisions", columns: ["name", "review", "cost"] },
      { view: "table", source: "decisions", columns: ["name", "review"], labels: { review: "When" }, format: { review: "relative" } },
      { view: "bar", source: "decisions", group: "confidence" },
      { view: "number", source: "decisions", field: "cost", agg: "sum", format: "$0" },
    ],
  });
  assert.deepEqual(r.errors, []);
  const [table, own, bar, number] = r.spec!.panels.map((ps) => ps.panel);
  assert.deepEqual(table.schema, {
    name: "text", expect: "text", confidence: [60, 70, 80], review: "date", outcome: ["open", "right", "wrong"], made: "date", cost: "number",
  });
  assert.deepEqual(table.labels, { name: "Decision", expect: "I expected", confidence: "% sure", review: "Due", outcome: "It went" });
  assert.deepEqual(table.format, { review: "date", cost: "$0,0.00" });
  // The panel's own label and format win, field by field.
  assert.equal(own.labels!.review, "When");
  assert.equal(own.labels!.name, "Decision");
  assert.deepEqual(own.format, { review: "relative", cost: "$0,0.00" });
  assert.equal(bar.labels!.confidence, "% sure");
  // A format typed as text is for every field, so the fields' formats don't join it.
  assert.equal(number.format, "$0");
});

test("a field map's problems are named, and say what to type instead", () => {
  const r = read({
    data: {
      d: {
        source: "notes", from: "Decisions",
        fields: {
          a: { type: "date", lable: "A" },
          b: { type: ["x", "y"], default: "z" },
          c: { type: "date", default: "tomorrow" },
          d: { format: "dollars" },
          e: { type: "number", default: "five" },
          f: { type: "colour" },
          g: { label: ["x"] },
        },
      },
      e: { source: "notes", from: "Decisions", fields: ["a", "b"] },
    },
    panels: [{ view: "table", source: "d" }],
  });
  assert.deepEqual(r.errors, [
    'data.d: field "a" has no key "lable" (it takes type, label, format, default)',
    'data.d: field "b" default must be one of its choices: x, y',
    'data.d: field "c" default must be today or a date, e.g. 2026-01-31',
    'data.d: field "d": format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes',
    'data.d: field "e" default must be a number',
    'data.d: field "g" label must be text',
    'data.d: field "f" type must be one of text, number, date, time, checkbox, textarea or a list of choices',
    "data.e: fields must be a set of name: type, e.g. fields: {status: [open, done]}",
  ]);
});

test("a form's fields listed by name come from the block it saves to; a name it doesn't have, or no block, is an error", () => {
  const r = read({
    data: { decisions: DECISIONS },
    panels: [
      { view: "form", fields: ["name", "expect", "confidence"], save: "decisions" },
      { view: "form", fields: ["name", "mood"], save: "decisions" },
      { view: "form", fields: ["name"], save: "Decisions/" },
    ],
  });
  assert.deepEqual(r.errors, [
    'panel 2: fields: "mood" isn\'t a field of the block it saves to (it has name, expect, confidence, review, outcome, made, cost)',
    "panel 3: fields as a list names fields of the block the form saves to; save to a block with fields, or give each field a type",
  ]);
  assert.deepEqual(r.spec!.panels[0].panel.fields, { name: "text", expect: "text", confidence: [60, 70, 80] });
  assert.deepEqual(r.spec!.panels.length, 1);
});

test("a form shows each field by its label and starts it at its default", async () => {
  const app = open({
    panels: [{
      view: "form", save: "log",
      fields: {
        mood: { type: ["low", "ok", "good"], label: "How I feel", default: "ok" },
        hours: { type: "number", label: "Hours slept", default: 7 },
        day: { type: "date", default: "today" },
        at: { type: "time", default: "now" },
        note: "text",
        done: { type: "checkbox", default: true },
      },
    }],
  });
  await settle();
  const form = app.panels()[0];
  assert.deepEqual([...form.querySelectorAll(".na-field > span")].map(text), ["How I feel", "Hours slept", "day", "at", "note", "done"]);
  const [mood] = form.querySelectorAll("select");
  const [hours, day, at, note, done] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  assert.equal((mood as HTMLSelectElement).value, "ok");
  assert.deepEqual([hours.value, day.value, at.value, note.value, done.checked], ["7", "2026-11-18", "12:00", "", true]);
});

test("saving a form saves the schema's defaults for the fields it doesn't show; row wins key by key; numbers stay numbers", async () => {
  const app = open({
    data: { decisions: DECISIONS },
    panels: [
      { view: "form", fields: ["name", "expect", "confidence"], save: "decisions", notify: "Saved {name}, {outcome}" },
      { view: "form", fields: ["name"], save: "decisions", row: { name: "{name}", outcome: "wrong" } },
    ],
  });
  await settle();
  const [first, second] = app.panels();
  (first.querySelector("input") as HTMLInputElement).value = "Take the train";
  (first.querySelectorAll("input")[1] as HTMLInputElement).value = "I keep it up";
  for (const o of first.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "70");
  first.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(app.f.files.get("Decisions/Take the train.md")!.fm, {
    expect: "I keep it up", confidence: 70, outcome: "open", made: "2026-11-18", at: "2026-11-18T12:00",
  });
  assert.ok(app.notices.includes("Saved Take the train, open"), app.notices.join("; "));
  (second.querySelector("input") as HTMLInputElement).value = "Plant seeds";
  second.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(app.f.files.get("Decisions/Plant seeds.md")!.fm, { outcome: "wrong", made: "2026-11-18", at: "2026-11-18T12:00" });
});

test("a choice list of numbers saves a number from a form, and from its shortcut link", async () => {
  const p = checkPanel({ view: "form", fields: { confidence: [60, 70, 80], word: ["a", "b"] }, save: "log" }, true).panel as Panel;
  const saved: Record<string, unknown>[] = [];
  const deps: ActionDeps = {
    now: () => new Date(2026, 10, 18, 12), dataPath: "Apps/X data.md", appPath: "Apps/X.md",
    writeFrontmatter: async (_, fn) => { const fm: Record<string, unknown> = {}; fn(fm); saved.push(...(fm.log as Record<string, unknown>[])); },
    appendLine: async () => {}, createNote: async () => true, readBody: async () => "", notify: () => {}, openNote: () => {},
  };
  await runActions(p, { confidence: 70, word: "b" }, deps);
  assert.equal(saved[0].confidence, 70);

  const bg = fakeBackground({
    "Apps/Sure.md": { fm: { app: "How sure", panels: [{ view: "form", fields: { confidence: { type: [60, 70, 80], default: 80 } }, save: "log", shortcut: "sure" }] } },
  });
  await bg.bg.start();
  await bg.bg.runUri({ app: "Sure", do: "sure", confidence: "60" });
  await bg.bg.runUri({ app: "Sure", do: "sure" });
  await settle();
  assert.deepEqual(bg.f.files.get("Apps/Sure data.md")!.fm!.log, [
    { confidence: 60, at: "2026-11-18T12:00" },
    { confidence: 80, at: "2026-11-18T12:00" },
  ]);
  bg.bg.stop();
});

test("a save: this form shows its fields by their labels", async () => {
  const t = fakeEnv({ "Books/Dune.md": { fm: { status: "reading" } } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Books/Dune.md", t.env, {
    kind: "embed", grantKey: "Books/Dune.md#x", hostPath: "Books/Dune.md",
    definition: () => ({ app: "", view: "form", save: "this", fields: { status: { type: ["reading", "done"], label: "Where I am" } } }),
  });
  started.push(app);
  app.load();
  await settle();
  assert.equal(text(root.querySelector(".na-field > span")), "Where I am");
  assert.equal((root.querySelector("select") as HTMLSelectElement).value, "0");
});
