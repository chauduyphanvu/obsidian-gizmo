import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeAppEnv, type HostParts } from "../src/app-env.ts";
import { runtimeOn } from "./support/runtime.ts";

function parts(over: Partial<HostParts> = {}): HostParts & { told: string[]; filled: string[] } {
  const told: string[] = [];
  const filled: string[] = [];
  return {
    told, filled,
    readBody: async () => "",
    notify: (m) => { told.push(m); },
    openNote: () => {},
    showSource: () => {},
    showSourceAt: () => {},
    sourceLines: async () => [],
    copy: () => {},
    tryFirst: () => {},
    explain: () => {},
    fill: (line) => { filled.push(line); },
    ...over,
  };
}

test("an app's environment on any host: reads, writes, grants and undo through the runtime; the rest is the host's", async () => {
  const t = await runtimeOn({ "Books/Emma.md": { fm: { status: "to read" }, body: "" } });
  const host = parts();
  const env = runtimeAppEnv(t.runtime, host);
  assert.deepEqual(env.frontmatter("Books/Emma.md"), { status: "to read" });

  assert.equal(env.isGranted("Apps/Books.md", ["read:Books"]), false);
  await env.grant("Apps/Books.md", ["read:Books"]);
  assert.equal(env.isGranted("Apps/Books.md", ["read:Books"]), true);
  assert.deepEqual(t.saved().grants, { "Apps/Books.md": ["read:Books"] });

  await env.writeFrontmatter("Books/Emma.md", (fm) => { fm.status = "read"; });
  assert.equal(t.f.files.get("Books/Emma.md")!.fm!.status, "read", "written through the runtime's writes");
  const entry = await env.log!({ app: "Apps/Books.md", actor: "you", what: "Mark read", changes: [{ kind: "property", path: "Books/Emma.md", field: "status", from: "to read", to: "read", had: true }] });
  assert.ok(entry);
  assert.equal(await env.undo!(entry.id), "Undone");
  assert.equal(t.f.files.get("Books/Emma.md")!.fm!.status, "to read");

  const store = env.store!("Apps/Books data.md", "Apps/Books.md");
  await store.add("books", { title: "Emma" });
  assert.equal((await t.runtime.dataLayer.ledger!.state("Apps/Books data.md", {})).lists.get("books")?.rows.length, 1, "rows kept in the ledger");

  env.notify("hi");
  env.asks!.fill("spend ", 6);
  assert.deepEqual([host.told, host.filled], [["hi"], ["spend "]]);
  assert.equal("addPanels" in env, false, "no Insert panel where the host can't show the note");
  assert.equal("addPanels" in runtimeAppEnv(t.runtime, parts({ addPanels: async () => ({ refusal: "x" }) })), true);
});
