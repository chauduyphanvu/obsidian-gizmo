import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPECT_MISSED } from "../src/background-rhythms.ts";
import { compileWhere, formatValue, sortRows } from "../src/data.ts";
import { readBeat, whereYouAre, type Beat } from "../src/device.ts";
import { readExpect, windowAt, type Rhythm } from "../src/expect.ts";
import { compileFormula } from "../src/formula.ts";
import { groupRows } from "../src/group.ts";
import { dayIn, minuteIn, periodStart, shownStamp, stampOf, toTime, wallTime } from "../src/time.ts";
import { fakeBackground } from "./support/fakes.ts";

const HOUR = 3_600_000;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const formula = (text: string, row: Record<string, unknown>, now: Date): unknown => {
  const f = compileFormula(text);
  if ("error" in f) assert.fail(`${text}: ${f.error}`);
  return f.run(row, { prev: undefined, vars: {}, now });
};
const rhythm = (raw: Record<string, unknown>): Rhythm => {
  const errors: string[] = [];
  const [r] = readExpect([{ source: "doses", ...raw }], errors);
  assert.deepEqual(errors, []);
  return r as Rhythm;
};

/** A dose logged at 08:00 on 19 November in Ho Chi Minh City (+07:00): 01:00 UTC. */
const ABROAD = "2026-11-19T08:00+07:00";

test("a saved stamp carries its offset: its moment is exact, its clock is as lived, and it's shown without the offset", () => {
  assert.equal(toTime(ABROAD), Date.UTC(2026, 10, 19, 1, 0));
  assert.equal(toTime("2026-11-19T08:14-08:00"), Date.UTC(2026, 10, 19, 16, 14));
  assert.equal(wallTime(ABROAD), local(2026, 11, 19, 8, 0), "08:00 on the 19th, read anywhere");
  // A stamp without an offset, as before and as people type them, is local time both ways.
  assert.equal(toTime("2026-11-19T08:00"), local(2026, 11, 19, 8, 0));
  assert.equal(wallTime("2026-11-19T08:00"), local(2026, 11, 19, 8, 0));
  assert.equal(wallTime("2026-11-19"), local(2026, 11, 19));
  // What a save writes reads back as the same minute.
  const now = new Date(local(2026, 11, 18, 12, 34));
  assert.match(stampOf(now), /^2026-11-18T12:34[+-]\d\d:\d\d$/);
  assert.equal(toTime(stampOf(now)), now.getTime());
  assert.equal(wallTime(stampOf(now)), now.getTime());
  assert.equal(shownStamp(ABROAD), "2026-11-19T08:00");
  assert.equal(formatValue(ABROAD), "2026-11-19T08:00");
  assert.equal(shownStamp("2026-11-19T08:00+7:00"), "2026-11-19T08:00+7:00", "not a stamp: left as it is");
});

test("a row saved abroad is on the day it was lived: today, a date, group by day and formulas agree", () => {
  const row = { at: ABROAD, dose: 1 };
  const on19 = new Date(local(2026, 11, 19, 12));
  assert.equal(compileWhere({ at: "today" }, on19)(row), true);
  assert.equal(compileWhere({ at: "2026-11-19" }, on19)(row), true);
  assert.equal(compileWhere({ at: "today" }, new Date(local(2026, 11, 18, 12)))(row), false, "never on the 18th, wherever it's read");
  assert.equal(compileWhere({ at: "yesterday" }, new Date(local(2026, 11, 20, 12)))(row), true);
  const grouped = groupRows([row], { group: "at", per: "day" }, on19);
  assert.deepEqual(grouped.map((g) => g.at), ["2026-11-19"]);
  const f = (src: string) => formula(src, row, on19);
  assert.equal(f("date(at)"), "2026-11-19");
  assert.equal(f("hour(at)"), 8);
});

