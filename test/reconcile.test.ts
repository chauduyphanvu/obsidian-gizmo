import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { undoEntry } from "../src/activity.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { reconcileOf, readMatch } from "../src/match.ts";
import { fakeEnv } from "./support/fakes.ts";

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const FIELDS = { amount: "number", memo: "text" };
const SPEND = { kind: "spend", fields: FIELDS, match: { amount: "exact", at: "2d" } };
const BUDGET = { app: "b", view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum" };

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

/** Three logged rows and three read from a bank file: one pairs, two pair with nothing. */
async function vault(kind: Record<string, unknown> = SPEND) {
  const t = fakeEnv({ [KIND]: { fm: kind }, "Apps/B.md": { fm: BUDGET } });
  await t.data.ledger!.write(KIND_DATA, [
    { op: "add", l: "spend", row: "m1", v: { amount: 14.5, memo: "lunch", at: "2026-11-17T12:30" } },
    { op: "add", l: "spend", row: "m2", v: { amount: 14.5, memo: "lunch again", at: "2026-11-17T13:00" } },
    { op: "add", l: "spend", row: "m3", v: { amount: 60, memo: "cash", at: "2026-11-16T09:00" } },
    { op: "add", l: "spend", row: "b1", v: { amount: 14.5, memo: "CORNER CAFE", at: "2026-11-17", line: "attested" } },
    { op: "add", l: "spend", row: "b2", v: { amount: 82.1, memo: "CITY POWER", at: "2026-11-18", line: "attested" } },
    { op: "add", l: "spend", row: "b3", v: { amount: 9, memo: "NOT ME", at: "2026-11-18", line: "attested" } },
  ]);
  const open = (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const c = new AppController(root, path, t.env);
    started.push(c);
    c.load();
    return root;
  };
  const rows = () => t.env.store!(KIND_DATA, KIND).rows("spend");
  return { ...t, open, rows };
}

const card = (root: Element) => root.querySelector(".gz-reconcile");
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label)!;

test("the four counts: paired, only in the file, only logged, logged twice", async () => {
  const t = await vault();
  const r = reconcileOf(await t.rows(), readMatch(SPEND.match, FIELDS).rule)!;
  assert.deepEqual(r.counts, { pairs: 1, attestedOnly: 2, loggedOnly: 1, loggedTwice: 1 });
  assert.deepEqual(r.open.map((o) => [rowIdOf(o.row), o.pair && rowIdOf(o.pair)]), [["b1", "m1"], ["b2", undefined], ["b3", undefined]]);
  assert.equal(reconcileOf((await t.rows()).filter((x) => x.line === undefined), {}), undefined, "nothing to check, no card");
});

test("a kind with no match pairs by the same amount within 2 days", async () => {
  const t = await vault({ kind: "spend", fields: FIELDS });
  const kind = t.open(KIND);
  await settle();
  assert.equal(text(card(kind)?.querySelector(".gz-reconcile-counts")), "1 pair with rows you logged2 only in the file1 only logged1 logged twice");
});

test("the kind's own note shows the rows from a file to check; an app reading the kind doesn't", async () => {
  const t = await vault();
  const kind = t.open(KIND);
  const app = t.open("Apps/B.md");
  await settle();
  assert.equal(text(card(kind)?.querySelector(".gz-title")), "3 rows from a file to check");
  assert.equal(text(card(kind)?.querySelector(".gz-reconcile-counts")), "1 pair with rows you logged2 only in the file1 only logged1 logged twice");
  assert.deepEqual([...card(kind)!.querySelectorAll("li .gz-reconcile-row")].map(text), ["Nov 17 · 14.50 · CORNER CAFE", "Nov 18 · 82.10 · CITY POWER", "Nov 18 · 9 · NOT ME"]);
  assert.ok(!card(app));
  assert.match(text(app), /Total89/, "until accepted, only what was logged counts");
});

test("each row to check holds what it says in one box and its buttons in another beside it, so a long row wraps in its box and the buttons stay at its right", async () => {
  const t = await vault();
  const kind = t.open(KIND);
  await settle();
  const li = card(kind)!.querySelector("li")!;
  assert.deepEqual([...li.children].map((c) => c.className), ["gz-reconcile-what", "gz-actions"]);
  assert.equal(text(li.querySelector(".gz-reconcile-what")), "Nov 17 · 14.50 · CORNER CAFE = Nov 17 · 14.50 · lunch");
  assert.deepEqual([...li.querySelectorAll(".gz-actions button")].map(text), ["Accept", "Not mine"]);
});

