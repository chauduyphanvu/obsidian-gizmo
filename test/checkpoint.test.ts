import assert from "node:assert/strict";
import { test } from "node:test";
import { logFolder } from "../src/ledger.ts";
import { DataLayer } from "../src/datalayer.ts";
import { IDS_KEY, Ledger, NOTE_ROWS, SETTLE_MS, isWhatIf, rowIdOf, type LedgerIO, type LedgerState } from "../src/ledger-store.ts";
import { fakeHost, later } from "./support/fakes.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1, 8, 0);
const DATA = "Apps/Kp data.md";
const enc = new TextEncoder();

/** Files in memory shared by every device, as a synced folder; `size` as a host knows it without reading. */
function vault() {
  const files = new Map<string, string>();
  const fms = new Map<string, Record<string, unknown>>();
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
    size: (p) => (files.has(p) ? enc.encode(files.get(p)!).length : undefined),
  };
  /** The same files without checkpoints and without sizes: a fold of every event, the answer to check against. */
  const plain: LedgerIO = { ...io, filesIn: (folder) => io.filesIn(folder).filter((p) => !p.includes("/checkpoint-")), size: undefined };
  const writeNote = async (fn: (fm: Record<string, unknown>) => void) => {
    const fm = structuredClone(fms.get(DATA) ?? {});
    fn(fm);
    fms.set(DATA, fm);
  };
  return { files, fms, io, plain, reads, writeNote };
}

function device(v: ReturnType<typeof vault>, id: string, clock = { now: T0 }) {
  return { id, clock, ledger: new Ledger(v.io, () => id, () => clock.now) };
}

const seen = (st: LedgerState) => ({
  lists: [...st.lists].map(([k, l]) => [k, l.rows.map((r) => [rowIdOf(r), { ...r }]), l.conflicts]),
  ticked: [...st.ticked], undone: [...st.undone].sort(),
});

/** What a fresh fold of every event gives, without checkpoints. */
async function truth(v: ReturnType<typeof vault>, now: number, caps: Record<string, number> = {}): Promise<ReturnType<typeof seen>> {
  const fresh = new Ledger(v.plain, () => "zzzz", () => now);
  fresh.setCaps(DATA, caps);
  return seen(await fresh.state(DATA));
}

const checkpoints = (v: ReturnType<typeof vault>) => [...v.files.keys()].filter((p) => p.includes("/checkpoint-"));
const logsRead = (v: ReturnType<typeof vault>) => v.reads.filter((p) => p.endsWith(".jsonl"));

/** A sample every 6 hours for 90 days on device a, snapshotted daily; a's checkpoint follows. */
async function history(v: ReturnType<typeof vault>, caps: Record<string, number> = { kp: 10_080 }) {
  const a = device(v, "a");
  a.ledger.setCaps(DATA, caps);
  for (let i = 0; i < 360; i++) {
    a.clock.now = T0 + i * 6 * 3_600_000;
    await a.ledger.write(DATA, [{ op: "add", l: "kp", row: `k${i}`, v: { kp: i % 9, i } }]);
    if (i % 4 === 3) await a.ledger.snapshot(DATA, {}, v.writeNote);
  }
  return a;
}

test("a device opening an app cold reads only the logs with events from the last week, and shows what folding them all would", async () => {
  const v = vault();
  const a = await history(v);
  assert.deepEqual(checkpoints(v), [`${logFolder(DATA)}/checkpoint-a.json`]);
  const logs = [...v.files.keys()].filter((p) => p.endsWith(".jsonl"));
  assert.equal(logs.length, 3, "August, September and October");
  v.reads.length = 0;
  const b = device(v, "b", { now: a.clock.now });
  b.ledger.setCaps(DATA, { kp: 10_080 });
  const st = await b.ledger.state(DATA);
  assert.deepEqual(logsRead(v), [logs.find((p) => p.endsWith("2026-10.jsonl"))], "only the month the last week is in");
  assert.equal(st.lists.get("kp")!.rows.length, 360);
  assert.deepEqual(seen(st), await truth(v, a.clock.now, { kp: 10_080 }));
});

