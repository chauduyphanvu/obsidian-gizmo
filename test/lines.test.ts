import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { readSpec } from "../src/spec.ts";
import { frontmatterStore, ledgerStore } from "../src/datastore.ts";
import { IDS_KEY, Ledger, rowIdOf, type LedgerIO } from "../src/ledger-store.ts";
import { heldInNote } from "../src/kind.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const SPEND = { kind: "spend", fields: { amount: "number", category: ["food", "home", "travel"], memo: "text" } };

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

/** A kind with one row on each line, written as events, and an app reading it. */
async function vault(app: Record<string, unknown>) {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/Budget.md": { fm: app } });
  await t.data.ledger!.write(KIND_DATA, [
    { op: "add", l: "spend", row: "r1", v: { amount: 10, category: "food", at: "2026-11-17T09:00" } },
    { op: "add", l: "spend", row: "r2", v: { amount: 200, category: "home", at: "2026-12-01T09:00", line: "planned" } },
    { op: "add", l: "spend", row: "r3", v: { amount: 30, category: "food", at: "2026-11-16", line: "attested" } },
    { op: "add", l: "spend", row: "r4", v: { amount: 4000, category: "travel", at: "2026-11-15", line: "dismissed" } },
  ]);
  const open = (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const c = new AppController(root, path, t.env);
    started.push(c);
    c.load();
    return root;
  };
  return { ...t, open };
}

const total = (lines?: unknown) => ({ app: "b", view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum", ...(lines === undefined ? {} : { lines }) });

test("a panel reading a kind counts only logged rows unless its lines say", async () => {
  for (const [lines, want] of [[undefined, "10"], ["all", "4,240"], [["logged", "planned"], "210"], ["attested", "30"]] as const) {
    const t = await vault(total(lines));
    const root = t.open("Apps/Budget.md");
    await settle();
    assert.match(text(root), new RegExp(`Total${want}`), `lines: ${JSON.stringify(lines)}`);
  }
});

test("a block can say which lines it reads, and a panel naming it reads those", async () => {
  const fm = {
    app: "b", data: { plans: { source: "[[Spend]]", lines: "planned" } },
    panels: [{ view: "number", title: "Planned", source: "plans", field: "amount", agg: "sum" }],
  };
  const t = await vault(fm);
  const root = t.open("Apps/Budget.md");
  await settle();
  assert.match(text(root), /Planned200/);
});

test("the kind's own note shows only its logged rows", async () => {
  const t = await vault(total());
  const root = t.open(KIND);
  await settle();
  assert.equal(root.querySelectorAll("tbody tr").length, 1);
});

/** A bill planned at 15.49 that a dearer charge under a longer name settled, the bank's copy of that charge paired with it, and a bill nothing settled. */
async function settledVault(app: Record<string, unknown>) {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/Bills.md": { fm: app } });
  await t.data.ledger!.write(KIND_DATA, [
    { op: "add", l: "spend", row: "l1", v: { amount: 17.99, category: "home", memo: "STREAMFLIX.COM 866", at: "2026-11-12T10:00" } },
    { op: "add", l: "spend", row: "p1", v: { amount: 15.49, category: "home", memo: "STREAMFLIX", at: "2026-11-12T09:00", line: "planned", matched: "l1" } },
    { op: "add", l: "spend", row: "p2", v: { amount: 50, category: "home", memo: "METRO WATER", at: "2026-11-16T09:00", line: "planned" } },
    { op: "add", l: "spend", row: "a1", v: { amount: 17.99, memo: "STREAMFLIX.COM 866", at: "2026-11-12", line: "attested", matched: "l1" } },
  ]);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, "Apps/Bills.md", t.env);
  started.push(c);
  c.load();
  await settle();
  return root;
}

test("lines that keep the logged line leave out a planned row a logged row settled, and a row from a file paired with one: that logged row stands for it", async () => {
  for (const [lines, want] of [[["logged", "planned"], "67.99"], [["logged", "attested"], "17.99"], ["planned", "65.49"], ["all", "101.47"]] as const) {
    const root = await settledVault({ ...total(lines), format: "0.00" });
    assert.match(text(root), new RegExp(`Total${want.replace(".", "\\.")}`), `lines: ${JSON.stringify(lines)}`);
  }
});

test("a planned row a logged row settled holds that row in settled, which compute reads; a planned row nothing settled has none", async () => {
  const root = await settledVault({
    app: "b", view: "table", title: "Bills", source: "[[Spend]]", lines: "planned", sort: "at",
    compute: { paid: "settled.amount", by: "settled.memo", rise: "settled.amount - amount" }, columns: ["memo", "amount", "paid", "by", "rise"],
    format: { amount: "0.00", paid: "0.00", rise: "0.00" },
  });
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([...root.querySelectorAll("tbody tr:not(.gz-ledger-group)")].map((tr) => [...tr.querySelectorAll("td")].map(text)), [
    ["STREAMFLIX", "15.49", "17.99", "STREAMFLIX.COM 866", "2.50"],
    ["METRO WATER", "50.00", "—", "—", "—"],
  ]);
});

test("settled is checked: a field the kind has, on a panel that reads a kind's planned rows without its logged ones", () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND } });
  const read = (fm: Record<string, unknown>) => readSpec(fm, { notes: t.env.notes, path: "Apps/B.md" })!.errors;
  const bills = (keys: Record<string, unknown>) => ({ app: "b", view: "table", title: "Bills", source: "[[Spend]]", lines: "planned", ...keys });
  assert.deepEqual(read(bills({ compute: { paid: "settled.amount", when: "settled.at" } })), []);
  assert.deepEqual(read(bills({ compute: { paid: "settled.amont" } })), ["compute.paid: settled.amont: Spend has no field “amont” (did you mean settled.amount?)"]);
  assert.deepEqual(read(bills({ compute: { paid: "settled" } })), ["compute.paid: settled is a row; read one of its fields, e.g. settled.amount"]);
  assert.deepEqual(read(bills({ lines: undefined, compute: { paid: "settled.amount" } })), ["compute.paid: settled is on planned rows, which this panel doesn't read; add lines: planned"]);
  assert.deepEqual(read(bills({ lines: ["logged", "planned"], compute: { paid: "settled.amount" } })),
    ["compute.paid: settled is on a planned row that a logged row settled, which lines: [logged, planned] leaves out, as that row stands for it; read lines: planned"]);
  assert.deepEqual(read({ app: "b", data: { s: { source: "[[Spend]]", lines: "planned", compute: { paid: "settled.amont" } } }, view: "table", title: "Bills", source: "s" }),
    ["compute.paid: settled.amont: Spend has no field “amont” (did you mean settled.amount?)"]);
  assert.deepEqual(read({ app: "b", data: { s: { source: "runs" } }, view: "table", title: "Runs", source: "s", compute: { paid: "settled.amount" } }),
    ["compute.paid: settled is on the planned rows of a kind; this panel's source isn't a kind"]);
  const field = readSpec({ kind: "spend", fields: { amount: "number", settled: "checkbox" } }, { path: KIND })!;
  assert.deepEqual(field.errors, ['fields can\'t have "settled": a planned row\'s settled holds the row that settled it']);
});

