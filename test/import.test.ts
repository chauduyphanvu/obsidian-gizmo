import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { importRows, importedText, readImports, runImport } from "../src/import.ts";
import { undoEntry } from "../src/activity.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const FIELDS = { amount: "number", category: ["food", "home", "travel"], memo: "text" } as Record<string, string | string[]>;
const SPEND = {
  kind: "spend", fields: FIELDS,
  import: { bank: { folder: "Inbox/Bank", amount: "-Amount", at: "Posted Date", memo: "Description" } },
  match: { amount: "exact", at: "2d" },
};
const CSV = [
  "Posted Date,Description,Amount",
  "11/17/2026,CORNER CAFE,-14.50",
  "11/17/2026,CORNER CAFE,-14.50",
  "11/18/2026,CITY POWER,-82.10",
  "11/18/2026,PAYROLL,2400.00",
  "",
].join("\n");

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

test("import is a set of named maps: field to column, at among them, and a folder to read", () => {
  const r = readImports(SPEND.import, FIELDS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.maps, [{
    name: "bank", folder: "Inbox/Bank",
    columns: { amount: { column: "Amount", negate: true }, at: { column: "Posted Date", negate: false }, memo: { column: "Description", negate: false } },
  }]);
  assert.deepEqual(readImports({ bank: { amount: "Amount" }, card: { at: "Date", memo: "-Text", nope: "X" } }, FIELDS).errors, [
    "import.bank needs at: the column that says when each row happened",
    "import.card: a - before a column turns a number's sign, and memo isn't a number",
    "import.card: \"nope\" isn't a field of the kind; its fields are at, amount, category, memo",
  ]);
});

test("a file's rows become attested rows, a number's sign turned, a US date read as a date, each with an id from what it holds", () => {
  const [map] = readImports(SPEND.import, FIELDS).maps;
  const records = [
    { "Posted Date": "11/17/2026", Description: "CORNER CAFE", Amount: -14.5 },
    { "Posted Date": "11/17/2026", Description: "CORNER CAFE", Amount: -14.5 },
    { "Posted Date": "13/40/2026", Description: "BAD", Amount: -1 },
    { Description: "NO DATE", Amount: -1 },
  ];
  const one = importRows("spend", map, FIELDS, records);
  assert.deepEqual(one.rows.map((r) => r.row), [
    { amount: 14.5, at: "2026-11-17", memo: "CORNER CAFE", line: "attested" },
    { amount: 14.5, at: "2026-11-17", memo: "CORNER CAFE", line: "attested" },
  ]);
  assert.notEqual(one.rows[0].id, one.rows[1].id, "two of the same row are two rows");
  assert.deepEqual(one.skipped, ["row 3: Posted Date isn't a date", "row 4 has no Posted Date"]);
  assert.deepEqual(importRows("spend", map, FIELDS, records).rows.map((r) => r.id), one.rows.map((r) => r.id), "read again, the same ids");
});

test("an import map's value that starts with = is a formula over the file's columns, as in row: a fixed value is a quoted text or a number", () => {
  const fields = { what: ["systolic", "diastolic", "pulse"], value: "number", note: "text" } as Record<string, string | string[]>;
  const r = readImports({ cuff: { at: "Date", what: '="systolic"', value: "SYS", note: '=lower(field("Cuff Note"))' } }, fields);
  assert.deepEqual(r.errors, []);
  const records = [{ Date: "2026-11-17", SYS: "128", "Cuff Note": "After COFFEE" }, { Date: "2026-11-18", SYS: "121", "Cuff Note": "" }];
  assert.deepEqual(importRows("measurement", r.maps[0], fields, records).rows.map((x) => x.row), [
    { at: "2026-11-17", what: "systolic", value: 128, note: "after coffee", line: "attested" },
    { at: "2026-11-18", what: "systolic", value: 121, line: "attested" },
  ]);
  assert.deepEqual(readImports({ a: { at: "Date", value: "=7" } }, fields).maps[0].columns.value, { column: "=7", negate: false, formula: "7" });
  // A column's name is never a formula, so "Systolic" alone is still the column of that name.
  assert.deepEqual(readImports({ a: { at: "Date", value: "Systolic" } }, fields).maps[0].columns.value, { column: "Systolic", negate: false });
  assert.deepEqual(readImports({ a: { at: "Date", what: "=$kind", value: "=round(" } }, fields).errors, [
    "import.a: what: an import's formula reads the file's columns, not $kind",
    "import.a: value: the formula ends where a value should be",
  ]);
});

