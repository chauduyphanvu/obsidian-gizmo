import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRows, readMatch, ruleOf, settledBy } from "../src/match.ts";
import { ROW_ID } from "../src/ledger-store.ts";
import type { Row } from "../src/data.ts";

const FIELDS = { amount: "number", category: ["food", "home"], memo: "text", paid: "date" } as Record<string, string | string[]>;

/** A row as the ledger hands it out, carrying its id. */
const row = (id: string, values: Row): Row => Object.defineProperty({ ...values }, ROW_ID, { value: id });
const ids = (rows: Row[]) => rows.map((r) => (r as Record<symbol, unknown>)[ROW_ID]);

test("match takes exact for any field, a number for a number field, and days for a date or at", () => {
  const r = readMatch({ amount: 0.5, category: "exact", at: "2d", paid: "1d" }, FIELDS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule, { amount: { kind: "near", by: 0.5 }, category: { kind: "exact" }, at: { kind: "days", days: 2 }, paid: { kind: "days", days: 1 } });
  assert.deepEqual(readMatch({ memo: "2d", nope: "exact", amount: "close" }, FIELDS).errors, [
    "match: memo takes exact or contains, not \"2d\"",
    "match: \"nope\" isn't a field of the kind; its fields are at, amount, category, memo, paid",
    "match: amount takes exact, a number (e.g. 0.5) or a percent up to 100% (e.g. 20%), not \"close\"",
  ]);
  assert.deepEqual(readMatch("amount", FIELDS).errors, ["match must be a set of field: how, e.g. match: {amount: exact, at: 2d}"]);
});

test("a kind with no match pairs each number field exactly and at within 2 days; a match it gives replaces all of that", () => {
  assert.deepEqual(readMatch(undefined, FIELDS), { rule: { amount: { kind: "exact" }, at: { kind: "days", days: 2 } }, errors: [] });
  assert.deepEqual(readMatch(null, { amount: "number", fee: "number", memo: "text" }).rule, { amount: { kind: "exact" }, fee: { kind: "exact" }, at: { kind: "days", days: 2 } });
  assert.deepEqual(readMatch({ category: "exact" }, FIELDS).rule, { category: { kind: "exact" } });
  assert.deepEqual(ruleOf({ kind: "spend", fields: { amount: { type: "number", label: "Spent" }, memo: "text" } }), { amount: { kind: "exact" }, at: { kind: "days", days: 2 } });
  assert.deepEqual(ruleOf({ kind: "spend", fields: FIELDS, match: { memo: "exact" } }), { memo: { kind: "exact" } });
});

test("a kind with no number field and no match has no rule: nothing pairs, nothing is logged twice or only logged", () => {
  const fields = { memo: "text", category: ["food", "home"] } as Record<string, string | string[]>;
  assert.deepEqual(readMatch(undefined, fields), { rule: {}, errors: [] });
  assert.deepEqual(ruleOf({ kind: "chore", fields }), {});
  const bank = [row("b1", { memo: "rent", at: "2026-11-18", line: "attested" })];
  const mine = [row("m1", { memo: "rent", at: "2026-11-18" }), row("m2", { memo: "milk", at: "2026-11-17" })];
  const m = matchRows(bank, mine, readMatch(undefined, fields).rule);
  assert.deepEqual([m.pairs.length, ids(m.attestedOnly), m.loggedOnly.length, m.loggedTwice.length], [0, ["b1"], 0, 0]);
  assert.equal(settledBy(row("n", { memo: "rent", at: "2026-11-18" }), [row("p", { memo: "rent", at: "2026-11-18", line: "planned" })], {}), undefined);
});

const RULE = readMatch({ amount: "exact", at: "2d" }, FIELDS).rule;

test("imported rows pair one to one with logged rows, the nearest day first", () => {
  const bank = [row("b1", { amount: 14.5, at: "2026-11-18", line: "attested" }), row("b2", { amount: 9, at: "2026-11-18", line: "attested" })];
  const mine = [
    row("m1", { amount: 14.5, at: "2026-11-16T12:00" }),
    row("m2", { amount: 14.5, at: "2026-11-18T12:00" }),
    row("m3", { amount: 30, at: "2026-11-17T09:00" }),
    row("m4", { amount: 30, at: "2026-10-01T09:00" }),
  ];
  const m = matchRows(bank, mine, RULE);
  assert.deepEqual(m.pairs.map((p) => [ids([p.attested])[0], ids([p.logged])[0]]), [["b1", "m2"]]);
  assert.deepEqual(ids(m.attestedOnly), ["b2"]);
  assert.deepEqual(ids(m.loggedTwice), ["m1"], "the same amount logged two days before: logged twice");
  assert.deepEqual(ids(m.loggedOnly), ["m3"], "a row long before the import's days is no part of it");
});

