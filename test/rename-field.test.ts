import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { describeChange, eventsOf, undoEntry, undoInFrontmatter, undoMessage, type Change } from "../src/activity.ts";
import { AppController, type AppEnv, type Hosting } from "../src/app.ts";
import { findRenames, renameKey, type Rename } from "../src/app-cards.ts";
import { AppWrites } from "../src/app-writes.ts";
import { frontmatterStore, type Edit } from "../src/datastore.ts";
import { eventLine, fold, parseLog } from "../src/ledger.ts";
import { railModel, tickLabel } from "../src/rail.ts";
import { pastEnv } from "../src/replay.ts";
import { readSpec } from "../src/spec.ts";
import { mergeSettings } from "../src/stored.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";

// Renaming a field, a choice or a list in an app's keys leaves the rows saved before under the old
// name, where no chart or table finds them. When the keys and the rows disagree one to one, the app
// says so in a card under its header, and Move (or Change) brings the rows along as data changes,
// one entry in the activity log that one Undo takes back. Leave them keeps the rows as they are,
// and the card away, for that change.

const APP = "Apps/Budget.md";
const DATA = "Apps/Budget data.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** Four rows saved when the form had a note field and the choices food, fun and home. */
const SPEND = [
  { amount: 5, category: "food", note: "coffee", at: "2026-11-16T09:00" },
  { amount: 30, category: "fun", note: "film", at: "2026-11-16T20:00" },
  { amount: 12, category: "fun", at: "2026-11-17T13:00" },
  { amount: 80, category: "home", note: "", at: "2026-11-17T18:00" },
];

function budget(fields: Record<string, unknown>, opts: { save?: string; columns?: string[] } = {}) {
  const save = opts.save ?? "spend";
  return {
    app: "Budget",
    panels: [
      { view: "form", title: "Add", fields, save },
      { view: "table", title: "Recent", source: save, columns: opts.columns ?? Object.keys(fields) },
    ],
  };
}

const NOTE_TO_MEMO = budget({ amount: "number", category: ["food", "fun", "home"], memo: "text" });
const FUN_TO_LEISURE = budget({ amount: "number", category: ["food", "leisure", "home"], note: "text" });

/** APP in its own tab, with the activity log's Undo; `env` changes the env it opens with, `hosting` shows it elsewhere. */
function open(notes: Parameters<typeof fakeEnv>[0], opts: { env?: (env: AppEnv) => AppEnv; hosting?: Hosting; reuse?: ReturnType<typeof fakeEnv> } = {}) {
  const t = opts.reuse ?? fakeEnv(notes);
  t.env.log = (entry) => t.activity.add(entry);
  t.env.undo = async (id) => {
    const entry = (await t.activity.get(id))!;
    const r = await undoEntry(entry, t.undoIO);
    await t.activity.setUndone(id, r.undone);
    return undoMessage(r);
  };
  const root = document.body.createDiv();
  const c = new AppController(root, APP, opts.env ? opts.env(t.env) : t.env, opts.hosting);
  started.push({ dispose: () => { c.dispose(); root.remove(); } });
  c.load();
  const card = () => root.querySelector(".gz-rename");
  const button = (label: string) => [...(card()?.querySelectorAll("button") ?? [])].find((b) => text(b) === label);
  const rows = async (list: string) => (await t.data.ledger!.state(DATA)).lists.get(list)?.rows ?? [];
  const noted = (list: string) => (listsIn(t.f.files.get(DATA)?.fm)?.[list] ?? []) as Record<string, unknown>[];
  const cells = (col: number) => [...root.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelectorAll("td")[col]));
  return { ...t, root, card, button, rows, noted, cells };
}

/** How many events this device has written to the data note's log. */
function logLines(t: ReturnType<typeof fakeEnv>): number {
  return [...t.f.others].filter(([p]) => p.startsWith("Apps/Budget data/log/")).reduce((n, [, s]) => n + s.split("\n").filter(Boolean).length, 0);
}

// ---- A field ------------------------------------------------------------------------------------

