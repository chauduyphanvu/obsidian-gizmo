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
  a.ledger.fileChanged(DATA);
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

test("a cell two devices set at once is still offered both ways after a snapshot, until one is picked", async () => {
  const v = vault();
  const a = device(v, "a");
  const b = device(v, "b");
  await a.ledger.write(DATA, [{ op: "add", l: "s", row: "r1", v: { who: "x" } }]);
  await b.ledger.state(DATA);
  await a.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "who", v: "Ann", from: "x" }]);
  await b.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "who", v: "Bo", from: "x" }]);
  for (const p of v.files.keys()) a.ledger.fileChanged(p);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  const r = device(v, "r");
  const s = (await r.ledger.state(DATA)).lists.get("s")!;
  assert.equal(s.conflicts.length, 1, "read from the snapshot, which keeps the conflict");
  await a.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "who", v: s.conflicts[0].value, from: s.rows[0].who }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  assert.equal(v.fms.get(DATA)!["gizmo-conflicts"], undefined);
  assert.deepEqual((await device(v, "r2").ledger.state(DATA)).lists.get("s")!.conflicts, []);
});

test("devices writing, reading late, undoing and snapshotting at random always read what a fresh fold reads", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    let s = seed;
    const rand = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    const v = vault();
    const ds = ["a", "b", "c"].map((id) => ({ id, ...device(v, id, { now: T0 }), offline: false }));
    const made: { d: string; ev: string }[] = [];
    const rows = async () => (await ds[0].ledger.state(DATA)).lists.get("x")?.rows ?? [];
    const seen = (st: Awaited<ReturnType<Ledger["state"]>>) => ({
      lists: [...st.lists].map(([k, l]) => [k, l.rows.map((r) => [rowIdOf(r), { ...r }]), l.conflicts]),
      ticked: [...st.ticked], undone: [...st.undone].sort(),
    });
    for (let step = 0; step < 60; step++) {
      const d = ds[rand(3)];
      d.clock.now += rand(4) * 500;
      const kind = rand(10);
      const ids = (await rows()).map((r) => rowIdOf(r)!);
      if (kind <= 2 || !ids.length) made.push(...(await d.ledger.write(DATA, [{ op: "add", l: "x", row: d.ledger.newRowId(), v: { n: step } }])).map((ev) => ({ d: d.id, ev })));
      else if (kind <= 4) {
        const row = ids[rand(ids.length)];
        const shown = (await d.ledger.state(DATA)).lists.get("x")?.rows.find((r) => rowIdOf(r) === row);
        await d.ledger.write(DATA, [{ op: "set", l: "x", row, f: "n", v: step, from: shown?.n }]);
      } else if (kind === 5) await d.ledger.write(DATA, [{ op: "del", l: "x", row: ids[rand(ids.length)] }]);
      else if (kind === 6) await d.ledger.write(DATA, [{ op: rand(2) ? "tick" : "untick", l: "c", item: `i${rand(3)}` }]);
      else if (kind === 7 && made.length) await d.ledger.write(DATA, [{ op: rand(3) ? "undo" : "redo", ev: [made[rand(made.length)].ev] }]);
      else if (kind === 8) d.offline = !d.offline;
      else {
        await ds[0].ledger.snapshot(DATA, {}, v.writeNote(DATA));
        for (const x of ds) x.ledger.fileChanged(DATA);
      }
      // Every device that's online hears of every file; one offline hears nothing until it's back.
      for (const x of ds) if (!x.offline) for (const p of v.files.keys()) x.ledger.fileChanged(p);
      for (const x of ds) {
        if (x.offline) continue;
        const fresh = new Ledger(v.io, () => "zzzz", () => x.clock.now);
        assert.deepEqual(seen(await x.ledger.state(DATA)), seen(await fresh.state(DATA)), `seed ${seed}, step ${step}, device ${x.id}`);
      }
    }
  }
});

