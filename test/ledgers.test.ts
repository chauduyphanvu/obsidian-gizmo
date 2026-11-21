import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel, type Panel } from "../src/spec.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "../src/views/registry.ts";
import { ledgerBy, list, table } from "../src/views/rows.ts";

// Wednesday 18 November 2026; the week began on Monday the 16th.
const NOW = new Date(2026, 10, 18, 12, 0);
const ctx = { now: NOW, width: () => 600, openNote: () => {}, editRow: async () => {} } as unknown as PanelCtx;
const text = (el: Element | null | undefined) => el?.textContent ?? "";
/** Locale text varies between ICU versions (a narrow space before PM); compare on plain spaces. */
const plain = (s: string) => s.replace(/[  ]/g, " ");
const clock = (...at: [number, number, number, number, number]) =>
  plain(new Date(...at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));

function panelOf(def: ViewDef, keys: Record<string, unknown>): Panel {
  const { panel, errors } = checkPanel({ view: def.id, source: "s", ...keys }, true);
  assert.deepEqual(errors, []);
  return panel as Panel;
}

function mount(def: ViewDef, keys: Record<string, unknown>, rows: unknown[]) {
  const el = document.createElement("div");
  const handle: PanelHandle = def.mount(el, panelOf(def, keys), ctx, "k");
  handle.update(rows);
  return { el, handle };
}

const dataRows = (el: Element) => [...el.querySelectorAll("tbody tr:not(.gz-ledger-group)")];
const whens = (el: Element) => [...el.querySelectorAll(".gz-ledger-when")].map(text);
const totals = (el: Element) => [...el.querySelectorAll(".gz-ledger-total")].map(text);

// ---- ledgerBy -------------------------------------------------------------------------------------

const SPENT = [
  { at: "2026-11-18T09:05", note: "coffee", amount: 4.5 },
  { at: "2026-11-17T19:30", note: "dinner", amount: 38 },
  { at: "2026-11-17T08:10", note: "bus", amount: 2.75 },
];

const panelFor = (keys: Record<string, unknown>) => ({ view: "table", source: "s", ...keys }) as Panel;

test("ledgerBy: rows sorted by a date with times are grouped by day", () => {
  assert.deepEqual(ledgerBy(panelFor({ sort: "-at" }), SPENT, ["at", "note", "amount"]), { field: "at", per: "day" });
  assert.deepEqual(ledgerBy(panelFor({ sort: "-at" }), SPENT), { field: "at", per: "day" });
});

test("ledgerBy: a date with no time spread over more than two weeks is grouped by week", () => {
  const rows = [{ date: "2026-11-18" }, { date: "2026-11-10" }, { date: "2026-10-29" }];
  assert.deepEqual(ledgerBy(panelFor({ sort: "-date" }), rows, ["date"]), { field: "date", per: "week" });
  // A date formatted as `date` has no time to show, whatever it holds.
  const stamped = [{ at: "2026-11-18T09:00" }, { at: "2026-11-02T09:00" }];
  assert.deepEqual(ledgerBy(panelFor({ sort: "-at" }), stamped, ["at"]), { field: "at", per: "day" });
  assert.deepEqual(ledgerBy(panelFor({ sort: "-at", format: { at: "date" } }), stamped, ["at"]), { field: "at", per: "week" });
});

test("ledgerBy: a date with no time inside two weeks is still grouped by day", () => {
  const rows = [{ date: "2026-11-18" }, { date: "2026-11-16" }, { date: "2026-11-13" }];
  assert.deepEqual(ledgerBy(panelFor({ sort: "-date" }), rows, ["date"]), { field: "date", per: "day" });
  assert.deepEqual(ledgerBy(panelFor({ sort: "-date" }), [{ date: "2026-11-18" }, { date: "2026-11-04" }], ["date"])?.per, "day", "exactly 14 days is not more");
});

