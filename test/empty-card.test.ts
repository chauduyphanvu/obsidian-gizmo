import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { AppController, type AppEnv } from "../src/app.ts";
import { STARTERS, WATER } from "../src/app-cards.ts";
import { VIEW_HINTS } from "../src/hints.ts";
import { skeleton, withPanels } from "../src/insert.ts";
import { pastEnv } from "../src/replay.ts";
import { readSpec } from "../src/spec.ts";
import { viewDef } from "../src/views/registry.ts";
import { fakeEnv } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const PATH = "Apps/Water.md";
const NEW = "---\napp: Count the glasses of water I drink each day\n---\n";

/** A note's properties, read as Obsidian reads them. */
function propsOf(note: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(note);
  return (m ? parse(m[1]) : {}) as Record<string, unknown>;
}

/** The app note `note` opened in its own tab; adding panels edits its text as the app's tab does in Obsidian. */
function open(note = NEW, env?: (env: AppEnv) => AppEnv) {
  const t = fakeEnv({ [PATH]: { fm: propsOf(note) } });
  t.source.lines = note.split("\n");
  const shown: [number, number | undefined][] = [];
  const added: string[][][] = [];
  t.env.showSourceAt = (line, ch) => { shown.push([line, ch]); };
  t.env.addPanels = async (panels) => {
    added.push(panels);
    const found = withPanels(t.source.lines.join("\n"), panels);
    if ("refusal" in found) return found;
    t.source.lines = found.text.split("\n");
    t.f.files.get(PATH)!.fm = propsOf(found.text);
    t.changed(PATH);
    return { cursor: found.cursor };
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, PATH, env ? env(t.env) : t.env);
  app.load();
  return { ...t, root, app, shown, added };
}

const starters = (root: Element) => [...root.querySelectorAll(".gz-starters button")] as HTMLButtonElement[];
const button = (root: Element, label: string) => [...root.querySelectorAll("button")].find((b) => text(b) === label) as HTMLButtonElement | undefined;

test("an app with only its app line shows an example under panels:, and a button for each starter panel with its view's hint", async () => {
  const t = open();
  await settle();
  const card = t.root.querySelector(".gz-empty-app");
  assert.match(text(card), /^No panels yet\. Add them under panels:, for example:/);
  const example = text(card?.querySelector("pre.gz-example"));
  assert.equal(example, "panels:\n  - view: countdown\n    to: 2027-01-01\n    label: New year");
  // Typed into the note as shown, the example is an app with no problems.
  const read = readSpec(propsOf(`---\napp: New year\n${example}\n---`));
  assert.deepEqual([read?.errors, read?.spec?.panels.length], [[], 1]);

  assert.deepEqual(starters(t.root).map(text), ["Button", "Form", "Checklist", "Countdown", "Timer", "Start from the Water example"]);
  assert.deepEqual(starters(t.root).slice(0, -1).map((b) => b.title), STARTERS.map((id) => VIEW_HINTS[id]));
  assert.ok(button(t.root, "Edit source"));
  t.app.dispose();
});

test("a starter button adds the panel Insert panel would add, shows it in the source, and the app draws it", async () => {
  const t = open();
  await settle();
  button(t.root, "Countdown")!.click();
  await settle();
  const expected = withPanels(NEW, [skeleton(viewDef("countdown")!)]);
  assert.ok("text" in expected);
  assert.deepEqual(t.added, [[skeleton(viewDef("countdown")!)]]);
  assert.equal(t.source.lines.join("\n"), expected.text);
  assert.deepEqual(t.shown, [[expected.cursor.line, expected.cursor.ch]]);
  assert.equal(t.source.lines[expected.cursor.line].slice(expected.cursor.ch), '"2027-10-03"');
  assert.ok(!t.root.querySelector(".gz-empty-app"));
  assert.ok(t.root.querySelector(".gz-view-countdown"));
  t.app.dispose();
});

test("each starter it offers works alone in a new app: no problems, and no list read that nothing saves", () => {
  for (const id of STARTERS) {
    const added = withPanels(NEW, [skeleton(viewDef(id)!)]);
    assert.ok("text" in added, id);
    const read = readSpec(propsOf(added.text), { now: new Date(2026, 10, 21), path: PATH });
    assert.deepEqual(read?.errors, [], id);
    const panels = read!.spec!.panels.map((ps) => ps.panel);
    assert.equal(panels.length, 1, id);
    for (const p of panels) assert.ok(!p.source || panels.some((q) => q.save === p.source), `${id} reads ${p.source}`);
  }
});

test("Start from the Water example adds the two panels of the reference's first app", async () => {
  const doc = readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("## Write an app"));
  const block = /```yaml\n([\s\S]*?)\n\s*```/.exec(section)![1].split("\n").map((l) => l.replace(/^ {3}/, "")).join("\n");
  const written = withPanels(NEW, WATER);
  assert.ok("text" in written);
  assert.deepEqual(propsOf(written.text), propsOf(block));

  const t = open();
  await settle();
  button(t.root, "Start from the Water example")!.click();
  await settle();
  assert.deepEqual(propsOf(t.source.lines.join("\n")), propsOf(block));
  assert.deepEqual(t.shown, [[written.cursor.line, written.cursor.ch]]);
  assert.equal(t.source.lines[written.cursor.line], "    label: Drank a glass");
  assert.ok(t.root.querySelector(".gz-view-button") && t.root.querySelector(".gz-view-progress"));
  t.app.dispose();
});

test("a refusal is said, and the buttons can be used again", async () => {
  const t = open(NEW, (env) => ({ ...env, addPanels: async () => ({ refusal: "This note has no frontmatter to add a panel to" }) }));
  await settle();
  button(t.root, "Form")!.click();
  await settle();
  assert.deepEqual(t.notices, ["This note has no frontmatter to add a panel to"]);
  assert.deepEqual(t.shown, []);
  assert.ok(starters(t.root).every((b) => !b.disabled));
  t.app.dispose();
});

test("no starters in the app as it was, where the env can't add panels (a try), or in an embed", async () => {
  const past = open(NEW, (env) => pastEnv(env, new Date(2026, 10, 1).getTime()));
  await settle();
  assert.ok(past.root.querySelector(".gz-empty-app"));
  assert.equal(starters(past.root).length, 0);
  assert.ok(button(past.root, "Edit source"));
  past.app.dispose();

  const tried = open(NEW, (env) => ({ ...env, addPanels: undefined }));
  await settle();
  assert.ok(tried.root.querySelector(".gz-empty-app"));
  assert.equal(starters(tried.root).length, 0);
  tried.app.dispose();

  const t = fakeEnv({ [PATH]: { fm: propsOf(NEW) } });
  t.env.addPanels = async () => { throw new Error("an embed must not edit the app note"); };
  const root = document.createElement("div");
  const embed = new AppController(root, PATH, t.env, { kind: "app", grantKey: "Daily.md#gizmo", hostPath: "Daily.md", definition: () => propsOf(NEW) });
  embed.load();
  await settle();
  assert.ok(root.querySelector(".gz-empty-app"));
  assert.equal(root.querySelectorAll("button").length, 0);
  embed.dispose();
});
