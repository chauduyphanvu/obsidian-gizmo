import assert from "node:assert/strict";
import { test } from "node:test";
import { readSpec } from "../src/spec.ts";
import { permissionsOf } from "../src/permissions.ts";
import { defaultDataPath, resolveList, storeTarget } from "../src/store.ts";

test("the default data note sits next to the app", () => {
  assert.equal(defaultDataPath("Apps/Weight.md"), "Apps/Weight data.md");
  assert.equal(defaultDataPath("Meds.md"), "Meds data.md");
});

test("store accepts a wikilink or a path", () => {
  assert.equal(storeTarget("[[Logs/Weight]]"), "Logs/Weight");
  assert.equal(storeTarget("[[Logs/Weight|my log]]"), "Logs/Weight");
  assert.equal(storeTarget("Logs/Weight.md"), "Logs/Weight");
});

test("recorded lists win over starting lists typed into the app", () => {
  const app = { doses: [{ at: "typed" }], books: ["Dune"] };
  const data = { doses: [{ at: "recorded" }] };
  assert.deepEqual(resolveList("doses", data, app), [{ at: "recorded" }]);
  assert.deepEqual(resolveList("books", data, app), ["Dune"]);
  assert.deepEqual(resolveList("missing", undefined, app), []);
});

test("the default data note needs no permission; another store does", () => {
  const plain = readSpec({ app: "x", view: "button", save: "log" })!.spec!;
  assert.deepEqual(permissionsOf(plain, "Apps/X.md"), []);
  const elsewhere = readSpec({ app: "x", view: "button", save: "log", store: "[[Logs/Shared]]" })!.spec!;
  assert.deepEqual(permissionsOf(elsewhere, "Apps/X.md"), ["store:Logs/Shared.md"]);
  assert.deepEqual(readSpec({ app: "x", view: "button", save: "log", store: 3 })?.errors, [
    'store must be a note, e.g. store: "[[Weight log]]"',
  ]);
});
