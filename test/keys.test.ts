import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel, readSpec } from "../src/spec.ts";
import { refusedPlaces } from "../src/template.ts";
import { readValue } from "../src/views/common.ts";

/** Every key declared ahead of the feature that uses it, with a value of the right type. */
const DECLARED: Record<string, unknown> = {
  select: "quake", action: "Add", row: { title: "{title}" }, name: "{title}", template: "[[Book]]",
  open: "{path}", edit: ["status"], format: "0.0", labels: { a: "A" }, values: { code: { 0: "Clear" } },
  cells: { p: "progress" }, layout: "cards", compare: "previous", goal: 80, stack: true,
  start: "start", end: "end", shortcut: "took-meds", pin: "status", alert: ">= 5",
};

test("keys declared for later features apply to no view yet", () => {
  for (const [key, value] of Object.entries(DECLARED)) {
    assert.deepEqual(checkPanel({ view: "number", source: "s", [key]: value }, true).errors, [`"${key}" doesn't apply to number`], key);
  }
});

test("internal keys can't be typed", () => {
  for (const key of ["upstream", "schema", "vars"]) {
    assert.deepEqual(checkPanel({ view: "number", source: "s", [key]: [{ where: { a: 1 } }] }, true).errors, [`unknown key "${key}"`]);
    const r = readSpec({ app: "x", panels: [{ view: "number", source: "s", [key]: { a: "text" } }] })!;
    assert.deepEqual(r.errors, [`panel 1: unknown key "${key}"`]);
    assert.equal(key in r.spec!.panels[0].panel, false);
    // A single panel at the top level shares the note with other properties, so it ignores them.
    const top = readSpec({ app: "x", view: "number", source: "s", [key]: { a: "text" } })!;
    assert.deepEqual(top.errors, []);
    assert.equal(key in top.spec!.panels[0].panel, false);
  }
});

test("the new key types read and normalise their values", () => {
  const ok: [Parameters<typeof readValue>[0], unknown, unknown][] = [
    ["stack", false, false],
    ["body", "query { x }", "query { x }"],
    ["body", { query: "{ x }", vars: { n: [1, 2] } }, { query: "{ x }", vars: { n: [1, 2] } }],
    ["format", "$0,0.00", "$0,0.00"],
    ["format", { price: "$0.00", n: 0 }, { price: "$0.00", n: "0" }],
    ["values", { code: { 0: "Clear", 1: 2, 3: true } }, { code: { 0: "Clear", 1: "2", 3: "true" } }],
    ["alert", ">= 5", ">= 5"],
    ["alert", { estimated_kp: ">= 5", active: true }, { estimated_kp: ">= 5", active: true }],
    ["compute", { change: "close - prev(close)", one: 1 }, { change: "close - prev(close)", one: 1 }],
    ["row", { title: "{title}", n: 5 }, { title: "{title}", n: "5" }],
    ["labels", { temperature_2m_max: "High" }, { temperature_2m_max: "High" }],
    ["goal", 80, 80],
  ];
  for (const [key, value, want] of ok) assert.deepEqual(readValue(key, value), { value: want }, key);
});

test("the new key types say what they expected", () => {
  const bad: [Parameters<typeof readValue>[0], unknown, string][] = [
    ["stack", "yes", "true or false"],
    ["body", [1, 2], "text or a set of keys"],
    ["format", { price: ["$"] }, "text, or a set of field: format"],
    ["values", { code: "Clear" }, "a set of field: {value: text}"],
    ["alert", [">= 5"], "a condition, or a set of field: condition"],
    ["compute", { flag: true }, "a set of name: formula"],
    ["compute", "close * 2", "a set of name: formula"],
    ["row", { title: { nested: 1 } }, "a set of name: text"],
    ["cells", ["progress"], "a set of name: text"],
    ["goal", "80", "number"],
  ];
  for (const [key, value, expected] of bad) {
    assert.deepEqual(readValue(key, value), { error: `"${key}" has the wrong type (expected ${expected})` }, key);
  }
});

test("a $name can't fill the keys that fix a panel's structure or identity", () => {
  for (const key of ["select", "shortcut", "pin", "template", "edit", "cells", "layout", "stack", "compare"]) {
    assert.deepEqual(refusedPlaces({ [key]: "$n" }, new Set(["n"]), "input"), [`$n can't be used in "${key}"`], key);
  }
  for (const key of ["name", "row", "open", "format", "labels", "values", "goal", "alert", "body", "start", "end"]) {
    assert.deepEqual(refusedPlaces({ [key]: "$n" }, new Set(["n"]), "param"), [], key);
  }
});