test("the data note keeps a recorded list's newest 500 rows, with their ids; the checkpoint keeps what the note used to", async () => {
  const v = vault();
  const a = device(v, "a");
  a.ledger.setCaps(DATA, { kp: 10_080 });
  for (let i = 0; i < 600; i++) {
    a.clock.now = T0 + i * 3_600_000;
    await a.ledger.write(DATA, [{ op: "add", l: "kp", row: `k${i}`, v: { i } }]);
  }
  await a.ledger.snapshot(DATA, {}, v.writeNote);
  const fm = v.fms.get(DATA)!;
  assert.equal((fm.kp as unknown[]).length, NOTE_ROWS);
  assert.deepEqual((fm.kp as { i: number }[])[0], { i: 100 });
  assert.deepEqual((fm[IDS_KEY] as Record<string, string[]>).kp.slice(0, 2), ["k100", "k101"]);
  assert.equal(fm["gizmo-gone"], undefined);
  assert.equal((await a.ledger.state(DATA)).lists.get("kp")!.rows.length, 600, "the app has them all");
});

test("a hand edit to a trimmed note imports exactly what changed, not the rows it never held", async () => {
  const v = vault();
  const a = device(v, "a");
  a.ledger.setCaps(DATA, { kp: 10_080 });
  for (let i = 0; i < 600; i++) await a.ledger.write(DATA, [{ op: "add", l: "kp", row: `k${i}`, v: { i } }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote);
  (v.fms.get(DATA)!.kp as { i: number }[])[10] = { i: -1 };
  a.ledger.fileChanged(DATA);
  const ops = await a.ledger.importOps(DATA);
  assert.deepEqual(ops.map((o) => [o.op, "row" in o && o.op === "del" ? o.row : "v" in o ? o.v : undefined]), [["add", { i: -1 }], ["del", "k110"]]);
});

test("late events from two days ago, from a device that was offline, fold in order without reading the settled months", async () => {
  const v = vault();
  const a = await history(v);
  const b = device(v, "b", { now: a.clock.now - 2 * DAY });
  // b, offline two days ago, saved a sample and took one of a's away.
  await b.ledger.write(DATA, [{ op: "add", l: "kp", row: "late", v: { kp: 1, i: -1 } }]);
  await b.ledger.write(DATA, [{ op: "del", l: "kp", row: "k355" }]);
  for (const p of v.files.keys()) a.ledger.fileChanged(p);
  v.reads.length = 0;
  const st = await a.ledger.state(DATA);
  assert.ok(logsRead(v).length && logsRead(v).every((p) => p.endsWith("2026-10.jsonl")), JSON.stringify(logsRead(v)));
  assert.deepEqual(seen(st), await truth(v, a.clock.now, { kp: 10_080 }));
  assert.ok(st.lists.get("kp")!.rows.some((r) => r.i === -1) && !st.lists.get("kp")!.rows.some((r) => r.i === 355));
});

test("a late event from before the settled time, or an undo of a settled event, comes out as folding everything would", async () => {
  for (const late of ["old event", "undo"] as const) {
    const v = vault();
    const a = await history(v);
    const b = device(v, "b", { now: late === "old event" ? T0 + 30 * DAY : a.clock.now });
    if (late === "old event") await b.ledger.write(DATA, [{ op: "set", l: "kp", row: "k10", f: "kp", v: 99, from: 1 }]);
    else {
      const stamp = new Date(T0 + 3 * 6 * 3_600_000).toISOString();
      await b.ledger.write(DATA, [{ op: "undo", ev: [`a@${stamp}/0`] }]);
    }
    for (const p of v.files.keys()) a.ledger.fileChanged(p);
    const st = await a.ledger.state(DATA);
    assert.deepEqual(seen(st), await truth(v, a.clock.now, { kp: 10_080 }), late);
    if (late === "undo") assert.ok(!st.lists.get("kp")!.rows.some((r) => r.i === 3), "the undone sample is gone");
    else assert.equal(st.lists.get("kp")!.rows.find((r) => r.i === 10)!.kp, 99);
    // The device that found its checkpoint out of date writes another at its next snapshot, and folds on from it.
    await a.ledger.snapshot(DATA, {}, v.writeNote);
    v.reads.length = 0;
    const c = device(v, "c", { now: a.clock.now });
    c.ledger.setCaps(DATA, { kp: 10_080 });
    const onC = seen(await c.ledger.state(DATA));
    const read = logsRead(v);
    assert.deepEqual(onC, await truth(v, a.clock.now, { kp: 10_080 }));
    assert.deepEqual(read, ["Apps/Kp data/log/a-2026-10.jsonl", ...(late === "undo" ? ["Apps/Kp data/log/b-2026-10.jsonl"] : [])], late);
  }
});

test("a set that didn't see one now settled is still told as a conflict, from the cell the checkpoint keeps", async () => {
  const v = vault();
  const a = device(v, "a");
  await a.ledger.write(DATA, [{ op: "add", l: "s", row: "r1", v: { who: "x" } }]);
  a.clock.now += DAY;
  await a.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "who", v: "Ann", from: "x" }]);
  // Nine days on, a's set is settled; b, offline for a week, set the same cell from what it last saw.
  a.clock.now += 9 * DAY;
  await a.ledger.write(DATA, [{ op: "add", l: "s", row: "r2", v: { who: "y" } }]);
  await a.ledger.snapshot(DATA, {}, v.writeNote);
  assert.equal(checkpoints(v).length, 1);
  const b = device(v, "b", { now: a.clock.now - 3 * DAY });
  await b.ledger.write(DATA, [{ op: "set", l: "s", row: "r1", f: "who", v: "Bo", from: "x" }]);
  for (const p of v.files.keys()) a.ledger.fileChanged(p);
  const st = await a.ledger.state(DATA);
  assert.deepEqual(st.lists.get("s")!.conflicts.map((c) => [c.field, c.value]), [["who", "Ann"]]);
  assert.deepEqual(seen(st), await truth(v, a.clock.now));
});

