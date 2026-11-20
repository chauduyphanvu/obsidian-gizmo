import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { NoteReader } from "../src/expand.ts";
import { isAllowed, migrateGrants } from "../src/grants.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readComponentPreview, readSpec } from "../src/spec.ts";
import { isApp, isComponent } from "../src/store.ts";
import { parseYaml } from "./support/yaml.ts";

// What every app (and lens) of the test vault and the gallery asks for, as recorded in
// permissions-golden.json. Grants are kept on every device, so an allowed app must stay allowed
// after an update: what it asks for now must be covered by what it asked for when recorded, once
// PERMISSION_MIGRATIONS has given old wordings their new ones. When an app is meant to ask for more,
// or a wording changes along with a migration, write the file again: GIZMO_UPDATE_GOLDEN=1 npm test.

const GOLDEN = new URL("./permissions-golden.json", import.meta.url);
const ROOTS = { vault: new URL("./vault/", import.meta.url), gallery: new URL("../gallery/", import.meta.url) };

function notesOf(root: URL): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (!rel.endsWith(".md")) continue;
    const text = readFileSync(new URL(rel, root), "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) continue;
    try {
      out[rel.split("\\").join("/")] = parseYaml(m[1]) as Record<string, unknown>;
    } catch {
      // A note made to be broken (the test vault keeps a few) asks for nothing.
    }
  }
  return out;
}

/** Each app's and lens's permissions, by `<root>:<path>`. */
function current(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, root] of Object.entries(ROOTS)) {
    const all = notesOf(root);
    const reader: NoteReader = {
      resolve: (link) => Object.keys(all).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
      frontmatter: (path) => all[path],
    };
    for (const [path, fm] of Object.entries(all).sort(([a], [b]) => a.localeCompare(b))) {
      if (isApp(fm)) {
        const spec = readSpec(fm, { path, notes: reader })?.spec;
        if (spec) out[`${name}:${path}`] = permissionsOf(spec, path);
      } else if (isComponent(fm)) {
        const preview = readComponentPreview(fm, { path, notes: reader });
        if (preview.lens && preview.result?.spec) out[`${name}:${path}`] = permissionsOf(preview.result.spec, path);
      }
    }
  }
  return out;
}

test("every app allowed as recorded stays allowed after an update: what it asks for now is covered, migrations applied", () => {
  const now = current();
  if (process.env.GIZMO_UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string[]>;
  assert.ok(Object.keys(golden).length > 40, "the vault's and the gallery's apps are all recorded");
  const grants = structuredClone(golden);
  migrateGrants(grants);
  const asksAgain = Object.entries(now).filter(([key, wanted]) => Object.hasOwn(grants, key) && !isAllowed(grants, key, wanted, true));
  assert.deepEqual(asksAgain.map(([key, wanted]) => `${key} now asks for ${wanted.filter((p) => !grants[key].includes(p)).join(", ")}`), [],
    "an allowed app would pause: add a migration if a wording changed, or write the file again if it is meant to ask for more");
  assert.deepEqual(Object.keys(now).filter((k) => !Object.hasOwn(golden, k)), [], "a new app: write the file again");
});