test("pairs are the same whatever order the rows come in; ties go by id", () => {
  const bank = [row("b2", { amount: 5, at: "2026-11-18", line: "attested" }), row("b1", { amount: 5, at: "2026-11-18", line: "attested" })];
  const mine = [row("m2", { amount: 5, at: "2026-11-18" }), row("m1", { amount: 5, at: "2026-11-18" })];
  const one = matchRows(bank, mine, RULE).pairs.map((p) => ids([p.attested, p.logged]));
  const two = matchRows([...bank].reverse(), [...mine].reverse(), RULE).pairs.map((p) => ids([p.attested, p.logged]));
  assert.deepEqual(one, [["b1", "m1"], ["b2", "m2"]]);
  assert.deepEqual(two, one);
});

test("rows already paired, and rows set aside, take no part; nothing pairs without a rule", () => {
  const bank = [
    row("b1", { amount: 5, at: "2026-11-18", line: "attested", matched: "m1" }),
    row("b2", { amount: 5, at: "2026-11-18", line: "dismissed" }),
    row("b3", { amount: 5, at: "2026-11-18", line: "attested" }),
  ];
  const mine = [row("m1", { amount: 5, at: "2026-11-18" }), row("m2", { amount: 5, at: "2026-11-18" })];
  assert.deepEqual(matchRows(bank, mine, RULE).pairs.map((p) => ids([p.attested, p.logged])), [["b3", "m2"]]);
  const none = matchRows(bank, mine, {});
  assert.deepEqual([none.pairs.length, ids(none.attestedOnly)], [0, ["b3"]]);
});

test("a row accepted from a file never pairs with a row still from a file: only rows logged by hand pair, and it isn't only logged or logged twice", () => {
  const rule = readMatch({ amount: "exact", at: "2d" }, { amount: "number" }).rule;
  const twin = { amount: 4.5, at: "2026-11-08", line: "attested" };
  const accepted = { amount: 4.5, at: "2026-11-08", imported: "t2" };
  const hand = { amount: 4.5, at: "2026-11-08T09:12" };
  const m = matchRows([twin], [accepted, hand], rule);
  assert.deepEqual(m.pairs, [{ attested: twin, logged: hand }]);
  assert.deepEqual([m.attestedOnly, m.loggedOnly, m.loggedTwice], [[], [], []]);
  const alone = matchRows([twin], [accepted], rule);
  assert.deepEqual([alone.pairs, alone.attestedOnly, alone.loggedOnly, alone.loggedTwice], [[], [twin], [], []]);
});

test("a logged row settles the planned row it matches, the nearest first", () => {
  const plans = [
    row("p1", { amount: 1200, at: "2026-12-01T09:00", line: "planned" }),
    row("p2", { amount: 1200, at: "2027-01-01T09:00", line: "planned" }),
    row("p3", { amount: 1200, at: "2026-12-02T09:00", line: "planned", matched: "x" }),
  ];
  assert.deepEqual(ids([settledBy(row("n", { amount: 1200, at: "2026-12-02T10:00" }), plans, RULE)!]), ["p1"]);
  assert.equal(settledBy(row("n", { amount: 1100, at: "2026-12-02T10:00" }), plans, RULE), undefined);
  assert.equal(settledBy(row("n", { amount: 1200, at: "2026-12-02T10:00" }), plans, {}), undefined);
});

test("a number field takes a percent up to 100%, a text field takes contains; anything else says what it takes", () => {
  const r = readMatch({ amount: "20%", memo: "contains", at: "3d" }, FIELDS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule, { amount: { kind: "percent", pct: 20 }, memo: { kind: "contains" }, at: { kind: "days", days: 3 } });
  assert.deepEqual(readMatch({ amount: "150%", memo: "20%", category: "contains", paid: "5%" }, FIELDS).errors, [
    "match: amount takes exact, a number (e.g. 0.5) or a percent up to 100% (e.g. 20%), not \"150%\"",
    "match: memo takes exact or contains, not \"20%\"",
    "match: category takes exact, not \"contains\"",
    "match: paid takes exact or a number of days, e.g. 2d, not \"5%\"",
  ]);
});

test("match can be a list of rules, any one of which pairs two rows; each is told by its place", () => {
  const r = readMatch([{ amount: "exact", at: "3d" }, { memo: "contains", amount: "20%", at: "3d" }], FIELDS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule, [
    { amount: { kind: "exact" }, at: { kind: "days", days: 3 } },
    { memo: { kind: "contains" }, amount: { kind: "percent", pct: 20 }, at: { kind: "days", days: 3 } },
  ]);
  assert.deepEqual(readMatch([{ amount: "exact" }, { nope: "exact" }], FIELDS).errors, [
    "match 2: \"nope\" isn't a field of the kind; its fields are at, amount, category, memo, paid",
  ]);
  assert.deepEqual(readMatch([], FIELDS).errors, ["match must be a set of field: how, or a list of them, e.g. match: {amount: exact, at: 2d}"]);
  assert.deepEqual(readMatch(["amount"], FIELDS).errors, ["match must be a set of field: how, or a list of them, e.g. match: {amount: exact, at: 2d}"]);
});