test("a field renamed in the keys shows a card; Move moves the old field's values into the new one, one Undo moves them back", async () => {
  const t = open({ [APP]: { fm: NOTE_TO_MEMO }, [DATA]: { fm: { spend: structuredClone(SPEND) } } });
  await settle();
  // The row saved with the note left empty has the field too.
  assert.equal(text(t.card()), "3 rows of spend have note, which is no longer a field. It now has memo. Move note into memo?MoveLeave them");
  assert.ok(t.card()!.closest(".gz-header"), "under the app's header");
  assert.deepEqual(t.cells(2), ["—", "—", "—", "—"], "the old rows have no memo yet");

  click(t.button("Move")!);
  await settle();
  assert.ok(!t.card(), "the card goes once the rows follow the keys");
  assert.deepEqual((await t.rows("spend")).map((r) => [r.memo, r.note]), [["coffee", undefined], ["film", undefined], [undefined, undefined], ["", undefined]]);
  assert.deepEqual(t.cells(2), ["coffee", "film", "—", ""]);
  // The note is written without the old field, not with an empty one.
  assert.deepEqual(t.noted("spend").map((r) => Object.keys(r).sort().join(",")), ["amount,at,category,memo", "amount,at,category,memo", "amount,at,category", "amount,at,category,memo"]);

  const [entry] = await t.activity.list(APP);
  assert.equal(entry.what, "Moved note into memo in 3 rows of spend");
  assert.equal(entry.changes.length, 6);
  assert.deepEqual(entry.changes.slice(0, 2).map(describeChange), ["Changed memo from nothing to coffee in spend in Budget data", "Changed note from coffee to nothing in spend in Budget data"]);
  assert.ok(eventsOf(entry), "every change is a ledger event, which any device can take back");
  const { ticks } = railModel(await t.activity.list(APP), t.env.now().getTime());
  assert.equal(ticks.length, 1, "one tick on the time rail");
  assert.match(tickLabel(ticks[0]), /· Moved note into memo in 3 rows of spend: Changed memo from nothing to coffee in spend in Budget data$/);

  const before = logLines(t);
  assert.equal(await t.env.undo!(entry.id), "Undid all 6 changes");
  await settle();
  assert.equal(logLines(t), before + 1, "one undo event takes back the whole batch");
  assert.deepEqual((await t.rows("spend")).map((r) => [r.memo, r.note]), [[undefined, "coffee"], [undefined, "film"], [undefined, undefined], [undefined, ""]]);
  assert.deepEqual(t.noted("spend"), SPEND);
  assert.equal(text(t.card()).slice(0, 33), "3 rows of spend have note, which ", "the card is back with the old rows");
});

test("one row says so in the singular", async () => {
  const t = open({ [APP]: { fm: NOTE_TO_MEMO }, [DATA]: { fm: { spend: [SPEND[0], SPEND[2]] } } });
  await settle();
  assert.equal(text(t.card()), "1 row of spend has note, which is no longer a field. It now has memo. Move note into memo?MoveLeave it");
});

// ---- A choice -----------------------------------------------------------------------------------

test("a choice renamed in the keys shows a card; Change changes the rows to the new choice, and Undo back", async () => {
  const t = open({ [APP]: { fm: FUN_TO_LEISURE }, [DATA]: { fm: { spend: structuredClone(SPEND) } } });
  await settle();
  assert.equal(text(t.card()), "2 rows of spend have category fun, which is no longer a choice. Change them to leisure?ChangeLeave them");
  click(t.button("Change")!);
  await settle();
  assert.ok(!t.card());
  assert.deepEqual((await t.rows("spend")).map((r) => r.category), ["food", "leisure", "leisure", "home"]);
  assert.deepEqual(t.cells(1), ["food", "leisure", "leisure", "home"]);
  const [entry] = await t.activity.list(APP);
  assert.equal(entry.what, "Changed category fun to leisure in 2 rows of spend");
  assert.deepEqual(entry.changes.map(describeChange), ["Changed category from fun to leisure in spend in Budget data", "Changed category from fun to leisure in spend in Budget data"]);
  await t.env.undo!(entry.id);
  await settle();
  assert.deepEqual(t.noted("spend").map((r) => r.category), ["food", "fun", "fun", "home"]);
  assert.ok(t.card());
});

test("a choice typed as a number is written as the number", () => {
  const spec = readSpec(budget({ stars: [1, 2, 3], note: "text" }), { path: APP })!.spec!;
  const lists = new Map([["spend", { rows: [{ stars: 1, note: "a" }, { stars: 2, note: "b" }, { stars: 5, note: "c" }] }]]);
  assert.deepEqual(findRenames(spec, lists, {}), [{ kind: "choice", list: "spend", field: "stars", from: "5", to: "3", value: 3, rows: 1 }]);
});

// ---- A list -------------------------------------------------------------------------------------