test("devices writing over weeks, offline and late, undoing and snapshotting at random always read what a fold of everything reads", async () => {
  let withCheckpoints = 0;
  for (let seed = 1; seed <= 40; seed++) {
    // mulberry32: the low bits of a plain LCG cycle too fast for days to pass at random.
    let a = seed;
    const rand = (n: number) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const v = vault();
    const ds = ["a", "b", "c"].map((id) => ({ ...device(v, id, { now: T0 }), offline: false }));
    const made: string[] = [];
    for (let step = 0; step < 120; step++) {
      const d = ds[rand(3)];
      // Hours to days pass; a device offline keeps its own clock, and writes what syncs late.
      d.clock.now += rand(5) * 3_600_000 + (rand(4) === 0 ? rand(4) * DAY : 0);
      for (const x of ds) if (!x.offline) x.clock.now = Math.max(x.clock.now, d.clock.now);
      const kind = rand(10);
      const shown = (await d.ledger.state(DATA)).lists.get("x")?.rows ?? [];
      const ids = shown.map((r) => rowIdOf(r)!);
      if (kind <= 2 || !ids.length) made.push(...await d.ledger.write(DATA, [{ op: "add", l: "x", row: d.ledger.newRowId(), v: { n: step } }]));
      else if (kind <= 4) {
        const i = rand(ids.length);
        await d.ledger.write(DATA, [{ op: "set", l: "x", row: ids[i], f: "n", v: step, from: shown[i].n }]);
      } else if (kind === 5) await d.ledger.write(DATA, [{ op: "del", l: "x", row: ids[rand(ids.length)] }]);
      else if (kind === 6) await d.ledger.write(DATA, [{ op: rand(2) ? "tick" : "untick", l: "c", item: `i${rand(3)}` }]);
      else if (kind === 7 && made.length) await d.ledger.write(DATA, [{ op: rand(3) ? "undo" : "redo", ev: [made[rand(made.length)]] }]);
      else if (kind === 8) d.offline = !d.offline;
      else await d.ledger.snapshot(DATA, {}, v.writeNote);
      for (const x of ds) if (!x.offline) for (const p of v.files.keys()) x.ledger.fileChanged(p);
      for (const x of ds) {
        if (x.offline) continue;
        assert.deepEqual(seen(await x.ledger.state(DATA)), await truth(v, x.clock.now), `seed ${seed}, step ${step}, device ${x.id}`);
      }
    }
    if (checkpoints(v).length) withCheckpoints++;
  }
  assert.ok(withCheckpoints >= 20, `checkpoints were written in ${withCheckpoints} runs`);
  assert.equal(SETTLE_MS, 7 * DAY);
});

