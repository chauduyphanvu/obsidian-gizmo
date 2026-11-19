import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration, permissionsOf, readSpec } from "../src/spec.ts";

test("a note without app is not an app", () => {
  assert.equal(readSpec({ tags: ["x"] }), undefined);
  assert.equal(readSpec(undefined), undefined);
});

test("an app line alone has no panels yet", () => {
  assert.deepEqual(readSpec({ app: "Weather in London" }), { errors: [], empty: true });
});

test("top-level keys make one panel and ignore unrelated properties", () => {
  const r = readSpec({ app: "Days to renewal", view: "countdown", to: "2026-10-03", tags: ["benefits"], created: "x" });
  assert.deepEqual(r?.errors, []);
  assert.deepEqual(r?.spec?.panels.map((ps) => ps.panel), [{ view: "countdown", to: "2026-10-03" }]);
});

test("panels are checked strictly", () => {
  const r = readSpec({
    app: "x",
    panels: [
      { view: "line", source: "weights" },
      { view: "number", source: "weights", colour: "red" },
      { view: "gauge" },
    ],
  });
  assert.deepEqual(r?.errors, [
    "panel 1: line needs x and y",
    'panel 2: unknown key "colour"',
    "panel 3: view must be one of number, text, line, bar, pie, table, list, button, form, checklist, countdown, progress, timer",
  ]);
  // A stray key is reported but doesn't stop an otherwise valid panel from showing.
  assert.deepEqual(r?.spec?.panels.map((ps) => ps.panel), [{ view: "number", source: "weights" }]);
});

test("actions only apply to action views, and buttons need one", () => {
  const r = readSpec({ app: "x", panels: [{ view: "number", source: "a", append: "Daily.md" }, { view: "button" }] });
  assert.deepEqual(r?.errors, [
    'panel 1: "append" doesn\'t apply to number',
    "panel 2: button needs at least one of save, append, notify",
  ]);
});

test("refresh durations", () => {
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("soon"), undefined);
  assert.deepEqual(readSpec({ app: "x", view: "text", text: "hi", refresh: "fast" })?.errors, ["refresh must look like 30s, 5m, 1h"]);
});

test("permissions come from the keys", () => {
  const spec = readSpec({
    app: "x",
    panels: [
      { view: "line", source: "https://api.example.com/q?k={secret:demo}", x: "t", y: "v", headers: { Authorization: "Bearer {secret:other}" } },
      { view: "list", source: "notes", from: "#health" },
      { view: "button", append: "Daily", save: "log" },
      { view: "button", append: "Apps/Me.md" },
    ],
  })!.spec!;
  assert.deepEqual(permissionsOf(spec, "Apps/Me.md"), [
    "net:api.example.com",
    "read:#health",
    "secret:demo",
    "secret:other",
    "write:Daily.md",
  ]);
});

test("save can't write over the app's own keys", () => {
  const r = readSpec({ app: "x", panels: [{ view: "button", save: "panels" }, { view: "checklist", items: ["a"], save: "app" }] });
  assert.deepEqual(r?.errors, [
    'panel 1: save can\'t use "panels", which names part of the app',
    'panel 2: save can\'t use "app", which names part of the app',
  ]);
});

test("spec 1 or none is read; anything else draws nothing", () => {
  const panel = { view: "countdown", to: "2027-01-01" };
  assert.equal(readSpec({ app: "x", ...panel })?.spec?.panels.length, 1);
  assert.equal(readSpec({ app: "x", spec: 1, ...panel })?.spec?.panels.length, 1);
  const newer = readSpec({ app: "x", spec: 2, ...panel });
  assert.equal(newer?.spec, undefined);
  assert.deepEqual(newer?.errors, ["spec: 2 needs a newer Note Apps (this one reads spec 1)"]);
  assert.deepEqual(readSpec({ app: "x", spec: "1", ...panel })?.errors, ["spec must be 1"]);
});

test("lists can't be named after the app's own keys, and secrets stay out of hosts", () => {
  const r = readSpec({
    app: "x",
    panels: [
      { view: "number", source: "data" },
      { view: "number", source: "https://{secret:k}.example.com/v1" },
      { view: "number", source: "https://api.example.com/v1?key={secret:k}" },
    ],
  });
  assert.deepEqual(r?.errors, [
    'panel 1: source can\'t use "data", which names part of the app',
    "panel 2: a secret can't be part of the host; put it in the path, the query or headers",
  ]);
  assert.equal(r?.spec?.panels.length, 1);
});

test("a single top-level panel's identity ignores the note's other properties", () => {
  const a = readSpec({ app: "x", tags: ["a"], view: "countdown", to: "2027-01-01" })!.spec!.panels[0];
  const b = readSpec({ app: "y", tags: ["b"], view: "countdown", to: "2027-01-01" })!.spec!.panels[0];
  assert.deepEqual(a.template, b.template);
  assert.deepEqual(a.template, { view: "countdown", to: "2027-01-01" });
});

test("span takes 1 to 4 columns", () => {
  const r = readSpec({ app: "x", panels: [{ view: "countdown", to: "2027-01-01", span: 5 }, { view: "countdown", to: "2027-01-01", span: 2, tab: "A" }] });
  assert.deepEqual(r?.errors, ["panel 1: span must be 1, 2, 3 or 4"]);
});
