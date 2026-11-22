import assert from "node:assert/strict";
import { test } from "node:test";
import { undoEntry } from "../src/activity.ts";
import { keyAction, type Ask } from "../src/asks.ts";
import { carryOver } from "../src/background-fired.ts";
import { EXPECT_MISSED } from "../src/background-rhythms.ts";
import { rowsOf } from "../src/data.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { expectRows, metIn, windowAt, type Rhythm } from "../src/expect.ts";
import { stampOf } from "../src/time.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A local time, as the fakes' clock counts it (it starts Wednesday 18 November 2026, 12:00). */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const lineOf = (a: Ask | undefined) => (a && "line" in a.answer ? a.answer.line : undefined);

const MEDS = {
  app: "Meds",
  panels: [{ view: "button", label: "Took it", save: "doses", shortcut: "took" }],
  expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", say: "no dose by 10:00" }],
};
const MEDS_PATH = "Apps/Meds.md";
const MEDS_DATA = "Apps/Meds data.md";
const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const SPEND = { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home", "travel"], memo: "text" }, match: { amount: "exact", at: "2d" } };

/** Meds, seen first at the fakes' start, then the clock moved on by `ms` and a tick run. */
async function meds(ms: number, opts: Parameters<typeof fakeBackground>[2] = {}, more: Parameters<typeof fakeBackground>[0] = {}) {
  const t = fakeBackground({ [MEDS_PATH]: { fm: MEDS }, ...more }, {}, opts);
  await t.bg.start();
  await settle();
  t.advance(ms);
  await t.bg.tick();
  await settle();
  return t;
}

test("a rhythm's window still open asks until a row meets it; its line logs the row and the ask goes by itself", async () => {
  const t = await meds(0);
  assert.deepEqual(t.bg.asks.list(), [], "Wednesday noon: today's deadline passed, and nothing was missed since the rule was seen");
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  const [ask, ...rest] = t.bg.asks.list();
  assert.deepEqual(rest, []);
  assert.deepEqual([ask.app, ask.path, ask.text, ask.due, ask.answer, ask.dismiss], ["Meds", MEDS_PATH, "Took it? by 10:00", at(2026, 11, 19, 10), { line: "took", cursor: 4, ready: true }, undefined]);
  const ran = await t.bg.capture(lineOf(ask)!);
  assert.ok(ran.ok, JSON.stringify(ran));
  await settle();
  assert.deepEqual(t.bg.asks.list(), []);
});

test("a missed window asks with a line dated inside it; running that line meets the window as the rule reads it, and the ask goes", async () => {
  const t = await meds(23 * HOUR);
  assert.deepEqual(t.notices.filter((n) => n.startsWith("Meds")), ["Meds: no dose by 10:00"]);
  const [ask] = t.bg.asks.list();
  assert.deepEqual([ask.text, ask.due, lineOf(ask)], ["no dose by 10:00 (Thu Nov 19)", at(2026, 11, 19, 10), "took @2026-11-19 10:00"]);
  assert.ok("line" in ask.answer && ask.answer.ready);
  assert.equal(ask.dismiss?.field, "acknowledged");
  assert.ok((await t.bg.capture(lineOf(ask)!)).ok);
  await settle();
  assert.deepEqual(t.bg.asks.list(), []);
  const doses = await t.env.store!(MEDS_DATA, MEDS_PATH).rows("doses");
  assert.deepEqual(doses.map((r) => r.at), [stampOf(new Date(at(2026, 11, 19, 10)))]);
  const spec = t.bg.spec(MEDS_PATH)!;
  const rule = spec.expect[0] as Rhythm;
  assert.ok(metIn(doses, rule, windowAt(at(2026, 11, 19, 12), rule), t.env.now()));
  assert.deepEqual(expectRows(spec.expect, () => doses, at(2026, 11, 19), t.env.now()).map((r) => [r.window, r.met]), [["2026-11-19", true]]);
});

test("where the person is in another zone, a missed window's line still lands inside the window the rule counts", async () => {
  for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kathmandu"]) {
    const t = fakeBackground({ [MEDS_PATH]: { fm: MEDS } });
    t.where.zone = zone;
    await t.bg.start();
    await settle();
    t.advance(3 * DAY);
    await t.bg.tick();
    await settle();
    const missed = t.bg.asks.list().filter((a) => a.dismiss);
    assert.ok(missed.length >= 2, `${zone}: ${JSON.stringify(missed)}`);
    for (const a of missed) assert.ok((await t.bg.capture(lineOf(a)!)).ok, `${zone}: ${lineOf(a)}`);
    await settle();
    assert.deepEqual(t.bg.asks.list().filter((a) => a.dismiss), [], zone);
    const doses = await t.env.store!(MEDS_DATA, MEDS_PATH).rows("doses");
    const kept = (await t.env.store!(MEDS_DATA, MEDS_PATH).rows(EXPECT_MISSED)).map((r) => r.window);
    const rule = t.bg.spec(MEDS_PATH)!.expect[0] as Rhythm;
    const windows = expectRows([rule], () => doses, t.env.now().getTime() - 4 * DAY, t.env.now(), zone);
    assert.deepEqual(windows.filter((w) => kept.includes(w.window)).map((w) => w.met), kept.map(() => true), `${zone}: ${JSON.stringify(windows)}`);
  }
});

