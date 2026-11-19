import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYaml } from "./support/yaml.ts";

// The test parser refuses what Obsidian's refuses, so a fixture that passes here also reads in
// Obsidian. Checked in an isolated Obsidian 1.15: an unquoted value holding ": " or ending in ":"
// is "Nested mappings are not allowed in compact mappings", and the note then has no properties.

test("an unquoted value holding ': ' or ending in ':' is refused, in a block or a flow map", () => {
  for (const yaml of [
    'line: if(x, "I expect: " + y)',
    "k: a: b",
    "k: x:",
    "panels:\n  - text: a: b",
    "k: {a: b: c}",
  ]) assert.throws(() => parseYaml(yaml), /quote it/, yaml);
});

test("quoted, or with no space after the colon, it reads as Obsidian reads it", () => {
  assert.deepEqual(parseYaml('line: \'if(x, "I expect: " + y)\''), { line: 'if(x, "I expect: " + y)' });
  assert.deepEqual(parseYaml('k: "quoted: ok"'), { k: "quoted: ok" });
  assert.deepEqual(parseYaml("k: a:b"), { k: "a:b" });
  assert.deepEqual(parseYaml("k: https://example.com/a"), { k: "https://example.com/a" });
  assert.deepEqual(parseYaml('k: {a: "b: c"}'), { k: { a: "b: c" } });
});
