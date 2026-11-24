import assert from "node:assert/strict";
import { test } from "node:test";
import { vaultWrites, type VaultFiles } from "../src/vault-ops.ts";

/** Files in memory, as a folder on disk; `onRead` lets a test edit a file between a read and a write. */
function disk(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const log: string[] = [];
  let onRead: ((path: string, n: number) => void) | undefined;
  let reads = 0;
  const fs: VaultFiles = {
    normalize: (p) => p.replace(/\/+/g, "/"),
    exists: (p) => files.has(p),
    read: async (p) => {
      onRead?.(p, ++reads);
      if (!files.has(p)) throw new Error(`no ${p}`);
      return files.get(p)!;
    },
    write: async (p, text) => { log.push(`write ${p}`); files.set(p, text); },
    append: async (p, text) => { log.push(`append ${p}`); files.set(p, files.get(p)! + text); },
    create: async (p, text) => {
      if (files.has(p)) throw new Error(`${p} exists`);
      log.push(`create ${p}`);
      files.set(p, text);
    },
    processFrontmatter: async (p, fn) => {
      const fm = JSON.parse(files.get(p) || "{}") as Record<string, unknown>;
      fn(fm);
      log.push(`fm ${p}`);
      files.set(p, JSON.stringify(fm));
    },
    trash: async (p) => { log.push(`trash ${p}`); files.delete(p); },
  };
  return { files, log, fs, set onRead(f: typeof onRead) { onRead = f; } };
}

test("a line added while someone else edits the note keeps their edit: read again before writing, and made again", async () => {
  const d = disk({ "Daily.md": "# Today\n" });
  const w = vaultWrites(d.fs, JSON.stringify);
  // Between the read the line is added to and the check before writing, the person types.
  d.onRead = (_p, n) => { if (n === 1) d.files.set("Daily.md", "# Today\nTyped meanwhile\n"); };
  assert.equal(await w.appendLine("Daily.md", "- 09:00 walked"), false);
  assert.equal(d.files.get("Daily.md"), "# Today\nTyped meanwhile\n- 09:00 walked\n");
  assert.equal(await w.appendLine("New.md", "- first"), true, "made the note");
  assert.equal(d.files.get("New.md"), "- first\n");
});

test("a task is ticked from the text as it is when written; one that moved or changed isn't ticked at all", async () => {
  const d = disk({ "Tasks.md": "- [ ] Call\n- [ ] Pay\n" });
  const w = vaultWrites(d.fs, JSON.stringify);
  assert.equal(await w.setTaskDone("Tasks.md", 1, "Pay", true), true);
  assert.equal(d.files.get("Tasks.md"), "- [ ] Call\n- [x] Pay\n");
  assert.equal(await w.setTaskDone("Tasks.md", 0, "Email", true), false, "not there");
  assert.equal(await w.setTaskDone("Gone.md", 0, "Call", true), false);
  d.log.length = 0;
  assert.equal(await w.setTaskDone("Tasks.md", 1, "Pay", true), true, "already ticked");
  assert.deepEqual(d.log, [], "nothing to write, so nothing written");
});

test("writes to one note run one after another; the policy note is never written; a note made is never overwritten", async () => {
  const d = disk({ "Apps/A data.md": "{}" });
  // YAML as a host writes it, ending in a line break.
  const w = vaultWrites(d.fs, (fm) => `${JSON.stringify(fm)}\n`);
  await Promise.all([1, 2, 3].map((n) => w.writeFrontmatter("Apps/A data.md", (fm) => { fm.list = [...(fm.list as number[] ?? []), n]; })));
  assert.deepEqual(JSON.parse(d.files.get("Apps/A data.md")!).list, [1, 2, 3]);
  await assert.rejects(w.writeFrontmatter("Gizmo POLICY.md", () => {}), /your Gizmo policy/);
  await assert.rejects(w.appendLine("gizmo policy.md", "x"), /your Gizmo policy/);
  // Whatever the host makes of a path, another spelling of the policy note's is still the policy note's.
  for (const path of ["./Gizmo policy.md", "Gizmo policy.md/", ".//gizmo policy.md", "Gizmo policy.md/."]) await assert.rejects(w.appendLine(path, "x"), /your Gizmo policy/, path);
  for (const path of ["Apps/../Gizmo policy.md", "../Outside.md", "/etc/x.md", ""]) await assert.rejects(w.appendLine(path, "x"), /isn't a path in this vault/, path);
  assert.deepEqual(d.log.filter((l) => /policy|Outside|etc/i.test(l)), []);
  // A note's own path under another spelling is that note.
  await w.appendLine("./Notes//Daily.md", "- x");
  assert.equal(d.files.get("Notes/Daily.md"), "- x\n");
  assert.equal(await w.createNote("Bets/B.md", { stake: 5 }, "Body\n"), "---\n{\"stake\":5}\n---\nBody\n");
  assert.equal(await w.createNote("Bets/B.md", { stake: 9 }, ""), false);
  assert.equal(await w.updateFrontmatter("Nope.md", () => {}), false);
  await w.writeFrontmatter("Made.md", (fm) => { fm.a = 1; });
  assert.equal(d.files.get("Made.md"), "{\"a\":1}");
});

test("a note is trashed only while it holds what the app wrote", async () => {
  const d = disk({ "Bets/B.md": "made" });
  const w = vaultWrites(d.fs, JSON.stringify);
  assert.equal(await w.trashIf("Bets/B.md", (t) => t === "edited"), "changed");
  assert.equal(await w.trashIf("Bets/B.md", (t) => t === "made"), "trashed");
  assert.equal(await w.trashIf("Bets/B.md", () => true), "gone");
});

test("a write to a note that vanished a moment before writes nothing and says so", async () => {
  const d = disk({ "N.md": "{}" });
  const fs: VaultFiles = { ...d.fs, processFrontmatter: async () => { throw new Error("ENOENT"); }, vanished: async () => true };
  assert.equal(await vaultWrites(fs, JSON.stringify).updateFrontmatter("N.md", () => {}), false);
  const still: VaultFiles = { ...fs, vanished: async () => false };
  await assert.rejects(vaultWrites(still, JSON.stringify).updateFrontmatter("N.md", () => {}), /ENOENT/);
});
