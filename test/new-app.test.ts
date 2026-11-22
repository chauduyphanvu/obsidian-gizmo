import "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parse } from "yaml";
import { insertPanel } from "../src/insert.ts";
import { afterAppLine, newAppProblem, newAppText } from "../src/new-app.ts";
import { readSpec } from "../src/spec.ts";
import { runsAsApp } from "../src/store.ts";
import { obsidian, workspace } from "./support/plugin.ts";

const { createApp } = await import("../src/new-app-command.ts");
const { MarkdownView, Platform } = obsidian;

const propsOf = (note: string) => parse(/^---\n([\s\S]*?)\n---/.exec(note)![1]) as Record<string, unknown>;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };

afterEach(() => { Platform.isPhone = false; });

test("Create is refused while the name is empty, can't be a file's or a link's, or is taken; and while it says nothing of what it is for", () => {
  const taken = ["Budget.md", "Water data.md", "Projects"];
  assert.equal(newAppProblem("", "Count water", taken), "Give it a name");
  assert.equal(newAppProblem("   ", "Count water", taken), "Give it a name");
  for (const c of ["\\", "/", ":", "*", "?", "\"", "<", ">", "|", "#", "^", "[", "]"]) {
    assert.equal(newAppProblem(`Wa${c}ter`, "Count water", taken), "A name can't hold any of \\ / : * ? \" < > | # ^ [ ]", c);
  }
  assert.equal(newAppProblem(".Water", "Count water", taken), "A name can't start with a dot");
  assert.equal(newAppProblem("budget", "Count water", taken), "There is already a note named budget in this folder");
  assert.equal(newAppProblem(" Budget ", "Count water", taken), "There is already a note named Budget in this folder");
  assert.equal(newAppProblem("Water", "  ", taken), "Say what it is for");
  assert.equal(newAppProblem("Water", "Count water", taken), undefined);
  // A folder or a data note by a similar name is no note of that name.
  assert.equal(newAppProblem("Projects", "Track them", taken), undefined);
});

test("the new note is only its app line, which YAML reads back as typed, and an app with no panels yet", () => {
  for (const purpose of ["Count the glasses of water I drink each day", "Note: drink more", "yes", "2 glasses a day", "Track #habits", "  Spaces around  "]) {
    const text = newAppText(purpose);
    assert.match(text, /^---\napp: .+\n---\n$/);
    const fm = propsOf(text);
    assert.deepEqual(fm, { app: purpose.trim() });
    assert.ok(runsAsApp(fm));
    assert.equal(readSpec(fm)?.empty, true, purpose);
    // Insert panel and the empty app's starter buttons add to it as to any app.
    assert.ok("edit" in insertPanel(text, ["view: countdown"]));
  }
});

test("the cursor goes at the end of the app line", () => {
  const text = newAppText("Note: drink more");
  const at = afterAppLine(text);
  assert.deepEqual(at, { line: 1, ch: 'app: "Note: drink more"'.length });
  assert.equal(text.split("\n")[at.line].slice(at.ch), "");
});

test("Create makes the note in the folder, opens it as the app in a new tab once its properties are read, and its source beside it", async () => {
  const w = workspace({}, propsOf);
  const folder = { path: "Apps", isRoot: () => false, children: [] };
  assert.equal(await createApp(w.plugin, folder as never, "Water", "Count the glasses of water I drink each day"), undefined);
  assert.equal(w.notes["Apps/Water.md"].text, "---\napp: Count the glasses of water I drink each day\n---\n");
  // Opened before Obsidian has read its properties, it would say it has no app key.
  assert.equal(w.leaves.length, 0);
  await settle();
  const [app, source] = w.leaves;
  assert.deepEqual(app.getViewState(), { type: "gizmo", state: { file: "Apps/Water.md" } });
  assert.deepEqual(source.getViewState(), { type: "markdown", state: { file: "Apps/Water.md", mode: "source", source: true } });
  assert.deepEqual((source as unknown as { from: unknown }).from, { leaf: app, direction: "vertical" });
  const view = source.view as InstanceType<typeof MarkdownView>;
  assert.deepEqual(view.editor.cursor, { line: 1, ch: "app: Count the glasses of water I drink each day".length });
  assert.ok(view.editor.focused);
  assert.equal(w.listening(), 0);
});

test("at the top of the vault the note has no folder; on a phone only the app opens", async () => {
  Platform.isPhone = true;
  const w = workspace({}, propsOf);
  const root = { path: "/", isRoot: () => true, children: [] };
  assert.equal(await createApp(w.plugin, root as never, "Water", "Count water"), undefined);
  await settle();
  assert.ok(w.notes["Water.md"]);
  assert.equal(w.leaves.length, 1);
  assert.equal(w.leaves[0].getViewState().type, "gizmo");
});

test("a note the vault won't make is said in the dialog, and nothing opens", async () => {
  const w = workspace({ "Apps/Water.md": { text: "mine" } }, propsOf);
  const folder = { path: "Apps", isRoot: () => false, children: [] };
  assert.equal(await createApp(w.plugin, folder as never, "Water", "Count water"), "Couldn't make the note: File already exists.");
  await settle();
  assert.equal(w.notes["Apps/Water.md"].text, "mine");
  assert.equal(w.leaves.length, 0);
});
