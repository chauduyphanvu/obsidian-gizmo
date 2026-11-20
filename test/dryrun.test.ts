import assert from "node:assert/strict";
import { test } from "node:test";
import { dryLines } from "../src/background.ts";
import { Overlay } from "../src/dryrun.ts";
import { fakeBackground } from "./support/fakes.ts";

type Notes = Parameters<typeof fakeBackground>[0];

/** Calls logs a call, adds a line to Daily, and asks Errands to add a call-back errand. */
const notes = (): Notes => ({
  "Apps/Calls.md": {
    fm: {
      app: "Calls",
      panels: [{
        view: "form", title: "Log", fields: { who: "text", back: "date" }, save: "calls", shortcut: "log",
        append: "Daily.md", line: "- Called {who}", notify: "Logged {who}",
        then: { app: "[[Errands]]", do: "add", fill: { errand: "Call {who} back by {back}" } },
      }],
    },
  },
  "Apps/Errands.md": { fm: { app: "Errands", panels: [{ view: "form", title: "Add", fields: { errand: "text" }, save: "errands", shortcut: "add" }] } },
  "Apps/Errands data.md": { fm: { errands: [{ errand: "Buy milk", at: "2026-11-17T10:00" }] } },
  "Daily.md": { fm: {}, body: "# Today\n" },
});

const snapshot = (t: ReturnType<typeof fakeBackground>) => JSON.stringify([...t.f.files].map(([p, n]) => [p, n.fm, n.body]));

test("a dry run shows exactly what the real run then does, across a then, and writes, tells and fetches nothing", async () => {
  const t = fakeBackground(notes());
  await t.bg.start();
  const before = snapshot(t);
  const params = { who: "Sam", back: "2026-12-01" };
  const steps = await t.bg.dryRun("Apps/Calls.md", "log", params);
  assert.equal(snapshot(t), before, "the vault is untouched");
  assert.deepEqual(t.notices, [], "nothing was shown");
  assert.deepEqual(t.out.apps, [], "nothing was opened");
  assert.deepEqual(steps.map((s) => [s.app, s.what, s.changes.map((c) => c.kind), s.notices]), [
    ["Calls", "Log", ["line-added", "row-added"], ["Logged Sam"]],
    ["Errands", "Add", ["row-added"], []],
  ]);
  assert.deepEqual(dryLines(steps), [
    "Add the line “- Called Sam” to Daily",
    "Save who Sam, back 2026-12-01 to calls in Calls data",
    "Tell you: Logged Sam",
    "Errands: Save errand Call Sam back by 2026-12-01 to errands in Errands data",
  ]);

  // The real run, through a keyed link, logs the same changes, field by field.
  const link = new URL(t.bg.shortcutLinks().find((l) => l.shortcut === "log")!.link);
  await t.bg.runUri({ ...Object.fromEntries(link.searchParams), ...params });
  const logged = (await t.activity.list()).reverse().map((e) => e.changes);
  assert.deepEqual(logged, steps.map((s) => s.changes));
});

test("a dry run stops a then loop where a real run would, and never counts toward the hourly limits", async () => {
  const loop: Notes = {
    "Apps/A.md": { fm: { app: "A", panels: [{ view: "button", label: "Go", save: "a", shortcut: "go", then: { app: "[[B]]", do: "go" } }] } },
    "Apps/B.md": { fm: { app: "B", panels: [{ view: "button", label: "Go", save: "b", shortcut: "go", then: { app: "[[A]]", do: "go" } }] } },
  };
  const t = fakeBackground(loop);
  await t.bg.start();
  for (let i = 0; i < 30; i++) await t.bg.dryRun("Apps/A.md", "go");
  const steps = await t.bg.dryRun("Apps/A.md", "go");
  assert.deepEqual(dryLines(steps), ["Save a row to a in A data", "B: Save a row to b in B data", "Tell you: B: stopped a loop: A → B → A"]);
  assert.equal((t.bg as unknown as { runs: Map<string, number[]> }).runs.size, 0, "no run was counted");
  assert.deepEqual(t.notices, []);
  // A real run still runs, as the dry runs used up nothing.
  await t.bg.runCommand("Apps/A.md:go");
  assert.equal((t.f.files.get("Apps/B data.md")?.fm?.b as unknown[]).length, 1);
});

