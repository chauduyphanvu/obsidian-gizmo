import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { AppWrites } from "../src/app-writes.ts";
import { MAX_PLANNED, NOT_YET, captureTargets, parseFields, parseLine, plannedText } from "../src/capture.ts";
import { undoEntry } from "../src/activity.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { readSpec } from "../src/spec.ts";
import { stampOf } from "../src/time.ts";
import { addLine, said, typeLine } from "./support/addline.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const SPEND = { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home", "travel"], memo: "text" }, match: { amount: "exact", category: "exact", at: "2d" } };
const BUDGET = { app: "b", panels: [{ view: "form", title: "Spent", save: "[[Spend]]", label: "Add" }] };
const OWN = { app: "o", panels: [{ view: "form", title: "Spent", alias: "paid", save: "spend", fields: { amount: "number", memo: "text" } }] };

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });
const at = (y: number, m: number, d: number, h = 12, mi = 0) => stampOf(new Date(y, m - 1, d, h, mi));

test("on a kind, a capture line for a time still to come plans a row; an app's own list still refuses it", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND }, "Apps/O.md": { fm: OWN } });
  await t.bg.start();
  const preview = await t.bg.previewLine("spend 1200 home rent @2026-12-01");
  assert.ok(preview.parsed.ok);
  assert.equal(preview.parsed.at?.getTime(), new Date(2026, 11, 1, 12, 0).getTime());
  const ran = await t.bg.capture("spend 1200 home rent @2026-12-01");
  assert.ok(ran.ok, JSON.stringify(ran));
  const rows = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ amount: 1200, category: "home", memo: "rent", at: at(2026, 12, 1), line: "planned" }]);
  const own = await t.bg.capture("paid 3 lunch @tomorrow");
  assert.deepEqual([own.ok, own.error], [false, NOT_YET]);
});

test("@every plans one row a period up to a date, in one write and one entry, and at most a year of days", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  const ran = await t.bg.capture("spend 1200 home rent @every month until 2027-03-01");
  assert.ok(ran.ok, JSON.stringify(ran));
  const rows = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.deepEqual(rows.map((r) => [r.at, r.line]), [[at(2026, 12, 18), "planned"], [at(2027, 1, 18), "planned"], [at(2027, 2, 18), "planned"]]);
  const [entry] = await t.activity.list(KIND);
  assert.equal(entry.changes.length, 3);
  const many = await t.bg.capture("spend 5 food coffee @every day until 2028-12-31");
  assert.deepEqual([many.ok, many.error], [false, `that plans more than ${MAX_PLANNED} rows; pick a nearer date or a longer period`]);
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 3);
});

test("@every keeps a month's day, or its last day when it has fewer", () => {
  const index = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map([["spend", { panel: { view: "form", fields: SPEND.fields, target: { kind: "list", name: "spend", at: KIND } } } as never]]) }]);
  const p = parseLine("spend 1 home @every month until 2027-03-31", index, new Date(2027, 0, 31, 9, 0));
  assert.ok(p.ok);
  assert.deepEqual(p.plan!.map((d) => [d.getMonth() + 1, d.getDate()]), [[2, 28], [3, 31]]);
  assert.equal(p.params!.at, "every month until 2027-03-31", "a link carries the words, read again when it runs");
  assert.equal(parseFields("1 @every month until 2027-03-31", [["amount", "number"]], new Date(2027, 0, 31), { name: "o", loose: true }).plan, undefined,
    "an app's own list reads no @every: the words stay what was typed");
});

