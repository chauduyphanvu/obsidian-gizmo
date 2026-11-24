import "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stableJson, textHash } from "../src/hash.ts";
import { blockKey } from "../src/hosted.ts";
import { panelIds } from "../src/spec.ts";

// Each of these is kept on disk (triggers.json, data.json, activity.json),
// so the same input must give the same text in every version.

test("a panel's identity is the same text in every version", () => {
  const countdown = { view: "countdown", to: "2027-01-01" };
  assert.deepEqual(panelIds([countdown, { view: "number", source: "doses", agg: "count" }, countdown]), ["1arz6a5", "zn7044", "1arz6a5-2"]);
});

test("a block's grant key is the same text in every version", () => {
  assert.equal(blockKey("Daily.md", "view: countdown\nto: 2027-01-01\n"), "Daily.md#1t1nnlv");
  assert.equal(blockKey("Notes/Ünï.md", 'app: "[[Meds]]"'), "Notes/Ünï.md#1dmy52n");
});

test("a note's fingerprint in the activity log is the same in every version", () => {
  assert.equal(textHash("---\nweight: 80\n---\nBody\n"), "3e11e10d:24");
  assert.equal(textHash(""), "811c9dc5:0");
});

test("stable JSON sorts keys and leaves out undefined", () => {
  assert.equal(stableJson({ b: 1, a: [{ d: undefined, c: "x" }], e: null }), '{"a":[{"c":"x"}],"b":1,"e":null}');
});