test("a data note with recorded lists is snapshotted a moment after a change, then at most once a gap; others soon after each; what's waiting is written on quit", async () => {
  const f = fakeHost({});
  f.host.now = () => Date.now();
  const data = new DataLayer(f.host);
  const wrote: number[] = [];
  const start = Date.now();
  data.setSnapshots({ isRunner: () => true, delayMs: 20, gapMs: 300, later, writeNote: async () => { wrote.push(Date.now() - start); } });
  const log = "Apps/Kp data/log/d1mac000-2026-11.jsonl";
  data.ledger!.setCaps("Apps/Kp data.md", { kp: 10_080 });
  const event = (n: number) => `{"t":"2026-11-18T12:00:0${n}.000Z/0","d":"d1mac000","op":"add","l":"kp","row":"r${n}","v":{"n":${n}}}\n`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await f.host.append!(log, event(1));
  data.fileChanged(log);
  await sleep(80);
  assert.equal(wrote.length, 1, "the first change after a quiet spell, soon");
  for (const n of [2, 3, 4]) {
    await f.host.append!(log, event(n));
    data.fileChanged(log);
    await sleep(40);
  }
  assert.equal(wrote.length, 1, "changes inside the gap wait for its end");
  await sleep(300);
  assert.equal(wrote.length, 2, "one write for all of them");
  assert.ok(wrote[1] >= 300, `${wrote[1]} ms`);
  await f.host.append!(log, event(5));
  data.fileChanged(log);
  await data.flushSnapshots();
  assert.equal(wrote.length, 3, "quitting writes what was waiting");
  // A note a person saves to, with nothing recorded, isn't held back by the gap.
  const chores = "Apps/Chores data/log/d1mac000-2026-11.jsonl";
  for (const n of [6, 7]) {
    await f.host.append!(chores, event(n));
    data.fileChanged(chores);
    await sleep(80);
  }
  assert.equal(wrote.length, 5, "each a moment after its save");
  data.dispose();
});

test("a device that doesn't know a list's cap yet (an app just opened) still folds on from the checkpoint; two readers at once read each log once", async () => {
  const v = vault();
  const a = await history(v);
  v.reads.length = 0;
  const b = device(v, "b", { now: a.clock.now });
  const [one, two] = await Promise.all([b.ledger.state(DATA), b.ledger.state(DATA)]);
  assert.deepEqual(logsRead(v), [logFolder(DATA) + "/a-2026-10.jsonl"], "only the last week's log, once");
  assert.equal(v.reads.filter((p) => p.includes("/checkpoint-")).length, 1, "the checkpoint once");
  assert.deepEqual(seen(one), seen(two));
  assert.deepEqual(seen(one), await truth(v, a.clock.now, { kp: 10_080 }));
  // Its cap known, it folds again from the checkpoint, reading nothing more.
  v.reads.length = 0;
  b.ledger.setCaps(DATA, { kp: 10_080 });
  const known = seen(await b.ledger.state(DATA));
  assert.deepEqual(v.reads, [], "nothing read again");
  assert.deepEqual(known, await truth(v, a.clock.now, { kp: 10_080 }));
});

test("a checkpoint cut to fewer rows than a list now keeps isn't used, and the next snapshot writes one that is", async () => {
  const v = vault();
  const a = await history(v, { kp: 100 });
  v.reads.length = 0;
  const b = device(v, "b", { now: a.clock.now });
  b.ledger.setCaps(DATA, { kp: 10_080 });
  const st = await b.ledger.state(DATA);
  assert.equal(st.lists.get("kp")!.rows.length, 360, "all of them, from every log");
  assert.equal(logsRead(v).length, 3);
  a.ledger.setCaps(DATA, { kp: 10_080 });
  await a.ledger.snapshot(DATA, {}, v.writeNote);
  v.reads.length = 0;
  const c = device(v, "c", { now: a.clock.now });
  c.ledger.setCaps(DATA, { kp: 10_080 });
  assert.equal((await c.ledger.state(DATA)).lists.get("kp")!.rows.length, 360);
  assert.equal(logsRead(v).length, 1);
});