test("ledgerBy: nothing when no date field is found", () => {
  const rows = [{ name: "Dune", pages: 412 }, { name: "Emma", pages: 474 }];
  assert.equal(ledgerBy(panelFor({ sort: "-pages" }), rows, ["name", "pages"]), undefined);
  assert.equal(ledgerBy(panelFor({}), rows, ["name", "pages"]), undefined);
  // Most of a field's values have to be times: 3 of 4 is not enough, 4 of 5 is.
  const mixed = [{ at: "2026-11-18" }, { at: "soon" }, { at: "2026-11-16" }, { at: "2026-11-15" }];
  assert.equal(ledgerBy(panelFor({ sort: "-at" }), mixed, ["at"]), undefined);
  assert.deepEqual(ledgerBy(panelFor({ sort: "-at" }), [...mixed, { at: "2026-11-14" }], ["at"]), { field: "at", per: "day" });
});

test("ledgerBy: a table is grouped by a shown `at` only while its rows are in date order", () => {
  const asc = [...SPENT].reverse();
  const byAmount = [SPENT[1], SPENT[0], SPENT[2]];
  assert.deepEqual(ledgerBy(panelFor({}), asc, ["at", "amount"]), { field: "at", per: "day" }, "oldest first");
  assert.deepEqual(ledgerBy(panelFor({}), SPENT, ["at", "amount"]), { field: "at", per: "day" }, "newest first");
  assert.equal(ledgerBy(panelFor({}), byAmount, ["at", "amount"]), undefined, "out of order");
  assert.equal(ledgerBy(panelFor({ sort: "-amount" }), byAmount, ["at", "amount"]), undefined, "sorted by something else");
  assert.equal(ledgerBy(panelFor({}), SPENT, ["note", "amount"]), undefined, "`at` isn't shown");
});

test("ledgerBy: a panel that groups, or draws cards, or has under two rows, is not a ledger", () => {
  assert.equal(ledgerBy(panelFor({ sort: "-at", group: "at", per: "day" }), SPENT, ["at", "count"]), undefined);
  assert.equal(ledgerBy(panelFor({ sort: "-at", layout: "cards" }), SPENT, ["at", "note"]), undefined);
  assert.equal(ledgerBy(panelFor({ sort: "-at" }), SPENT.slice(0, 1), ["at"]), undefined);
  assert.equal(ledgerBy(panelFor({ sort: "-at" }), [], ["at"]), undefined);
});

// ---- Group headers --------------------------------------------------------------------------------

test("a ledger table has a heading per day: Today, Yesterday, a weekday, a date", () => {
  const rows = [
    { at: "2026-11-18T09:05", note: "coffee", amount: 4.5 },
    { at: "2026-11-17T19:30", note: "dinner", amount: 38 },
    { at: "2026-11-14T08:10", note: "bus", amount: 2.75 },
    { at: "2026-11-09T12:00", note: "lunch", amount: 14 },
    { at: "2025-12-30T10:00", note: "gift", amount: 60 },
  ];
  const { el } = mount(table, { sort: "-at", columns: ["at", "note", "amount"] }, rows);
  assert.ok(el.querySelector("table.gz-table.gz-ledger"));
  assert.deepEqual(whens(el), ["Today", "Yesterday", "Saturday", "Mon Nov 9", "Tue Dec 30, 2025"]);
  assert.equal(dataRows(el).length, 5);
  // A heading is a row of its own, over every column, before the rows of its group.
  const groups = [...el.querySelectorAll("tbody tr.gz-ledger-group")];
  assert.equal(groups.length, 5);
  assert.equal(groups[0].querySelector("th")!.getAttribute("colspan"), "3");
  assert.equal(groups[0].nextElementSibling, dataRows(el)[0]);
  assert.equal(groups[1].nextElementSibling, dataRows(el)[1]);
  assert.ok(groups[0].querySelector("th .gz-ledger-when") && groups[0].querySelector("th .gz-ledger-total"));
  // The column headings stay.
  assert.deepEqual([...el.querySelectorAll("thead th")].map(text), ["at", "note", "amount"]);
});

test("a heading counts the row action's column", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "coffee" }, { at: "2026-11-17T19:30", note: "dinner" }];
  const { el } = mount(table, { sort: "-at", columns: ["at", "note"], action: "Open", open: "{note}" }, rows);
  assert.equal(el.querySelector("tr.gz-ledger-group th")!.getAttribute("colspan"), "3");
});