test("a list renamed in the keys shows a card naming the data note; Move moves its rows to the new list, Undo moves them back, and Move works again", async () => {
  const keys = budget({ amount: "number", category: ["food", "fun", "home"], note: "text" }, { save: "expenses" });
  const t = open({ [APP]: { fm: keys }, [DATA]: { fm: { spend: structuredClone(SPEND) } } });
  await settle();
  assert.equal(text(t.card()), "Budget data has a list spend that no panel reads (4 rows). Move them to expenses?MoveLeave them");
  assert.deepEqual(t.cells(0), []);
  click(t.button("Move")!);
  await settle();
  assert.ok(!t.card());
  assert.deepEqual(t.cells(0), ["5", "30", "12", "80"]);
  assert.deepEqual(t.noted("expenses"), SPEND);
  assert.deepEqual(t.noted("spend"), []);
  const [entry] = await t.activity.list(APP);
  assert.equal(entry.what, "Moved 4 rows from spend to expenses");
  assert.deepEqual(entry.changes.slice(0, 2).map(describeChange), [
    "Saved amount 5, category food, note coffee to expenses in Budget data", "Deleted amount 5, category food, note coffee from spend in Budget data",
  ]);
  await t.env.undo!(entry.id);
  await settle();
  assert.deepEqual(t.noted("spend"), SPEND);
  assert.deepEqual(t.noted("expenses"), []);
  assert.deepEqual(t.cells(0), []);
  // An undone add keeps its row id out of that list, so a second Move must not reuse it.
  click(t.button("Move")!);
  await settle();
  assert.deepEqual(t.noted("expenses"), SPEND);
  assert.deepEqual(t.noted("spend"), []);
});

// ---- Never a guess ------------------------------------------------------------------------------

test("with two candidates on either side, no card", async () => {
  const spec = (fields: Record<string, unknown>, more: Record<string, unknown> = {}) => readSpec({ ...budget(fields), ...more }, { path: APP })!.spec!;
  const rows = (...extra: Record<string, unknown>[]) => new Map<string, { rows: Record<string, unknown>[] }>([["spend", { rows: SPEND.map((r, i) => ({ ...r, ...extra[i] })) }]]);
  const fields = { amount: "number", category: ["food", "fun", "home"] };
  // One gone, one new: the one found.
  assert.deepEqual(findRenames(spec({ ...fields, memo: "text" }), rows(), {}).map((r) => r.kind), ["field"]);
  // Two gone (note and tag), one new.
  assert.deepEqual(findRenames(spec({ ...fields, memo: "text" }), rows({ tag: "x" }), {}), []);
  // One gone, two new (memo and tip).
  assert.deepEqual(findRenames(spec({ ...fields, memo: "text", tip: "number" }), rows(), {}), []);
  // A field taken out of the keys (tag), beside one nobody fills in, which the form saves empty: no new name.
  const blankNotes = new Map([["spend", { rows: SPEND.map((r) => ({ ...r, note: "", tag: "x" })) }]]);
  assert.deepEqual(findRenames(spec({ ...fields, note: "text" }), blankNotes, {}), []);
  // Two choices the keys no longer have (fun and misc).
  assert.deepEqual(findRenames(spec({ amount: "number", category: ["food", "leisure", "home"], note: "text" }), rows({}, {}, { category: "misc" }), {}), []);
  // Two choices with no rows (leisure and travel).
  assert.deepEqual(findRenames(spec({ amount: "number", category: ["food", "leisure", "home", "travel"], note: "text" }), rows(), {}), []);
  // Two lists the app saves to that have no rows.
  const two = readSpec({ app: "B", panels: [
    { view: "form", fields: { amount: "number" }, save: "expenses" },
    { view: "form", fields: { kg: "number" }, save: "weights" },
  ] }, { path: APP })!.spec!;
  assert.deepEqual(findRenames(two, rows(), {}), []);
  // Two lists no panel reads.
  const one = readSpec(budget({ amount: "number" }, { save: "expenses" }), { path: APP })!.spec!;
  assert.deepEqual(findRenames(one, new Map([...rows(), ["old", { rows: [{ amount: 1 }] }]]), {}), []);
  assert.deepEqual(findRenames(one, rows(), {}), [{ kind: "list", from: "spend", to: "expenses", rows: 4 }]);
});

