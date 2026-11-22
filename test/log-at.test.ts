import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { describeChange, undoEntry, undoMessage } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { captureTargets, logTime, NOT_YET, parseFields, parseLine, whenText, type CaptureApp } from "../src/capture.ts";
import { rowsOf } from "../src/data.ts";
import { EXPECT_MISSED } from "../src/background-rhythms.ts";
import { expectRows, metIn, windowAt, type Rhythm } from "../src/expect.ts";
import { parseLog, parseStamp } from "../src/ledger.ts";
import { pastEnv } from "../src/replay.ts";
import { readSpec } from "../src/spec.ts";
import { stampOf } from "../src/time.ts";
import { typeLine, addLine, said, lineIn } from "./support/addline.ts";
import { fakeBackground, fakeEnv, listsIn, savedAt } from "./support/fakes.ts";

// A row logged for another time: a trailing `@when` on the add line, Do… and `;;` lines, a link's
// `at=`, and the side sheet's When for a row already saved.

// Thursday 19 November 2026, 10:00.
const NOW = new Date(2026, 10, 19, 10, 0);
const on = (d: number, h: number, mi = 0, m = 11, y = 2026) => new Date(y, m - 1, d, h, mi);
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const HOUR = 3_600_000;

const SPEND_FIELDS: [string, string | string[]][] = [["amount", "number"], ["category", ["food", "home"]], ["note", "text"]];
const loose = (line: string) => parseFields(line, SPEND_FIELDS, NOW, { name: "spend", loose: true });
const time = (d: Date | undefined) => d?.getTime();

test("a trailing @ gives the time a row is logged for: a time today, a day at this time of day, or a day and a time", () => {
  const r = loose("14.5 lunch @yday");
  assert.deepEqual(r.params, { amount: "14.5", note: "lunch" });
  assert.deepEqual(r.errors, []);
  assert.equal(time(r.at), time(on(18, 10)), "a day alone is that day at this time of day");
  assert.equal(time(loose("14.5 lunch @8am").at), time(on(19, 8)), "a time alone is today");
  assert.equal(time(loose("14.5 lunch @fri 13:00").at), time(on(13, 13)), "a weekday is the latest one, as what's logged has happened");
  assert.equal(time(loose("14.5 @thu").at), time(on(19, 10)), "today's weekday is today");
  assert.equal(time(loose("14.5 @last mon 8:15").at), time(on(9, 8, 15)), "last and a weekday is a week before the latest one");
  assert.equal(time(loose("14.5 @11-03").at), time(on(3, 10)));
  assert.equal(time(loose("14.5 @12-25").at), time(on(25, 10, 0, 12, 2025)), "a month and day still to come this year is last year's");
  assert.equal(time(loose("14.5 @2026-11-17 7:30pm").at), time(on(17, 19, 30)));
  assert.equal(time(loose("14.5 @-2d").at), time(on(17, 10)));
  assert.equal(whenText(on(19, 13), NOW), "Thu Nov 19, 13:00");
  assert.equal(whenText(on(25, 10, 0, 12, 2025), NOW), "Thu Dec 25 2025, 10:00");
});

test("@last and a weekday goes back one more week than the weekday alone, on that weekday and the day after", () => {
  const at = (line: string, now: Date) => time(parseFields(line, SPEND_FIELDS, now, { name: "spend", loose: true }).at);
  const sat = on(21, 10);
  assert.equal(at("14.5 @fri", sat), time(on(20, 10)), "on a Saturday, fri is the day before");
  assert.equal(at("14.5 @last fri", sat), time(on(13, 10)), "and last fri is 8 days before");
  const fri = on(20, 10);
  assert.equal(at("14.5 @fri", fri), time(on(20, 10)), "on a Friday, fri is today");
  assert.equal(at("14.5 @last fri 9am", fri), time(on(13, 9)), "and last fri is 7 days before");
  assert.equal(time((logTime("last fri", sat) as { at: Date }).at), time(on(13, 10)), "a link's at= reads it the same");
});