test("order and elapsed time read the moment: two stamps from two zones sort by when they happened", () => {
  // 20:00 in Los Angeles on the 18th is 04:00 UTC on the 19th: after the dose abroad, though its text sorts first.
  const west = { at: "2026-11-18T20:00-08:00", n: "west" };
  const east = { at: ABROAD, n: "east" };
  assert.deepEqual(sortRows([west, east], "at").map((r) => (r as { n: string }).n), ["east", "west"]);
  const now = new Date(local(2026, 11, 20));
  assert.equal(compileWhere({ at: `between 2026-11-19T01:30Z and 2026-11-19T05:00Z` }, now)(west), true);
  assert.equal(compileWhere({ at: `between 2026-11-19T01:30Z and 2026-11-19T05:00Z` }, now)(east), false);
  assert.equal(compileWhere({ at: "past" }, new Date(Date.UTC(2026, 10, 19, 1, 30)))(east), true, "past is about now, the moment");
  assert.equal(compileWhere({ at: "past" }, new Date(Date.UTC(2026, 10, 19, 0, 30)))(east), false);
  const f = (src: string) => formula(src, { a: west.at, b: east.at }, now);
  assert.equal(f("a > b"), true, "formulas compare stamps as times");
});

test("periods and deadlines in a zone: Ho Chi Minh City's day, and Los Angeles' clock going back", () => {
  const hcm = "Asia/Ho_Chi_Minh", la = "America/Los_Angeles";
  // 03:00 on the 19th in Ho Chi Minh City; its day began at 17:00 UTC on the 18th.
  assert.equal(periodStart(Date.UTC(2026, 10, 18, 20), "day", hcm), Date.UTC(2026, 10, 18, 17));
  assert.equal(dayIn(Date.UTC(2026, 10, 18, 20), hcm), "2026-11-19");
  assert.equal(minuteIn(Date.UTC(2026, 10, 18, 20, 5), hcm), "2026-11-19T03:05");
  // Wednesday 18 November: its week from Monday 16th.
  assert.equal(periodStart(Date.UTC(2026, 10, 18, 5), "week", hcm), Date.UTC(2026, 10, 15, 17));
  const day = rhythm({ every: "day", by: "10:00" });
  // 1 November 2026 in Los Angeles: 00:00 is PDT (-7), 10:00 is PST (-8), the next day begins in PST.
  assert.deepEqual(windowAt(Date.UTC(2026, 10, 1, 20), day, la), { start: Date.UTC(2026, 10, 1, 7), deadline: Date.UTC(2026, 10, 1, 18), end: Date.UTC(2026, 10, 2, 8) });
  // 8 March 2026: 02:30 doesn't happen there; it moves on to 03:30 PDT, as Date does.
  assert.equal(windowAt(Date.UTC(2026, 2, 8, 20), rhythm({ every: "day", by: "02:30" }), la).deadline, Date.UTC(2026, 2, 8, 10, 30));
  // 1:30 on 1 November happens twice: the first.
  assert.equal(windowAt(Date.UTC(2026, 10, 1, 20), rhythm({ every: "day", by: "01:30" }), la).deadline, Date.UTC(2026, 10, 1, 8, 30));
  const month = rhythm({ every: "month", by: "31 09:00" });
  assert.equal(windowAt(Date.UTC(2027, 1, 10), month, hcm).deadline, Date.UTC(2027, 1, 28, 2), "the last day of a short month, there");
  // A zone this device doesn't know falls back to its own clock.
  assert.equal(periodStart(local(2026, 11, 18, 12), "day", "Nowhere/Atlantis"), local(2026, 11, 18));
});

