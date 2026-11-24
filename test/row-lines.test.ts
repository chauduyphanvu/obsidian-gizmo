import assert from "node:assert/strict";
import { test } from "node:test";
import { captureTargets, parseLine } from "../src/capture.ts";
import { ROW_ID } from "../src/ledger-store.ts";
import { RowLines, frozen, lineChanges, lineOfRow, readLine, readRowLine, rowLineText, rowLinesIn, type RowHome } from "../src/row-lines.ts";
import { readSpec } from "../src/spec.ts";
import { stampOf } from "../src/time.ts";

// Friday 20 November 2026, 19:42.
const NOW = new Date(2026, 10, 20, 19, 42);
const KIND = "Kinds/Spend.md";
const SPEND = { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home", "travel"], note: "text" } };
const ID = "0123456789abcdef";
const ID2 = "fedcba9876543210";

const spec = readSpec(SPEND, { path: KIND, notes: { resolve: () => undefined, frontmatter: () => undefined } as never })!.spec!;
const index = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map([["spend", spec.panels[0]]]) }]);
const HOME: RowHome = { dataPath: "Kinds/Spend data.md", list: "spend", owner: KIND };
const home = () => HOME;

function row(id: string, values: Record<string, unknown>): Record<string, unknown> {
  return Object.defineProperty({ ...values }, ROW_ID, { value: id });
}

// ---- the line -------------------------------------------------------------------------------------

test("a row line: a tick, the capture line and the row's id as a block id; read back as it was written", () => {
  const text = rowLineText({ indent: "", live: true, line: "spend 14.5 food lunch", id: ID });
  assert.equal(text, `✓ spend 14.5 food lunch ^gz-${ID}`);
  assert.deepEqual(readRowLine(text), { indent: "", live: true, line: "spend 14.5 food lunch", id: ID });
  assert.deepEqual(readRowLine(`  ✗ spend 1 food x ^gz-${ID}  `), { indent: "  ", live: false, line: "spend 1 food x", id: ID });
  assert.equal(readRowLine("✓ spend 14.5 food lunch · Budget · 08:14"), undefined, "an old receipt is no row");
  assert.equal(readRowLine(`spend 14.5 food lunch ^gz-${ID}`), undefined);
});

test("rowLinesIn: each row line with where it is; none inside a code block", () => {
  const note = [`# Friday`, `✓ spend 14.5 food lunch ^gz-${ID}`, "```", `✓ spend 1 food x ^gz-${ID2}`, "```", `✓ spend 30 home lamp ^gz-${ID2}`].join("\n");
  assert.deepEqual(rowLinesIn(note).map((l) => [l.at, l.id]), [[1, ID], [5, ID2]]);
});

test("frozen: a time said in words becomes the time it meant; a line with no time stays as it is", () => {
  const at = new Date(2026, 10, 19, 13, 0);
  assert.equal(frozen("spend 14.5 food lunch @yday 13:00", at), "spend 14.5 food lunch @2026-11-19 13:00");
  assert.equal(frozen("spend 14.5 food lunch", undefined), "spend 14.5 food lunch");
  assert.equal(frozen("spend 14.5 food lunch @ cafe", undefined), "spend 14.5 food lunch @ cafe");
  const read = parseLine("spend 14.5 food lunch @2026-11-19 13:00", index, NOW);
  assert.ok(read.ok && read.at?.getTime() === at.getTime(), "and the capture line reads it back to the same minute");
});

