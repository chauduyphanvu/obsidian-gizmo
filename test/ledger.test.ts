import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Clock, baseIds, eventId, eventLine, eventsAt, fold, logFile, logFileParts, newRowId, parseLog, type LedgerEvent, type Op,
} from "../src/ledger.ts";

const T0 = Date.UTC(2026, 10, 19, 8, 14, 3, 112);

/** Events a device writes with its own clock, `ms` apart from T0. */
function writer(d: string) {
  const clock = new Clock();
  return (ms: number, op: Op): LedgerEvent => ({ ...op, t: clock.next(T0 + ms), d } as LedgerEvent);
}

/** A seeded shuffle, so a failure can be run again. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("a clock never goes back, and after hearing of a later event it writes after that one", () => {
  const c = new Clock();
  assert.equal(c.next(T0), "2026-11-19T08:14:03.112Z/0");
  assert.equal(c.next(T0), "2026-11-19T08:14:03.112Z/1");
  assert.equal(c.next(T0 - 5000), "2026-11-19T08:14:03.112Z/2", "a clock set back doesn't write in the past");
  c.seen("2026-11-19T09:00:00.000Z/4");
  assert.equal(c.next(T0), "2026-11-19T09:00:00.000Z/5");
});

test("log files are one per device and month; a sync's copy is read as the same device's", () => {
  assert.equal(logFile("Apps/Budget data.md", "d1mac000", new Date(T0)), "Apps/Budget data/log/d1mac000-2026-11.jsonl");
  assert.deepEqual(logFileParts("Apps/Budget data/log/d1mac000-2026-11.jsonl"), { device: "d1mac000", month: "2026-11" });
  assert.deepEqual(logFileParts("Apps/Budget data/log/d1mac000-2026-11 2.jsonl"), { device: "d1mac000", month: "2026-11" });
  assert.equal(logFileParts("Apps/Budget data/log/notes.md"), undefined);
});

test("a log is read line by line; a line cut short or edited into nonsense is skipped and counted", () => {
  const w = writer("a");
  const e = w(0, { op: "add", l: "spend", row: "r1", v: { amount: 5 } });
  const text = `${eventLine(e)}{"t":"2026-11-19T08:14:04.000Z/0","d":"a","op":"add","l":"spend"\n{"op":"tick"}\n`;
  const r = parseLog(text);
  assert.deepEqual(r.events, [e]);
  assert.equal(r.bad, 2);
});

test("folding is independent of the order files and lines were read in", () => {
  const a = writer("a");
  const b = writer("b");
  const events = [
    a(0, { op: "add", l: "spend", row: "r1", v: { amount: 5 } }),
    b(1, { op: "add", l: "spend", row: "r2", v: { amount: 7 } }),
    a(2, { op: "set", l: "spend", row: "r2", f: "note", v: "lunch", from: undefined }),
    b(3, { op: "tick", l: "packed", item: "Passport" }),
    a(3, { op: "tick", l: "packed", item: "Charger" }),
    b(4, { op: "del", l: "spend", row: "r1" }),
    a(5, { op: "add", l: "spend", row: "r3", v: { amount: 1 } }),
  ];
  const want = fold(events);
  for (let seed = 1; seed <= 50; seed++) {
    const got = fold(shuffled(events, seed));
    assert.deepEqual(got.lists, want.lists, `seed ${seed}`);
    assert.deepEqual(got.ticked, want.ticked, `seed ${seed}`);
  }
  assert.deepEqual(want.lists.get("spend")!.rows, [{ amount: 7, note: "lunch" }, { amount: 1 }]);
  assert.deepEqual(want.ticked.get("packed"), ["Charger", "Passport"], "at the same moment, by device");
});

test("two devices writing at random, read in any order, always fold the same", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const a = writer("a");
    const b = writer("b");
    const events: LedgerEvent[] = [];
    let s = seed;
    const rand = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const w = rand(2) ? a : b;
      const ms = rand(5) * 1000;
      const kind = rand(4);
      if (kind === 0 || !ids.length) {
        const row = `r${i}`;
        ids.push(row);
        events.push(w(ms, { op: "add", l: "x", row, v: { n: i } }));
      } else if (kind === 1) events.push(w(ms, { op: "del", l: "x", row: ids[rand(ids.length)] }));
      else if (kind === 2) events.push(w(ms, { op: "set", l: "x", row: ids[rand(ids.length)], f: "n", v: i, from: rand(3) }));
      else events.push(w(ms, { op: rand(2) ? "tick" : "untick", l: "c", item: `i${rand(4)}` }));
    }
    const want = fold(events);
    assert.deepEqual(fold(shuffled(events, seed * 7)), want, `seed ${seed}`);
  }
});

test("a sync's second copy of a file changes nothing, and an add for a row that exists is ignored", () => {
  const a = writer("a");
  const add = a(0, { op: "add", l: "s", row: "r1", v: { n: 1 } });
  const again = { ...a(1, { op: "add", l: "s", row: "r1", v: { n: 2 } }) };
  const once = fold([add, again]);
  assert.deepEqual(fold([add, again, add, again]), once);
  assert.deepEqual(once.lists.get("s")!.rows, [{ n: 1 }]);
});

test("undo takes events back from any device, after later edits; redo puts them back", () => {
  const a = writer("a");
  const b = writer("b");
  const add = a(0, { op: "add", l: "s", row: "r1", v: { amount: 5 } });
  const edit = b(1, { op: "set", l: "s", row: "r1", f: "amount", v: 6, from: 5 });
  const other = a(2, { op: "add", l: "s", row: "r2", v: { amount: 9 } });
  const undoEdit = a(3, { op: "undo", ev: [eventId(edit)] });
  assert.deepEqual(fold([add, edit, other, undoEdit]).lists.get("s")!.rows, [{ amount: 5 }, { amount: 9 }]);
  const undoAdd = b(4, { op: "undo", ev: [eventId(add)] });
  const after = fold([add, edit, other, undoEdit, undoAdd]);
  assert.deepEqual(after.lists.get("s")!.rows, [{ amount: 9 }]);
  assert.ok(after.undone.has(eventId(add)));
  const redo = a(5, { op: "redo", ev: [eventId(add)] });
  assert.deepEqual(fold([add, edit, other, undoEdit, undoAdd, redo]).lists.get("s")!.rows, [{ amount: 5 }, { amount: 9 }]);
});

test("two devices that set one cell from the same value: the later wins and the other is kept as a conflict", () => {
  const a = writer("a");
  const b = writer("b");
  const add = a(0, { op: "add", l: "s", row: "r1", v: { note: "x" } });
  const mine = a(1000, { op: "set", l: "s", row: "r1", f: "note", v: "lunch", from: "x" });
  const theirs = b(1000, { op: "set", l: "s", row: "r1", f: "note", v: "dinner", from: "x" });
  const f = fold([add, mine, theirs]);
  assert.deepEqual(f.lists.get("s")!.rows, [{ note: "dinner" }]);
  assert.deepEqual(f.lists.get("s")!.conflicts, [{ row: "r1", field: "note", value: "lunch", by: "a", t: mine.t }]);
  const settle = a(2000, { op: "set", l: "s", row: "r1", f: "note", v: "lunch", from: "dinner" });
  assert.deepEqual(fold([add, mine, theirs, settle]).lists.get("s")!.conflicts, [], "picking one settles it");
  const inTurn = b(3000, { op: "set", l: "s", row: "r1", f: "note", v: "tea", from: "lunch" });
  assert.deepEqual(fold([add, mine, inTurn]).lists.get("s")!.conflicts, [], "a set that saw the last one is no conflict");
});

test("rows from a note get ids from what they hold and which copy they are, so an insert above doesn't move them", () => {
  const before = baseIds([{ a: 1 }, { a: 2 }, { a: 1 }]);
  const after = baseIds([{ a: 0 }, { a: 1 }, { a: 2 }, { a: 1 }]);
  assert.equal(new Set(before).size, 3);
  assert.deepEqual(after.slice(1), before);
  assert.match(before[0], /^[0-9a-f]{16}$/);
  assert.notEqual(newRowId("a", "x"), newRowId("b", "x"));
});

test("folding starts from a base; a recorded list keeps its newest rows; the data at a time leaves out later events", () => {
  const a = writer("a");
  const ids = baseIds([{ n: 1 }, { n: 2 }]);
  const events = [a(0, { op: "add", l: "s", row: "r3", v: { n: 3 } }), a(60_000, { op: "del", l: "s", row: ids[0] })];
  const base = { lists: { s: { rows: [{ n: 1 }, { n: 2 }], ids } }, ticked: { c: ["x"] } };
  assert.deepEqual(fold(events, base).lists.get("s")!.rows, [{ n: 2 }, { n: 3 }]);
  assert.deepEqual(fold(events, base, { s: 1 }).lists.get("s")!.rows, [{ n: 3 }]);
  assert.deepEqual(fold(eventsAt(events, T0 + 30_000), base).lists.get("s")!.rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(fold(events, base).ticked.get("c"), ["x"]);
});

test("a row two runners added under one id goes when either add is undone; a deleted row stays deleted when a late copy of its add arrives", () => {
  const a = writer("a");
  const b = writer("b");
  const addA = a(0, { op: "add", l: "x", row: "r1", v: { n: 1 } });
  const addB = b(10, { op: "add", l: "x", row: "r1", v: { n: 1 } });
  assert.deepEqual(fold([addA, addB]).lists.get("x")!.rows, [{ n: 1 }]);
  const undo = a(20, { op: "undo", ev: [eventId(addA)] });
  assert.deepEqual(fold([addA, addB, undo]).lists.get("x")!.rows, []);
  assert.deepEqual(fold([addA, addB, undo, a(30, { op: "redo", ev: [eventId(addA)] })]).lists.get("x")!.rows, [{ n: 1 }]);
  const del = a(40, { op: "del", l: "x", row: "r1" });
  const late = b(50, { op: "add", l: "x", row: "r1", v: { n: 1 } });
  assert.deepEqual(fold([addA, del, late]).lists.get("x")!.rows, []);
});