test("@every takes a time of day and a day to start from; only times still to come are planned, and the preview says the first, the last and how many", () => {
  const index = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map([["spend", { panel: { view: "form", fields: SPEND.fields, target: { kind: "list", name: "spend", at: KIND } } } as never]]) }]);
  const noon = new Date(2026, 10, 18, 12, 0);
  const read = (line: string, now = noon) => parseLine(line, index, now);
  const days = (p: ReturnType<typeof read>) => (p.ok ? p.plan!.map((d) => stampOf(d)) : p.error);

  // Each day at 08:00: today's has passed at noon, so the first is tomorrow's; until a month and a day.
  const daily = read("spend 4 food coffee @every day 08:00 until dec 5");
  assert.ok(daily.ok, JSON.stringify(daily));
  assert.equal(daily.plan!.length, 17);
  assert.deepEqual([stampOf(daily.plan![0]), stampOf(daily.plan!.at(-1)!)], [at(2026, 11, 19, 8), at(2026, 12, 5, 8)]);
  assert.equal(plannedText({ at: daily.at!, plan: daily.plan }, noon), "planned 17 times, Thu Nov 19, 08:00 to Sat Dec 5, 08:00");
  assert.equal(daily.params!.at, "every day 08:00 until dec 5");
  // At 07:00, today's 08:00 is still to come, and so is the first.
  assert.equal(days(read("spend 4 food coffee @every day 8am until dec 5", new Date(2026, 10, 18, 7)))[0], at(2026, 11, 18, 8));

  // From a day: the first of December, then each month, to the first of the next December, at the time now.
  const monthly = read("spend 1450 home rent @every month from 2026-12-01 until 2027-12-01");
  assert.deepEqual([monthly.ok && monthly.plan!.length, days(monthly).slice(0, 2), (days(monthly) as string[]).at(-1)], [13, [at(2026, 12, 1), at(2027, 1, 1)], at(2027, 12, 1)]);
  // From a weekday and a time: the next Monday at 09:00, then each Monday.
  assert.deepEqual(days(read("spend 20 travel class @every week from mon 09:00 until 2026-12-21")), [23, 30].map((d) => at(2026, 11, d, 9)).concat([7, 14, 21].map((d) => at(2026, 12, d, 9))));
  // From a month and a day; a year-less day that has passed this year is next year's.
  assert.deepEqual(days(read("spend 9 travel app @every month from jan 31 until 03-31")), [at(2027, 1, 31), at(2027, 2, 28), at(2027, 3, 31)]);

  // The forms there were keep their meaning: the first a period from now, at the time now.
  assert.deepEqual(days(read("spend 1 home @every week until 2026-12-09")), [at(2026, 11, 25), at(2026, 12, 2), at(2026, 12, 9)]);

  // What can't be read says what to type.
  assert.equal((read("spend 1 home @every day 25:00 until dec 5") as { error: string }).error, "say every day, week, month or year, or a count of them, until a date, e.g. @every month until 2027-06-01, @every day 08:00 until dec 5 or @every 3 months from 2026-12-12 until 2028-01-01");
  assert.equal((read("spend 1 home @every week from someday until dec 5") as { error: string }).error, "from must be a day (2026-12-01, dec 1, mon, tomorrow), not “someday until dec 5”");
  assert.equal((read("spend 1 home @every day until dec 40") as { error: string }).error, "until must be a date (2027-06-01, dec 5, 06-01, +30d), not “dec 40”");
  assert.equal((read("spend 1 home @every month from 2027-01-10 until 2026-12-31") as { error: string }).error, "until 2026-12-31 comes before the first month still to come");
});