test("lineOfRow: the row as the capture line that would save it", () => {
  const target = index.names.get("spend")!;
  assert.equal(lineOfRow(target, { amount: 14.5, category: "food", note: "lunch with friends" }), "spend 14.5 food lunch with friends");
  assert.equal(lineOfRow(target, { amount: 14.5, category: "food", note: "" }), "spend 14.5 food");
  assert.equal(lineOfRow(target, { amount: 14.5, category: "", note: "taxi" }), 'spend 14.5 note=taxi');
  assert.equal(lineOfRow(target, { amount: 14.5, category: "food", note: "lunch" }, "2026-11-19 13:00"), "spend 14.5 food lunch @2026-11-19 13:00");
  for (const r of [{ amount: 14.5, category: "food", note: "lunch with friends" }, { amount: 3, category: "home", note: "" }]) {
    const back = readLine(lineOfRow(target, r), index, home, NOW);
    assert.ok(back.ok);
    assert.deepEqual(lineChanges(back, r), {}, "a line written from a row reads back as that row");
  }
});

test("lineChanges: only what the line gives and the row holds differently; a time by its minute", () => {
  const read = readLine("spend 41.5 food lunch", index, home, NOW);
  assert.ok(read.ok);
  assert.deepEqual(lineChanges(read, { at: "2026-11-19T13:00-08:00", amount: 14.5, category: "food", note: "lunch", line: "planned" }), { amount: 41.5 });
  const timed = readLine("spend 14.5 food lunch @2026-11-19 13:00", index, home, NOW);
  assert.ok(timed.ok);
  assert.deepEqual(lineChanges(timed, { at: stampOf(new Date(2026, 10, 19, 13, 0)), amount: 14.5, category: "food", note: "lunch" }), {});
  assert.deepEqual(Object.keys(lineChanges(timed, { at: stampOf(new Date(2026, 10, 19, 9, 0)), amount: 14.5, category: "food", note: "lunch" })), ["at"]);
  assert.deepEqual(readLine("spend lots food", index, home, NOW), { ok: false, error: "amount must be a number, not “lots”" });
});

test("lineChanges: a line still saying what its row was typed as changes nothing, whatever the rate is now", () => {
  const yen = readSpec({ ...SPEND, fields: { ...SPEND.fields, amount: { type: "USD", rates: { JPY: 100 } } } }, { path: KIND, notes: { resolve: () => undefined, frontmatter: () => undefined } as never })!.spec!;
  const yenIndex = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map([["spend", yen.panels[0]]]) }]);
  const yenHome = () => ({ ...HOME, info: yen.panels[0].panel.fieldInfo });
  const was = { amount: 9.99, amount_as: "1500 JPY @150.2", category: "food", note: "ramen" };
  const changes = (line: string) => {
    const read = readLine(line, yenIndex, yenHome, NOW);
    assert.ok(read.ok);
    return lineChanges(read, was);
  };
  assert.deepEqual(changes("spend 1500 jpy food ramen"), {});
  assert.deepEqual(changes("spend 1500 jpy food big ramen"), { note: "big ramen" });
  assert.deepEqual(changes("spend 1600 jpy food ramen"), { amount: 16, amount_as: "1600 JPY @100" });
  assert.deepEqual(changes("spend 12 food ramen"), { amount: 12, amount_as: undefined }, "a plain number drops what the old one was typed as");
});

// ---- both ways ------------------------------------------------------------------------------------

function vault(rows: Record<string, unknown>[]) {
  const sets: [string, Record<string, unknown>, string][] = [];
  const removed: string[] = [];
  const elsewhere = new Set<string>();
  const lines = new RowLines({
    now: () => NOW,
    index: () => index,
    home: () => HOME,
    rows: async () => rows,
    set: async (_home, r, changes, note) => {
      sets.push([(r as Record<symbol, string>)[ROW_ID], changes, note]);
      Object.assign(r, changes);
    },
    remove: async (_home, r) => {
      removed.push((r as Record<symbol, string>)[ROW_ID]);
      rows.splice(rows.indexOf(r), 1);
      return async () => { rows.push(r); };
    },
    heldElsewhere: (id) => elsewhere.has(id),
  });
  return { lines, sets, removed, rows, elsewhere };
}

const DAILY = "Daily/2026-11-19.md";
const note = (...lines: string[]) => ["# Thursday", ...lines, "", "Walked to the market."].join("\n");

