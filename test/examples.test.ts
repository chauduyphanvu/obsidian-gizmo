import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { drawExamples, planOf, readWords, type ExamplePlan } from "../src/examples-view.ts";
import { parseFields } from "../src/capture.ts";
import { appNoteText, askKindOf, dateAt, exampleNameProblem, findPanels, inferRows, kindNoteText, readAnswer } from "../src/examples.ts";
import { readSpec } from "../src/spec.ts";
import { parseYaml } from "./support/yaml.ts";

// Friday 20 November 2026.
const NOW = new Date(2026, 10, 20, 19, 42);

const LIST = `
- mar 3 groceries 62.10 weekly shop
- mar 4 coffee 4.50
- mar 4 groceries 18.25 bread and milk
- mar 9 transport 31.00 train
- mar 10 coffee 4.50
- mar 12 groceries 230.05 big shop
- apr 2 coffee 5.00 with sam
`;

test("dateAt: the ways a list says a day, the latest one when it gives no year", () => {
  assert.deepEqual(dateAt(["2026-03-03", "x"], NOW), { date: "2026-03-03", used: 1 });
  assert.deepEqual(dateAt(["3/14/2026"], NOW), { date: "2026-03-14", used: 1 });
  assert.deepEqual(dateAt(["3/14"], NOW), { date: "2026-03-14", used: 1 });
  assert.deepEqual(dateAt(["mar", "3", "groceries"], NOW), { date: "2026-03-03", used: 2 });
  assert.deepEqual(dateAt(["3", "March", "2025"], NOW), { date: "2025-03-03", used: 3 });
  assert.deepEqual(dateAt(["dec", "25"], NOW), { date: "2025-12-25", used: 2 }, "a day still to come this year was last year's");
  assert.deepEqual(dateAt(["yday"], NOW), { date: "2026-11-19", used: 1 });
  assert.equal(dateAt(["62.10"], NOW), undefined);
  assert.equal(dateAt(["11-03"], NOW), undefined, "a bare number pair isn't taken for a day");
  assert.equal(dateAt(["feb", "30"], NOW), undefined);
});

test("inferRows: a date, a choice, an amount and a note, in the order the lines give them", () => {
  const r = inferRows(LIST, NOW);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.dated, true);
  assert.deepEqual(r.fields, [["category", ["groceries", "coffee", "transport"]], ["amount", "number"], ["note", "text"]]);
  assert.equal(r.rows.length, 7);
  assert.deepEqual(r.rows.slice(0, 2).map((x) => [String(x.at).slice(0, 16), x.category, x.amount, x.note]), [
    ["2026-03-03T12:00", "groceries", 62.1, "weekly shop"],
    ["2026-03-04T12:00", "coffee", 4.5, ""],
  ]);
});

test("inferRows: a line shaped unlike the rest is set aside with its number and why", () => {
  const r = inferRows(`${LIST}\nremember to cancel the gym\napr 3 31 coffee`, NOW);
  assert.deepEqual(r.skipped.map((s) => [s.line, s.why]), [
    [8, "no date at its start, as the other lines have"],
    [9, "its numbers and words aren't in the places the other lines have them"],
  ]);
  assert.equal(r.rows.length, 7);
});

const SPEND = `
62.10 food weekly shop
4.50 food coffee
31 transport train
$18.25 food bread and milk
12 fun cinema
`;

test("inferRows: a number first, then a choice and the words after it as a note; no dates means now", () => {
  const r = inferRows(SPEND, NOW);
  assert.deepEqual(r.fields, [["amount", "number"], ["category", ["food", "transport", "fun"]], ["note", "text"]]);
  assert.deepEqual(r.rows[0], { at: "2026-11-20T19:42" + r.rows[0].at!.toString().slice(16), amount: 62.1, category: "food", note: "weekly shop" });
  assert.equal(r.dated, false);
  assert.equal(r.rows[3].amount, 18.25, "a money sign on one line doesn't make the field money");
  assert.deepEqual(r.formats, { amount: "0,0.00" }, "lines that write cents show cents");
  assert.deepEqual(inferRows("3 apples\n12 pears\n5 plums", NOW).formats, {}, "whole numbers stay as they are");
});

test("inferRows: a sign or an ending on most numbers gives the field its unit; words that never repeat are text", () => {
  const money = inferRows("$62.10 rent\n$4.50 coffee with sam\n$31 train", NOW);
  assert.deepEqual(money.fields, [["amount", "USD"], ["note", "text"]]);
  assert.deepEqual(money.rows.map((r) => r.note), ["rent", "coffee with sam", "train"]);
  const weights = inferRows("nov 1 81.2kg\nnov 8 80.9kg\nnov 15 80.4kg", NOW);
  assert.deepEqual(weights.fields, [["weight", "kg"]]);
  assert.deepEqual(weights.rows.map((r) => [String(r.at).slice(0, 10), r.weight]), [["2026-11-01", 81.2], ["2026-11-08", 80.9], ["2026-11-15", 80.4]]);
});