test("a miss dismissed is acknowledged in expect_missed, as one change Undo takes back; only the newest three misses ask", async () => {
  const t = await meds(5 * DAY);
  const asks = t.bg.asks.list();
  assert.deepEqual(asks.map((a) => a.text), ["no dose by 10:00 (Sat Nov 21)", "no dose by 10:00 (Sun Nov 22)", "no dose by 10:00 (Mon Nov 23)"]);
  const done = await t.bg.settleAsk(asks[2], "dismiss");
  assert.ok(done.ok && done.entryId, JSON.stringify(done));
  await settle();
  assert.deepEqual(t.bg.asks.list().map((a) => a.text), ["no dose by 10:00 (Sat Nov 21)", "no dose by 10:00 (Sun Nov 22)"], "an older miss doesn't take its place");
  const kept = await t.env.store!(MEDS_DATA, MEDS_PATH).rows(EXPECT_MISSED);
  assert.deepEqual(kept.filter((r) => r.acknowledged === true).map((r) => r.window), ["2026-11-23"]);
  const entry = await t.activity.get(done.entryId!);
  assert.equal(entry?.actor, "you");
  await undoEntry(entry!, t.undoIO);
  await settle();
  assert.equal(t.bg.asks.list().length, 3);
  await t.bg.tick();
  await settle();
  assert.equal(t.notices.filter((n) => n.startsWith("Meds")).length, 3, "nothing is told again");
});

test("oldest due first: yesterday's miss comes before today's open window", async () => {
  const t = await meds(44 * HOUR);
  assert.deepEqual(t.bg.asks.list().map((a) => [a.text, lineOf(a)]), [["no dose by 10:00 (Thu Nov 19)", "took @2026-11-19 10:00"], ["Took it? by 10:00", "took"]]);
});

test("a rule's where picks the button whose row meets it, and fills a form's choice; a form still to type takes the cursor", async () => {
  const pills = {
    app: "Pills",
    panels: [
      { view: "button", label: "Morning pill", save: "doses", row: { slot: "morning" }, shortcut: "am" },
      { view: "button", label: "Evening pill", save: "doses", row: { slot: "evening" }, shortcut: "pm" },
      { view: "form", title: "Vitamin", save: "doses", fields: { kind: ["vitamin d", "iron"], note: "text" }, alias: "vit" },
    ],
    expect: [
      { id: "pm", every: "day", by: "22:00", source: "doses", where: { slot: "evening" } },
      { id: "iron", every: "day", by: "20:00", source: "doses", where: { kind: "iron" } },
      { id: "d", every: "day", by: "21:00", source: "doses", where: { kind: "vitamin d" } },
      { id: "am", every: "day", by: "10:00", source: "doses", where: { slot: "morning" } },
      { id: "any", every: "day", by: "23:00", source: "doses", where: { slot: "noon" } },
    ],
  };
  const t = fakeBackground({ "Apps/Pills.md": { fm: pills } });
  await t.bg.start();
  await settle();
  // Wednesday noon: the morning's deadline passed before the rules were seen; the evening's are open.
  assert.deepEqual(t.bg.asks.list().map((a) => [a.text, a.answer]), [
    ["Vitamin? by 20:00", { line: "vit kind=iron ", cursor: 14, ready: true }],
    ["Vitamin? by 21:00", { line: 'vit kind="vitamin d" ', cursor: 21, ready: true }],
    ["Evening pill? by 22:00", { line: "pm", cursor: 2, ready: true }],
    ["any? by 23:00", { open: true }],
  ]);
  assert.ok((await t.bg.capture('vit kind="vitamin d" before bed')).ok);
  await settle();
  assert.ok(!t.bg.asks.list().some((a) => a.text === "Vitamin? by 21:00"));
  assert.ok((await t.bg.capture("pm")).ok);
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  // Thursday 08:00: the morning's window is open, and two of Wednesday's evening windows were missed.
  assert.deepEqual(t.bg.asks.list().map((a) => [a.text, "line" in a.answer ? a.answer.line : "open"]), [
    ["Vitamin wasn't done by 20:00 (Wed Nov 18)", "vit kind=iron  @2026-11-18 20:00"],
    ["any wasn't done by 23:00 (Wed Nov 18)", "open"],
    ["Morning pill? by 10:00", "am"],
    ["Vitamin? by 20:00", "vit kind=iron "],
    ["Vitamin? by 21:00", 'vit kind="vitamin d" '],
    ["Evening pill? by 22:00", "pm"],
    ["any? by 23:00", "open"],
  ]);
});