test("lines takes all or the four lines, and only with a source that links to a kind", async () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND } });
  const read = (fm: Record<string, unknown>) => readSpec(fm, { notes: t.env.notes, path: "Apps/B.md" })!.errors;
  assert.deepEqual(read(total(["logged", "nope"])), ['lines must be all, or one or more of logged, planned, attested, dismissed, not "nope"']);
  assert.deepEqual(read({ app: "b", view: "number", source: "spend", field: "amount", agg: "sum", lines: "all" }),
    ['"lines" picks rows of a kind; give it a source that links to a kind, e.g. source: "[[Spend]]"']);
  assert.deepEqual(read({ app: "b", data: { s: { source: "[[Spend]]" }, f: { source: "s", lines: "all" } }, view: "table", source: "f" }),
    ['data.f: "lines" belongs on data.s, where the source is']);
});

test("a kind can't name a field line, matched or by, which Gizmo keeps on each row", () => {
  const r = readSpec({ kind: "spend", fields: { amount: "number", line: "text" } }, { path: KIND })!;
  assert.deepEqual(r.errors, ['fields can\'t have "line": Gizmo keeps line, matched, by, writer, imported on each row of a kind']);
  assert.equal(r.spec, undefined);
});

test("a kind's data note holds its logged rows, with their ids; an app's list holds every row", async () => {
  const t = await vault(total());
  await t.data.snapshotNow(KIND_DATA, true);
  const fm = t.f.files.get(KIND_DATA)!.fm!;
  assert.deepEqual((listsIn(fm)!.spend as { amount: number }[]).map((r) => r.amount), [10]);
  assert.deepEqual((fm[IDS_KEY] as Record<string, string[]>).spend, ["r1"]);
  assert.equal(heldInNote({ app: "x" }), undefined, "an app's data note holds every row, as before");
});

