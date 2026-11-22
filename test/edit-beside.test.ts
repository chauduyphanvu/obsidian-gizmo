import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { obsidian, obsidianAppEnv, workspace } from "./support/plugin.ts";

const { MarkdownView, Platform } = obsidian;
type View = InstanceType<typeof MarkdownView>;

const WATER = "---\napp: Count the glasses of water I drink each day\n---\n";

afterEach(() => { Platform.isPhone = false; });

const markdown = (leaf: { view: unknown }) => leaf.view as View;

test("Edit source opens the note's text in Source mode in a split beside the app, which stays", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo");
  const source = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  assert.notEqual(source, app);
  assert.deepEqual((source as unknown as { from: unknown }).from, { leaf: app, direction: "vertical" });
  assert.deepEqual(source.getViewState(), { type: "markdown", state: { file: "Apps/Water.md", mode: "source", source: true } });
  assert.equal(app.getViewState().type, "gizmo");
  assert.equal(w.active, source);
  assert.equal(w.leaves.length, 2);
});

test("Edit source again goes back to that tab rather than open another; so does a tab of the note opened some other way", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo");
  const first = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  w.plugin.app.workspace.setActiveLeaf(app as never);
  const again = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  assert.equal(again, first);
  assert.equal(w.leaves.length, 2);
  assert.deepEqual(w.revealed, [first]);
  assert.equal(w.active, first);

  // A tab already showing the note in Live Preview is used, turned to Source mode, where nested panels can be typed.
  const v = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const live = await v.open("Apps/Water.md", "markdown", undefined, { source: false });
  const appTab = await v.open("Apps/Water.md", "gizmo");
  assert.equal(await v.plugin.editSource(appTab as never, v.file("Apps/Water.md")), live);
  assert.equal(live.getViewState().state?.source, true);
  assert.equal(v.leaves.length, 2);
});

test("a tab of another note, or of this note in Reading view, isn't taken for its source", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER }, "Daily.md": { text: "hi" } });
  await w.open("Daily.md", "markdown");
  await w.open("Apps/Water.md", "markdown", undefined, { mode: "preview" });
  const app = await w.open("Apps/Water.md", "gizmo");
  const source = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  assert.equal(w.leaves.length, 4);
  assert.deepEqual((source as unknown as { from: unknown }).from, { leaf: app, direction: "vertical" });
});

test("on a phone, with no room beside it, the app's own tab turns into the source", async () => {
  Platform.isPhone = true;
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo");
  assert.equal(await w.plugin.editSource(app as never, w.file("Apps/Water.md")), app);
  assert.equal(app.getViewState().type, "markdown");
  assert.equal(w.leaves.length, 1);
});

test("an app in a sidebar gets its source in a tab of the main area, not squeezed beside it", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo", w.rightSplit);
  const source = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  assert.equal((source as unknown as { from?: unknown }).from, undefined);
  assert.equal((source as unknown as { root: { name: string } }).root.name, "root");
});

test("a link to a line opens the source beside the app, or the tab already open, with the cursor there", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: "---\napp: Water\npanels:\n  - view: gauge\n---\n" } });
  const app = await w.open("Apps/Water.md", "gizmo");
  await w.plugin.showSourceAt(app as never, w.file("Apps/Water.md"), 3);
  const source = w.leaves.find((l) => l !== app)!;
  assert.deepEqual(markdown(source).editor.cursor, { line: 3, ch: 0 });
  assert.ok(markdown(source).editor.focused);
  assert.equal(app.getViewState().type, "gizmo");

  await w.plugin.showSourceAt(app as never, w.file("Apps/Water.md"), 1, 14);
  assert.equal(w.leaves.length, 2);
  assert.deepEqual(markdown(source).editor.cursor, { line: 1, ch: 14 });
});

test("the app's env sends Edit source and its links through the same way, and only an app tab's env adds panels", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo");
  const env = obsidianAppEnv(w.plugin, app as never, w.file("Apps/Water.md") as never);
  env.showSource();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.leaves.length, 2);
  assert.equal(app.getViewState().type, "gizmo");

  const added = await env.addPanels!([["view: countdown", "to: \"2027-10-03\""]]);
  assert.deepEqual(added, { cursor: { line: 4, ch: 8 } });
  assert.equal(w.notes["Apps/Water.md"].text, `---\napp: Count the glasses of water I drink each day\npanels:\n  - view: countdown\n    to: "2027-10-03"\n---\n`);
  // An embed or a lens has no tab of its own, and its note isn't the app's to edit.
  assert.equal(obsidianAppEnv(w.plugin, undefined, w.file("Apps/Water.md") as never).addPanels, undefined);
});

test("Show the app, from the source beside an app, closes it and goes back to the app", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo");
  const source = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  await w.own.showApp(markdown(source));
  assert.deepEqual(w.leaves, [app]);
  assert.equal(w.active, app);
  assert.ok(w.revealed.includes(app));
});

test("Show the app, with no tab showing the app, turns that tab into it", async () => {
  Platform.isPhone = true;
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const tab = await w.open("Apps/Water.md", "gizmo");
  await w.plugin.editSource(tab as never, w.file("Apps/Water.md"));
  await w.own.showApp(markdown(tab));
  assert.deepEqual(tab.getViewState(), { type: "gizmo", state: { file: "Apps/Water.md" } });
  assert.equal(w.leaves.length, 1);
});

test("each tab showing an app note's text gets one Show the app action, which goes when the note stops being an app", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER }, "Daily.md": { text: "hi" } });
  const tab = await w.open("Apps/Water.md", "markdown");
  const daily = await w.open("Daily.md", "markdown");
  for (let i = 0; i < 3; i++) w.own.syncShowAppActions();
  const live = (leaf: { view: unknown }) => markdown(leaf).actions.filter((a) => !a.el.removed);
  assert.deepEqual(live(tab).map((a) => [a.icon, a.title]), [["layout-dashboard", "Show the app"]]);
  assert.equal(live(daily).length, 0);

  w.notes["Apps/Water.md"].fm = { title: "Water, no longer an app" };
  w.own.syncShowAppActions();
  assert.equal(live(tab).length, 0);

  w.notes["Apps/Water.md"].fm = { app: "Water" };
  w.own.syncShowAppActions();
  w.own.syncShowAppActions();
  assert.equal(live(tab).length, 1);

  // The tab moves on to a note that isn't an app.
  await tab.setViewState({ type: "markdown", state: { file: "Daily.md", mode: "source" } });
  w.own.syncShowAppActions();
  assert.equal(live(tab).length, 0);
});

test("the action runs Show the app for its tab", async () => {
  const w = workspace({ "Apps/Water.md": { fm: { app: "Water" }, text: WATER } });
  const app = await w.open("Apps/Water.md", "gizmo");
  const source = await w.plugin.editSource(app as never, w.file("Apps/Water.md"));
  w.own.syncShowAppActions();
  await markdown(source).actions[0].callback();
  assert.deepEqual(w.leaves, [app]);
});