test("@every takes a count and year: every 3 months, every 2 weeks, every year, each from a day; the cap and the preview still hold", () => {
  const index = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map([["spend", { panel: { view: "form", fields: SPEND.fields, target: { kind: "list", name: "spend", at: KIND } } } as never]]) }]);
  const noon = new Date(2026, 10, 18, 12, 0);
  const read = (line: string) => parseLine(line, index, noon);
  const days = (p: ReturnType<typeof read>) => (p.ok ? p.plan!.map((d) => stampOf(d)) : p.error);

  const filter = read("spend 24.99 home filter @every 3 months from 2026-12-12 until 2028-01-01");
  assert.ok(filter.ok, JSON.stringify(filter));
  assert.deepEqual(days(filter), [at(2026, 12, 12), at(2027, 3, 12), at(2027, 6, 12), at(2027, 9, 12), at(2027, 12, 12)]);
  assert.equal(plannedText({ at: filter.at!, plan: filter.plan }, noon), "planned 5 times, Sat Dec 12, 12:00 to Sun Dec 12 2027, 12:00");
  assert.equal(filter.params!.at, "every 3 months from 2026-12-12 until 2028-01-01", "a link carries the words, read again when it runs");
  assert.deepEqual(days(read("spend 20 travel class @every 2 weeks from mon 09:00 until 2026-12-21")), [at(2026, 11, 23, 9), at(2026, 12, 7, 9), at(2026, 12, 21, 9)]);
  assert.deepEqual(days(read("spend 99 home alarm @every year from 2026-12-12 until 2030-01-01")), [2026, 2027, 2028, 2029].map((y) => at(y, 12, 12)));
  // A year keeps the day, or the month's last day: February 29 is the 28th in the years between.
  assert.deepEqual(days(read("spend 1 home leap @every year from 2028-02-29 09:00 until 2031-03-01")), [at(2028, 2, 29, 9), at(2029, 2, 28, 9), at(2030, 2, 28, 9), at(2031, 2, 28, 9)]);
  // Without a day to start, the first is that many periods from now; a count of 1 and the plain word are the same.
  assert.deepEqual(days(read("spend 1 home @every 2 days until 2026-11-24")), [at(2026, 11, 20), at(2026, 11, 22), at(2026, 11, 24)]);
  assert.deepEqual(days(read("spend 1 home @every 1 week until 2026-12-09")), days(read("spend 1 home @every week until 2026-12-09")));
  assert.deepEqual(days(read("spend 1 home @every 2 years until 2031-01-01")), [at(2028, 11, 18), at(2030, 11, 18)]);

  assert.equal((read("spend 1 home @every 0 months until 2027-06-01") as { error: string }).error, "the count after every must be 1 or more, e.g. every 3 months");
  assert.equal((read("spend 1 home @every 1 day until 2028-12-31") as { error: string }).error, `that plans more than ${MAX_PLANNED} rows; pick a nearer date or a longer period`);
});

test("on a line that plans, a month and a day with no year is the next one; a weekday, and an app's own list, keep the last one", () => {
  const index = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map([["spend", { panel: { view: "form", fields: SPEND.fields, target: { kind: "list", name: "spend", at: KIND } } } as never]]) }]);
  const noon = new Date(2026, 10, 18, 12, 0);
  const when = (line: string) => {
    const p = parseLine(line, index, noon);
    return p.ok ? stampOf(p.at!) : p.error;
  };
  assert.equal(when("spend 1200 home rent @dec 1"), at(2026, 12, 1));
  assert.equal(when("spend 1200 home rent @december 1 09:00"), at(2026, 12, 1, 9));
  assert.equal(when("spend 1200 home rent @12-01"), at(2026, 12, 1));
  assert.equal(when("spend 60 home gift @nov 10"), at(2027, 11, 10), "a day gone by this year is next year's");
  assert.equal(when("spend 4 food lunch @nov 18 08:30"), at(2026, 11, 18, 8, 30), "today's, at a time gone by, is logged");
  assert.equal(when("spend 4 food lunch @mon"), at(2026, 11, 16), "a weekday is still the last one");
  // An app's own list logs only what happened: 12-01 there is the last one, as before.
  const own = parseFields("3 lunch @12-01", [["amount", "number"], ["memo", "text"]], noon, { name: "o", loose: true });
  assert.equal(stampOf(own.at!), at(2025, 12, 1));
});