test("lists whose fields no key declares, a shared store, lists typed in the app note and whole-row archives are left out", () => {
  const rows = new Map([["spend", { rows: structuredClone(SPEND) }]]);
  // With store, other apps may save other fields, and keep other lists, in the same note.
  const shared = readSpec({ ...NOTE_TO_MEMO, store: "[[Money]]" }, { path: APP })!.spec!;
  assert.deepEqual(findRenames(shared, rows, {}), []);
  const sharedList = readSpec({ ...budget({ amount: "number" }, { save: "expenses" }), store: "[[Money]]" }, { path: APP })!.spec!;
  assert.deepEqual(findRenames(sharedList, rows, {}), []);
  // A row action saves whole rows: the archive's fields are whatever the rows held.
  const archive = readSpec({ app: "B", panels: [
    { view: "table", source: "spend", columns: ["amount"], action: "Archive", save: "archived" },
  ] }, { path: APP })!.spec!;
  assert.deepEqual(findRenames(archive, new Map([["archived", { rows: [{ amount: 1, extra: 2 }] }], ["old", { rows: [{ a: 1 }] }]]), {}), []);
  // A list typed in the app note is the app's own.
  const one = readSpec(budget({ amount: "number" }, { save: "expenses" }), { path: APP })!.spec!;
  assert.deepEqual(findRenames(one, rows, { spend: SPEND }), []);
});

// ---- Leave them ---------------------------------------------------------------------------------

test("Leave them keeps the card away for that change, across a reopen; a different change shows a new card", async () => {
  const t = open({ [APP]: { fm: NOTE_TO_MEMO }, [DATA]: { fm: { spend: structuredClone(SPEND) } } });
  await settle();
  click(t.button("Leave them")!);
  await settle();
  assert.ok(!t.card());
  assert.deepEqual(Object.keys(t.leftAlone), [renameKey(APP, { kind: "field", list: "spend", from: "note", to: "memo", rows: 3 })]);
  assert.deepEqual((await t.rows("spend")).map((r) => r.note), ["coffee", "film", undefined, ""], "the rows stay as they are");

  const again = open({}, { reuse: t });
  await settle();
  assert.ok(!again.card(), "kept across a reopen");

  t.f.files.get(APP)!.fm = budget({ amount: "number", category: ["food", "fun", "home"], comment: "text" });
  t.changed(APP);
  await settle();
  assert.equal(text(again.card()).split(".")[1], " It now has comment");
});

test("the renames left alone are merged entry by entry with what other devices saved", () => {
  const merged = mergeSettings({ grants: {} }, { grants: {}, leftAlone: { a: true } }, { grants: {}, leftAlone: { b: true } });
  assert.deepEqual(merged.leftAlone, { a: true, b: true });
});

test("the key a rename is left alone under names the app and exactly what changed", () => {
  const field: Rename = { kind: "field", list: "spend", from: "note", to: "memo", rows: 2 };
  assert.notEqual(renameKey(APP, field), renameKey("Apps/Other.md", field));
  assert.notEqual(renameKey(APP, field), renameKey(APP, { ...field, to: "comment" }));
  assert.notEqual(renameKey(APP, field), renameKey(APP, { ...field, list: "other" }));
  assert.equal(renameKey(APP, field), renameKey(APP, { ...field, rows: 3 }), "the same change with more rows is still the one left alone");
});

// ---- Only in the app's own tab, as it is now -----------------------------------------------------

test("no card in an embed, a try or the app as it was", async () => {
  const notes = { [APP]: { fm: NOTE_TO_MEMO }, [DATA]: { fm: { spend: structuredClone(SPEND) } } };
  const embed = open(notes, { hosting: { kind: "app", grantKey: "Notes/Day.md#k", hostPath: "Notes/Day.md", definition: () => NOTE_TO_MEMO } });
  const tried = open(notes, { env: (env) => ({ ...env, preview: true }) });
  const past = open(notes, { env: (env) => pastEnv(env, new Date(2026, 10, 18, 11).getTime()) });
  const own = open(notes);
  await settle();
  assert.ok(own.card(), "it shows in the app's own tab");
  assert.ok(embed.root.querySelector("tbody tr"), "the embed shows its rows");
  assert.ok(!embed.card());
  assert.ok(tried.root.querySelector("tbody tr"));
  assert.ok(!tried.card());
  assert.ok(past.root.querySelector(".gz-past"));
  assert.ok(!past.card());
});

// ---- The writes underneath ----------------------------------------------------------------------

test("a set the ledger writes without a value takes the field out of the row, read back from its line", () => {
  const add = { t: "2026-11-18T12:00:00.000Z/0", d: "d1", op: "add" as const, l: "spend", row: "r1", v: { amount: 5, note: "coffee" } };
  const clear = { t: "2026-11-18T12:00:00.000Z/1", d: "d1", op: "set" as const, l: "spend", row: "r1", f: "note", v: undefined, from: "coffee" };
  const { events, bad } = parseLog(eventLine(add) + eventLine(clear));
  assert.equal(bad, 0, "older readers take the line as a set too");
  assert.ok(!("v" in events[1]));
  const row = fold(events).lists.get("spend")!.rows[0];
  assert.deepEqual(row, { amount: 5 });
  assert.ok(!Object.hasOwn(row, "note"));
});