test("only a trailing @ that reads as a time is taken; an address, a lone @, a quoted or named value, or one mid-line stays text", () => {
  const kept = (line: string, note: string) => {
    const r = loose(line);
    assert.equal(r.params.note, note, line);
    assert.equal(r.at, undefined, line);
    assert.deepEqual(r.errors, [], line);
  };
  kept("14.5 lunch @ cafe", "lunch @ cafe");
  kept("14.5 lunch @cafe", "lunch @cafe");
  kept("14.5 mail bob@example.com", "mail bob@example.com");
  kept('14.5 "@yday"', "@yday");
  kept("14.5 note=@yday", "@yday");
  kept("14.5 @yday lunch", "@yday lunch");
  kept("14.5 lunch @yday cafe", "lunch @yday cafe");
  kept("14.5 lunch @8", "lunch @8");
});

test("a time still to come is refused: rows record what happened", () => {
  assert.deepEqual(loose("14.5 @tomorrow").errors, [NOT_YET]);
  assert.deepEqual(loose("14.5 @11am").errors, [NOT_YET], "later today");
  assert.deepEqual(loose("14.5 @+3d 8am").errors, [NOT_YET]);
  const r = loose("14.5 @yday 11am");
  assert.deepEqual(r.errors, []);
  assert.equal(time(r.at), time(on(18, 11)));
});