/** A ledger on files in memory, for what the snapshot writes and a hand edit makes of it. */
function memory(notes: Record<string, Record<string, unknown>> = {}) {
  const files = new Map<string, string>();
  const fms = new Map(Object.entries(notes));
  const io: LedgerIO = {
    filesIn: (folder) => [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    readFile: async (p) => files.get(p) ?? "",
    append: async (p, text) => { files.set(p, (files.get(p) ?? "") + text); },
    writeFile: async (p, text) => { files.set(p, text); },
    frontmatter: (p) => fms.get(p),
  };
  const writeNote = (path: string) => async (fn: (fm: Record<string, unknown>) => void) => {
    const fm = structuredClone(fms.get(path) ?? {});
    fn(fm);
    fms.set(path, fm);
  };
  return { fms, io, writeNote, ledger: new Ledger(io, () => "a", () => Date.UTC(2026, 10, 19, 8, 0)) };
}

test("a hand edit of a kind's note keeps each row's id: an edited row is set field by field, and what points at it still does", async () => {
  const m = memory();
  const { ledger } = m;
  await ledger.write(KIND_DATA, [
    { op: "add", l: "spend", row: "r1", v: { amount: 10, memo: "lunch" } },
    { op: "add", l: "spend", row: "r2", v: { amount: 20, memo: "taxi" } },
    { op: "add", l: "spend", row: "b1", v: { amount: 20, line: "attested", matched: "r2" } },
  ]);
  await ledger.snapshot(KIND_DATA, SPEND, m.writeNote(KIND_DATA), false, [], heldInNote(SPEND));
  const fm = m.fms.get(KIND_DATA)!;
  assert.deepEqual(fm.spend, [{ amount: 10, memo: "lunch" }, { amount: 20, memo: "taxi" }]);
  fm.spend = [{ amount: 10, memo: "lunch" }, { amount: 21, memo: "cab" }, { amount: 5 }];
  ledger.fileChanged(KIND_DATA);
  const ops = await ledger.importOps(KIND_DATA, SPEND);
  assert.deepEqual(ops.map((o) => [o.op, "row" in o ? o.row : "", "f" in o ? o.f : ""]).sort(), [
    ["add", ops.find((o) => o.op === "add")!.op === "add" ? (ops.find((o) => o.op === "add") as { row: string }).row : "", ""],
    ["set", "r2", "amount"], ["set", "r2", "memo"],
  ].sort());
  await ledger.write(KIND_DATA, ops);
  const rows = (await ledger.state(KIND_DATA, SPEND)).lists.get("spend")!.rows;
  assert.deepEqual(rows.map((r) => [rowIdOf(r), r.amount]), [["r1", 10], ["r2", 21], ["b1", 20], [rowIdOf(rows[3]), 5]]);
  assert.equal(rows[2].matched, "r2");
});

test("a hand edit of an app's list is still rows taken out and put in", async () => {
  const m = memory();
  await m.ledger.write("Apps/B data.md", [{ op: "add", l: "spend", row: "r1", v: { amount: 10 } }]);
  await m.ledger.snapshot("Apps/B data.md", {}, m.writeNote("Apps/B data.md"));
  m.fms.get("Apps/B data.md")!.spend = [{ amount: 11 }];
  m.ledger.fileChanged("Apps/B data.md");
  assert.deepEqual((await m.ledger.importOps("Apps/B data.md", { app: "b" })).map((o) => o.op).sort(), ["add", "del"]);
});

test("an add with an id adds the row once; one that was undone says so and writes nothing", async () => {
  const m = memory();
  const store = ledgerStore(m.ledger, KIND_DATA);
  const first = await store.add("spend", { amount: 1 }, { id: "x1" });
  assert.ok(first.event);
  assert.equal(first.id, "x1");
  assert.deepEqual(await store.add("spend", { amount: 1 }, { id: "x1" }), { already: true, id: "x1" });
  await store.undo([first.event!]);
  const again = await store.add("spend", { amount: 1 }, { id: "x1" });
  assert.deepEqual(again, { already: true, gone: true, id: "x1" });
  assert.equal((await store.rows("spend")).length, 0);
});

test("a batch adds rows under the ids it is given, skipping one there already and one that was undone", async () => {
  const m = memory();
  const store = ledgerStore(m.ledger, KIND_DATA);
  const first = await store.batch([{ op: "add", list: "spend", row: { n: 1 }, id: "a" }, { op: "add", list: "spend", row: { n: 2 }, id: "b" }]);
  assert.ok(!("refused" in first));
  await store.undo([first[1].event!]);
  const second = await store.batch([
    { op: "add", list: "spend", row: { n: 1 }, id: "a" },
    { op: "add", list: "spend", row: { n: 2 }, id: "b" },
    { op: "add", list: "spend", row: { n: 3 }, id: "c" },
    { op: "add", list: "spend", row: { n: 3 }, id: "c" },
  ]);
  assert.ok(!("refused" in second));
  assert.deepEqual(second.map((d) => d.already ?? (d.event ? "added" : "")), ["there", "gone", "added", "there"]);
  assert.deepEqual((await store.rows("spend")).map(rowIdOf), ["a", "c"]);
});

test("in a note's own list, an add with an id is kept with its id and added once", async () => {
  const notes = new Map<string, Record<string, unknown>>([["D.md", { spend: [{ n: 0 }] }]]);
  const store = frontmatterStore("D.md", async (path, fn) => {
    const fm = notes.get(path) ?? {};
    fn(fm);
    notes.set(path, fm);
  }, (path) => notes.get(path));
  assert.deepEqual(await store.add("spend", { n: 1 }, { id: "x" }), { id: "x" });
  assert.deepEqual(await store.add("spend", { n: 1 }, { id: "x" }), { already: true, id: "x" });
  const done = await store.batch([{ op: "add", list: "spend", row: { n: 1 }, id: "x" }, { op: "add", list: "spend", row: { n: 2 }, id: "y" }]);
  assert.ok(!("refused" in done));
  assert.deepEqual(done.map((d) => d.already ?? "added"), ["there", "added"]);
  assert.deepEqual(notes.get("D.md")!.spend, [{ n: 0 }, { n: 1 }, { n: 2 }]);
});

test("a hand edit of a kind's note that lost its ids compares only the logged rows it held; a new row never takes the id, and the writer or plan, of a row gone", async () => {
  const m = memory();
  const { ledger } = m;
  await ledger.write(KIND_DATA, [
    { op: "add", l: "spend", row: "a1", v: { amount: 5, at: "2026-11-17T09:00" } },
    { op: "add", l: "spend", row: "s1", v: { amount: 1200, at: "2026-11-16T09:00" } },
    { op: "add", l: "spend", row: "m1", v: { amount: 7, at: "2026-11-16T10:00", by: "Mai", writer: "aaaaaaaaaaaaaaaa" } },
    { op: "add", l: "spend", row: "p1", v: { amount: 1200, at: "2026-11-15T09:00", line: "planned", matched: "s1" } },
    { op: "add", l: "spend", row: "t1", v: { amount: 15.49, at: "2026-11-16", line: "attested" } },
  ]);
  await ledger.snapshot(KIND_DATA, SPEND, m.writeNote(KIND_DATA), false, [], heldInNote(SPEND));
  const fm = m.fms.get(KIND_DATA)!;
  // The amount fixed by hand, and the ids gone with a tidy of the properties: only that change.
  fm.spend = [{ amount: 6, at: "2026-11-17T09:00" }, { amount: 1200, at: "2026-11-16T09:00" }, { amount: 7, at: "2026-11-16T10:00", by: "Mai", writer: "aaaaaaaaaaaaaaaa" }];
  delete fm[IDS_KEY];
  ledger.fileChanged(KIND_DATA);
  assert.deepEqual(await ledger.importOps(KIND_DATA, SPEND), [{ op: "set", l: "spend", row: "a1", f: "amount", v: 6, from: 5 }]);
  // The rent that settled a plan and Mai's row taken out, two rows of mine put in: neither takes their ids.
  fm.spend = [{ amount: 5, at: "2026-11-17T09:00" }, { amount: 30, at: "2026-11-18T09:00" }, { amount: 8, at: "2026-11-18T10:00" }];
  ledger.fileChanged(KIND_DATA);
  const ops = await ledger.importOps(KIND_DATA, SPEND);
  assert.deepEqual(ops.filter((o) => o.op !== "add"), [{ op: "del", l: "spend", row: "s1" }, { op: "del", l: "spend", row: "m1" }]);
  assert.deepEqual(ops.filter((o) => o.op === "add").map((o) => (o as { v: unknown }).v), [{ amount: 30, at: "2026-11-18T09:00" }, { amount: 8, at: "2026-11-18T10:00" }]);
});

test("a kind note's match: list is its rule, not a list of rows", async () => {
  const m = memory();
  const kind = { ...SPEND, match: [{ amount: "exact", at: "3d" }, { memo: "contains", amount: "20%", at: "3d" }] };
  await m.ledger.write(KIND_DATA, [{ op: "add", l: "spend", row: "a1", v: { amount: 5, at: "2026-11-17T09:00" } }]);
  assert.deepEqual([...(await m.ledger.state(KIND_DATA, kind)).lists.keys()], ["spend"]);
});
