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
  assert.deepEqual(r?.spec?.panels, [{ view: "countdown", to: "2026-10-03" }]);
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
    "panel 3: view must be one of number, text, line, bar, table, list, button, form, checklist, countdown, progress, timer",
  ]);
  // A stray key is reported but doesn't stop an otherwise valid panel from showing.
  assert.deepEqual(r?.spec?.panels, [{ view: "number", source: "weights" }]);
});

test("actions only belong on action views, and buttons need one", () => {
  const r = readSpec({ app: "x", panels: [{ view: "number", source: "a", append: "Daily.md" }, { view: "button" }] });
  assert.deepEqual(r?.errors, [
    "panel 1: save/append/notify only work on button, form, checklist, timer",
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