test("Accept pairs a row, or makes one that pairs with nothing logged; Not mine sets it aside; each is one entry Undo takes back", async () => {
  const t = await vault();
  const kind = t.open(KIND);
  const app = t.open("Apps/B.md");
  await settle();
  const rowsOf = () => [...card(kind)!.querySelectorAll("li")];
  click(buttonIn(rowsOf()[0], "Accept"));
  await settle();
  assert.equal((await t.rows()).find((r) => rowIdOf(r) === "b1")!.matched, "m1");
  assert.match(text(app), /Total89/, "a paired row is the row logged, counted once");
  click(buttonIn(rowsOf()[0], "Accept"));
  await settle();
  const b2 = (await t.rows()).find((r) => rowIdOf(r) === "b2")!;
  assert.deepEqual([b2.line, b2.amount], [undefined, 82.1]);
  assert.equal((await t.rows()).length, 6, "accepted, not copied");
  assert.match(text(app), /Total171/);
  click(buttonIn(rowsOf()[0], "Not mine"));
  await settle();
  assert.equal((await t.rows()).find((r) => rowIdOf(r) === "b3")!.line, "dismissed");
  assert.ok(!card(kind), "nothing left to check");
  const entries = await t.activity.list(KIND);
  assert.deepEqual(entries.map((e) => e.what), ["Set aside a row from a file", "Accepted a row from a file", "Accepted a row from a file"]);
  await undoEntry(entries[0], t.undoIO);
  await undoEntry(entries[1], t.undoIO);
  await settle();
  assert.deepEqual((await t.rows()).filter((r) => r.line === "attested" && r.matched === undefined).map(rowIdOf), ["b2", "b3"]);
  assert.equal(text(card(kind)?.querySelector(".gz-title")), "2 rows from a file to check");
});

test("Accept all settles every open row in one write and one entry", async () => {
  const t = await vault();
  const kind = t.open(KIND);
  await settle();
  click(buttonIn(card(kind)!, "Accept all"));
  await settle();
  const rows = await t.rows();
  assert.deepEqual(rows.map((r) => [rowIdOf(r), r.line ?? "logged", r.matched]), [
    ["m1", "logged", undefined], ["m2", "logged", undefined], ["m3", "logged", undefined],
    ["b1", "attested", "m1"], ["b2", "logged", undefined], ["b3", "logged", undefined],
  ]);
  const [entry] = await t.activity.list(KIND);
  // b1 is paired; b2 and b3 each become logged and keep their import's id.
  assert.deepEqual([entry.what, entry.changes.length], ["Accepted 3 rows from a file", 5]);
  assert.ok(!card(kind));
  await undoEntry(entry, t.undoIO);
  assert.equal((await t.rows()).filter((r) => r.line === "attested" && r.matched === undefined).length, 3);
});

test("an accepted row that pairs with nothing logged settles the planned row it matches, in the same entry; Undo takes back both", async () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/B.md": { fm: BUDGET } });
  await t.data.ledger!.write(KIND_DATA, [
    { op: "add", l: "spend", row: "p1", v: { amount: 38.2, memo: "METRO WATER", at: "2026-11-16T09:00", line: "planned" } },
    { op: "add", l: "spend", row: "p2", v: { amount: 38.2, memo: "METRO WATER", at: "2026-12-16T09:00", line: "planned" } },
    { op: "add", l: "spend", row: "w1", v: { amount: 38.2, memo: "METRO WATER", at: "2026-11-17", line: "attested" } },
    { op: "add", l: "spend", row: "w2", v: { amount: 38.2, memo: "METRO WATER", at: "2026-11-17", line: "attested" } },
  ]);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, KIND, t.env);
  started.push(c);
  c.load();
  await settle();
  const rows = () => t.env.store!(KIND_DATA, KIND).rows("spend");
  const state = async () => (await rows()).map((r) => [rowIdOf(r), r.line ?? "logged", r.matched]);
  click(buttonIn(card(root)!, "Accept all"));
  await settle();
  // The first bank row settles the planned row of that month; the second finds none left within its days, and stays a row of its own.
  assert.deepEqual(await state(), [["p1", "planned", "w1"], ["p2", "planned", undefined], ["w1", "logged", undefined], ["w2", "logged", undefined]]);
  const [entry] = await t.activity.list(KIND);
  assert.deepEqual([entry.what, entry.changes.length], ["Accepted 2 rows from a file", 5]);
  await undoEntry(entry, t.undoIO);
  await settle();
  assert.deepEqual(await state(), [["p1", "planned", undefined], ["p2", "planned", undefined], ["w1", "attested", undefined], ["w2", "attested", undefined]]);
});