test("with no form or button that saves the rule's rows under a name to type, the ask opens the app", async () => {
  const quiet = { app: "Quiet", panels: [{ view: "button", label: "Done", save: "done" }], expect: [{ id: "daily", every: "day", by: "10:00", source: "done" }] };
  const t = fakeBackground({ "Apps/Quiet.md": { fm: quiet } });
  await t.bg.start();
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.bg.asks.list().map((a) => [a.text, a.answer]), [["daily? by 10:00", { open: true }]]);
});

test("a rhythm on a kind's rows is answered by the app's own form that saves there, else by the kind's own line", async () => {
  const kind = { ...SPEND, expect: [{ id: "log", every: "day", by: "20:00", source: "spend" }] };
  const app = { app: "Budget", panels: [{ view: "form", title: "Paid", save: "[[Spend]]", alias: "paid" }], expect: [{ id: "daily", every: "day", by: "21:00", source: "[[Spend]]" }] };
  const t = fakeBackground({ [KIND]: { fm: kind }, "Apps/Budget.md": { fm: app } });
  await t.bg.start();
  await settle();
  assert.deepEqual(t.bg.asks.list().map((a) => [a.app, a.text, lineOf(a)]), [["Spend", "Add to spend? by 20:00", "spend "], ["Budget", "Paid? by 21:00", "paid "]]);
  assert.ok((await t.bg.capture("paid 12 food lunch")).ok);
  await settle();
  assert.deepEqual(t.bg.asks.list(), [], "one row in the kind meets both");
});

test("a planned row whose time passed asks whether it happened: yes logs it with one change, Undo plans it again, and dismiss sets it aside", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  assert.ok((await t.bg.capture("spend 1200 home rent @tomorrow")).ok);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.bg.asks.list(), [], "not yet");
  t.advance(DAY + HOUR);
  await t.bg.tick();
  await settle();
  const [ask] = t.bg.asks.list();
  assert.deepEqual([ask.app, ask.path, ask.text, ask.due], ["Spend", KIND, "1200 home rent, planned Thu Nov 19, 12:00: did it happen?", at(2026, 11, 19, 12)]);
  const yes = await t.bg.settleAsk(ask, "answer");
  assert.ok(yes.ok, JSON.stringify(yes));
  await settle();
  const store = t.env.store!(KIND_DATA, KIND);
  assert.deepEqual((await store.rows("spend")).map((r) => [r.amount, r.line ?? "logged"]), [[1200, "logged"]]);
  assert.deepEqual(t.bg.asks.list(), []);
  const entry = await t.activity.get(yes.entryId!);
  assert.equal(entry?.what, "Marked as happened: 1200 home rent");
  await undoEntry(entry!, t.undoIO);
  await settle();
  const [again] = t.bg.asks.list();
  assert.equal(again?.id, ask.id);
  assert.ok((await t.bg.settleAsk(again, "dismiss")).ok);
  await settle();
  assert.deepEqual((await store.rows("spend")).map((r) => r.line), ["dismissed"]);
  assert.deepEqual(t.bg.asks.list(), []);
});

