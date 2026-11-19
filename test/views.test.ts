import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel } from "../src/spec.ts";
import { KEY_TYPES } from "../src/views/common.ts";
import { VIEW_DEFS } from "../src/views/registry.ts";

for (const def of VIEW_DEFS) {
  test(`${def.id}: every example checks out`, () => {
    assert.ok(def.examples.length > 0, "needs at least one example");
    for (const ex of def.examples) {
      assert.deepEqual(checkPanel(ex.panel, true).errors, ex.errors ?? [], JSON.stringify(ex.panel));
    }
  });

  test(`${def.id}: accepts only known keys`, () => {
    for (const key of def.keys) assert.ok(key in KEY_TYPES, `${key} isn't in KEY_TYPES`);
  });
}

test("view ids are unique", () => {
  const ids = VIEW_DEFS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});
