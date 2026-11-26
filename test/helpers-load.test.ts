import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The commands' logic, as the standalone app and gizmod run it. Imported as Node imports it, with
 * nothing standing in for Obsidian: had any of these reached "obsidian", the import would fail.
 */
const HELPERS = [
  "install", "try", "kind-make", "share-setup", "ask", "backtest", "activity", "activity-list", "capture-run", "links", "runtime",
];

test("the commands' helpers load without Obsidian", async () => {
  for (const name of HELPERS) {
    const mod = (await import(`../src/${name}.ts`)) as Record<string, unknown>;
    assert.ok(Object.keys(mod).length > 0, name);
  }
});
