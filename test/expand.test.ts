import assert from "node:assert/strict";
import { test } from "node:test";
import { readSpec } from "../src/spec.ts";
import { permissionsOf } from "../src/permissions.ts";

const URL_A = "https://api.example.com/forecast?lat=1";

test("a panel naming a block takes its keys, then replaces them key by key", () => {
  const r = readSpec({
    app: "x",
    data: { forecast: { source: URL_A, pick: "current", limit: 5 } },
    panels: [
      { view: "number", source: "forecast", field: "t" },
      { view: "line", source: "forecast", pick: "hourly", x: "time", y: "t", limit: null },
    ],
  })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel), [
    { view: "number", field: "t", pick: "current", limit: 5, source: URL_A },
    { view: "line", pick: "hourly", x: "time", y: "t", source: URL_A },
  ]);
});

test("a block named after a list reads that list; a block can read another block", () => {
  const r = readSpec({
    app: "x",
    data: {
      weights: { source: "weights", where: { at: "last 30 days" } },
      recent: { source: "weights", limit: 3 },
    },
    panels: [{ view: "number", source: "weights", field: "weight" }, { view: "list", source: "recent" }],
  })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels[0].panel, { view: "number", field: "weight", where: { at: "last 30 days" }, source: "weights" });
  // "recent" runs on what "weights" gives: the list, narrowed to the last 30 days.
  assert.deepEqual(r.spec!.panels[1].panel, { view: "list", limit: 3, source: "weights", upstream: [{ where: { at: "last 30 days" } }] });
});

test("block problems name the block", () => {
  const r = readSpec({
    app: "x",
    data: {
      a: { source: URL_A, unit: "kg", colour: "red" },
      b: { pick: "x" },
      notes: { source: URL_A },
      c: { source: URL_A, limit: "five" },
    },
    panels: [{ view: "checklist", items: ["a"], source: "a" }],
  })!;
  assert.deepEqual(r.errors, [
    'data.a: "unit" belongs on the panel, not in data',
    'data.a: unknown key "colour"',
    "data.b needs a source",
    'data: "notes" can\'t be a name; source: notes already means notes in the vault',
    'data.c: "limit" has the wrong type (expected number)',
    'panel 1: "source" doesn\'t apply to checklist',
  ]);
});

test("a block key the view doesn't take is reported against the block", () => {
  const r = readSpec({
    app: "x",
    data: { doses: { source: "doses", where: { at: "today" } } },
    panels: [{ view: "progress", source: "doses", max: 2 }, { view: "timer", minutes: 5, source: "doses" }],
  })!;
  assert.deepEqual(r.errors, [
    'panel 2: "where" doesn\'t apply to timer (from data.doses)',
    'panel 2: "source" doesn\'t apply to timer',
  ]);
});

test("unused blocks ask for nothing", () => {
  const r = readSpec({
    app: "x",
    data: { used: { source: URL_A }, spare: { source: "https://other.example.org/v1" } },
    view: "number",
    source: "used",
  })!;
  assert.deepEqual(permissionsOf(r.spec!, "Apps/X.md"), ["net:api.example.com"]);
  assert.equal(r.spec!.panels[0].panel.source, URL_A);
});