test("a dry run says why a run wouldn't go ahead, as the run would", async () => {
  const t = fakeBackground(notes());
  await t.bg.start();
  t.denied.add("Apps/Calls.md");
  assert.deepEqual(dryLines(await t.bg.dryRun("Apps/Calls.md", "log", { who: "Sam" })), ["Tell you: Open Calls once to allow it"]);
  t.denied.clear();
  assert.deepEqual(dryLines(await t.bg.dryRun("Apps/Calls.md", "log", { who: "Sam", back: "soon" })), ["Tell you: Calls: back must be a date like 2026-11-18"]);
  assert.deepEqual(dryLines(await t.bg.dryRun("Apps/Calls.md", "nope")), ["Tell you: Calls has no shortcut “nope”"]);
  assert.deepEqual(dryLines(await t.bg.dryRun("Apps/Calls.md", "log")), ["Open Calls for you to fill in", "Tell you: Calls: fill in the form"]);
  assert.deepEqual(t.out.apps, []);
});

test("the overlay: copies made on first touch, notes made and refused as the vault would, tasks ticked on the copy", async () => {
  const vault: Record<string, { fm?: Record<string, unknown>; text: string }> = {
    "Daily.md": { fm: { mood: "ok" }, text: "---\nmood: ok\n---\n- [ ] Water the plants\n" },
  };
  const overlay = new Overlay({
    frontmatter: (p) => vault[p]?.fm,
    text: async (p) => vault[p]?.text,
    exists: (p) => p in vault,
  });
  overlay.writeFrontmatter("Daily.md", (fm) => { fm.mood = "great"; });
  assert.equal(vault["Daily.md"].fm!.mood, "ok", "the source is never changed");
  assert.equal(overlay.frontmatter("Daily.md")!.mood, "great");
  assert.equal(await overlay.appendLine("Log.md", "- one"), true);
  assert.equal(await overlay.appendLine("Log.md", "- two"), false);
  assert.equal(await overlay.text("Log.md"), "- one\n- two\n");
  assert.equal(typeof overlay.createNote("Books/Dune.md", { title: "Dune" }, ""), "string");
  assert.equal(overlay.createNote("Books/Dune.md", { title: "Dune" }, ""), false);
  assert.equal(overlay.createNote("Daily.md", {}, ""), false);
  assert.equal(overlay.updateFrontmatter("Missing.md", () => {}), false);
  assert.equal(await overlay.setTaskDone("Daily.md", 3, "Water the plants", true), true);
  assert.match((await overlay.text("Daily.md"))!, /- \[x\] Water the plants/);
  assert.deepEqual(overlay.touched, ["Daily.md", "Log.md", "Books/Dune.md"]);
});

test("a dry run starts a form from the values a link that names no field would save, with each field's type", async () => {
  const t = fakeBackground({
    "Apps/Log.md": { fm: { app: "Log", panels: [{ view: "form", fields: { chore: ["dishes", "bins"], who: "text", n: "number", done: "checkbox", on: "date" }, save: "x", shortcut: "log" }] } },
  });
  await t.bg.start();
  assert.deepEqual(t.bg.formStart("Apps/Log.md", "log"), {
    fields: { chore: ["dishes", "bins"], who: "text", n: "number", done: "checkbox", on: "date" },
    row: { chore: "dishes", who: "", n: null, done: false, on: "2026-11-18" },
  });
  assert.equal(t.bg.formStart("Apps/Log.md", "nope"), undefined);
});
