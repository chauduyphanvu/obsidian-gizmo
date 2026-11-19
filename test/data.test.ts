import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate, daysUntil, fillTemplate, filterRows, getPath, matches, parseBody, parseCSV, seriesOf, sortRows, valueOf,
} from "../src/data.ts";

const NOW = new Date(2026, 10, 18, 14, 30); // Wed 18 Nov 2026, local time

test("getPath walks objects and array indexes", () => {
  const data = { chart: { result: [{ meta: { price: 5 } }] }, list: [1, 2, 3] };
  assert.equal(getPath(data, "chart.result.0.meta.price"), 5);
  assert.equal(getPath(data, "list.-1"), 3);
  assert.equal(getPath(data, "chart.missing.x"), undefined);
});

test("series from parallel arrays (Open-Meteo, Yahoo)", () => {
  const data = { hourly: { time: ["2026-11-18T00:00", "2026-11-18T01:00"], temperature_2m: [7.1, 6.8] } };
  assert.deepEqual(seriesOf(data, "hourly.time", "hourly.temperature_2m"), [
    { x: "2026-11-18T00:00", y: 7.1 },
    { x: "2026-11-18T01:00", y: 6.8 },
  ]);
  const yahoo = { timestamp: [1, 2, 3], indicators: { quote: [{ close: [10, null, 12] }] } };
  assert.deepEqual(seriesOf(yahoo, "timestamp", "indicators.quote.0.close"), [{ x: 1, y: 10 }, { x: 3, y: 12 }]);
});

test("series from rows", () => {
  const rows = [{ at: "2026-11-01T08:00", weight: 80.2 }, { at: "2026-11-02T08:00", weight: "79.9" }, { at: "x" }];
  assert.deepEqual(seriesOf(rows, "at", "weight"), [
    { x: "2026-11-01T08:00", y: 80.2 },
    { x: "2026-11-02T08:00", y: 79.9 },
  ]);
});

test("date windows", () => {
  assert.equal(matches("2026-11-18T09:00", "today", NOW), true);
  assert.equal(matches("2026-11-17T23:59", "today", NOW), false);
  assert.equal(matches("2026-11-16", "this week", NOW), true); // Monday
  assert.equal(matches("2026-11-15", "this week", NOW), false); // Sunday before
  assert.equal(matches("2026-11-12", "last 7 days", NOW), true);
  assert.equal(matches("2026-11-11", "last 7 days", NOW), false);
  assert.equal(matches("2026-12-01", "upcoming", NOW), true);
  assert.equal(matches("2026-11-01", "upcoming", NOW), false);
});

test("comparisons and equality", () => {
  assert.equal(matches(5, ">=5", NOW), true);
  assert.equal(matches("4", ">4", NOW), false);
  assert.equal(matches("done", "!=open", NOW), true);
  assert.equal(matches(["#a", "#b"], "#b", NOW), true);
  assert.equal(matches(true, true, NOW), true);
});

test("filter, sort, aggregate", () => {
  const rows = [
    { at: "2026-11-18T08:00", mg: 5 },
    { at: "2026-11-18T20:00", mg: 10 },
    { at: "2026-11-17T08:00", mg: 5 },
  ];
  const today = filterRows(rows, { at: "today" }, NOW);
  assert.equal(today.length, 2);
  assert.equal(aggregate(today, undefined, "count"), 2);
  assert.equal(aggregate(today, "mg", "sum"), 15);
  assert.equal(aggregate(rows, "mg", "avg"), 20 / 3);
  assert.deepEqual(sortRows(rows, "-at").map((r) => (r as { at: string }).at), [
    "2026-11-18T20:00", "2026-11-18T08:00", "2026-11-17T08:00",
  ]);
});

test("valueOf picks the right single value", () => {
  assert.equal(valueOf({ view: "number", source: "x" }, [1, 2, 3]), 3); // count
  assert.equal(valueOf({ view: "number", source: "x", field: "w" }, [{ w: 1 }, { w: 2 }]), 2); // last
  assert.equal(valueOf({ view: "number", source: "x", field: "temperature_2m" }, { temperature_2m: 7.5 }), 7.5);
  assert.equal(valueOf({ view: "number", source: "x" }, 42), 42);
});

test("templates", () => {
  assert.equal(fillTemplate("{name} — {due}", { name: "Dentist", due: "2026-12-01" }), "Dentist — 2026-12-01");
  assert.equal(fillTemplate("{temperature_2m}°C, {missing}", { temperature_2m: 7.456 }), "7.5°C, ");
});

test("daysUntil counts calendar days", () => {
  assert.equal(daysUntil("2026-11-18", NOW), 0);
  assert.equal(daysUntil("2026-11-25", NOW), 7);
  assert.equal(daysUntil("2026-10-03", NOW), -46);
});

test("CSV and JSON bodies", () => {
  assert.deepEqual(parseCSV('Date,Close\n2026-11-17,"1,001.5"\n2026-11-18,1002\n'), [
    { Date: "2026-11-17", Close: 1001.5 },
    { Date: "2026-11-18", Close: 1002 },
  ]);
  assert.deepEqual(parseBody('{"a":1}', "text/plain"), { a: 1 });
  assert.equal(parseBody("hello", "text/plain"), "hello");
});
