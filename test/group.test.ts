import assert from "node:assert/strict";
import { test } from "node:test";
import { getPath, matches, periodStart, shiftPeriod, stampParts } from "../src/data.ts";
import { groupRows, streak } from "../src/group.ts";
import { compilePipeline } from "../src/pipeline.ts";
import { readSpec } from "../src/spec.ts";

const NOW = new Date(2026, 10, 18, 14, 30); // Wed 18 Nov 2026, local time
const day = (t: number) => stampParts(new Date(t)).date;
const at = (y: number, m: number, d: number, h = 9) => stampParts(new Date(y, m - 1, d, h)).at;

test("periods start on the local day, Monday, the 1st and 1 January", () => {
  const wed = new Date(2026, 10, 18, 14).getTime();
  const sun = new Date(2026, 10, 22, 23).getTime();
  assert.equal(day(periodStart(wed, "day")), "2026-11-18");
  assert.equal(day(periodStart(wed, "week")), "2026-11-16");
  assert.equal(day(periodStart(sun, "week")), "2026-11-16");
  assert.equal(day(periodStart(wed, "month")), "2026-11-01");
  assert.equal(day(periodStart(wed, "year")), "2026-01-01");
});

test("stepping periods counts calendar days, so clock changes don't shift them", () => {
  // US and EU clocks change in March and late October/early November.
  let d = new Date(2026, 2, 1).getTime();
  for (let i = 0; i < 40; i++) d = shiftPeriod(d, "day", 1);
  assert.equal(day(d), "2026-04-10");
  assert.equal(day(shiftPeriod(new Date(2026, 9, 26).getTime(), "week", 1)), "2026-11-02");
  assert.equal(day(shiftPeriod(new Date(2026, 0, 1).getTime(), "month", 13)), "2027-02-01");
});

test("a bare date matches that whole day; last N weeks covers whole weeks", () => {
  assert.equal(matches("2026-11-18T09:00", "2026-11-18", NOW), true);
  assert.equal(matches("2026-11-18", "2026-11-18", NOW), true);
  assert.equal(matches("2026-11-17T23:59", "2026-11-18", NOW), false);
  assert.equal(matches("2026-11-09", "last 2 weeks", NOW), true); // Monday of last week
  assert.equal(matches("2026-11-08", "last 2 weeks", NOW), false);
  assert.equal(matches("2026-10-01", "last 2 months", NOW), true);
  assert.equal(matches("2025-12-31", "last 1 year", NOW), false);
});

test("a key with dots in its name is read as one key first", () => {
  assert.equal(getPath({ "Adj. Close": 5 }, "Adj. Close"), 5);
  assert.equal(getPath({ a: { b: 1 }, "a.b": 2 }, "a.b"), 2);
  assert.equal(getPath({ a: { b: 1 } }, "a.b"), 1);
});

test("per day fills empty days between rows; sums are 0, other totals empty", () => {
  const rows = [
    { at: at(2026, 11, 16), minutes: 20 },
    { at: at(2026, 11, 16, 18), minutes: 10 },
    { at: at(2026, 11, 18), minutes: 15 },
    { at: "not a date", minutes: 99 },
  ];
  const sum = groupRows(rows, { group: "at", per: "day", y: "minutes", agg: "sum" }, NOW);
  assert.deepEqual(sum, [
    { at: "2026-11-16", count: 2, minutes: 30 },
    { at: "2026-11-17", count: 0, minutes: 0 },
    { at: "2026-11-18", count: 1, minutes: 15 },
  ]);
  const avg = groupRows(rows, { group: "at", per: "day", y: "minutes", agg: "avg" }, NOW);
  assert.equal(avg[1].minutes, null);
});