test("a ledger table by week: This week, Last week, Week of, and the date in each row", () => {
  const rows = [
    { date: "2026-11-18", note: "a" }, { date: "2026-11-16", note: "b" },
    { date: "2026-11-12", note: "c" },
    { date: "2026-11-04", note: "d" },
    { date: "2026-10-28", note: "e" },
    { date: "2025-11-26", note: "f" },
  ];
  const { el } = mount(table, { sort: "-date", columns: ["date", "note"] }, rows);
  assert.deepEqual(whens(el), ["This week", "Last week", "Week of Nov 2", "Week of Oct 26", "Week of Nov 24, 2025"]);
  const dates = [...el.querySelectorAll("td.gz-ledger-time")].map(text);
  assert.deepEqual(dates, ["Wed Nov 18", "Mon Nov 16", "Thu Nov 12", "Wed Nov 4", "Wed Oct 28", "Wed Nov 26, 2025"]);
  assert.deepEqual([...el.querySelectorAll("thead th")].map(text), ["date", "note"], "a week's rows keep the date column");
});

test("a ledger sorted oldest first groups the same way, in that order", () => {
  const rows = [{ at: "2026-11-17T08:10", note: "bus" }, { at: "2026-11-17T19:30", note: "dinner" }, { at: "2026-11-18T09:05", note: "coffee" }];
  const { el } = mount(table, { columns: ["at", "note"] }, rows);
  assert.deepEqual(whens(el), ["Yesterday", "Today"]);
  assert.deepEqual(dataRows(el).map((tr) => text(tr.querySelectorAll("td")[1])), ["bus", "dinner", "coffee"]);
});

// ---- Totals ---------------------------------------------------------------------------------------

test("a group's total is the sum of a currency column, and the average of another number", () => {
  const rows = [
    { at: "2026-11-18T09:05", note: "coffee", amount: 4.5 },
    { at: "2026-11-18T08:00", note: "bagel", amount: 3.25 },
    { at: "2026-11-17T19:30", note: "dinner", amount: 38 },
  ];
  const spent = mount(table, { sort: "-at", columns: ["at", "note", "amount"], format: { amount: "$0,0.00" } }, rows).el;
  assert.deepEqual(totals(spent), ["$7.75", "$38.00"]);

  const weights = [
    { at: "2026-11-18T07:30", weight: 80.2 }, { at: "2026-11-18T07:00", weight: 80.5 },
    { at: "2026-11-17T07:30", weight: 81 },
  ];
  const avg = mount(table, { sort: "-at", columns: ["at", "weight"], format: { weight: "0.0 kg" } }, weights).el;
  assert.deepEqual(totals(avg), ["avg 80.4 kg", "avg 81.0 kg"]);

  // Without a format: one decimal when the average isn't whole, none when it is.
  const plainAvg = mount(table, { sort: "-at", columns: ["at", "reps"] }, [
    { at: "2026-11-18T09:00", reps: 8 }, { at: "2026-11-18T08:00", reps: 9 }, { at: "2026-11-17T08:00", reps: 6 }, { at: "2026-11-17T07:00", reps: 6 },
  ]).el;
  assert.deepEqual(totals(plainAvg), ["avg 8.5", "avg 6"]);
});

test("the total is the first number column, never the date; none when there is no number", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "a", n: 1, m: 100 }, { at: "2026-11-17T09:05", note: "b", n: 3, m: 200 }];
  assert.deepEqual(totals(mount(table, { sort: "-at", columns: ["at", "note", "m", "n"] }, rows).el), ["avg 100", "avg 200"]);
  assert.deepEqual(totals(mount(table, { sort: "-at", columns: ["at", "note"] }, rows).el), ["", ""]);
  // An epoch time is a number, but it is the ledger's date.
  const epoch = [{ at: 1_763_460_000_000, n: 2 }, { at: 1_763_373_600_000, n: 4 }];
  assert.deepEqual(totals(mount(table, { sort: "-at", columns: ["at", "n"] }, epoch).el).length, 2);
  assert.ok(totals(mount(table, { sort: "-at", columns: ["at", "n"] }, epoch).el).every((t) => t.startsWith("avg ")));
});

test("an edited number column is totalled too", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "a", score: 2, path: "a.md" }, { at: "2026-11-18T08:05", note: "b", score: 4, path: "b.md" }];
  const el = mount(table, { sort: "-at", columns: ["at", "note", "score"], edit: ["score"], source: "notes", from: "Books" }, rows).el;
  assert.deepEqual(totals(el), ["avg 3"]);
});