test("inferRows: an amount after a day isn't taken for a year, and a column keeps one unit, setting aside a line in another", () => {
  assert.deepEqual(dateAt(["mar", "3", "1500", "rent"], NOW), { date: "2026-03-03", used: 2 });
  const r = inferRows("coffee $4\ntea ¥1500\njuice $3", NOW);
  assert.deepEqual(r.rows.map((x) => x.amount), [4, 3]);
  assert.deepEqual(r.skipped.map((s) => [s.line, s.why]), [[2, "it is in JPY, and the other lines are in USD"]]);
  assert.ok(r.fields.some(([name, type]) => name === "amount" && type === "USD"));
});

test("the fields read the same lines on the capture line afterwards", () => {
  const r = inferRows(SPEND, NOW);
  const read = parseFields("9.75 food lunch with friends", r.fields, NOW, { name: "spend" });
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.params, { amount: "9.75", category: "food", note: "lunch with friends" });
});

test("readAnswer: the number after =, and the words before it", () => {
  assert.deepEqual(readAnswer("food this week = $62.30"), { value: 62.3, words: ["food", "this", "week"] });
  assert.deepEqual(readAnswer("= 1,310.40"), { value: 1310.4, words: [] });
  assert.match((readAnswer("food 62") as { error: string }).error, /words = number/);
  assert.match((readAnswer("food = lots") as { error: string }).error, /the number you know/);
});

test("findPanels: a known total picks the ask that gives it, the shortest first, and says how the others differ", () => {
  const inferred = inferRows(LIST, NOW);
  const kind = askKindOf("spend", "Spend.md", inferred);
  const groceries = findPanels(kind, inferred.rows, { value: 310.4, words: ["groceries"] }, NOW);
  assert.deepEqual(groceries.candidates.map((c) => c.ask), ["groceries"]);
  const { title: _title, ...keys } = groceries.candidates[0].panel;
  assert.deepEqual(keys, { view: "number", source: "[[Spend]]", where: { category: "groceries" }, field: "amount", agg: "sum" });
  assert.equal(groceries.candidates[0].rows, 3);
  const all = findPanels(kind, inferred.rows, { value: 355.4, words: [] }, NOW);
  assert.equal(all.candidates[0].ask, "");
  assert.ok(all.candidates.every((c) => Math.abs(c.value - 355.4) < 0.005));
  const count = findPanels(kind, inferred.rows, { value: 3, words: ["coffee"] }, NOW);
  assert.deepEqual(count.candidates.map((c) => c.ask), ["count coffee"]);
  const none = findPanels(kind, inferred.rows, { value: 999, words: ["groceries", "in", "march", "roughly"] }, NOW);
  assert.deepEqual(none.candidates, []);
  assert.deepEqual(none.unused, ["march", "roughly"]);
});

test("findPanels: two asks that give the same number are told apart by a row", () => {
  // Rows this month and before: 'this month' and 'last 30 days' can agree on a number and differ on rows.
  const lines = "nov 2 food 10\nnov 18 food 5\noct 25 food 7\noct 1 home 5\nsep 1 food 20";
  const inferred = inferRows(lines, NOW);
  const kind = askKindOf("spend", "Spend.md", inferred);
  const found = findPanels(kind, inferred.rows, { value: 15, words: [] }, NOW);
  assert.equal(found.candidates[0].ask, "this month");
  assert.ok(found.candidates.length >= 1);
  for (const c of found.candidates.slice(1)) assert.ok(c.differs, `${c.ask} says how it differs`);
});

test("the notes: a kind and an app that check out, with the panel kept", () => {
  const inferred = inferRows(SPEND, NOW);
  const kindText = kindNoteText("spend", inferred);
  const kindFm = parseYaml(kindText.split("---")[1]) as Record<string, unknown>;
  assert.deepEqual(kindFm, { kind: "spend", shortcut: "spend", fields: { amount: { type: "number", format: "0,0.00" }, category: ["food", "transport", "fun"], note: "text" } });
  const kind = askKindOf("spend", "Spend.md", inferred);
  const { candidates } = findPanels(kind, inferred.rows, { value: 84.85, words: ["food"] }, NOW);
  const appText = appNoteText("What I spend", "[[Spend]]", [candidates[0].panel]);
  const appFm = parseYaml(appText.split("---")[1]) as Record<string, unknown>;
  const notes = { resolve: (link: string) => (link === "Spend" ? "Spend.md" : undefined), frontmatter: (path: string) => (path === "Spend.md" ? kindFm : undefined) };
  const spec = readSpec(appFm, { path: "Budget.md", notes: notes as never });
  assert.deepEqual(spec!.errors, []);
  assert.deepEqual(spec!.spec!.panels.map((ps) => ps.panel.view), ["form", "number", "table"]);
  assert.equal(exampleNameProblem("spend"), undefined);
  assert.match(exampleNameProblem("my spend")!, /letters, digits and _/);
  assert.equal(exampleNameProblem(" "), "Give the rows a name, e.g. spend");
});