test("a bounded where window is filled whole; an open one isn't extended to today", () => {
  const rows = [{ at: at(2026, 11, 3) }];
  const weeks = groupRows(rows, { group: "at", per: "week", where: { at: "last 4 weeks" } }, NOW);
  assert.deepEqual(weeks.map((r) => [r.at, r.count]), [["2026-10-26", 0], ["2026-11-02", 1], ["2026-11-09", 0], ["2026-11-16", 0]]);
  const old = groupRows([{ at: at(2019, 1, 5) }, { at: at(2019, 3, 5) }], { group: "at", per: "month", where: { at: "past" } }, NOW);
  assert.deepEqual(old.map((r) => r.at), ["2019-01-01", "2019-02-01", "2019-03-01"]);
});

test("too many periods to fill shows only the ones with rows", () => {
  const rows = [{ at: at(2010, 1, 1) }, { at: at(2026, 1, 1) }];
  assert.deepEqual(groupRows(rows, { group: "at", per: "day" }, NOW).map((r) => r.at), ["2010-01-01", "2026-01-01"]);
});

test("list values join each of their groups; empty values form (none)", () => {
  const rows = [{ tags: ["a", "b"] }, { tags: ["b"] }, {}, { tags: "c" }];
  assert.deepEqual(groupRows(rows, { group: "tags" }, NOW), [
    { tags: "(none)", count: 1 }, { tags: "a", count: 1 }, { tags: "b", count: 2 }, { tags: "c", count: 1 },
  ]);
  const top = compilePipeline({ group: "tags", sort: "-count", limit: 1 }, NOW)(rows);
  assert.deepEqual(top, [{ tags: "b", count: 2 }]);
});

test("parallel arrays from an API are grouped as rows", () => {
  const hourly = { time: ["2026-11-18T00:00", "2026-11-18T12:00", "2026-11-19T00:00"], temp: [4, 11, 6], other: [1, 2, 3] };
  const run = compilePipeline({ pick: "hourly", group: "time", per: "day", y: "temp", agg: "max" }, NOW);
  assert.deepEqual(run({ hourly }), [{ time: "2026-11-18", count: 2, temp: 11 }, { time: "2026-11-19", count: 1, temp: 6 }]);
});

test("a streak counts back from today, or from yesterday when today is still open", () => {
  const days = (...ds: number[]) => ds.map((d) => ({ at: at(2026, 11, d) }));
  assert.equal(streak(days(16, 17, 18), "at", "day", NOW), 3);
  assert.equal(streak(days(15, 16, 17), "at", "day", NOW), 3);
  assert.equal(streak(days(14, 16), "at", "day", NOW), 0);
  assert.equal(streak(days(14, 15, 17), "at", "day", NOW), 1);
  assert.equal(streak(days(17, 19, 20), "at", "day", NOW), 1);
  assert.equal(streak([...days(2, 10, 17), { at: "never" }], "at", "week", NOW), 3);
  assert.equal(streak([], "at", "day", NOW), 0);
});

test("grouping problems are explained", () => {
  const r = readSpec({
    app: "x",
    panels: [
      { view: "bar", source: "s", per: "week" },
      { view: "bar", source: "s", group: "at", per: "fortnight" },
      { view: "table", source: "s", group: "count" },
      { view: "progress", source: "s", group: "at", per: "day", max: 7 },
      { view: "list", source: "s", group: "at", agg: "sum" },
    ],
  })!;
  assert.deepEqual(r.errors, [
    'panel 1: bar needs x and y',
    'panel 1: "per" needs "group"',
    "panel 2: per must be one of day, week, month, year",
    'panel 3: group can\'t be "count"; every group gets a count',
    "panel 4: progress can't group rows; for one period use where (e.g. where: {at: this week}) with agg",
    'panel 5: "agg" doesn\'t apply to list',
  ]);
});

test("grouping 10,000 rows by week is quick", () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ at: at(2025, 1, 1 + (i % 600)), minutes: i % 90 }));
  const start = performance.now();
  const out = compilePipeline({ group: "at", per: "week", y: "minutes", agg: "sum" }, NOW)(rows) as unknown[];
  const ms = performance.now() - start;
  assert.ok(out.length > 80);
  assert.ok(ms < 150, `took ${ms.toFixed(1)} ms`);
});