test("a logged row settles the planned row it matches, in the same entry, which one Undo takes back", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  assert.ok((await t.bg.capture("spend 1200 home rent @2026-11-20")).ok);
  t.advance(3 * 86_400_000);
  const ran = await t.bg.capture("spend 1200 home paid rent");
  assert.ok(ran.ok, JSON.stringify(ran));
  const store = t.env.store!(KIND_DATA, KIND);
  const rows = await store.rows("spend");
  assert.deepEqual(rows.map((r) => [r.line ?? "logged", r.matched]), [["planned", rowIdOf(rows[1])], ["logged", undefined]]);
  const entry = (await t.activity.list(KIND))[0];
  assert.deepEqual(entry.changes.map((c) => c.kind), ["row-added", "row-edited"]);
  await undoEntry(entry, t.undoIO);
  assert.deepEqual((await store.rows("spend")).map((r) => [r.line, r.matched]), [["planned", undefined]]);
  assert.ok((await t.bg.capture("spend 900 home other")).ok);
  assert.equal((await store.rows("spend"))[0].matched, undefined, "a row that doesn't match settles nothing");
});

function open(notes: Record<string, { fm: Record<string, unknown> }>, path: string) {
  const t = fakeEnv(notes);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, t.env);
  started.push(c);
  c.load();
  return { ...t, root };
}

test("a kind with no match settles a planned row by the same amount within 2 days", async () => {
  const { match: _, ...plain } = SPEND;
  const t = fakeBackground({ [KIND]: { fm: plain } });
  await t.bg.start();
  assert.ok((await t.bg.capture("spend 1200 home rent @2026-11-20")).ok);
  assert.ok((await t.bg.capture("spend 80 food dinner @2026-11-21")).ok);
  t.advance(3 * 86_400_000);
  assert.ok((await t.bg.capture("spend 1200 travel paid rent")).ok, "a choice isn't part of the default");
  const rows = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.deepEqual(rows.map((r) => [r.amount, r.line ?? "logged", r.matched]), [[1200, "planned", rowIdOf(rows[2])], [80, "planned", undefined], [1200, "logged", undefined]]);
});

test("an app's add line that saves to a kind says a time still to come is planned, and plans the row", async () => {
  const t = open({ [KIND]: { fm: SPEND }, "Apps/B.md": { fm: BUDGET } }, "Apps/B.md");
  await settle();
  typeLine(t.root, "1200 home rent @2026-12-01");
  assert.deepEqual([...t.root.querySelectorAll(".gz-pv")].map(text).at(-1), "plannedTue Dec 1, 12:00");
  addLine(t.root, "1200 home rent @2026-12-01");
  await settle();
  assert.equal(said(t.root), "Planned 1,200 in spend for Tue Dec 1, 12:00");
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => r.line), ["planned"]);
  typeLine(t.root, "5 food @every week until 2026-12-05");
  assert.equal([...t.root.querySelectorAll(".gz-pv")].map(text).at(-1), "planned2 times, Wed Nov 25, 12:00 to Wed Dec 2, 12:00");
});

test("the kind's own add line plans a row too, and its table keeps showing what was logged", async () => {
  const t = open({ [KIND]: { fm: SPEND } }, KIND);
  await settle();
  addLine(t.root, "1200 home rent @tomorrow 9am");
  await settle();
  assert.equal(said(t.root), "Planned 1,200 in spend for Thu Nov 19, 09:00");
  assert.equal(t.root.querySelectorAll("tbody tr").length, 0);
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => r.line), ["planned"]);
});