// ---- the window -----------------------------------------------------------------------------------

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 5)); };
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
};

function windowOf(taken: string[] = []) {
  const made: ExamplePlan[] = [];
  const el = document.createElement("div");
  drawExamples(el, { now: () => NOW, taken: (note) => taken.includes(note), make: async (plan) => { made.push(plan); return undefined; }, cancel: () => {} });
  const [name, answer] = [...el.querySelectorAll("input[type=text]")] as HTMLInputElement[];
  return { el, made, lines: el.querySelector("textarea") as HTMLTextAreaElement, name, answer, keep: el.querySelector("button.mod-cta") as HTMLButtonElement };
}

test("the window: says what the lines were read as, and Keep waits for lines and a name", () => {
  const w = windowOf();
  assert.equal(w.keep.disabled, true);
  type(w.lines, LIST);
  assert.equal(w.el.querySelector(".gz-examples-read")!.firstElementChild!.textContent, "Read 7 lines, each with its day: category (one of groceries, coffee, transport), then amount (a number), then note (text).");
  assert.equal(w.keep.disabled, true, "no name yet");
  type(w.name, "my spend");
  assert.match(w.el.querySelector(".gz-new-app-problem")!.textContent!, /letters, digits and _/);
  type(w.name, "spend");
  assert.equal(w.keep.disabled, false);
  assert.equal(w.el.querySelector(".gz-new-app-problem")!.textContent, "");
  assert.equal(w.el.querySelectorAll(".gz-examples-notes pre").length, 2);
});

test("the window: an answer lists the questions that give it, the one picked goes into the app, and Keep hands over the plan", async () => {
  const w = windowOf();
  type(w.lines, LIST);
  type(w.name, "spend");
  type(w.answer, "groceries = 310.40");
  const picks = [...w.el.querySelectorAll(".gz-examples-pick")];
  assert.equal(picks.length, 1);
  assert.match(picks[0].textContent!, /^ \? spend groceries · 3 rows$/);
  assert.match(w.el.querySelectorAll(".gz-examples-notes pre")[1].textContent!, /where: \{category: groceries\}/);
  w.keep.click();
  await settle();
  assert.equal(w.made.length, 1);
  assert.equal(w.made[0].kindNote, "Spend");
  assert.equal(w.made[0].appNote, "Spend log");
  assert.equal(w.made[0].rows.length, 7);
  assert.match(w.made[0].kindText, /^---\nkind: spend\nshortcut: spend\nfields:\n {2}category: \[groceries, coffee, transport\]\n {2}amount: \{type: number, format: "0,0\.00"\}\n {2}note: text\n---\n$/);
});

test("the window: no question gives a wrong number, which is said; a taken name is refused", () => {
  const w = windowOf(["Spend"]);
  type(w.lines, LIST);
  type(w.name, "spend");
  assert.equal(w.keep.disabled, true);
  assert.equal(w.el.querySelector(".gz-new-app-problem")!.textContent, "A note called Spend is already here; give the rows another name");
  type(w.name, "cost");
  type(w.answer, "groceries = 1");
  assert.match(w.el.querySelector(".gz-examples-picks")!.textContent!, /No question over these rows gives 1\./);
  assert.equal(w.keep.disabled, false, "the app can still be kept, with its total");
});

test("the window: a name a kind or a shortcut already has anywhere in the vault is refused, since a capture line couldn't tell the two apart", () => {
  const made: ExamplePlan[] = [];
  const el = document.createElement("div");
  drawExamples(el, { now: () => NOW, taken: () => false, used: (name) => name === "spend", make: async (plan) => { made.push(plan); return undefined; }, cancel: () => {} });
  const [name] = [...el.querySelectorAll("input[type=text]")] as HTMLInputElement[];
  type(el.querySelector("textarea") as HTMLTextAreaElement, LIST);
  type(name, "spend");
  assert.equal(el.querySelector(".gz-new-app-problem")!.textContent, "“spend” already names a kind or a shortcut in this vault, so a capture line couldn't tell them apart; give the rows another name");
  assert.equal((el.querySelector("button.mod-cta") as HTMLButtonElement).disabled, true);
  type(name, "cost");
  assert.equal((el.querySelector("button.mod-cta") as HTMLButtonElement).disabled, false);
});

test("planOf: with no answer the app totals the first number; with no number it counts", () => {
  const acts = { now: () => NOW, taken: () => false, make: async () => undefined, cancel: () => {} };
  assert.match(planOf(SPEND, "spend", "", 0, acts).plan!.appText, /title: Total amount\n {4}source: "\[\[Spend\]\]"\n {4}field: amount\n {4}agg: sum/);
  assert.match(planOf("call mum\ncall bank\nwrite to sam\ncall bank again", "todo", "", 0, acts).plan!.appText, /agg: count/);
  assert.equal(readWords(planOf("", "x", "", 0, acts).inferred), "No line could be read yet.");
});