test("where you are is the zone of the device used last; gizmod, which no one uses, never says", () => {
  const beat = (id: string, priority: number, zone?: string, used?: number): Beat => ({ id, name: id, host: "", priority, seen: 1, ...(zone && { zone }), ...(used !== undefined && { used }) });
  assert.equal(whereYouAre([beat("mac", 1, "America/New_York", 100), beat("phone", 0, "Asia/Ho_Chi_Minh", 200), beat("gizmod", 2, "America/New_York")]), "Asia/Ho_Chi_Minh");
  // A device as suited to background work as gizmod that a person uses (Gizmo outside Obsidian) says where they are.
  assert.equal(whereYouAre([beat("phone", 0, "Asia/Ho_Chi_Minh", 200), beat("app", 2, "Europe/Paris", 300)]), "Europe/Paris");
  assert.equal(whereYouAre([beat("mac", 1, "America/New_York", 300), beat("phone", 0, "Asia/Ho_Chi_Minh", 200)]), "America/New_York");
  assert.equal(whereYouAre([beat("old", 1)]), undefined, "a device from before says nothing");
  assert.deepEqual(readBeat(JSON.stringify({ id: "p", name: "Phone", priority: 0, seen: 5, zone: "Asia/Ho_Chi_Minh", used: 4 })), { id: "p", name: "Phone", host: "", priority: 0, seen: 5, zone: "Asia/Ho_Chi_Minh", used: 4 });
});

const MEDS = { app: "Meds", panels: [{ view: "button", label: "Took it", save: "doses" }], expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", say: "no dose by 10:00" }] };

test("a rhythm's deadline is 10:00 where you are; moving west doesn't tell the same day twice", async () => {
  const t = fakeBackground({ "Apps/Meds.md": { fm: MEDS } });
  // On holiday in Auckland (+13:00 in November): 10:00 on the 19th there is 21:00 UTC on the 18th.
  t.where.zone = "Pacific/Auckland";
  await t.bg.start();
  await settle();
  const to = async (ms: number) => { t.advance(ms - t.env.now().getTime()); await t.bg.tick(); await settle(); };
  const told = () => (t.notices as string[]).filter((n) => n.startsWith("Meds"));
  await to(Date.UTC(2026, 10, 18, 20, 59));
  assert.deepEqual(told(), []);
  await to(Date.UTC(2026, 10, 18, 21, 1));
  assert.deepEqual(told(), ["Meds: no dose by 10:00"]);
  const missed = () => t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED);
  assert.deepEqual((await missed()).map((r) => r.window), ["2026-11-19"], "named by its date where you were");
  // Flying home to Los Angeles: its 10:00 on the 19th comes later, and is the same day, already told.
  t.where.zone = "America/Los_Angeles";
  await to(Date.UTC(2026, 10, 19, 18, 1));
  assert.deepEqual(told(), ["Meds: no dose by 10:00"]);
  assert.equal((await missed()).length, 1);
  // The 20th, in Los Angeles, is a day of its own.
  await to(Date.UTC(2026, 10, 20, 18, 1));
  assert.equal(told().length, 2);
});

test("a sample taken in a zone to the east isn't read as newer than it is: a laptop moving west keeps sampling", async () => {
  // 61 minutes ago, stamped in Auckland's clock (+13:00), which reads later than the clock here.
  const before = new Date(local(2026, 11, 18, 12) - 61 * 60_000 + 13 * HOUR);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${before.getUTCFullYear()}-${pad(before.getUTCMonth() + 1)}-${pad(before.getUTCDate())}T${pad(before.getUTCHours())}:${pad(before.getUTCMinutes())}+13:00`;
  const KP = "https://example.com/kp.json";
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: { source: KP, limit: 1, record: "1h" } }, panels: [{ view: "number", source: "kp", field: "kp" }] } },
    "Apps/Kp data.md": { fm: { kp_log: [{ at: stamp, kp: 3 }] } },
  }, { [KP]: [{ kp: 4 }] });
  await t.bg.start();
  await settle();
  assert.deepEqual((t.f.files.get("Apps/Kp data.md")!.fm!.kp_log as { kp: number }[]).map((r) => r.kp), [3, 4]);
});