function app(path: string, fm: Record<string, unknown>): CaptureApp {
  const spec = readSpec(fm, { now: NOW, path })!.spec!;
  const shortcuts = new Map(spec.panels.filter((ps) => ps.panel.shortcut).map((ps) => [ps.panel.shortcut!, ps]));
  return { path, name: path.replace(/^.*\//, "").replace(/\.md$/, ""), shortcuts };
}

const INDEX = captureTargets([
  app("Apps/Budget.md", { app: "b", panels: [{ view: "form", title: "Spent something", alias: "spend", save: "spend", fields: { amount: "number", category: ["food", "home"], note: "text" } }] }),
  app("Apps/Meds.md", { app: "m", panels: [{ view: "button", label: "Took meds", save: "doses", shortcut: "took-meds", alias: "meds" }] }),
  app("Apps/Trip.md", { app: "t", panels: [{ view: "form", alias: "trip", save: "costs", fields: { item: "text", local: "number", at: "time" } }] }),
  app("Apps/Day.md", { app: "d", panels: [{ view: "checklist", items: ["Meds @8am", "Walk"], save: "done", shortcut: "check" }] }),
]);

test("Do… and ;; lines take a trailing @ too: as a link's at=, beside the values; a button takes it alone", () => {
  const ok = (line: string) => {
    const r = parseLine(line, INDEX, NOW);
    assert.ok(r.ok, `${line}: ${"error" in r ? r.error : ""}`);
    return r;
  };
  const bad = (line: string) => {
    const r = parseLine(line, INDEX, NOW);
    assert.ok(!r.ok, line);
    return r.error;
  };
  const spend = ok("spend 14.5 food lunch with Sam @yday 8am");
  assert.deepEqual(spend.params, { amount: "14.5", category: "food", note: "lunch with Sam", at: stampOf(on(18, 8)) });
  assert.equal(time(spend.at), time(on(18, 8)));
  const meds = ok("meds @8am");
  assert.deepEqual(meds.params, { at: stampOf(on(19, 8)) });
  assert.equal(ok("meds").params, undefined);
  assert.equal(bad("meds lunch @8am"), "meds takes no values");
  assert.equal(bad("meds @tomorrow"), NOT_YET);
  assert.equal(bad("spend 3 @9pm"), NOT_YET);
  assert.equal(bad("spend @yday"), "type what spend saves, starting with amount");
  // A form with a field of its own called at can't be told when its row is logged for.
  assert.equal(bad("trip coffee 4.5 @yday"), "trip has a field called at, so @ can't give the time it's logged for");
  // A checklist's item is matched as typed, @ and all.
  assert.deepEqual(ok("check meds @8am").params, { item: "Meds @8am" });
});

test("a link's at= takes the same words, or a stamp; never a time still to come", () => {
  assert.equal(time((logTime("yday", NOW) as { at: Date }).at), time(on(18, 10)));
  assert.equal(time((logTime("@fri 13:00", NOW) as { at: Date }).at), time(on(13, 13)));
  assert.equal(time((logTime("2026-11-18T08:14-08:00", NOW) as { at: Date }).at), Date.parse("2026-11-18T08:14-08:00"));
  assert.equal(time((logTime("2026-11-18T08:14", NOW) as { at: Date }).at), time(on(18, 8, 14)));
  assert.deepEqual(logTime("soon", NOW), { error: "at must be a time (yday, fri 13:00, 8am, 2026-11-19T08:14), not “soon”" });
  assert.deepEqual(logTime("2026-11-20T08:00", NOW), { error: NOT_YET });
  assert.deepEqual(logTime("tomorrow", NOW), { error: NOT_YET });
});

// ---- In an app ------------------------------------------------------------------------------------

const APP = "Apps/W.md";
const DATA = "Apps/W data.md";
const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** APP on a fake vault in its own tab, with a sheet and Undo as Obsidian gives them; or as it was at `past`. */
function open(notes: Parameters<typeof fakeEnv>[0], opts: { past?: number } = {}) {
  const t = fakeEnv(notes);
  t.env.log = (entry) => t.activity.add(entry);
  t.env.undo = async (id) => {
    const entry = (await t.activity.get(id))!;
    const r = await undoEntry(entry, t.undoIO);
    await t.activity.setUndone(id, r.undone);
    return undoMessage(r);
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, APP, opts.past === undefined ? t.env : pastEnv(t.env, opts.past));
  c.openInPlace(() => {});
  started.push(c);
  c.load();
  const sheet = () => root.querySelector("aside.gz-sheet")!;
  const rows = () => [...root.querySelectorAll("tbody tr:not(.gz-ledger-group)")];
  const list = (key: string) => (listsIn(t.f.files.get(DATA)?.fm)?.[key] ?? []) as Record<string, unknown>[];
  return { ...t, root, sheet, rows, list };
}

const WEIGH = {
  app: "W",
  panels: [{
    view: "form", title: "Weigh in", save: "weights", fields: { kg: "number", day: { type: "date", default: "today" } },
    append: "[[Journal]]", line: "- {date} {time} weighed {kg} on {day}",
  }],
};

test("the add line shows when a row is logged for before Enter, and saves it then: its at, date and time, and a default of today", async () => {
  // The fakes' clock: Wednesday 18 November, 12:00.
  const t = open({ [APP]: { fm: WEIGH } });
  await settle();
  typeLine(t.root, "80 @yday 7:30");
  assert.deepEqual([...t.root.querySelectorAll(".gz-pv")].map(text), ["kg80", "dayYesterday", "atTue Nov 17, 07:30"]);
  addLine(t.root, "80 @yday 7:30");
  await settle();
  assert.deepEqual(t.list("weights"), [{ kg: 80, day: "2026-11-17", at: savedAt("2026-11-17T07:30") }]);
  assert.equal(t.f.files.get("Journal.md")!.body, "- 2026-11-17 07:30 weighed 80 on 2026-11-17\n");
  assert.equal(said(t.root), "Added 80 to weights for Tue Nov 17, 07:30");
  // The ledger's event keeps the time it was written; only the row says when it happened.
  const [log] = [...t.f.others].filter(([path]) => path.startsWith("Apps/W data/log/"));
  const [event] = parseLog(log[1]).events;
  assert.equal(parseStamp(event.t)!.wall, t.f.host.now());
  // Undo takes it out, as for any save.
  click(t.root.querySelector(".gz-notice button.gz-undo")!);
  await settle();
  assert.deepEqual(t.list("weights"), []);
});

test("the add line refuses a time still to come, and keeps what was typed", async () => {
  const t = open({ [APP]: { fm: WEIGH } });
  await settle();
  typeLine(t.root, "80 @9pm");
  assert.equal(text(t.root.querySelector(".gz-addline-error")), NOT_YET);
  assert.equal((t.root.querySelector("button.gz-addline-go") as HTMLButtonElement).disabled, true);
  addLine(t.root, "80 @9pm");
  await settle();
  assert.deepEqual(t.list("weights"), []);
  assert.equal(lineIn(t.root).value, "80 @9pm");
});

const BUDGET = {
  app: "Budget",
  panels: [{ view: "form", title: "Spent something", alias: "spend", shortcut: "spent", save: "spend", fields: { amount: "number", category: ["food", "home"], note: "text" } }],
};
const MEDS = {
  app: "Meds",
  panels: [
    { view: "button", label: "Took it", save: "doses", shortcut: "took" },
    { view: "number", title: "Days on time", source: "expect", where: { rule: "meds", met: true }, agg: "streak", group: "at", per: "day" },
  ],
  expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", say: "no dose by 10:00" }],
};

test("Do… previews and runs a line logged for another time; one for a time still to come runs nothing", async () => {
  const t = fakeBackground({ "Apps/Budget.md": { fm: BUDGET } });
  await t.bg.start();
  const preview = await t.bg.previewLine("spend 14.5 food lunch @yday 8am");
  assert.ok(preview.parsed.ok);
  assert.equal(time(preview.parsed.at), time(on(17, 8)));
  assert.ok(preview.effects?.some((l) => l.startsWith("Save amount 14.5")), JSON.stringify(preview.effects));
  const ran = await t.bg.capture("spend 14.5 food lunch @yday 8am");
  assert.ok(ran.ok);
  const store = t.env.store!("Apps/Budget data.md", "Apps/Budget.md");
  assert.deepEqual(await store.rows("spend"), [{ amount: 14.5, category: "food", note: "lunch", at: savedAt("2026-11-17T08:00") }]);
  const late = await t.bg.capture("spend 3 food @tomorrow");
  assert.deepEqual([late.ok, late.error], [false, NOT_YET]);
  assert.equal((await store.rows("spend")).length, 1);
});

test("a shortcut's link takes at= with the same words or a stamp, for a phone that logs late; the window asking first says it", async () => {
  const t = fakeBackground({ "Apps/Budget.md": { fm: BUDGET }, "Apps/Meds.md": { fm: MEDS } });
  await t.bg.start();
  const spend = () => t.env.store!("Apps/Budget data.md", "Apps/Budget.md").rows("spend");
  await t.bg.runUri({ app: "Budget", do: "spent", amount: "5", category: "home", at: "yday 8am" });
  assert.deepEqual(await spend(), [{ amount: 5, category: "home", note: "", at: savedAt("2026-11-17T08:00") }]);
  assert.deepEqual(t.out.asked.at(-1)!.lines, ["amount: 5", "category: home", "at: Tue Nov 17, 08:00"]);
  await t.bg.runUri({ app: "Budget", do: "spent", amount: "6", at: "2026-11-16T21:30-05:00" });
  assert.equal((await spend())[1].at, stampOf(new Date(Date.parse("2026-11-16T21:30-05:00"))));
  await t.bg.runUri({ app: "Budget", do: "spent", amount: "7", at: "tomorrow" });
  assert.equal(t.notices.at(-1), `Budget: ${NOT_YET}`);
  await t.bg.runUri({ app: "Budget", do: "spent", amount: "8", at: "soon" });
  assert.equal(t.notices.at(-1), "Budget: at must be a time (yday, fri 13:00, 8am, 2026-11-19T08:14), not “soon”");
  assert.equal((await spend()).length, 2);
  // A button's link takes at= alone.
  await t.bg.runUri({ app: "Meds", do: "took", at: "8am" });
  assert.deepEqual(await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows("doses"), [{ at: savedAt("2026-11-18T08:00") }]);
});

test("a link's at= for a form with a field of its own called at is refused, as @ is on a line, not dropped", async () => {
  const trip = { app: "Trip", panels: [{ view: "form", shortcut: "cost", save: "costs", fields: { item: "text", at: "time" } }] };
  const t = fakeBackground({ "Apps/Trip.md": { fm: trip } });
  await t.bg.start();
  await t.bg.runUri({ app: "Trip", do: "cost", item: "tram", at: "08:15" });
  assert.equal(t.notices.at(-1), "Trip: cost has a field called at, so at= can't give the time it's logged for");
  assert.deepEqual(await t.env.store!("Apps/Trip data.md", "Apps/Trip.md").rows("costs"), []);
  await t.bg.runUri({ app: "Trip", do: "cost", item: "tram" });
  assert.equal((await t.env.store!("Apps/Trip data.md", "Apps/Trip.md").rows("costs")).length, 1, "without at= it runs");
});

test("a dose logged @yday counts for yesterday's window, met when its time is by the deadline; a miss already told isn't told again", async () => {
  // Wednesday 12:00: the rule is seen. Friday 11:00: Thursday's and Friday's doses were missed and told.
  const t = fakeBackground({ "Apps/Meds.md": { fm: MEDS } });
  await t.bg.start();
  await settle();
  t.advance(47 * HOUR);
  await t.bg.tick();
  await settle();
  const told = () => (t.notices as string[]).filter((n) => n.startsWith("Meds: no dose"));
  assert.deepEqual(told(), ["Meds: no dose by 10:00", "Meds: no dose by 10:00"]);
  // Both were taken on time, and logged late.
  assert.ok((await t.bg.capture("took @yday 8am")).ok);
  assert.ok((await t.bg.capture("took @9:30")).ok);
  await t.bg.tick();
  await settle();
  assert.equal(told().length, 2, "nothing is told again");
  const store = t.env.store!("Apps/Meds data.md", "Apps/Meds.md");
  assert.equal((await store.rows(EXPECT_MISSED)).length, 2, "what was told stays told");
  const doses = await store.rows("doses");
  assert.deepEqual(doses.map((r) => r.at), [savedAt("2026-11-19T08:00"), savedAt("2026-11-20T09:30")]);
  const spec = t.bg.spec("Apps/Meds.md")!;
  const now = t.env.now();
  assert.deepEqual(expectRows(spec.expect, () => doses, new Date(2026, 10, 19).getTime(), now).map((r) => [r.window, r.met]), [["2026-11-19", true], ["2026-11-20", true]]);
  const streak = await t.bg.evaluate("Apps/Meds.md", spec.panels[1]);
  assert.equal("value" in streak && streak.value, 2, "the days on time count them");
  // A day alone is that day at this time of day: 11:00 the day before is in its window, but late for 10:00.
  const rule = spec.expect[0] as Rhythm;
  const yday = logTime("yday", now) as { at: Date };
  assert.equal(metIn(rowsOf([{ at: stampOf(yday.at) }]), rule, windowAt(yday.at.getTime(), rule), now), false);
});

// ---- The side sheet's When ------------------------------------------------------------------------

const SAVED = {
  spend: [{ amount: 5, note: "Coffee", at: "2026-11-17T09:15" }, { amount: 7, note: "Lunch", at: savedAt("2026-11-18T11:40") }],
};
const PLAIN = { app: "W", panels: [{ view: "table", title: "Recent", source: "spend", columns: ["amount", "note"] }] };

test("in the sheet, a saved row's When is a date and time to move it to, written as an edit that is kept and undone", async () => {
  const t = open({ [APP]: { fm: PLAIN }, [DATA]: { fm: structuredClone(SAVED) } });
  await settle();
  click(t.rows()[1]);
  await settle();
  const fields = [...t.sheet().querySelectorAll(".gz-sheet-field")];
  assert.deepEqual(fields.map((f) => text(f.querySelector(".gz-sheet-label"))), ["amount", "note", "at"], "added where the table leaves it out");
  const when = fields[2].querySelector("input.gz-edit") as HTMLInputElement;
  assert.deepEqual([when.type, when.value, when.getAttribute("max"), when.getAttribute("aria-label")], ["datetime-local", "2026-11-18T11:40", "2026-11-18T12:00", "at"]);
  when.value = "2026-11-17T20:05";
  change(when);
  await settle();
  assert.deepEqual(t.list("spend").map((r) => r.at), ["2026-11-17T09:15", savedAt("2026-11-17T20:05")]);
  const [entry] = await t.activity.list(APP);
  assert.deepEqual(entry.changes.map(describeChange), ["Changed at from 2026-11-18T11:40 to 2026-11-17T20:05 in spend in W data"]);
  assert.deepEqual(await undoEntry(entry, t.undoIO), { undone: 1, total: 1 });
  await settle();
  assert.deepEqual(t.list("spend").map((r) => r.at), ["2026-11-17T09:15", savedAt("2026-11-18T11:40")]);
});

test("in the sheet, a When still to come is put back and refused with why", async () => {
  const t = open({ [APP]: { fm: PLAIN }, [DATA]: { fm: structuredClone(SAVED) } });
  await settle();
  click(t.rows()[0]);
  await settle();
  const when = t.sheet().querySelector(".gz-sheet-field input[type=datetime-local]") as HTMLInputElement;
  assert.equal(when.value, "2026-11-17T09:15", "a stamp without an offset reads as it is");
  when.value = "2026-11-19T08:00";
  change(when);
  await settle();
  assert.equal(when.value, "2026-11-17T09:15");
  assert.ok(t.notices.includes(`Not saved: ${NOT_YET}`), JSON.stringify(t.notices));
  assert.deepEqual(t.list("spend").map((r) => r.at), ["2026-11-17T09:15", savedAt("2026-11-18T11:40")]);
});

test("the sheet's When keeps a table's label and is only for the app's own rows as they are now", async () => {
  const labelled = { app: "W", panels: [{ view: "table", title: "Recent", source: "spend", columns: ["at", "amount"], labels: { at: "When" }, format: { at: "relative" } }] };
  const t = open({ [APP]: { fm: labelled }, [DATA]: { fm: structuredClone(SAVED) } });
  await settle();
  click(t.rows()[0]);
  await settle();
  const first = t.sheet().querySelector(".gz-sheet-field")!;
  assert.equal(text(first.querySelector(".gz-sheet-label")), "When");
  assert.equal((first.querySelector("input") as HTMLInputElement).type, "datetime-local");

  // In the past: as text, with no control.
  const past = open({ [APP]: { fm: PLAIN }, [DATA]: { fm: structuredClone(SAVED) } }, { past: new Date(2026, 10, 18, 12).getTime() });
  await settle();
  click(past.rows()[0]);
  await settle();
  assert.equal(past.sheet().querySelectorAll("input").length, 0);

  // A note's row has no When to move.
  const notes = open({
    [APP]: { fm: { app: "W", panels: [{ view: "table", title: "Shelf", source: "notes", from: "Books", columns: ["name", "at"] }] } },
    "Books/Emma.md": { fm: { at: "2026-11-01T08:00" } },
  });
  await settle();
  click(notes.rows()[0]);
  await settle();
  assert.equal(notes.sheet().querySelectorAll("input").length, 0);
});