test("a kind with an import folder asks to read it; one without asks for nothing", () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND } });
  const spec = readSpec(SPEND, { notes: t.env.notes, path: KIND })!.spec!;
  assert.deepEqual(permissionsOf(spec, KIND), ["read:Inbox/Bank"]);
  const plain = readSpec({ ...SPEND, import: { bank: { at: "Date" } } }, { notes: t.env.notes, path: KIND })!.spec!;
  assert.deepEqual(permissionsOf(plain, KIND), []);
});

test("an import adds every new row in one write and one activity entry, which one Undo takes back; read again it adds nothing", async () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND } });
  const spec = readSpec(SPEND, { notes: t.env.notes, path: KIND })!.spec!;
  const store = t.env.store!(KIND_DATA, KIND);
  const log = (what: string, changes: Parameters<NonNullable<typeof t.env.log>>[0]["changes"]) => t.activity.add({ app: KIND, actor: "you", what, changes }).then((e) => e?.id);
  const file = { path: "Inbox/Bank/nov.csv", text: CSV };
  const deps = { store, now: () => t.env.now(), log };
  const first = await runImport(deps, spec.kind!, spec.kind!.imports[0], file);
  assert.deepEqual([first.added, first.there, first.gone], [4, 0, 0]);
  const rows = await store.rows("spend");
  assert.deepEqual(rows.map((r) => [r.amount, r.line]), [[14.5, "attested"], [14.5, "attested"], [82.1, "attested"], [-2400, "attested"]]);
  const entries = await t.activity.list(KIND);
  assert.deepEqual(entries.map((e) => [e.what, e.changes.length]), [["Imported 4 rows from nov.csv", 4]]);
  const again = await runImport(deps, spec.kind!, spec.kind!.imports[0], file);
  assert.deepEqual([again.added, again.there], [0, 4]);
  assert.equal((await t.activity.list(KIND)).length, 1, "nothing new, nothing kept");
  assert.deepEqual(await undoEntry(entries[0], t.undoIO), { undone: 4, total: 4 });
  assert.equal((await store.rows("spend")).length, 0);
  const after = await runImport(deps, spec.kind!, spec.kind!.imports[0], file);
  assert.deepEqual([after.added, after.gone], [0, 4], "rows imported, then undone, are told and stay out");
});

test("an import changes no panel's total until its rows are accepted", async () => {
  const app = { app: "b", view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum" };
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/B.md": { fm: app } });
  await t.data.ledger!.write(KIND_DATA, [{ op: "add", l: "spend", row: "m1", v: { amount: 20, at: "2026-11-17T12:00" } }]);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, "Apps/B.md", t.env);
  started.push(c);
  c.load();
  await settle();
  assert.match(root.textContent ?? "", /Total20/);
  const spec = readSpec(SPEND, { notes: t.env.notes, path: KIND })!.spec!;
  await runImport({ store: t.env.store!(KIND_DATA, KIND), now: () => t.env.now() }, spec.kind!, spec.kind!.imports[0], { path: "Inbox/Bank/nov.csv", text: CSV });
  await settle();
  assert.match(root.textContent ?? "", /Total20/);
});

test("a new file in a kind's import folder is read in by the device running background work", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  t.f.others.set("Inbox/Bank/nov.csv", CSV);
  t.changed("Inbox/Bank/nov.csv");
  await settle();
  const rows = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.equal(rows.length, 4);
  assert.ok(t.notices.includes("Imported 4 rows from nov.csv into Spend"), t.notices.join("\n"));
  const [entry] = await t.activity.list(KIND);
  assert.equal(entry.actor, "import");
  t.f.others.set("Inbox/Bank/notes.txt", "not rows");
  t.changed("Inbox/Bank/notes.txt");
  await settle();
  assert.equal((await t.activity.list(KIND)).length, 1, "the same file read again, and a file of another kind, add nothing");
  assert.deepEqual(rows.map(rowIdOf), (await t.env.store!(KIND_DATA, KIND).rows("spend")).map(rowIdOf));
});