test("two identical charges in one export, one logged by hand: accepting the unpaired twin keeps that it came from a file, and the other twin still pairs with the hand row", async () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/B.md": { fm: BUDGET } });
  await t.data.ledger!.write(KIND_DATA, [
    { op: "add", l: "spend", row: "h1", v: { amount: 4.5, memo: "coffee", at: "2026-11-08T09:12" } },
    { op: "add", l: "spend", row: "t1", v: { amount: 4.5, memo: "BLUE BOTTLE COFFEE", at: "2026-11-08", line: "attested" } },
    { op: "add", l: "spend", row: "t2", v: { amount: 4.5, memo: "BLUE BOTTLE COFFEE", at: "2026-11-08", line: "attested" } },
  ]);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, KIND, t.env);
  started.push(c);
  c.load();
  await settle();
  const rows = () => t.env.store!(KIND_DATA, KIND).rows("spend");
  const rule = readMatch(SPEND.match, FIELDS).rule;
  const before = reconcileOf(await rows(), rule)!;
  assert.deepEqual(before.open.map((o) => [rowIdOf(o.row), o.pair && rowIdOf(o.pair)]), [["t1", "h1"], ["t2", undefined]]);
  const unpaired = [...card(root)!.querySelectorAll("li")][1];
  click(buttonIn(unpaired, "Accept"));
  await settle();
  const t2 = (await rows()).find((r) => rowIdOf(r) === "t2")!;
  assert.deepEqual([t2.line, t2.imported], [undefined, "t2"], "logged, and still known to have come from a file");
  const after = reconcileOf(await rows(), rule)!;
  assert.deepEqual(after.open.map((o) => [rowIdOf(o.row), o.pair && rowIdOf(o.pair)]), [["t1", "h1"]], "the other twin pairs with the hand row, never with its accepted twin");
  assert.deepEqual(after.counts, { pairs: 1, attestedOnly: 0, loggedOnly: 0, loggedTwice: 0 });
  const [entry] = await t.activity.list(KIND);
  await undoEntry(entry, t.undoIO);
  const undone = (await rows()).find((r) => rowIdOf(r) === "t2")!;
  assert.deepEqual([undone.line, undone.imported], ["attested", undefined], "Undo takes back both");
});

test("view: reconcile shows a kind's card in an app that reads the kind, asks to change its rows, and its Accept and Not mine are the app's changes; nothing waiting, it says so", async () => {
  const app = { app: "b", panels: [{ view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum" }, { view: "reconcile", title: "From the bank", source: "[[Spend]]" }] };
  const t = await vault();
  t.f.files.set("Apps/C.md", { fm: app });
  const spec = (await import("../src/spec.ts")).readSpec(app, { notes: t.env.notes, path: "Apps/C.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual((await import("../src/permissions.ts")).permissionsOf(spec.spec!, "Apps/C.md"), ["kind-write:Kinds/Spend.md", "kind:Kinds/Spend.md"]);
  const root = t.open("Apps/C.md");
  await settle();
  const panel = [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-title")) === "From the bank")!;
  assert.equal(text(card(panel)?.querySelector(".gz-title")), "3 rows from a file to check");
  assert.equal(text(card(panel)?.querySelector(".gz-reconcile-counts")), "1 pair with rows you logged2 only in the file1 only logged1 logged twice");
  click(buttonIn([...card(panel)!.querySelectorAll("li")][2], "Not mine"));
  await settle();
  click(buttonIn(card(panel)!, "Accept all"));
  await settle();
  assert.deepEqual((await t.rows()).filter((r) => r.line !== undefined).map((r) => [rowIdOf(r), r.line, r.matched]), [["b1", "attested", "m1"], ["b3", "dismissed", undefined]]);
  assert.match(text(root), /Total171/);
  assert.equal(text(panel.querySelector(".gz-empty")), "Nothing read from a file waits to be checked.");
  assert.deepEqual((await t.activity.list("Apps/C.md")).map((e) => e.what), ["Accepted 2 rows from a file", "Set aside a row from a file"]);

  const wrong = (await import("../src/spec.ts")).readSpec({ app: "x", view: "reconcile", source: "spend" }, { notes: t.env.notes, path: "Apps/X.md" })!;
  assert.deepEqual(wrong.errors, ['reconcile checks the rows a kind read from a file; give it a source that links to a kind, e.g. source: "[[Spend]]"']);
});