test("a total covers the rows that are shown, not rows a limit cut", () => {
  // The view gets the rows after `limit` has cut them; the heading adds up what it was given.
  const rows = [{ at: "2026-11-18T09:05", amount: 4.5 }, { at: "2026-11-18T08:00", amount: 3.25 }];
  assert.deepEqual(totals(mount(table, { sort: "-at", limit: 1, columns: ["at", "amount"], format: { amount: "$0.00" } }, rows.slice(0, 1)).el), []);
  assert.deepEqual(totals(mount(table, { sort: "-at", limit: 2, columns: ["at", "amount"], format: { amount: "$0.00" } }, rows).el), ["$7.75"]);
});

// ---- The date column ------------------------------------------------------------------------------

test("under a day's heading the date cell is the time of day", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "coffee" }, { at: "2026-11-17T19:30", note: "dinner" }];
  const { el } = mount(table, { sort: "-at", columns: ["at", "note"], format: { at: "date" } }, rows);
  const cells = dataRows(el).map((tr) => tr.querySelector("td")!);
  assert.deepEqual(cells.map((td) => plain(text(td))), [clock(2026, 10, 18, 9, 5), clock(2026, 10, 17, 19, 30)]);
  assert.ok(cells.every((td) => td.classList.contains("gz-ledger-time")));
  assert.deepEqual([...el.querySelectorAll("thead th")].map(text), ["at", "note"], "the column keeps its heading");
  // A `time` format is the same thing.
  const time = mount(table, { sort: "-at", columns: ["at", "note"], format: { at: "time" } }, rows).el;
  assert.equal(plain(text(time.querySelector("tbody tr:not(.gz-ledger-group) td"))), clock(2026, 10, 18, 9, 5));
});

test("a date with no time of day, grouped by day, leaves the table: the heading says the day", () => {
  const rows = [{ date: "2026-11-18", note: "bins" }, { date: "2026-11-16", note: "post" }, { date: "2026-11-16", note: "swim" }];
  const { el } = mount(table, { sort: "-date", columns: ["date", "note"] }, rows);
  assert.deepEqual(whens(el), ["Today", "Monday"]);
  assert.deepEqual([...el.querySelectorAll("thead th")].map(text), ["note"]);
  assert.deepEqual(dataRows(el).map((tr) => [...tr.querySelectorAll("td")].map(text)), [["bins"], ["post"], ["swim"]]);
  assert.equal(el.querySelector("tr.gz-ledger-group th")!.getAttribute("colspan"), "1");
});

test("a date column the panel edits or draws as a kind stays as it is", () => {
  const rows = [{ date: "2026-11-18", note: "bins", path: "a.md" }, { date: "2026-11-16", note: "post", path: "b.md" }];
  const edited = mount(table, { sort: "-date", columns: ["date", "note"], edit: ["date"], source: "notes", from: "Chores" }, rows).el;
  assert.deepEqual(whens(edited), ["Today", "Monday"]);
  assert.equal(edited.querySelectorAll("tbody tr:not(.gz-ledger-group) input").length, 2);
  assert.equal(edited.querySelectorAll("td.gz-ledger-time").length, 0);

  const stamped = [{ at: "2026-11-18T09:05", note: "a" }, { at: "2026-11-17T19:30", note: "b" }];
  const kind = mount(table, { sort: "-at", columns: ["at", "note"], cells: { at: "check" } }, stamped).el;
  assert.equal(kind.querySelectorAll("td.gz-ledger-time").length, 0);
  assert.equal(kind.querySelectorAll("td .gz-check").length, 2);
});

test("the date cell is the time whatever the panel formats the date as", () => {
  const stamped = [{ at: "2026-11-18T09:05", note: "a" }, { at: "2026-11-17T19:30", note: "b" }];
  for (const at of ["relative", "date", "datetime", "time", "until"]) {
    const el = mount(table, { sort: "-at", columns: ["at", "note"], format: { at } }, stamped).el;
    assert.deepEqual(dataRows(el).map((tr) => plain(text(tr.querySelector("td")))), [clock(2026, 10, 18, 9, 5), clock(2026, 10, 17, 19, 30)], at);
  }
});