test("moving a kind's logged row to a time still to come plans it, in one entry; an app's own row still can't move there", async () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/O.md": { fm: OWN } });
  await t.data.ledger!.write(KIND_DATA, [{ op: "add", l: "spend", row: "r1", v: { amount: 5, at: at(2026, 11, 17) } }]);
  const site = (appPath: string) => ({ appPath, hostPath: appPath, dataPath: () => appPath.replace(/\.md$/, " data.md"), checklistName: (k: string) => k, expect: () => [] });
  const kindSpec = readSpec(SPEND, { notes: t.env.notes, path: KIND })!.spec!;
  const table = kindSpec.panels[1].panel;
  const [row] = await t.env.store!(KIND_DATA, KIND).rows("spend");
  await new AppWrites(t.env, site(KIND)).editRow({ p: table }, row, "at", at(2026, 12, 1), () => {});
  const [moved] = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.deepEqual([moved.at, moved.line], [at(2026, 12, 1), "planned"]);
  assert.equal((await t.activity.list(KIND))[0].changes.length, 2);
  await t.data.ledger!.write("Apps/O data.md", [{ op: "add", l: "spend", row: "o1", v: { amount: 5, at: at(2026, 11, 17) } }]);
  const ownTable = { view: "table", source: "spend", edit: ["at"] };
  const [mine] = await t.env.store!("Apps/O data.md", "Apps/O.md").rows("spend");
  await new AppWrites(t.env, site("Apps/O.md")).editRow({ p: ownTable }, mine, "at", at(2026, 12, 1), () => {});
  assert.deepEqual(t.notices, [`Not saved: ${NOT_YET}`]);
});

test("a row read from a file is never deleted: Not mine sets it aside", async () => {
  const t = fakeEnv({ [KIND]: { fm: SPEND } });
  await t.data.ledger!.write(KIND_DATA, [{ op: "add", l: "spend", row: "b1", v: { amount: 5, at: "2026-11-17", line: "attested" } }]);
  const site = { appPath: KIND, hostPath: KIND, dataPath: () => KIND_DATA, checklistName: (k: string) => k, expect: () => [] };
  const table = { view: "table", source: "spend", lines: "all" };
  const [row] = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.equal(await new AppWrites(t.env, site).deleteRow({ p: table }, row, () => {}), undefined);
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 1);
  assert.match(t.notices[0], /Not mine/);
});

test("a planned row is settled only while the row that settled it is there and logged: delete it and Next asks again, Undo settles it again; a file's row paired to a row deleted waits again", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  await settle();
  assert.ok((await t.bg.capture("spend 1200 home rent @2026-11-19 12:00")).ok);
  t.advance(25 * 3_600_000); // Thu 19th 13:00
  assert.ok((await t.bg.capture("spend 1200 home rent")).ok);
  await settle();
  const store = t.env.store!(KIND_DATA, KIND);
  const [planned, logged] = await store.rows("spend");
  assert.equal(planned.matched, rowIdOf(logged));
  const asked = () => t.bg.asks.list().map((a) => a.text);
  const del = await store.delete("spend", { id: rowIdOf(logged), shown: logged });
  assert.ok("row" in del && del.event);
  await t.bg.tick();
  await settle();
  assert.deepEqual((await store.rows("spend")).map((r) => [r.line, r.matched]), [["planned", undefined]]);
  assert.deepEqual(asked(), ["1200 home rent, planned Thu Nov 19, 12:00: did it happen?"]);
  await store.undo([del.event!]);
  await t.bg.tick();
  await settle();
  assert.equal((await store.rows("spend"))[0].matched, rowIdOf(logged), "the row back, the plan settled again");
  assert.deepEqual(asked(), []);

  // A row from a file accepted onto a logged row it pairs with; the logged row deleted, it waits on the card again.
  await t.data.ledger!.write(KIND_DATA, [{ op: "add", l: "spend", row: "f1", v: { amount: 1200, category: "home", at: "2026-11-19", line: "attested", matched: rowIdOf(logged) } }]);
  await t.bg.tick();
  await settle();
  assert.ok(!asked().some((x) => x.includes("from a file")));
  const now = await store.rows("spend");
  const gone = now.find((r) => rowIdOf(r) === rowIdOf(logged))!;
  assert.ok("row" in (await store.delete("spend", { id: rowIdOf(gone), shown: gone })));
  await t.bg.tick();
  await settle();
  assert.equal((await store.rows("spend")).find((r) => rowIdOf(r) === "f1")!.matched, undefined);
  assert.ok(asked().includes("1 row from a file to check in Spend"), asked().join(" | "));
});
