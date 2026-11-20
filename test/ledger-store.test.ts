import assert from "node:assert/strict";
import { test } from "node:test";
import { logFile } from "../src/ledger.ts";
import { IDS_KEY, Ledger, ROW_ID, SNAPSHOT_KEY, listsHash, rowIdOf, type LedgerIO } from "../src/ledger-store.ts";

const T0 = Date.UTC(2026, 10, 19, 8, 0);

/** Files in memory, shared by every device's ledger as a synced folder would be. */
function vault(notes: Record<string, Record<string, unknown>> = {}) {
  const files = new Map<string, string>();
  const fms = new Map(Object.entries(notes));
  const reads: string[] = [];
  const io: LedgerIO = {
    filesIn: (folder) => [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    readFile: async (p) => {
      reads.push(p);
      if (!files.has(p)) throw new Error(`Can't find ${p}`);
      return files.get(p)!;
    },
    append: async (p, text) => { files.set(p, (files.get(p) ?? "") + text); },
    writeFile: async (p, text) => { files.set(p, text); },
    frontmatter: (p) => fms.get(p),
  };
  const writeNote = (path: string) => async (fn: (fm: Record<string, unknown>) => void) => {
    const fm = structuredClone(fms.get(path) ?? {});
    fn(fm);
    fms.set(path, fm);
  };
  return { files, fms, io, reads, writeNote };
}

function device(v: ReturnType<typeof vault>, id: string, clock = { now: T0 }) {
  const ledger = new Ledger(v.io, () => id, () => clock.now);
  return { ledger, clock };
}

const DATA = "Apps/Budget data.md";

test("each device appends to its own file; every device reads them all into the same lists, rows carrying their ids", async () => {
  const v = vault();
  const a = device(v, "a");
  const b = device(v, "b", { now: T0 + 1000 });
  await a.ledger.write(DATA, [{ op: "add", l: "spend", row: "r1", v: { amount: 5 } }]);
  await b.ledger.write(DATA, [{ op: "add", l: "spend", row: "r2", v: { amount: 7 } }]);
  assert.deepEqual([...v.files.keys()].sort(), [logFile(DATA, "a", new Date(T0)), logFile(DATA, "b", new Date(T0))].sort());
  for (const ids of ["a", "b"]) {
    const d = ids === "a" ? a : b;
    for (const p of v.files.keys()) d.ledger.fileChanged(p);
    const s = await d.ledger.state(DATA);
    assert.deepEqual(s.lists.get("spend")!.rows, [{ amount: 5 }, { amount: 7 }]);
    assert.deepEqual(s.lists.get("spend")!.rows.map(rowIdOf), ["r1", "r2"]);
  }
});

test("a file that grew is read only past what was read; a line still being written waits for its end", async () => {
  const v = vault();
  const a = device(v, "a");
  await a.ledger.write(DATA, [{ op: "add", l: "s", row: "r1", v: { n: 1 } }]);
  const reader = device(v, "r");
  await reader.ledger.state(DATA);
  const path = [...v.files.keys()][0];
  const whole = `{"t":"2026-11-19T08:00:01.000Z/0","d":"a","op":"add","l":"s","row":"r2","v":{"n":2}}\n`;
  v.files.set(path, v.files.get(path)! + whole.slice(0, 30));
  reader.ledger.fileChanged(path);
  assert.equal((await reader.ledger.state(DATA)).lists.get("s")!.rows.length, 1);
  v.files.set(path, v.files.get(path)!.slice(0, -30) + whole);
  reader.ledger.fileChanged(path);
  assert.equal((await reader.ledger.state(DATA)).lists.get("s")!.rows.length, 2);
});

test("a hand-kept data note is the base until the first snapshot, which keeps it beside the logs; later folds start there", async () => {
  const v = vault({ [DATA]: { spend: [{ amount: 1 }, { amount: 2 }], packed: ["Passport"] } });
  const a = device(v, "a");
  const s0 = await a.ledger.state(DATA);
  assert.deepEqual(s0.lists.get("spend")!.rows, [{ amount: 1 }, { amount: 2 }]);
  const [first] = s0.lists.get("spend")!.rows;
  await a.ledger.write(DATA, [
    { op: "set", l: "spend", row: rowIdOf(first)!, f: "amount", v: 10, from: 1 },
    { op: "tick", l: "packed", item: "Charger" },
  ]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  const fm = v.fms.get(DATA)!;
  assert.deepEqual(fm.spend, [{ amount: 10 }, { amount: 2 }]);
  assert.deepEqual(fm.packed, ["Passport", "Charger"]);
  assert.deepEqual(Object.keys(fm[SNAPSHOT_KEY] as object), ["files", "at"]);
  assert.equal((fm[IDS_KEY] as Record<string, string[]>).spend.length, 2);
  assert.ok(v.files.has("Apps/Budget data/log/base.json"));

  // A device that only reads starts at the snapshot and reads no event twice.
  const r = device(v, "r");
  const s = await r.ledger.state(DATA);
  assert.deepEqual(s.lists.get("spend")!.rows, [{ amount: 10 }, { amount: 2 }]);
  assert.equal(s.handEdited, false);
});

test("an event from before the snapshot that arrives after it, or an undo of an event inside it, makes a full fold", async () => {
  const v = vault();
  const a = device(v, "a", { now: T0 + 10_000 });
  const b = device(v, "b", { now: T0 + 15_000 });
  await a.ledger.write(DATA, [{ op: "add", l: "s", row: "r1", v: { note: "x" } }]);
  // b saw the row, then went offline.
  await b.ledger.state(DATA);
  a.clock.now = T0 + 20_000;
  const [setY] = await a.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "note", v: "y", from: "x" }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  // b set the note before a did; its file syncs in after the snapshot.
  await b.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "note", v: "z", from: "x" }]);
  const r = device(v, "r");
  const s = (await r.ledger.state(DATA)).lists.get("s")!;
  assert.deepEqual(s.rows, [{ note: "y" }], "the later set still wins");
  assert.deepEqual(s.conflicts.map((c) => c.value), ["z"], "and the other is kept");
  await a.ledger.write(DATA, [{ op: "undo", ev: [setY] }]);
  const r2 = device(v, "r2");
  assert.deepEqual((await r2.ledger.state(DATA)).lists.get("s")!.rows, [{ note: "z" }], "undoing y leaves the other set");
});