test("a date that isn't a time is shown as the panel shows it", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "a" }, { at: "2026-11-17T19:30", note: "b" }, { at: "someday", note: "c" }];
  const { el } = mount(table, { sort: "-at", columns: ["at", "note"] }, rows);
  assert.deepEqual(dataRows(el).map((tr) => text(tr.querySelector("td"))).slice(2), ["someday"]);
});

// ---- Lists ----------------------------------------------------------------------------------------

test("a list that is a ledger has the same headings, as list items", () => {
  const rows = [
    { at: "2026-11-18T09:05", note: "coffee", amount: 4.5 },
    { at: "2026-11-17T19:30", note: "dinner", amount: 38 },
    { at: "2026-11-17T08:10", note: "bus", amount: 2.5 },
  ];
  const { el } = mount(list, { sort: "-at", item: "{note} · {amount}" }, rows);
  assert.ok(el.querySelector("ul.gz-list.gz-ledger"));
  assert.deepEqual(whens(el), ["Today", "Yesterday"]);
  assert.deepEqual([...el.querySelectorAll("li.gz-ledger-group")].map((li) => [...li.children].map((c) => c.className)), [["gz-ledger-when", "gz-ledger-total"], ["gz-ledger-when", "gz-ledger-total"]]);
  assert.deepEqual([...el.querySelectorAll("li:not(.gz-ledger-group)")].map(text), ["coffee · 4.5", "dinner · 38", "bus · 2.5"]);
  assert.deepEqual([...el.querySelectorAll("ul > li")].map((li) => li.classList.contains("gz-ledger-group")), [true, false, true, false, false]);
});

test("a list of one row, or of grouped rows, or with no date is a plain list", () => {
  assert.equal(mount(list, { sort: "-at", item: "{note}" }, [{ at: "2026-11-18T09:05", note: "a" }]).el.querySelector(".gz-ledger-group"), null);
  assert.equal(mount(list, { item: "{note}" }, [{ note: "a" }, { note: "b" }]).el.querySelector("ul.gz-ledger"), null);
  const grouped = mount(list, { source: "notes", from: "#book", group: "at", per: "day" }, [{ at: "2026-11-18", count: 2 }, { at: "2026-11-17", count: 1 }]).el;
  assert.equal(grouped.querySelector(".gz-ledger-group"), null);
});

test("cards are never grouped", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "a" }, { at: "2026-11-17T19:30", note: "b" }];
  const { el } = mount(table, { sort: "-at", columns: ["note", "at"], layout: "cards" }, rows);
  assert.equal(el.querySelector(".gz-ledger-group"), null);
  assert.equal(el.querySelectorAll(".gz-rowcard").length, 2);
});

// ---- Rows that arrive -----------------------------------------------------------------------------

const NOTES = [
  { path: "a.md", at: "2026-11-18T09:05", note: "coffee" },
  { path: "b.md", at: "2026-11-17T19:30", note: "dinner" },
];
const fresh = (el: Element) => [...el.querySelectorAll(".gz-fresh")].map((e) => text(e.closest("tr, li") ?? e));

test("a row new since the last draw is marked fresh; the first draw marks none", () => {
  const { el, handle } = mount(table, { sort: "-at", columns: ["note", "at"], source: "notes", from: "Chores" }, NOTES);
  assert.deepEqual(fresh(el), []);
  handle.update([{ path: "c.md", at: "2026-11-18T11:30", note: "tea" }, ...NOTES]);
  assert.deepEqual(fresh(el).length, 1);
  assert.match(fresh(el)[0], /tea/);
  assert.ok(el.querySelector("tr.gz-fresh"));
  // Drawn again with nothing new: none.
  handle.update([{ path: "c.md", at: "2026-11-18T11:30", note: "tea" }, ...NOTES]);
  assert.deepEqual(fresh(el), []);
  handle.destroy?.();
});