test("editing the sentence sets the row; an edit that changes nothing writes nothing", async () => {
  const v = vault([row(ID, { at: "2026-11-19T13:00-08:00", amount: 14.5, category: "food", note: "lunch" })]);
  v.lines.seen(DAILY, note(`✓ spend 14.5 food lunch ^gz-${ID}`));
  const done = await v.lines.edited(DAILY, note(`✓ spend 41.5 food lunch ^gz-${ID}`));
  assert.deepEqual(v.sets, [[ID, { amount: 41.5 }, DAILY]]);
  assert.deepEqual(done.set, [{ line: "spend 41.5 food lunch", fields: ["amount"] }]);
  await v.lines.edited(DAILY, note(`✓ spend 41.5 food lunch ^gz-${ID}`, "More words in the note."));
  assert.equal(v.sets.length, 1);
});

test("deleting the sentence takes the row out; a line never seen before is only taken note of", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "lunch" }), row(ID2, { amount: 30, category: "home", note: "lamp" })]);
  // Pasted into a note that wasn't open: nothing is known of it yet, so nothing is done.
  assert.deepEqual(await v.lines.edited(DAILY, note(`✓ spend 14.5 food lunch ^gz-${ID}`, `✓ spend 30 home lamp ^gz-${ID2}`)), { set: [], removed: [], unread: [] });
  const done = await v.lines.edited(DAILY, note(`✓ spend 30 home lamp ^gz-${ID2}`));
  assert.deepEqual(v.removed, [ID]);
  assert.deepEqual(done.removed, ["spend 14.5 food lunch"]);
  assert.equal(v.rows.length, 1);
});

test("a sentence edited into something unreadable leaves its row alone and says so", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "lunch" })]);
  v.lines.seen(DAILY, note(`✓ spend 14.5 food lunch ^gz-${ID}`));
  const done = await v.lines.edited(DAILY, note(`✓ spend about fifteen food lunch ^gz-${ID}`));
  assert.deepEqual(v.sets, []);
  assert.deepEqual(done.unread, [{ line: "spend about fifteen food lunch", error: "amount must be a number, not “about”" }]);
});

test("a row changed elsewhere writes its sentence again; one taken out is marked, and comes back with its row", async () => {
  const v = vault([row(ID, { at: "2026-11-19T13:00-08:00", amount: 14.5, category: "food", note: "lunch" })]);
  const text = note(`✓ spend 14.5 food lunch ^gz-${ID}`);
  v.lines.seen(DAILY, text);
  assert.equal(await v.lines.rewritten(DAILY, text), undefined, "in step: nothing to write");
  v.rows[0].amount = 16;
  v.rows[0].note = "lunch and coffee";
  const next = await v.lines.rewritten(DAILY, text);
  assert.equal(next, note(`✓ spend 16 food lunch and coffee ^gz-${ID}`));
  // What Gizmo wrote is taken as seen: the edit event it causes sets nothing.
  assert.deepEqual((await v.lines.edited(DAILY, next!)).set, []);
  const [kept] = v.rows.splice(0, 1);
  const gone = await v.lines.rewritten(DAILY, next!);
  assert.equal(gone, note(`✗ spend 16 food lunch and coffee ^gz-${ID}`));
  // Removing a line whose row is already gone takes nothing out.
  assert.deepEqual((await v.lines.edited(DAILY, note())).removed, []);
  v.rows.push(kept);
  assert.equal(await v.lines.rewritten(DAILY, gone!), note(`✓ spend 16 food lunch and coffee ^gz-${ID}`));
});

const OTHER = "Daily/2026-11-20.md";

test("a line that leaves a note while another note holds it keeps its row", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "lunch" })]);
  v.lines.seen(DAILY, note(`✓ spend 14.5 food lunch ^gz-${ID}`));
  v.elsewhere.add(ID);
  const done = await v.lines.edited(DAILY, note());
  assert.deepEqual(v.removed, []);
  assert.deepEqual(done.removed, []);
  assert.equal(v.rows.length, 1);
});