test("a device that doesn't run background work leaves the folder alone; the files there at start are read once it does", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  t.f.others.set("Inbox/Bank/nov.csv", CSV);
  t.device.background = false;
  await t.bg.start();
  await settle();
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 0);
  t.device.background = true;
  await t.bg.tick();
  await settle();
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 4);
});

test("the files already in the folder are read in as soon as the kind is allowed, not a tick later", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } }, {}, { seen: true });
  t.f.others.set("Inbox/Bank/nov.csv", CSV);
  await t.bg.start();
  await settle();
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 0, "not allowed yet");
  t.grants[KIND] = ["read:Inbox/Bank"];
  t.bg.opened(KIND);
  await settle();
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 4);
  assert.ok(t.notices.includes("Imported 4 rows from nov.csv into Spend"), t.notices.join("\n"));
});

test("the command's import reads the file a person picks, under the map they pick", async () => {
  const t = fakeBackground({ [KIND]: { fm: { ...SPEND, import: { bank: { amount: "-Amount", at: "Posted Date" } } } } });
  await t.bg.start();
  t.f.others.set("Downloads/nov.csv", CSV);
  const r = await t.bg.importFile(KIND, "bank", "Downloads/nov.csv", "you");
  assert.ok(!("error" in r));
  assert.equal(r.added, 4, "two rows that hold the same are still two rows");
  assert.deepEqual(await t.bg.importFile(KIND, "card", "Downloads/nov.csv", "you"), { error: "Spend has no import called card" });
});

test("an import's where reads the file's columns, as a panel's where reads fields, before anything is mapped; what it leaves out is counted and told", async () => {
  const kind = { ...SPEND, import: { bank: { ...SPEND.import.bank, where: { Amount: "< 0" } } } };
  const r = readImports(kind.import, FIELDS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.maps[0].where, { Amount: "< 0" });
  assert.deepEqual(readImports({ bank: { at: "Date", where: "Amount < 0" }, card: { at: "Date", where: { Amount: ["< 0"] } } }, FIELDS).errors, [
    "import.bank: where must be a set of column: condition, e.g. where: {Amount: \"< 0\"}",
    "import.card: where must be a set of column: condition, e.g. where: {Amount: \"< 0\"}",
  ]);
  // A column the map doesn't read can still pick rows: a pay cheque is money in.
  const picked = importRows("spend", readImports({ bank: { at: "Posted Date", memo: "Description", where: { Description: "!= PAYROLL", Amount: "< 0" } } }, FIELDS).maps[0], FIELDS, [
    { "Posted Date": "11/17/2026", Description: "CORNER CAFE", Amount: "-14.50" },
    { "Posted Date": "11/18/2026", Description: "PAYROLL", Amount: "2,400.00" },
    { "Posted Date": "11/18/2026", Description: "REFUND", Amount: "3.10" },
    { Description: "NO DATE", Amount: "-1" },
  ]);
  assert.deepEqual(picked.rows.map((x) => x.row.memo), ["CORNER CAFE"]);
  assert.deepEqual([picked.left, picked.skipped], [2, ["row 4 has no Posted Date"]], "a row left out isn't a row that couldn't be read");
  // `where` reads money as the fields do: a bank that writes a currency sign still has money out.
  const signed = importRows("spend", readImports({ bank: { at: "Posted Date", amount: "-Amount", memo: "Description", where: { Amount: "< 0" } } }, FIELDS).maps[0], FIELDS, [
    { "Posted Date": "11/17/2026", Description: "CORNER CAFE", Amount: "-$14.50" },
    { "Posted Date": "11/18/2026", Description: "CITY POWER", Amount: "-€1,082.10" },
    { "Posted Date": "11/18/2026", Description: "PAYROLL", Amount: "$2,400.00" },
  ]);
  assert.deepEqual(signed.rows.map((x) => [x.row.memo, x.row.amount]), [["CORNER CAFE", 14.5], ["CITY POWER", 1082.1]]);
  assert.equal(signed.left, 1, "only the pay cheque is left out");

  const t = fakeEnv({ [KIND]: { fm: kind } });
  const spec = readSpec(kind, { notes: t.env.notes, path: KIND })!.spec!;
  const store = t.env.store!(KIND_DATA, KIND);
  const done = await runImport({ store, now: () => t.env.now() }, spec.kind!, spec.kind!.imports[0], { path: "Inbox/Bank/nov.csv", text: CSV });
  assert.deepEqual([done.added, done.left], [3, 1]);
  assert.deepEqual((await store.rows("spend")).map((x) => x.memo), ["CORNER CAFE", "CORNER CAFE", "CITY POWER"]);
  assert.equal(importedText(done, "Spend", "nov.csv"), "Imported 3 rows from nov.csv into Spend, skipped 1");
  const again = await runImport({ store, now: () => t.env.now() }, spec.kind!, spec.kind!.imports[0], { path: "Inbox/Bank/nov.csv", text: CSV });
  assert.equal(importedText(again, "Spend", "nov.csv"), "Nothing new in nov.csv for Spend, skipped 1; 3 rows already imported");
});