test("a batch in a note's list is one rewrite; each change it gives undoes in turn, newest first, back to the list as it was", async () => {
  const fm: Record<string, unknown> = { spend: structuredClone(SPEND), expenses: [] };
  let writes = 0;
  const store = frontmatterStore(DATA, async (_p, fn) => { writes++; fn(fm); }, () => fm);
  const shown = structuredClone(SPEND);
  const ref = (i: number) => ({ index: i, shown: shown[i] });
  const edits: Edit[] = [
    { op: "set", list: "spend", ref: ref(0), field: "memo", value: "coffee" },
    { op: "set", list: "spend", ref: ref(0), field: "note", value: undefined },
    { op: "add", list: "expenses", row: shown[1] },
    { op: "delete", list: "spend", ref: ref(1) },
    { op: "add", list: "expenses", row: shown[2] },
    { op: "delete", list: "spend", ref: ref(2) },
  ];
  const done = await store.batch(edits);
  assert.equal(writes, 1);
  assert.ok(Array.isArray(done));
  assert.deepEqual(fm.spend, [{ amount: 5, category: "food", at: SPEND[0].at, memo: "coffee" }, SPEND[3]]);
  assert.deepEqual(fm.expenses, [SPEND[1], SPEND[2]]);
  // Each deleted row's place in the list at that point, so putting it back lands it there.
  assert.deepEqual(done.map((d) => d.index), [undefined, undefined, undefined, 1, undefined, 1]);
  const changes: Change[] = edits.map((e, i) => {
    if (e.op === "add") return { kind: "row-added", path: DATA, list: e.list, row: done[i].row };
    if (e.op === "delete") return { kind: "row-deleted", path: DATA, list: e.list, row: done[i].row, index: done[i].index };
    return { kind: "row-edited", path: DATA, list: e.list, row: done[i].row, field: e.field, from: e.ref.shown[e.field], to: e.value };
  });
  for (const c of [...changes].reverse()) assert.equal(undoInFrontmatter(c, fm), undefined);
  assert.deepEqual(fm, { spend: SPEND, expenses: [] });
});

test("Move in a note's list finds each row by its place among all the list's entries, a stray value among them too", async () => {
  const fm: Record<string, unknown> = {};
  const notices: string[] = [];
  const kept: string[] = [];
  const env = {
    frontmatter: (path: string) => (path === DATA ? fm : undefined),
    writeFrontmatter: async (_path: string, fn: (fm: Record<string, unknown>) => void) => fn(fm),
    notify: (m: string) => void notices.push(m),
    log: async (e: { what: string }) => { kept.push(e.what); return undefined; },
  } as unknown as AppEnv;
  const writes = new AppWrites(env, { appPath: APP, hostPath: APP, dataPath: () => DATA, checklistName: () => "", expect: () => [] });

  fm.spend = ["a stray line", ...structuredClone(SPEND)];
  await writes.moveRenamed({ kind: "field", list: "spend", from: "note", to: "memo", rows: 3 });
  assert.deepEqual(notices, []);
  assert.deepEqual(fm.spend, [
    "a stray line",
    { amount: 5, category: "food", at: SPEND[0].at, memo: "coffee" },
    { amount: 30, category: "fun", at: SPEND[1].at, memo: "film" },
    SPEND[2],
    { amount: 80, category: "home", at: SPEND[3].at, memo: "" },
  ]);

  fm.spend = [...structuredClone(SPEND.slice(0, 2)), 7, ...structuredClone(SPEND.slice(2))];
  await writes.moveRenamed({ kind: "list", from: "spend", to: "expenses", rows: 4 });
  assert.deepEqual(notices, []);
  assert.deepEqual([fm.spend, fm.expenses], [[7], SPEND]);
  assert.deepEqual(kept, ["Moved note into memo in 3 rows of spend", "Moved 4 rows from spend to expenses"]);
});

test("a batch writes nothing when a row it names changed since it was shown", async () => {
  const fm: Record<string, unknown> = { spend: structuredClone(SPEND) };
  const store = frontmatterStore(DATA, async (_p, fn) => fn(fm), () => fm);
  const stale = { ...SPEND[1], note: "a film" };
  const r = await store.batch([
    { op: "set", list: "spend", ref: { index: 0, shown: SPEND[0] }, field: "memo", value: "coffee" },
    { op: "set", list: "spend", ref: { index: 1, shown: stale }, field: "memo", value: "a film" },
  ]);
  assert.deepEqual(r, { refused: "changed" });
  assert.deepEqual(fm.spend, SPEND);
});
