import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// gizmod runs the engine where there is no DOM. What it loads reaches the views through one door,
// views/registry.ts, which the checks need for each view's keys; nothing else of the engine names a
// view file, and no engine module loads another in a loop.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IMPORT = /^(?:import|export)\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"/gms;

/** The modules a file loads when it runs: its imports that aren't of types only. */
function loads(file: string): string[] {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  return [...text.matchAll(IMPORT)].filter((m) => !m[1]).map((m) => relative(ROOT, resolve(ROOT, dirname(file), m[2])));
}

/** Everything gizmod loads, each with what it loads. */
function engine(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const todo = ["scripts/gizmod/gizmod.ts"];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.set(file, loads(file));
    todo.push(...seen.get(file)!);
  }
  return seen;
}

test("the engine reaches the views only through their registry", () => {
  const through: string[] = [];
  for (const [file, deps] of engine()) {
    if (file.startsWith("src/views/")) continue;
    for (const dep of deps) if (dep.startsWith("src/views/") && dep !== "src/views/registry.ts") through.push(`${file} loads ${dep}`);
  }
  assert.deepEqual(through, []);
});

test("no engine module outside the views loads another in a loop", () => {
  const graph = engine();
  const outside = (file: string) => !file.startsWith("src/views/");
  const loops: string[] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (file: string, path: string[]): void => {
    if (state.get(file) === "done") return;
    if (state.get(file) === "open") return void loops.push([...path.slice(path.indexOf(file)), file].join(" → "));
    state.set(file, "open");
    for (const dep of graph.get(file) ?? []) if (outside(dep)) visit(dep, [...path, file]);
    state.set(file, "done");
  };
  for (const file of graph.keys()) if (outside(file)) visit(file, []);
  assert.deepEqual(loops, []);
});