test("a planned row a logged row settled asks nothing", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  assert.ok((await t.bg.capture("spend 1200 home rent @tomorrow")).ok);
  t.advance(DAY + HOUR);
  assert.ok((await t.bg.capture("spend 1200 home rent")).ok);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.bg.asks.list(), []);
});

test("a kind's rows from a file make one ask that opens the kind, gone once they are accepted", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  const store = t.env.store!(KIND_DATA, KIND);
  await store.add("spend", { amount: 5, memo: "CAFE", at: stampOf(new Date(at(2026, 11, 17, 9))), line: "attested" });
  await store.add("spend", { amount: 9, memo: "BOOKS", at: stampOf(new Date(at(2026, 11, 16, 9))), line: "attested" });
  await t.bg.tick();
  await settle();
  const [ask] = t.bg.asks.list();
  assert.deepEqual([ask.text, ask.answer, ask.dismiss, ask.due], ["2 rows from a file to check in Spend", { open: true }, undefined, at(2026, 11, 16, 9)]);
  for (const row of await store.rows("spend")) await store.set("spend", { id: rowIdOf(row), shown: row }, "line", undefined);
  await settle();
  assert.deepEqual(t.bg.asks.list(), []);
});

test("a skip keeps an ask out until tomorrow on this device, across a restart and a takeover of background work", async () => {
  const t = await meds(20 * HOUR);
  const [ask] = t.bg.asks.list();
  await t.bg.skipAsk(ask.id);
  assert.deepEqual(t.bg.asks.list(), []);
  await settle();
  assert.ok(t.triggers.text?.includes("skip:"), String(t.triggers.text));
  // The plugin turned off and on: the same files, the same triggers.
  t.bg.stop();
  const again = fakeBackground({ [MEDS_PATH]: { fm: MEDS } }, {}, { triggers: t.triggers });
  again.advance(20 * HOUR);
  await again.bg.start();
  await settle();
  assert.deepEqual(again.bg.asks.list(), []);
  // Midnight: Friday's window opens, and Thursday's skip is over.
  again.advance(17 * HOUR);
  await again.bg.tick();
  await settle();
  assert.deepEqual(again.bg.asks.list().map((a) => a.text), ["no dose by 10:00 (Thu Nov 19)", "Took it? by 10:00"]);
  const kept = carryOver({ [`skip:${ask.id}`]: { skipped: 5 }, "Apps/X.md\nsomething": { on: true } }, []);
  assert.deepEqual(kept, { [`skip:${ask.id}`]: { skipped: 5 } }, "a device taking over keeps its own skips");
});

test("an app that isn't allowed asks nothing, as with alerts", async () => {
  const t = fakeBackground({ [MEDS_PATH]: { fm: MEDS } });
  await t.bg.start();
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  assert.equal(t.bg.asks.list().length, 1);
  t.denied.add(MEDS_PATH);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.bg.asks.list(), []);
  const never = fakeBackground({ [MEDS_PATH]: { fm: MEDS } }, {}, { seen: true });
  await never.bg.start();
  never.advance(20 * HOUR);
  await never.bg.tick();
  await settle();
  assert.deepEqual(never.bg.asks.list(), [], "never opened");
});

test("source: asks lists the queue as rows, and panels reading it hear when it changes", async () => {
  const today = { app: "Today", panels: [{ view: "table", title: "To do", source: "asks" }, { view: "number", title: "Left", source: "asks", agg: "count" }] };
  const t = await meds(0, {}, { "Today.md": { fm: today } });
  const spec = () => t.bg.spec("Today.md")!;
  const rows = async () => { const r = await t.bg.evaluate("Today.md", spec().panels[0]); return "rows" in r ? rowsOf(r.rows) : r; };
  assert.deepEqual(await rows(), []);
  let heard = 0;
  t.data.subscribe(t.data.depsOf("asks", spec().panels[0].panel, { appPath: "Today.md", dataPath: "Today data.md" }), () => { heard++; });
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  t.f.flush();
  assert.equal(heard, 1);
  assert.deepEqual(await rows(), [{ app: "Meds", text: "Took it? by 10:00", due: stampOf(new Date(at(2026, 11, 19, 10))), line: "took", path: MEDS_PATH }]);
});

