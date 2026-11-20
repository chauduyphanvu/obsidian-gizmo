// A recorded app on a long history: a sample every 15 minutes for 105 days (10,080 samples), in the
// ledger's monthly files, with the data note snapshotted. Measures what one more sample writes, and
// what a device opening the app cold reads, how long it takes and how much memory it holds.
//
//   node --expose-gc test/perf/recorded.ts [--samples N] [--every MIN] [--iters N]
import { parseArgs } from "node:util";
import { Ledger, type LedgerIO } from "../../src/ledger-store.ts";
import { logFolder } from "../../src/ledger.ts";
import { stampOf } from "../../src/time.ts";

const { values: args } = parseArgs({
  options: {
    samples: { type: "string", default: "10080" },
    every: { type: "string", default: "15" },
    iters: { type: "string", default: "5" },
  },
});
const SAMPLES = Number(args.samples);
const EVERY = Number(args.every) * 60_000;
const DATA = "Apps/Kp data.md";
const LIST = "kp_log";
const CAP = 10_080;
const NOW = new Date(2026, 10, 18, 12, 0).getTime();
const enc = new TextEncoder();

/** A vault of text files and one note's frontmatter, counting what's read and written. */
function vault() {
  const files = new Map<string, string>();
  let fm: Record<string, unknown> = {};
  const count = { reads: 0, readBytes: 0, written: 0 };
  const io: LedgerIO = {
    filesIn: (folder) => [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    readFile: async (p) => {
      const text = files.get(p);
      if (text === undefined) throw new Error(`no ${p}`);
      count.reads++;
      count.readBytes += enc.encode(text).length;
      return text;
    },
    append: async (p, text) => { files.set(p, (files.get(p) ?? "") + text); count.written += enc.encode(text).length; },
    writeFile: async (p, text) => { files.set(p, text); count.written += enc.encode(text).length; },
    frontmatter: (p) => (p === DATA ? fm : undefined),
    size: (p) => { const t = files.get(p); return t === undefined ? undefined : enc.encode(t).length; },
  };
  const writeNote = async (fn: (fm: Record<string, unknown>) => void) => {
    const next = structuredClone(fm);
    fn(next);
    fm = next;
    count.written += enc.encode(JSON.stringify(fm)).length;
  };
  return { files, io, count, writeNote, note: () => fm };
}

function sample(i: number, at: number) {
  return { at: stampOf(new Date(at)), time_tag: new Date(at).toISOString(), kp_index: i % 9, estimated_kp: Math.round((i % 9) * 100 / 3) / 100 };
}

let clock = NOW - SAMPLES * EVERY;
const v = vault();
const ledger = new Ledger(v.io, () => "d1mac000", () => clock);
ledger.setCaps(DATA, { [LIST]: CAP });
for (let i = 0; i < SAMPLES; i++) {
  clock += EVERY;
  await ledger.write(DATA, [{ op: "add", l: LIST, row: ledger.newRowId(), v: sample(i, clock) }]);
  // The runner snapshots once a day while building, as a long history would have left it.
  if (i % 96 === 95) await ledger.snapshot(DATA, {}, v.writeNote);
}
await ledger.snapshot(DATA, {}, v.writeNote);
const noteBytes = enc.encode(JSON.stringify(v.note())).length;
const sizeOf = (keep: (p: string) => boolean) => [...v.files].filter(([p]) => p.startsWith(logFolder(DATA)) && keep(p)).reduce((n, [, t]) => n + enc.encode(t).length, 0);
const logBytes = sizeOf((p) => p.endsWith(".jsonl"));
const checkpointBytes = sizeOf((p) => p.includes("/checkpoint-"));

// One more sample, as the runner takes it: the event, then the snapshot.
v.count.written = 0;
clock += EVERY;
await ledger.write(DATA, [{ op: "add", l: LIST, row: ledger.newRowId(), v: sample(SAMPLES, clock) }]);
await ledger.snapshot(DATA, {}, v.writeNote);
const perSample = v.count.written;

const gc = (globalThis as { gc?: () => void }).gc;
const opens: number[] = [];
let reads = 0, readBytes = 0, heap = 0, rows = 0;
const keep: unknown[] = [];
for (let i = 0; i < Number(args.iters); i++) {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  v.count.reads = 0;
  v.count.readBytes = 0;
  const cold = new Ledger(v.io, () => "phone000", () => clock);
  cold.setCaps(DATA, { [LIST]: CAP });
  const t0 = performance.now();
  const state = await cold.state(DATA, {});
  opens.push(performance.now() - t0);
  rows = state.lists.get(LIST)?.rows.length ?? 0;
  // What an open app holds: the ledger and its state, kept alive past the collection.
  keep.push(cold, state);
  gc?.();
  // The first open's: later ones share the strings V8 interned for it.
  heap = Math.max(heap, process.memoryUsage().heapUsed - before);
  reads = v.count.reads;
  readBytes = v.count.readBytes;
  keep.length = 0;
}
opens.sort((a, b) => a - b);
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(JSON.stringify({
  samples: SAMPLES, rowsShown: rows,
  noteSize: kb(noteBytes), logSize: kb(logBytes), checkpointSize: kb(checkpointBytes),
  writtenPerSample: kb(perSample),
  open: { medianMs: Number(opens[Math.floor(opens.length / 2)].toFixed(1)), filesRead: reads, read: kb(readBytes), heap: gc ? kb(heap) : "run with --expose-gc" },
}, null, 1));