test("a data note edited by hand after a snapshot is noticed, and Import turns the edit into events", async () => {
  const v = vault();
  const a = device(v, "a");
  await a.ledger.write(DATA, [
    { op: "add", l: "spend", row: "r1", v: { amount: 5 } },
    { op: "add", l: "spend", row: "r2", v: { amount: 7 } },
    { op: "tick", l: "packed", item: "Passport" },
  ]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  const fm = v.fms.get(DATA)!;
  fm.spend = [{ amount: 5 }, { amount: 8 }, { amount: 1 }];
  fm.packed = ["Charger"];
  const s = await a.ledger.state(DATA);
  assert.equal(s.handEdited, true);
  assert.deepEqual(s.lists.get("spend")!.rows, [{ amount: 5 }, { amount: 7 }], "nothing is taken in by itself");
  const ops = await a.ledger.importOps(DATA);
  assert.deepEqual(ops.map((o) => o.op).sort(), ["add", "add", "del", "tick", "untick"]);
  await a.ledger.write(DATA, ops);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA), true);
  const after = await a.ledger.state(DATA);
  assert.equal(after.handEdited, false);
  assert.deepEqual(after.lists.get("spend")!.rows, [{ amount: 5 }, { amount: 8 }, { amount: 1 }]);
  assert.deepEqual(after.ticked.get("packed"), ["Charger"]);
  assert.equal(listsHash(v.fms.get(DATA)), v.fms.get(DATA)!["gizmo-hash"]);
});

test("lists typed in the app note are the base of lists the data note lacks, and edits to them are kept as events", async () => {
  const v = vault();
  const a = device(v, "a");
  const app = { flights: [{ code: "BA1" }, { code: "BA2" }] };
  const s = await a.ledger.state(DATA, app);
  const second = s.lists.get("flights")!.rows[1];
  assert.equal(typeof (second as Record<symbol, unknown>)[ROW_ID], "string");
  await a.ledger.write(DATA, [{ op: "set", l: "flights", row: rowIdOf(second)!, f: "seat", v: "4A", from: undefined }]);
  assert.deepEqual((await a.ledger.state(DATA, app)).lists.get("flights")!.rows, [{ code: "BA1" }, { code: "BA2", seat: "4A" }]);
});