test("an imported time is the same text, and its row the same id, on every device: a calendar's time in its own zone's clock and offset, an ISO time with its own, a floating time as written", async () => {
  const fields = { title: "text" } as Record<string, string | string[]>;
  const [cal] = readImports({ cal: { at: "start", title: "summary" } }, fields).maps;
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:1", "DTSTART:20261119T233000Z", "SUMMARY:Dentist", "END:VEVENT",
    "BEGIN:VEVENT", "UID:2", "DTSTART;TZID=America/Los_Angeles:20261119T153000", "SUMMARY:Call", "END:VEVENT",
    "BEGIN:VEVENT", "UID:3", "DTSTART:20261120T090000", "SUMMARY:Gym", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const seen: { id?: string; row: Record<string, unknown> }[] = [];
  const store = { dataPath: "Kinds/Visit data.md", batch: async (edits: { id?: string; row: Record<string, unknown> }[]) => edits.map((e) => (seen.push({ id: e.id, row: e.row }), { row: e.row })) } as never;
  await runImport({ store, now: () => new Date(2026, 10, 18, 12) }, { name: "visit", fields }, cal, { path: "Inbox/cal.ics", text: ics });
  // Run under three time zones (npm run test:tz): the same text, and so the same ids, in each.
  assert.deepEqual(seen.map((s) => s.row.at), ["2026-11-19T15:30-08:00", "2026-11-19T23:30+00:00", "2026-11-20T09:00"]);
  assert.deepEqual(seen.map((s) => s.id), ["272a0ede2dced258", "382fb74acdbb8eb8", "bf50f30c73901dbe"]);

  // A JSON export's times, read as stamps, pair on the day of their own clock wherever they are read.
  const [json] = readImports({ j: { at: "time", amount: "amount" } }, FIELDS).maps;
  const r = importRows("spend", json, FIELDS, [{ time: "2026-11-19T23:30:00Z", amount: 12 }, { time: "2026-11-19 08:05:59", amount: 3 }, { time: "Nov 19 2026", amount: 1 }]);
  assert.deepEqual(r.rows.map((x) => x.row.at), ["2026-11-19T23:30+00:00", "2026-11-19T08:05"]);
  assert.deepEqual(r.skipped, ["row 3: time isn't a date"]);
});

test("an import's ids name its map: the same charge in two accounts on one day is two rows; a later export of the same account that overlaps adds nothing new", async () => {
  const maps = readImports({ checking: { at: "Posted Date", amount: "-Amount", memo: "Description" }, card: { at: "Posted Date", amount: "-Amount", memo: "Description" } }, FIELDS).maps;
  const rec = [{ "Posted Date": "11/17/2026", Description: "CORNER CAFE", Amount: -14.5 }];
  const [checking, card] = maps.map((m) => importRows("spend", m, FIELDS, rec).rows[0].id);
  assert.notEqual(checking, card);
  const t = fakeEnv({ [KIND]: { fm: SPEND } });
  const store = t.env.store!(KIND_DATA, KIND);
  const [bank] = readImports(SPEND.import, FIELDS).maps;
  const first = await runImport({ store, now: () => new Date(2026, 10, 18, 12) }, { name: "spend", fields: FIELDS }, bank, { path: "Inbox/Bank/Checking 2026-11-15.csv", text: CSV });
  const later = await runImport({ store, now: () => new Date(2026, 10, 18, 12) }, { name: "spend", fields: FIELDS }, bank, { path: "Inbox/Bank/Checking 2026-11-18.csv", text: CSV });
  assert.deepEqual([first.added, later.added, later.there], [4, 0, 4]);
});