test("a rhythm's miss pushed beyond the notice carries the line that logs it, when that line runs as it stands", async () => {
  const t = await meds(23 * HOUR);
  assert.deepEqual(t.out.pushed.map((p) => [p.text, p.answer]), [["Meds: no dose by 10:00", "took @2026-11-19 10:00"]]);
  const weigh = { app: "Weight", panels: [{ view: "form", title: "Weigh", save: "w", fields: { kg: "number" }, shortcut: "kg" }], expect: [{ id: "w", every: "day", by: "10:00", source: "w" }] };
  const w = fakeBackground({ "Apps/Weight.md": { fm: weigh } });
  await w.bg.start();
  w.advance(23 * HOUR);
  await w.bg.tick();
  await settle();
  assert.deepEqual(w.out.pushed.map((p) => [p.text, p.answer]), [["Weight: w wasn't done by 10:00", undefined]], "a weight still to type can't be a button");
  assert.deepEqual(w.bg.asks.list().map((a) => [a.text, a.answer]), [["Weigh wasn't done by 10:00 (Thu Nov 19)", { line: "kg  @2026-11-19 10:00", cursor: 3, ready: false }]]);
});

test("the Next window's keys: Enter answers, s skips and x dismisses only while no line is being typed in", () => {
  const plain = { key: "s", mod: false, typing: false };
  const missed = { dismiss: {} } as Ask;
  const open = {} as Ask;
  assert.equal(keyAction({ ...plain, key: "Enter" }, open), "answer");
  assert.equal(keyAction(plain, open), "skip");
  assert.equal(keyAction({ ...plain, key: "x" }, missed), "dismiss");
  assert.equal(keyAction({ ...plain, key: "x" }, open), undefined, "nothing to dismiss");
  assert.equal(keyAction({ ...plain, typing: true }, open), undefined);
  assert.equal(keyAction({ ...plain, key: "x", typing: true }, missed), undefined);
  assert.equal(keyAction({ ...plain, key: "Enter", typing: true }, open), undefined, "the line runs itself on Enter");
  assert.equal(keyAction({ ...plain, mod: true }, open), undefined);
  assert.equal(keyAction({ ...plain, key: "S" }, open), undefined);
});

