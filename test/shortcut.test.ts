import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeBackground } from "./support/fakes.ts";

const MEDS = {
  app: "Log when I take my meds",
  panels: [
    { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds" },
    { view: "button", label: "Skipped", save: "skips" },
    { view: "form", title: "Side effects", fields: { note: "text", severity: ["mild", "bad"], dizzy: "checkbox", hours: "number", on: "date", when: "time" }, save: "effects", notify: "Logged {severity}: {note}", shortcut: "effects" },
  ],
};

function meds(more: Parameters<typeof fakeBackground>[0] = {}) {
  const t = fakeBackground({ "Apps/Meds.md": { fm: MEDS }, ...more });
  const data = (key: string) => t.f.files.get("Apps/Meds data.md")?.fm?.[key] as Record<string, unknown>[] | undefined;
  return { ...t, data };
}

test("each shortcut is a command named after its app and panel; commands follow the apps", async () => {
  const t = meds({ "Apps/Weight.md": { fm: { app: "w", view: "form", fields: { kg: "number" }, save: "weights", shortcut: "weigh-in" } } });
  await t.bg.start();
  assert.deepEqual(t.out.commands, [
    { id: "Apps/Meds.md:effects", name: "Meds: Side effects" },
    { id: "Apps/Meds.md:took-meds", name: "Meds: Took meds" },
    { id: "Apps/Weight.md:weigh-in", name: "Weight: weigh-in" },
  ]);
  t.f.files.get("Apps/Weight.md")!.fm = { app: "w", view: "form", fields: { kg: "number" }, save: "weights" };
  t.changed("Apps/Weight.md");
  assert.deepEqual(t.out.commands.map((c) => c.id), ["Apps/Meds.md:effects", "Apps/Meds.md:took-meds"]);
});

test("a button's command runs its actions without opening the app", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runCommand("Apps/Meds.md:took-meds");
  assert.deepEqual(t.data("doses"), [{ at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices, ["Meds: Took meds done"]);
  assert.deepEqual(t.out.apps, []);
});

test("a form's command opens the app to fill it in", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runCommand("Apps/Meds.md:effects");
  assert.deepEqual(t.out.apps, ["Apps/Meds.md"]);
  assert.deepEqual(t.notices, ["Meds: fill in the form"]);
  assert.equal(t.data("effects"), undefined);
});

test("a link fills a form's fields by type; fields not given save as an untouched form; others are ignored", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runUri({ action: "note-apps", app: "Meds", do: "effects", note: "headache", severity: "bad", dizzy: "yes", hours: "2.5", when: "08:30", extra: "ignored" });
  assert.deepEqual(t.data("effects"), [{ note: "headache", severity: "bad", dizzy: true, hours: 2.5, on: "2026-11-18", when: "08:30", at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices, ["Logged bad: headache"]);
  await t.bg.runUri({ action: "note-apps", app: "Apps/Meds", do: "effects" });
  assert.deepEqual(t.data("effects")![1], { note: "", severity: "mild", dizzy: false, hours: null, on: "2026-11-18", when: "", at: "2026-11-18T12:00" });
});

test("a value that doesn't fit its field refuses the whole action, naming the field", async () => {
  const t = meds();
  await t.bg.start();
  const tries: [string, string][] = [
    ["hours", "two"], ["hours", "Infinity"], ["severity", "awful"], ["dizzy", "maybe"], ["on", "18/11/2026"], ["when", "25:00"],
  ];
  for (const [field, value] of tries) await t.bg.runUri({ app: "Meds", do: "effects", [field]: value });
  assert.deepEqual(t.notices, [
    "Meds: hours must be a number",
    "Meds: hours must be a number",
    "Meds: severity must be one of mild, bad",
    "Meds: dizzy must be true or false",
    "Meds: on must be a date like 2026-11-18",
    "Meds: when must be a time like 08:30",
  ]);
  assert.equal(t.data("effects"), undefined);
});

test("a link from any web page can't reach a panel without a shortcut, an app not yet allowed, or inject through values", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runUri({ app: "Meds", do: "Skipped" });
  await t.bg.runUri({ app: "Meds", do: "skips" });
  assert.equal(t.data("skips"), undefined);

  await t.bg.runUri({ app: "Meds", do: "effects", note: "{secret:demo}" });
  await t.bg.runUri({ app: "Meds", do: "effects", note: "line\nbreak" });
  await t.bg.runUri({ app: "Meds", do: "effects", junk: "x\r\ny" });
  assert.equal(t.data("effects"), undefined);
  // A placeholder in a value is text, never filled again.
  await t.bg.runUri({ app: "Meds", do: "effects", note: "{severity} {secret}", severity: "bad" });
  assert.deepEqual(t.data("effects")!.map((r) => r.note), ["{severity} {secret}"]);

  t.denied.add("Apps/Meds.md");
  await t.bg.runUri({ app: "Meds", do: "took-meds" });
  await t.bg.runCommand("Apps/Meds.md:took-meds");
  assert.equal(t.data("doses"), undefined);
  assert.deepEqual(t.notices, [
    "Meds has no shortcut “Skipped”",
    "Meds has no shortcut “skips”",
    "Meds: $note can't hold a secret or a line break",
    "Meds: $note can't hold a secret or a line break",
    "Meds: $junk can't hold a secret or a line break",
    "Logged bad: {severity} {secret}",
    "Open Meds once to allow it",
    "Open Meds once to allow it",
  ]);
});

test("a link names its app by path or name; none or several is said so", async () => {
  const t = meds({ "Old/Meds.md": { fm: MEDS } });
  await t.bg.start();
  await t.bg.runUri({ app: "Meds", do: "took-meds" });
  await t.bg.runUri({ app: "Vitamins", do: "took-meds" });
  assert.deepEqual(t.notices, ["Several apps are called “Meds”; use its path", "No app called “Vitamins”"]);
  await t.bg.runUri({ app: "Old/Meds.md", do: "took-meds" });
  assert.deepEqual(t.f.files.get("Old/Meds data.md")?.fm?.doses, [{ at: "2026-11-18T12:00" }]);
  assert.equal(t.data("doses"), undefined);
});