test("a percent is of the planned row's number when a logged row settles it, and of the logged row's when a row from a file pairs", () => {
  const rule = readMatch({ amount: "15%", at: "3d" }, FIELDS).rule;
  // 17.99 is 16% over 15.49, but 15.49 is under 14% below 17.99: which side counts decides it.
  const plan = row("p", { amount: 15.49, at: "2026-11-12T09:00", line: "planned" });
  assert.equal(settledBy(row("n", { amount: 17.99, at: "2026-11-12T10:00" }), [plan], rule), undefined, "15% of 15.49 is 2.32, short of 2.50");
  assert.deepEqual(ids([settledBy(row("n", { amount: 15.49, at: "2026-11-12T10:00" }), [row("p", { amount: 17.99, at: "2026-11-12T09:00", line: "planned" })], rule)!]), ["p"]);
  const bank = [row("b", { amount: 15.49, at: "2026-11-12", line: "attested" })];
  assert.deepEqual(matchRows(bank, [row("m", { amount: 17.99, at: "2026-11-12T08:00" })], rule).pairs.length, 1, "15% of the logged 17.99 is 2.70");
  assert.deepEqual(matchRows([row("b", { amount: 17.99, at: "2026-11-12", line: "attested" })], [row("m", { amount: 15.49, at: "2026-11-12T08:00" })], rule).pairs.length, 0);
});

test("contains: one text holds the other, case and spacing aside; an empty one holds nothing", () => {
  const rule = readMatch({ memo: "contains" }, FIELDS).rule;
  const plan = (memo: unknown) => row("p", { memo, line: "planned" });
  assert.ok(settledBy(row("n", { memo: "streamflix.com  866-555" }), [plan("STREAMFLIX")], rule));
  assert.ok(settledBy(row("n", { memo: "Streamflix" }), [plan("STREAMFLIX.COM 866")], rule));
  assert.equal(settledBy(row("n", { memo: "TUNEBOX" }), [plan("STREAMFLIX")], rule), undefined);
  assert.equal(settledBy(row("n", { memo: "STREAMFLIX" }), [plan("")], rule), undefined);
  assert.ok(settledBy(row("n", { memo: "" }), [plan(undefined)], rule), "two empty texts agree, as with exact");
});

test("with a list of rules, a dearer charge of the same name settles its bill, a charge logged by hand pairs by its amount, and an unrelated one near in amount pairs with nothing", () => {
  const rule = readMatch([{ amount: "exact", at: "3d" }, { memo: "contains", amount: "20%", at: "3d" }], FIELDS).rule;
  const plans = [
    row("p1", { amount: 15.49, memo: "STREAMFLIX", at: "2026-11-12T09:00", line: "planned" }),
    row("p2", { amount: 86, memo: "GREENLEAF MARKET", at: "2026-11-12T09:00", line: "planned" }),
  ];
  // The bank's 17.99 is a fifth or less over the 15.49 planned, under the same name.
  assert.deepEqual(ids([settledBy(row("n", { amount: 17.99, memo: "STREAMFLIX", at: "2026-11-12" }), plans, rule)!]), ["p1"]);
  // 20.00 is more than a fifth over.
  assert.equal(settledBy(row("n", { amount: 20, memo: "STREAMFLIX", at: "2026-11-12" }), plans, rule), undefined);
  // 16.50 is near both amounts' windows, but its name is neither bill's.
  assert.equal(settledBy(row("n", { amount: 16.5, memo: "BLUE DOOR CAFE", at: "2026-11-12" }), plans, rule), undefined);
  // The same amount still settles whatever its name, by the first rule, before a near one of the same name.
  const both = [row("p3", { amount: 17, memo: "STREAMFLIX", at: "2026-11-12T09:00", line: "planned" }), row("p4", { amount: 17.99, memo: "x", at: "2026-11-13T09:00", line: "planned" })];
  assert.deepEqual(ids([settledBy(row("n", { amount: 17.99, memo: "STREAMFLIX", at: "2026-11-12T09:00" }), both, rule)!]), ["p4"]);

  // A row from a file pairs with lunch logged by hand by its amount, though their texts differ.
  const bank = [row("b1", { amount: 14.5, memo: "BLUE DOOR CAFE", at: "2026-11-18", line: "attested" }), row("b2", { amount: 92.15, memo: "GREENLEAF MARKET", at: "2026-11-18", line: "attested" })];
  const mine = [row("m1", { amount: 14.5, memo: "lunch", at: "2026-11-18T12:00" }), row("m2", { amount: 88, memo: "groceries", at: "2026-11-17T18:00" })];
  const m = matchRows(bank, mine, rule);
  assert.deepEqual(m.pairs.map((p) => ids([p.attested, p.logged])), [["b1", "m1"]]);
  assert.deepEqual([ids(m.attestedOnly), ids(m.loggedOnly)], [["b2"], ["m2"]], "groceries near in amount but not by name stay apart");
});