test("a planned row in a rhythm's window stands in for it: one ask per dose, answered or dismissed once, and no notice or push of the window; with none planned, the rhythm asks as before", async () => {
  const DOSE = { kind: "dose", shortcut: "dose", fields: { med: ["A", "B"] }, match: { med: "exact", at: "0d" } };
  const app = {
    app: "Meds",
    panels: [{ view: "button", label: "Took A", save: "[[Dose]]", row: { med: "A" }, alias: "meds" }],
    expect: [{ id: "a-by-10", every: "day", by: "10:00", source: "[[Dose]]", where: { med: "A" }, say: "no A by 10:00", then: { app: "[[Log]]", do: "note" } }],
  };
  const log = { app: "Log", panels: [{ view: "button", label: "Note", save: "jots", shortcut: "note" }] };
  const t = fakeBackground({ "Kinds/Dose.md": { fm: DOSE }, "Apps/Meds.md": { fm: app }, "Apps/Log.md": { fm: log } });
  await t.bg.start();
  await settle();
  // A of the 19th and the 20th planned for 08:00, and B of the 19th, which the rule doesn't count.
  for (const line of ["dose A @2026-11-19 08:00", "dose A @2026-11-20 08:00", "dose B @2026-11-19 08:00"]) assert.ok((await t.bg.capture(line)).ok, line);
  const texts = () => t.bg.asks.list().map((a) => a.text).sort();

  // The 19th at 07:00: A is planned in the window, so the rule doesn't ask "by 10:00"; nor has the plan's time come.
  t.advance(19 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(texts(), []);
  // 08:30: the plan's own ask, once for A (and once for B, which no rule counts).
  t.advance(90 * 60_000);
  await t.bg.tick();
  await settle();
  assert.deepEqual(texts(), ["A, planned Thu Nov 19, 08:00: did it happen?", "B, planned Thu Nov 19, 08:00: did it happen?"]);
  // x: it was missed. Nothing else asks about that window, then or once its deadline has passed, and nothing is told or pushed.
  const a = t.bg.asks.list().find((x) => x.text.startsWith("A,"))!;
  assert.ok((await t.bg.settleAsk(a, "dismiss")).ok);
  await settle();
  assert.deepEqual(texts(), ["B, planned Thu Nov 19, 08:00: did it happen?"]);
  t.advance(4 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(texts(), ["B, planned Thu Nov 19, 08:00: did it happen?"]);
  assert.deepEqual([t.notices.filter((n) => n.includes("no A")), t.out.pushed.map((p) => p.text)], [[], []]);
  // The miss is still kept, and its then still runs: only asking and telling stand aside.
  assert.deepEqual(rowsOf(t.f.files.get("Apps/Meds data.md")?.fm?.[EXPECT_MISSED]).map((r) => (r as { window: string }).window), ["2026-11-19"]);
  assert.equal(rowsOf(t.f.files.get("Apps/Log data.md")?.fm?.jots).length, 1);

  // The 20th at 08:30: answered with Enter, it is taken at 08:00, which meets the rule too.
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  const a20 = t.bg.asks.list().find((x) => x.text.startsWith("A, planned Fri"))!;
  assert.ok(a20, texts().join(" | "));
  assert.ok((await t.bg.settleAsk(a20, "answer")).ok);
  await settle();
  assert.deepEqual(texts().filter((x) => !x.startsWith("B")), []);

  // The 21st, nothing planned: the rule asks by 10:00 as it always did, and a miss is told and pushed.
  t.advance(16 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(texts().filter((x) => !x.startsWith("B")), ["Took A? by 10:00"]);
  t.advance(10 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.notices.filter((n) => n.includes("no A")), ["Meds: no A by 10:00"]);
  assert.deepEqual(t.out.pushed.map((p) => p.text), ["Meds: no A by 10:00"]);
  assert.deepEqual(texts().filter((x) => !x.startsWith("B")), ["no A by 10:00 (Sat Nov 21)"]);
});

test("only a planned row stands in for a rhythm's window: a row set aside that was never planned (a refused writer's, a take-back, Not mine) leaves the rule asking and telling", async () => {
  const DOSE = { kind: "dose", shortcut: "dose", fields: { med: ["A", "B"] }, match: { med: "exact", at: "0d" }, share: { relay: "https://ntfy.sh", key: { secret: "dose-key" } } };
  const app = {
    app: "Meds",
    panels: [{ view: "button", label: "Took A", save: "[[Dose]]", row: { med: "A" }, alias: "meds" }],
    expect: [{ id: "a-by-10", every: "day", by: "10:00", source: "[[Dose]]", where: { med: "A" }, say: "no A by 10:00" }],
  };
  const t = fakeBackground({ "Kinds/Dose.md": { fm: DOSE }, "Apps/Meds.md": { fm: app } });
  await t.bg.start();
  await settle();
  const store = t.env.store!("Kinds/Dose data.md", "Kinds/Dose.md");
  // Each in the window of the 19th: a stranger's row, waiting; a row read from a file; a row another vault sent, logged.
  await store.add("dose", { med: "A", at: "2026-11-19T08:00", line: "attested", by: "Mallory", writer: "deadbeefdeadbeef" });
  await store.add("dose", { med: "A", at: "2026-11-19T08:10", line: "attested" });
  await store.add("dose", { med: "A", at: "2026-11-19T08:20", by: "Sam", writer: "0123456789abcdef" });
  t.advance(19 * HOUR); // Thu 19th 07:00
  await t.bg.tick();
  await settle();
  // The stranger refused; the file's row Not mine; Sam takes his row back.
  const writerAsk = t.bg.asks.list().find((a) => a.text.startsWith("Accept rows from"))!;
  assert.ok((await t.bg.settleAsk(writerAsk, "dismiss")).ok);
  const rows = await store.rows("dose");
  assert.ok("row" in (await store.set("dose", { id: rowIdOf(rows[1]), shown: rows[1] }, "line", "dismissed")));
  assert.ok("row" in (await store.set("dose", { id: rowIdOf(rows[2]), shown: rows[2] }, "line", "dismissed")));
  assert.deepEqual((await store.rows("dose")).map((r) => r.line), ["dismissed", "dismissed", "dismissed"]);
  t.advance(HOUR); // 08:00
  await t.bg.tick();
  await settle();
  assert.ok(t.bg.asks.list().some((a) => a.text === "Took A? by 10:00"), t.bg.asks.list().map((a) => a.text).join(" | "));
  t.advance(4 * HOUR); // 12:00
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.notices.filter((n) => n.includes("no A")), ["Meds: no A by 10:00"]);
  assert.ok(t.bg.asks.list().some((a) => a.text === "no A by 10:00 (Thu Nov 19)"));
});