test("an empty ledger's first row is fresh, and rows with no key never are", () => {
  const { el, handle } = mount(table, { sort: "-at", columns: ["note", "at"], source: "notes", from: "Chores" }, []);
  handle.update(NOTES);
  assert.equal(el.querySelectorAll("tr.gz-fresh").length, 2);
  handle.destroy?.();
  const keyless = mount(table, { sort: "-at", columns: ["note", "at"] }, [{ at: "2026-11-18T09:05", note: "x" }, { at: "2026-11-17T09:05", note: "y" }]);
  keyless.handle.update([{ at: "2026-11-18T10:05", note: "z" }, { at: "2026-11-18T09:05", note: "x" }, { at: "2026-11-17T09:05", note: "y" }]);
  assert.deepEqual(fresh(keyless.el), []);
});

test("a list marks its new items too, and stops on destroy", () => {
  const { el, handle } = mount(list, { sort: "-at", item: "{note}", source: "notes", from: "Chores" }, NOTES);
  assert.deepEqual(fresh(el), []);
  handle.update([{ path: "c.md", at: "2026-11-18T11:30", note: "tea" }, ...NOTES]);
  assert.deepEqual(fresh(el), ["tea"]);
  handle.destroy?.();
});

test("the mark ends after a moment, and a destroyed view leaves no timer behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { el, handle } = mount(table, { sort: "-at", columns: ["note", "at"], source: "notes", from: "Chores" }, NOTES);
  handle.update([{ path: "c.md", at: "2026-11-18T11:30", note: "tea" }, ...NOTES]);
  assert.equal(el.querySelectorAll("tr.gz-fresh").length, 1);
  t.mock.timers.tick(1799);
  assert.equal(el.querySelectorAll("tr.gz-fresh").length, 1);
  t.mock.timers.tick(1);
  assert.equal(el.querySelectorAll("tr.gz-fresh").length, 0);

  handle.update([{ path: "d.md", at: "2026-11-18T11:45", note: "toast" }, { path: "c.md", at: "2026-11-18T11:30", note: "tea" }, ...NOTES]);
  assert.equal(el.querySelectorAll("tr.gz-fresh").length, 1);
  handle.destroy?.();
  t.mock.timers.tick(5000);
  assert.equal(el.querySelectorAll("tr.gz-fresh").length, 1, "stopped, so nothing took the mark off");
});

// ---- Editing in a ledger ----------------------------------------------------------------------------

test("new values for the same rows update a ledger in place, totals included; a row on another day draws it again", () => {
  const rows = (a: number, b: number, atB = "2026-11-18T08:00") => [
    { path: "a.md", at: "2026-11-18T09:05", note: "a", score: a },
    { path: "b.md", at: atB, note: "b", score: b },
  ];
  const keys = { sort: "-at", columns: ["at", "note", "score"], edit: ["score"], source: "notes", from: "Books" };
  const { el, handle } = mount(table, keys, rows(2, 4));
  const tbody = el.querySelector("tbody")!;
  const input = tbody.querySelector("input")!;
  assert.deepEqual(totals(el), ["avg 3"]);

  handle.update(rows(4, 8));
  assert.equal(el.querySelector("tbody"), tbody, "patched in place");
  assert.equal(tbody.querySelector("input"), input);
  assert.deepEqual(totals(el), ["avg 6"]);
  assert.deepEqual(fresh(el), []);

  handle.update(rows(4, 8, "2026-11-17T08:00"));
  assert.notEqual(el.querySelector("tbody"), tbody, "the second row is now yesterday's");
  assert.deepEqual(whens(el), ["Today", "Yesterday"]);
  handle.destroy?.();
});

test("rows picked in a ledger still pick, and a heading is not one of them", () => {
  const rows = [{ at: "2026-11-18T09:05", note: "a" }, { at: "2026-11-17T19:30", note: "b" }];
  const picked: unknown[] = [];
  const pickCtx = { ...ctx, selected: () => undefined, select: (_: string, row: unknown) => picked.push(row) } as unknown as PanelCtx;
  const el = document.createElement("div");
  document.body.appendChild(el);
  table.mount(el, panelOf(table, { sort: "-at", columns: ["note", "at"], select: "pick" }), pickCtx, "k").update(rows);
  assert.equal(el.querySelectorAll("tr.gz-selectable").length, 2);
  assert.equal(el.querySelector("tr.gz-ledger-group.gz-selectable"), null);
  (el.querySelectorAll("tr.gz-selectable")[1] as HTMLElement).click();
  assert.deepEqual(picked, [rows[1]]);
});