test("a list that starts empty keeps the rows added to it through a snapshot", async () => {
  const v = vault({ [DATA]: { spend: [], packed: ["Charger"] } });
  const a = device(v, "a");
  await a.ledger.write(DATA, [{ op: "tick", l: "packed", item: "Socks" }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  a.ledger.fileChanged(DATA);
  await a.ledger.write(DATA, [{ op: "add", l: "spend", row: "r1", v: { amount: 5 } }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  assert.deepEqual(v.fms.get(DATA)!.spend, [{ amount: 5 }]);
  assert.deepEqual((await device(v, "fresh").ledger.state(DATA)).lists.get("spend")!.rows, [{ amount: 5 }]);
});

test("lists typed in the app note are read with their ids after the data note has a snapshot, and an add keeps their rows", async () => {
  const app = { app: "Budget", cats: [{ n: "food" }, { n: "rent" }] };
  const v = vault();
  const a = device(v, "a");
  await a.ledger.write(DATA, [{ op: "add", l: "spend", row: "r1", v: { amount: 5 } }]);
  await a.ledger.snapshot(DATA, app, v.writeNote(DATA));
  const fresh = device(v, "b").ledger;
  const cats = (await fresh.state(DATA, app)).lists.get("cats")!;
  assert.deepEqual(cats.rows, [{ n: "food" }, { n: "rent" }]);
  assert.ok(cats.rows.every((r) => rowIdOf(r)));
  await fresh.write(DATA, [{ op: "add", l: "cats", row: "c3", v: { n: "fun" } }]);
  assert.deepEqual((await fresh.state(DATA, app)).lists.get("cats")!.rows.map((r) => r.n), ["food", "rent", "fun"]);
});

test("importing a hand edit to a recorded list leaves the rows its cap keeps out of the note alone", async () => {
  const v = vault();
  const a = device(v, "a");
  a.ledger.setCaps(DATA, { kp: 3 });
  for (let i = 0; i < 5; i++) await a.ledger.write(DATA, [{ op: "add", l: "kp", row: `k${i}`, v: { kp: i } }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  assert.deepEqual(v.fms.get(DATA)!.kp, [{ kp: 2 }, { kp: 3 }, { kp: 4 }]);
  (v.fms.get(DATA)!.kp as { kp: number }[])[2] = { kp: 40 };
  a.ledger.fileChanged(DATA);
  const ops = await a.ledger.importOps(DATA);
  assert.deepEqual(ops.map((o) => o.op).sort(), ["add", "del"], "only the row edited: one taken out, one put in");
});

test("discarding a hand edit takes out a list the edit added", async () => {
  const v = vault();
  const a = device(v, "a");
  await a.ledger.write(DATA, [{ op: "add", l: "spend", row: "r1", v: { amount: 5 } }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  v.fms.get(DATA)!.extra = [{ a: 1 }];
  a.ledger.fileChanged(DATA);
  assert.equal((await a.ledger.state(DATA)).handEdited, true);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA), true);
  a.ledger.fileChanged(DATA);
  assert.equal(v.fms.get(DATA)!.extra, undefined);
  assert.equal((await a.ledger.state(DATA)).handEdited, false);
});

test("a deleted row stays deleted after a snapshot when a late copy of its add arrives; a checklist emptied by hand unticks on Import; Discard keeps a list of text", async () => {
  const v = vault();
  const a = device(v, "a");
  const b = device(v, "b");
  await a.ledger.write(DATA, [{ op: "add", l: "s", row: "x", v: { n: 1 } }, { op: "add", l: "s", row: "y", v: { n: 2 } }, { op: "tick", l: "c", item: "milk" }]);
  await a.ledger.write(DATA, [{ op: "del", l: "s", row: "x" }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  // Another runner's add of the same row, later.
  b.clock.now += 60_000;
  await b.ledger.write(DATA, [{ op: "add", l: "s", row: "x", v: { n: 1 } }]);
  const fresh = device(v, "r").ledger;
  assert.deepEqual((await fresh.state(DATA)).lists.get("s")!.rows.map(rowIdOf), ["y"]);
  for (const p of v.files.keys()) a.ledger.fileChanged(p);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA));
  a.ledger.fileChanged(DATA);
  v.fms.get(DATA)!.c = [];
  a.ledger.fileChanged(DATA);
  assert.deepEqual(await a.ledger.importOps(DATA), [{ op: "untick", l: "c", item: "milk" }]);
  v.fms.get(DATA)!.people = ["[[Ann]]"];
  a.ledger.fileChanged(DATA);
  await a.ledger.snapshot(DATA, {}, v.writeNote(DATA), true);
  assert.deepEqual(v.fms.get(DATA)!.people, ["[[Ann]]"], "a list of text may be the person's own");
});
