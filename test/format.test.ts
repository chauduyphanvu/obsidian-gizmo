import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fillTemplate, formatValue } from "../src/data.ts";
import { checkFormat, display, formatErrors, formatWith } from "../src/format.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { bar, line } from "../src/views/chart.ts";
import { pie } from "../src/views/pie.ts";
import type { PanelCtx, ViewDef } from "../src/views/registry.ts";
import { list, table } from "../src/views/rows.ts";
import { number, progress, text } from "../src/views/value.ts";

const NOW = new Date(2026, 10, 18, 12, 0);
const f = (v: unknown, format: string) => formatWith(v, format, NOW);
/** Locale text varies between ICU versions (a narrow space before PM); compare on plain spaces. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

test("number patterns: decimals, thousands separators, percent", () => {
  assert.equal(f(1234.567, "0"), "1235");
  assert.equal(f(1234.567, "0.0"), "1234.6");
  assert.equal(f(1234.567, "0.00"), "1234.57");
  assert.equal(f(1234.567, "0.000"), "1234.567");
  assert.equal(f(1234.567, "0,0"), "1,235");
  assert.equal(f(1234.567, "0,0.0"), "1,234.6");
  assert.equal(f(1234567, "0,0"), "1,234,567");
  assert.equal(f(0.256, "0%"), "26%");
  assert.equal(f(0.256, "0.0%"), "25.6%");
  assert.equal(f(0.07, "0%"), "7%");
  assert.equal(f(1.5, "0,0%"), "150%");
});

test("a pattern keeps the text around it; a negative's sign goes in front of the prefix", () => {
  assert.equal(f(1234.5, "$0,0.00"), "$1,234.50");
  assert.equal(f(71.26, "0.0 °F"), "71.3 °F");
  assert.equal(f(-5, "$0.00"), "-$5.00");
  assert.equal(f(-1234.5, "$0,0.00"), "-$1,234.50");
  assert.equal(f(-0.25, "0%"), "-25%");
  assert.equal(f(12, "≈ 0 pts"), "≈ 12 pts");
  assert.equal(f(3, "Q1 0"), "Q1 3");
});

test("zero, and a value that rounds to zero, carry no sign", () => {
  assert.equal(f(0, "0.0"), "0.0");
  assert.equal(f(0, "$0,0.00"), "$0.00");
  assert.equal(f(-0.001, "0.00"), "0.00");
  assert.equal(f(-0.001, "$0.00"), "$0.00");
  assert.equal(f(0, "0%"), "0%");
});

test("numbers typed as text are numbers; other text, booleans and objects show as they would plain", () => {
  assert.equal(f("42.5", "0.0"), "42.5");
  assert.equal(f("1234", "0,0"), "1,234");
  assert.equal(f("abc", "0.0"), "abc");
  assert.equal(f("abc", "$0.00"), "abc");
  assert.equal(f(true, "0.0"), "true");
  assert.equal(f({ a: 1 }, "0.0"), '{"a":1}');
  assert.equal(f("hello", "date"), "hello");
  assert.equal(f("hello", "bytes"), "hello");
  assert.equal(f("hello", "duration"), "hello");
  assert.equal(f(5, "date"), "5");
  assert.equal(f(Infinity, "0.0"), formatValue(Infinity));
});

test("a list is formatted item by item", () => {
  assert.equal(f([1, 2.5], "0.0"), "1.0, 2.5");
  assert.equal(f([], "0.0"), "");
});

test("a missing value is a dash, whatever the format", () => {
  for (const format of ["0", "$0,0.00", "0%", "date", "time", "datetime", "relative", "until", "duration", "duration:ms", "duration:min", "bytes"]) {
    assert.equal(f(undefined, format), "—", format);
    assert.equal(f(null, format), "—", format);
  }
});

test("date, time and datetime read dates as the rest of the plugin does", () => {
  const day = new Date(2026, 10, 18);
  const moment = new Date(2026, 10, 18, 14, 5);
  assert.equal(f("2026-11-18", "date"), day.toLocaleDateString());
  assert.equal(f("2026-11-18T14:05", "date"), day.toLocaleDateString());
  assert.equal(plain(f("2026-11-18T14:05", "time")), plain(moment.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })));
  assert.match(plain(f("2026-11-18T14:05", "time")), /^2:05 PM$/);
  assert.equal(f("2026-11-18T14:05", "datetime"), `${day.toLocaleDateString()}, ${f("2026-11-18T14:05", "time")}`);
  assert.equal(f(moment.getTime(), "date"), day.toLocaleDateString());
  assert.equal(f(moment.getTime() / 1000, "date"), day.toLocaleDateString());
  assert.equal(f(moment, "date"), day.toLocaleDateString());
});

test("relative: days for a date, minutes and hours for a moment under a day away", () => {
  assert.equal(f("2026-11-18", "relative"), "today");
  assert.equal(f("2026-11-17", "relative"), "yesterday");
  assert.equal(f("2026-11-19", "relative"), "tomorrow");
  assert.equal(f("2026-11-15", "relative"), "3 days ago");
  assert.equal(f("2026-11-30", "relative"), "in 12 days");
  assert.equal(f("2026-11-18T11:30", "relative"), "30 minutes ago");
  assert.equal(f("2026-11-18T11:59", "relative"), "1 minute ago");
  assert.equal(f("2026-11-18T09:00", "relative"), "3 hours ago");
  assert.equal(f("2026-11-18T11:00", "relative"), "1 hour ago");
  assert.equal(f("2026-11-18T13:00", "relative"), "in 1 hour");
  assert.equal(f("2026-11-18T12:45", "relative"), "in 45 minutes");
  assert.equal(f("2026-11-18T12:00:20", "relative"), "just now");
  assert.equal(f("2026-11-17T13:00", "relative"), "23 hours ago");
  assert.equal(f("2026-11-17T09:00", "relative"), "yesterday");
  assert.equal(f("2026-11-16T09:00", "relative"), "2 days ago");
  assert.equal(f("2026-11-19T13:00", "relative"), "tomorrow");
});

test("until: whole calendar days to a date", () => {
  assert.equal(f("2026-11-30", "until"), "12 days");
  assert.equal(f("2026-11-19", "until"), "1 day");
  assert.equal(f("2026-11-18", "until"), "today");
  assert.equal(f("2026-11-18T23:00", "until"), "today");
  assert.equal(f("2026-11-15", "until"), "3 days ago");
  assert.equal(f("2026-11-17", "until"), "1 day ago");
});

test("duration: seconds as 1h 05m, 4m 10s, 8s; ms and min for other units", () => {
  assert.equal(f(3900, "duration"), "1h 05m");
  assert.equal(f(3600, "duration"), "1h 00m");
  assert.equal(f(250, "duration"), "4m 10s");
  assert.equal(f(245, "duration"), "4m 05s");
  assert.equal(f(8, "duration"), "8s");
  assert.equal(f(0, "duration"), "0s");
  assert.equal(f(8.4, "duration"), "8s");
  assert.equal(f(-90, "duration"), "-1m 30s");
  assert.equal(f("250", "duration"), "4m 10s");
  assert.equal(f(250_000, "duration:ms"), "4m 10s");
  assert.equal(f(8000, "duration:ms"), "8s");
  assert.equal(f(450, "duration:ms"), "450ms");
  assert.equal(f(65, "duration:min"), "1h 05m");
  assert.equal(f(0.5, "duration:min"), "30s");
  assert.equal(f(4.25, "duration:min"), "4m 15s");
});

test("bytes: steps of 1024, one decimal below ten", () => {
  assert.equal(f(0, "bytes"), "0 B");
  assert.equal(f(512, "bytes"), "512 B");
  assert.equal(f(1024, "bytes"), "1.0 KB");
  assert.equal(f(1_258_291, "bytes"), "1.2 MB");
  assert.equal(f(15 * 1024, "bytes"), "15 KB");
  assert.equal(f(2 * 1024 ** 3, "bytes"), "2.0 GB");
  assert.equal(f(3 * 1024 ** 4, "bytes"), "3.0 TB");
  assert.equal(f(1023.6 * 1024, "bytes"), "1.0 MB");
  assert.equal(f(-2048, "bytes"), "-2.0 KB");
  assert.equal(f("2048", "bytes"), "2.0 KB");
});

test("checkFormat accepts patterns and words and says what is wrong with anything else", () => {
  for (const ok of ["0", "0.0", "0.00", "0.0000", "0,0", "0,0.0", "0%", "0.0%", "$0,0.00", "0.0 °F", "0 pts", "£0", "date", "time", "datetime", "relative", "until", "duration", "duration:ms", "duration:min", "bytes"]) {
    assert.equal(checkFormat(ok), undefined, ok);
  }
  const tail = "isn't a number pattern or one of date, time, datetime, relative, until, duration, bytes";
  for (const bad of ["0.0.0", "0,0,0", "money", "", "00", "1000 pts", "dates", "duration:h", "Date"]) {
    assert.equal(checkFormat(bad), `format "${bad}" ${tail}`, bad);
  }
});

test("formatErrors checks a text format and each value of a map", () => {
  assert.deepEqual(formatErrors({}), []);
  assert.deepEqual(formatErrors({ format: "0.0" }), []);
  assert.deepEqual(formatErrors({ format: { a: "0.0", b: "date" } }), []);
  assert.deepEqual(formatErrors({ format: { a: "nope", b: "0.0", c: "nope", d: "also" } }), [
    `format "nope" isn't a number pattern or one of date, time, datetime, relative, until, duration, bytes`,
    `format "also" isn't a number pattern or one of date, time, datetime, relative, until, duration, bytes`,
  ]);
});

test("display: values first, then format, else the plain form; by mode", () => {
  const p = { values: { code: { 0: "Clear", 3: "Rain" } }, format: { code: "0.0", price: "$0,0.00" }, decimals: undefined } as Pick<Panel, "values" | "format" | "decimals">;
  assert.equal(display(p, "code", 0, NOW), "Clear");
  assert.equal(display(p, "code", "3", NOW), "Rain");
  assert.equal(display(p, "code", 7, NOW), "7.0");
  assert.equal(display(p, "price", 1234.5, NOW), "$1,234.50");
  assert.equal(display(p, "other", 1234.5, NOW), "1,235");
  assert.equal(display(p, "other", 1234.5, NOW, "text"), "1235");
  assert.equal(display(p, "other", "1234.5", NOW), "1,235");
  assert.equal(display(p, "other", "1234.5", NOW, "cell"), "1234.5");
  assert.equal(display(p, "code", [0, 3, 7], NOW), "Clear, Rain, 7.0");
  assert.equal(display(p, "code", undefined, NOW), "—");
  // An own key only: names on the prototype are no mapping.
  assert.equal(display({ values: { code: {} } }, "code", "constructor", NOW), "constructor");
  assert.equal(display({ values: {} }, "constructor", "x", NOW), "x");
  // A text format is for every value in a value or sentence; in a table, for numbers.
  const all = { format: "$0.00" };
  assert.equal(display(all, "a", 5, NOW, "cell"), "$5.00");
  assert.equal(display(all, "a", "Dune", NOW, "cell"), "Dune");
  assert.equal(display({ format: "until" }, "a", "2026-11-30", NOW, "cell"), "2026-11-30");
  assert.equal(display({ format: "until" }, "a", "2026-11-30", NOW, "text"), "12 days");
  assert.equal(display({ format: { a: "until" } }, "a", "2026-11-30", NOW, "cell"), "12 days");
});

test("format wins over decimals", () => {
  assert.equal(display({ format: "0.0", decimals: 3 }, "a", 2.34567, NOW), "2.3");
  assert.equal(display({ decimals: 3 }, "a", 2.34567, NOW), "2.346");
});

test("a placeholder's integer has no thousands separator; numbers elsewhere keep theirs", () => {
  assert.equal(fillTemplate("First published in {year}", { year: 1965 }), "First published in 1965");
  assert.equal(fillTemplate("{pages} pages", { pages: 12345 }), "12345 pages");
  assert.equal(fillTemplate("{n}", { n: 7.456 }), "7.5");
  assert.equal(fillTemplate("{n}", { n: 1234.5 }, 2), "1234.50");
  assert.equal(fillTemplate("{xs}", { xs: [1965, 2.5] }), "1965, 2.5");
  assert.equal(formatValue(1965), "1,965");
  assert.equal(formatValue(1965, undefined, false), "1965");
});

// ---- Each view honours it -----------------------------------------------------------------------

const ctx = { now: NOW, width: () => 600 } as unknown as PanelCtx;

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown): HTMLElement {
  const { panel, errors } = checkPanel({ view: def.id, ...keys }, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, ctx, "k").update(data);
  return el;
}
const text_ = (el: Element | null) => el?.textContent ?? "";

test("number: format, and format wins over unit; until and relative take a date as it is", () => {
  const sum = draw(number, { source: "s", field: "amount", agg: "sum", format: "$0,0.00", unit: "USD" }, [{ amount: 1000 }, { amount: 234.5 }]);
  assert.equal(text_(sum.querySelector(".gz-big")), "$1,234.50");
  assert.equal(sum.querySelector(".gz-unit"), null);
  const unit = draw(number, { source: "s", field: "amount", agg: "sum", unit: "kg" }, [{ amount: 1000 }, { amount: 234.5 }]);
  assert.equal(text_(unit.querySelector(".gz-big")), "1,235kg");
  assert.equal(text_(draw(number, { source: "s", field: "due", agg: "first", format: "until" }, [{ due: "2026-11-30" }]).querySelector(".gz-big")), "12 days");
  assert.equal(text_(draw(number, { source: "s", field: "due", format: "relative" }, { due: "2026-11-15" }).querySelector(".gz-big")), "3 days ago");
  assert.equal(text_(draw(number, { source: "s", field: "due", format: "until" }, [{ due: "2026-11-18" }]).querySelector(".gz-big")), "today");
  assert.equal(text_(draw(number, { source: "s", field: "secs", format: "duration" }, { secs: 3900 }).querySelector(".gz-big")), "1h 05m");
  assert.equal(text_(draw(number, { source: "s", field: "w", format: { w: "0.0 kg" } }, { w: 71.26 }).querySelector(".gz-big")), "71.3 kg");
  assert.equal(text_(draw(number, { source: "s", field: "w" }, { w: "1234.5" }).querySelector(".gz-big")), "1,235");
});

test("progress: both ends in the format", () => {
  const el = draw(progress, { source: "s", field: "amount", agg: "sum", max: 500, format: "$0", unit: "USD" }, [{ amount: 120 }]);
  assert.equal(text_(el.querySelector(".gz-big")), "$120/ $500");
});

test("text: a text format is for every placeholder, a map for its fields", () => {
  const row = { n: 1234.5, due: "2026-11-30", year: 1965 };
  assert.equal(text_(draw(text, { text: "{n} due {due}", format: { n: "$0,0.00", due: "until" } }, row).querySelector(".gz-text")), "$1,234.50 due 12 days");
  assert.equal(text_(draw(text, { text: "{due}", format: "until" }, row).querySelector(".gz-text")), "12 days");
  assert.equal(text_(draw(text, { text: "In {year}: {n}" }, row).querySelector(".gz-text")), "In 1965: 1235");
  assert.equal(text_(draw(text, { source: "s", text: "{count} entries" }, [{}, {}]).querySelector(".gz-text")), "2 entries");
});

const hourly = { time: ["2026-11-18T00:00", "2026-11-18T01:00", "2026-11-18T02:00"], t: [4, 5, 6], h: [0.5, 0.6, 0.7] };

test("line: axis ticks and the readout take the format; a map is per series", () => {
  const one = draw(line, { source: "s", x: "time", y: "t", format: "0.0 °C" }, hourly);
  const ticks = [...one.querySelectorAll("text.gz-axis")].filter((t) => t.getAttribute("x") === "44").map((t) => text_(t));
  assert.ok(ticks.length > 1);
  assert.ok(ticks.every((t) => /^\d+\.\d °C$/.test(t)), ticks.join("|"));
  assert.match(text_(one.querySelector(".gz-readout")), /6\.0 °C$/);

  const many = draw(line, { source: "s", x: "time", y: ["t", "h"], format: { t: "0.0 °C", h: "0%" } }, hourly);
  assert.match(plain(text_(many.querySelector(".gz-readout"))), /t 6\.0 °C *h 70%/);
  const plainOne = draw(line, { source: "s", x: "time", y: "t", unit: "°C" }, hourly);
  assert.match(text_(plainOne.querySelector(".gz-readout")), /6 °C$/);
});

test("bar: tooltips take the format of their series", () => {
  const rows = [{ g: "a", spent: 1234.5, budget: 2000 }, { g: "b", spent: 800, budget: 2000 }];
  const el = draw(bar, { source: "s", x: "g", y: ["spent", "budget"], format: { spent: "$0,0.00", budget: "$0,0" } }, rows);
  assert.match(plain(text_(el.querySelector(".gz-readout"))), /b.*spent \$800\.00.*budget \$2,000/);
  const group = draw(bar, { source: "s", group: "genre", format: "0 books" }, [{ genre: "x", count: 2 }]);
  assert.match(text_(group.querySelector(".gz-readout")), /2 books$/);
});

test("pie: legend values and the total follow the format", () => {
  const rows = [{ c: "food", v: 30 }, { c: "rent", v: 1200.5 }];
  const el = draw(pie, { source: "s", x: "c", y: "v", format: "$0,0.00" }, rows);
  assert.match(text_(el.querySelector(".gz-pie-legend")), /rent\$1,200\.50 · 98%.*food\$30\.00 · 2%/);
  assert.equal(text_(el.querySelector(".gz-readout")), "Total · $1,230.50");
});

test("table: a map is per column, a text format is for numeric columns; grouping stays without a format", () => {
  const rows = [{ name: "Lunch", amount: 12.5, at: "2026-11-30", pages: 1234 }];
  const map = draw(table, { source: "s", columns: ["name", "amount", "at", "pages"], format: { amount: "$0,0.00", at: "until" } }, rows);
  assert.deepEqual([...map.querySelectorAll("td")].map((td) => text_(td)), ["Lunch", "$12.50", "12 days", "1,234"]);
  const all = draw(table, { source: "s", columns: ["name", "amount", "at", "pages"], format: "0.0" }, rows);
  assert.deepEqual([...all.querySelectorAll("td")].map((td) => text_(td)), ["Lunch", "12.5", "2026-11-30", "1234.0"]);
});

test("list: a map is per {placeholder}; years stay years", () => {
  const rows = [{ note: "Lunch", amount: 12.5, due: "2026-11-30", year: 1965 }];
  const el = draw(list, { source: "s", item: "{note} {year} · {amount} · {due}", format: { amount: "$0.00", due: "until" } }, rows);
  assert.equal(text_(el.querySelector("li")), "Lunch 1965 · $12.50 · 12 days");
});