test("with a device's what-if branch beside the logs, every device still reads what a fold of the logs reads, and the branch reads what a fold of the logs and the branch reads", async () => {
  /** What a fresh fold of every event and device a's branch gives, without checkpoints. */
  const withBranch = async (v: ReturnType<typeof vault>, now: number) => {
    const fresh = new Ledger(v.plain, () => "a", () => now, undefined, "Budget");
    const st = await fresh.state(DATA);
    return { ...seen(st), whatIf: [...st.lists].map(([k, l]) => [k, l.rows.filter(isWhatIf).map((r) => rowIdOf(r))]) };
  };
  let branched = 0;
  for (let seed = 1; seed <= 40; seed++) {
    let a = seed;
    const rand = (n: number) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const v = vault();
    const ds = ["a", "b", "c"].map((id) => ({ ...device(v, id, { now: T0 }), offline: false }));
    // Device a's what-if, on a's clock: it reads the logs as a does and writes only its branch.
    const ahead = new Ledger(v.io, () => "a", () => ds[0].clock.now, undefined, "Budget");
    const made: string[] = [];
    for (let step = 0; step < 120; step++) {
      const which = rand(4);
      if (which === 3) {
        if (ds[0].offline) continue;
        const shown = (await ahead.state(DATA)).lists.get("x")?.rows ?? [];
        const mine = shown.filter(isWhatIf);
        const kind = rand(6);
        if (kind <= 2 || !mine.length) await ahead.write(DATA, [{ op: "add", l: "x", row: ahead.newRowId(), v: { n: step, whatIf: true } }]);
        else if (kind <= 4) {
          const r = mine[rand(mine.length)];
          await ahead.write(DATA, [{ op: "set", l: "x", row: rowIdOf(r)!, f: "n", v: step, from: r.n }]);
        } else await ahead.write(DATA, [{ op: "del", l: "x", row: rowIdOf(mine[rand(mine.length)])! }]);
        if (rand(15) === 0) await ahead.discard(DATA);
      } else {
        const d = ds[which];
        d.clock.now += rand(5) * 3_600_000 + (rand(4) === 0 ? rand(4) * DAY : 0);
        for (const x of ds) if (!x.offline) x.clock.now = Math.max(x.clock.now, d.clock.now);
        const kind = rand(10);
        const shown = (await d.ledger.state(DATA)).lists.get("x")?.rows ?? [];
        const ids = shown.map((r) => rowIdOf(r)!);
        if (kind <= 2 || !ids.length) made.push(...await d.ledger.write(DATA, [{ op: "add", l: "x", row: d.ledger.newRowId(), v: { n: step } }]));
        else if (kind <= 4) {
          const i = rand(ids.length);
          await d.ledger.write(DATA, [{ op: "set", l: "x", row: ids[i], f: "n", v: step, from: shown[i].n }]);
        } else if (kind === 5) await d.ledger.write(DATA, [{ op: "del", l: "x", row: ids[rand(ids.length)] }]);
        else if (kind === 6) await d.ledger.write(DATA, [{ op: rand(2) ? "tick" : "untick", l: "c", item: `i${rand(3)}` }]);
        else if (kind === 7 && made.length) await d.ledger.write(DATA, [{ op: rand(3) ? "undo" : "redo", ev: [made[rand(made.length)]] }]);
        else if (kind === 8) d.offline = !d.offline;
        else await d.ledger.snapshot(DATA, {}, v.writeNote);
      }
      for (const x of ds) if (!x.offline) for (const p of v.files.keys()) x.ledger.fileChanged(p);
      if (!ds[0].offline) for (const p of v.files.keys()) ahead.fileChanged(p);
      for (const x of ds) {
        if (x.offline) continue;
        assert.deepEqual(seen(await x.ledger.state(DATA)), await truth(v, x.clock.now), `seed ${seed}, step ${step}, device ${x.id}`);
      }
      if (ds[0].offline) continue;
      const st = await ahead.state(DATA);
      const got = { ...seen(st), whatIf: [...st.lists].map(([k, l]) => [k, l.rows.filter(isWhatIf).map((r) => rowIdOf(r))]) };
      assert.deepEqual(got, await withBranch(v, ds[0].clock.now), `seed ${seed}, step ${step}, the branch`);
    }
    const branch = `${logFolder(DATA)}/a.Budget.branch`;
    if (v.files.get(branch)) branched++;
    // Nothing but the branch ledger wrote the branch, and it wrote nothing else.
    assert.ok([...v.files.keys()].every((p) => p === branch || p.endsWith(".jsonl") || p.includes("/checkpoint-") || p.endsWith("/base.json")), [...v.files.keys()].join(", "));
  }
  assert.ok(branched >= 20, `a branch held events at the end of ${branched} runs`);
});