test("a line cut from one note and pasted into another a while later puts its row back, once", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "lunch" })]);
  const line = `✓ spend 14.5 food lunch ^gz-${ID}`;
  v.lines.seen(DAILY, note(line));
  await v.lines.edited(DAILY, note());
  assert.deepEqual(v.removed, [ID]);
  assert.equal(v.rows.length, 0);
  v.lines.seen(OTHER, "Friday");
  const done = await v.lines.edited(OTHER, `Friday\n${line}`);
  assert.deepEqual(done.restored, ["spend 14.5 food lunch"]);
  assert.equal(v.rows.length, 1);
  assert.equal((await v.lines.edited(OTHER, `Friday\n${line}\nMore words.`)).restored, undefined);
  assert.equal(v.rows.length, 1);
});

test("a deleted line brought back in the same note, as an undo of the typing does, puts its row back", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "lunch" })]);
  const text = note(`✓ spend 14.5 food lunch ^gz-${ID}`);
  v.lines.seen(DAILY, text);
  await v.lines.edited(DAILY, note());
  assert.deepEqual((await v.lines.edited(DAILY, text)).restored, ["spend 14.5 food lunch"]);
  assert.equal(v.rows.length, 1);
});

test("a line deleted for good takes its row with it, and a crossed-out copy brings nothing back", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "lunch" })]);
  v.lines.seen(DAILY, note(`✓ spend 14.5 food lunch ^gz-${ID}`));
  await v.lines.edited(DAILY, note());
  assert.equal(v.rows.length, 0);
  v.lines.seen(OTHER, "Friday");
  assert.equal((await v.lines.edited(OTHER, `Friday\n✗ spend 14.5 food lunch ^gz-${ID}`)).restored, undefined);
  assert.equal(v.rows.length, 0);
});

test("a word fixed in a line that is behind its row sets that word, and doesn't put the row's older values back", async () => {
  const v = vault([row(ID, { amount: 20, category: "food", note: "lunch" })]);
  v.lines.seen(DAILY, note(`✓ spend 14.5 food lunch ^gz-${ID}`));
  await v.lines.edited(DAILY, note(`✓ spend 14.5 food brunch ^gz-${ID}`));
  assert.deepEqual(v.sets, [[ID, { note: "brunch" }, DAILY]]);
  assert.equal(v.rows[0].amount, 20);
});

test("a line's time is the clock where its row was saved, so reading it in another zone changes nothing", () => {
  const read = readLine("spend 14.5 food lunch @2026-11-19 13:00", index, home, NOW);
  assert.ok(read.ok);
  assert.deepEqual(lineChanges(read, { at: "2026-11-19T13:00+14:00", amount: 14.5, category: "food", note: "lunch" }), {});
  assert.deepEqual(Object.keys(lineChanges(read, { at: "2026-11-19T14:00+14:00", amount: 14.5, category: "food", note: "lunch" })), ["at"]);
});

test("a row whose value has a line break leaves its line as it is, since one line can't say it", async () => {
  const v = vault([row(ID, { amount: 14.5, category: "food", note: "two\nlines" })]);
  const text = note(`✓ spend 14.5 food one line ^gz-${ID}`);
  v.lines.seen(DAILY, text);
  assert.equal(await v.lines.rewritten(DAILY, text), undefined);
});

test("only the lines of the rows that changed are written; a line of another data note is left", async () => {
  const v = vault([row(ID, { amount: 99, category: "food", note: "lunch" })]);
  const text = note(`✓ spend 14.5 food lunch ^gz-${ID}`);
  assert.equal(await v.lines.rewritten(DAILY, text, new Set(["Apps/Other data.md"])), undefined);
  assert.equal(await v.lines.rewritten(DAILY, text, new Set([HOME.dataPath])), note(`✓ spend 99 food lunch ^gz-${ID}`));
});
