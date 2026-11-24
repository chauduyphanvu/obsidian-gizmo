import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { parseFields } from "../src/capture.ts";
import { display } from "../src/format.ts";
import { formulaUnit } from "../src/formula.ts";
import { readFields } from "../src/keys.ts";
import { formRow } from "../src/links.ts";
import { readSpec } from "../src/spec.ts";
import { convert, quantityIn, unitDef, unitFormat, unitOf } from "../src/units.ts";
import { addLine, underLine, typeLine } from "./support/addline.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 20, 19, 42);

// ---- units ----------------------------------------------------------------------------------------

test("units: measures and money are known in any case; other words aren't units", () => {
  assert.deepEqual(unitDef("kg"), { id: "kg", dim: "mass", factor: 1 });
  assert.equal(unitDef("MMHG")?.id, "mmHg");
  assert.deepEqual(unitDef("usd"), { id: "USD", dim: "money" });
  assert.equal(unitDef("text"), undefined);
  assert.equal(unitDef("number"), undefined);
  assert.equal(unitDef("steps"), undefined);
  assert.deepEqual(unitOf("steps"), { id: "steps", dim: "steps" }, "a unit of the note's own measures only itself");
});

test("units: money shows as its code is written, with its own decimals; a measure as the number then the unit", () => {
  assert.equal(unitFormat("USD"), "$0,0.00");
  assert.equal(unitFormat("JPY"), "¥0,0");
  assert.equal(unitFormat("EUR"), "€0,0.00");
  assert.equal(unitFormat("CHF"), "0,0.00 CHF");
  assert.equal(unitFormat("kg"), "unit:kg");
  assert.equal(display({ format: { w: "unit:kg" } }, "w", 81.2, NOW), "81.2 kg");
  assert.equal(display({ format: { a: unitFormat("JPY") } }, "a", 1500, NOW), "¥1,500");
});

test("units: a measure converts by its size, money by the field's rate, and nothing across measures", () => {
  assert.deepEqual(convert(180, unitDef("lb")!, { unit: "kg" }), { value: 81.647 });
  assert.deepEqual(convert(90, unitDef("min")!, { unit: "h" }), { value: 1.5 });
  assert.deepEqual(convert(1500, unitDef("JPY")!, { unit: "USD", rates: { JPY: 150 } }), { value: 10, rate: 150 });
  assert.deepEqual(convert(1000, unitDef("USD")!, { unit: "JPY", rates: { USD: 0.0066 } }), { value: 151515, rate: 0.0066 }, "yen keep no decimals");
  assert.deepEqual(convert(5, unitDef("kg")!, { unit: "USD" }), { error: "is in USD, and kg measures something else" });
  assert.deepEqual(convert(5, unitDef("EUR")!, { unit: "USD", rates: { JPY: 150 } }), { error: "is in USD, and has no rate for EUR; add rates: {EUR: …} to the field" });
  assert.deepEqual(quantityIn("1500jpy"), { n: 1500, unit: { id: "JPY", dim: "money" } });
  assert.equal(quantityIn("13O"), undefined);
});

// ---- fields ---------------------------------------------------------------------------------------

test("fields: a unit as a type is a number field with that unit and its format", () => {
  const r = readFields({ amount: "USD", weight: "kg", steps: { type: "number", unit: "steps" }, paid: { type: "JPY", label: "Paid" }, note: "text" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.types, { amount: "number", weight: "number", steps: "number", paid: "number", note: "text" });
  assert.deepEqual(r.info, {
    amount: { unit: "USD", format: "$0,0.00" },
    weight: { unit: "kg", format: "unit:kg" },
    steps: { unit: "steps", format: "unit:steps" },
    paid: { label: "Paid", unit: "JPY", format: "¥0,0" },
  });
});

test("fields: a format the field gives wins over the unit's; rates need a money unit", () => {
  const r = readFields({
    amount: { type: "USD", format: "$0", rates: { jpy: 150.2 } },
    weight: { type: "kg", rates: { lb: 2 } },
    name: { type: "text", unit: "kg" },
    both: { type: "kg", unit: "lb" },
    bad: { type: "USD", rates: { JPY: 0 } },
  });
  assert.deepEqual(r.info.amount, { format: "$0", unit: "USD", rates: { JPY: 150.2 } });
  assert.deepEqual(r.errors, [
    'field "weight" rates needs a money unit, e.g. unit: USD',
    'field "name" has a unit, so its type must be number',
    'field "both" has a unit as its type and a unit key; give one',
    'field "bad" rates must give a number above 0 for each currency, e.g. rates: {JPY: 150.2}',
  ]);
});

test("fields: a unit that depends on another field is kept as that field and its units", () => {
  const r = readFields({ what: ["weight", "systolic", "sleep"], value: { type: "number", unit: { what: { weight: "kg", systolic: "mmhg", sleep: "h" } } } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.info.value, { unitBy: { field: "what", units: { weight: "kg", systolic: "mmHg", sleep: "h" } } });
  assert.match(readFields({ v: { type: "number", unit: { a: "kg", b: "lb" } } }).errors[0], /unit must be a unit, or one field with the unit for each of its values/);
});

// ---- the capture line -----------------------------------------------------------------------------

const FIELDS: [string, string | string[]][] = [["amount", "number"], ["category", ["food", "home"]], ["note", "text"]];
const UNITS = { amount: { unit: "USD", rates: { JPY: 150 } } };

test("capture: a value typed with another currency is converted at the field's rate, and what was typed is kept", () => {
  const r = parseFields("1500 jpy food ramen", FIELDS, NOW, { name: "spend", units: UNITS });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.params, { amount: "10", amount_as: "1500 JPY @150", category: "food", note: "ramen" });
  assert.deepEqual(parseFields("1500jpy food ramen", FIELDS, NOW, { name: "spend", units: UNITS }).params, r.params);
  assert.deepEqual(parseFields("food ramen amount=1500jpy", FIELDS, NOW, { name: "spend", units: UNITS, loose: true }).params.amount, "10");
});

test("capture: the field's own unit, or none, is the number as typed; a unit with no rate is told", () => {
  assert.deepEqual(parseFields("14.5 usd food lunch", FIELDS, NOW, { name: "spend", units: UNITS }).params, { amount: "14.5", category: "food", note: "lunch" });
  assert.deepEqual(parseFields("14.5 food lunch", FIELDS, NOW, { name: "spend", units: UNITS }).params, { amount: "14.5", category: "food", note: "lunch" });
  assert.deepEqual(parseFields("12 eur food lunch", FIELDS, NOW, { name: "spend", units: UNITS }).errors, ["amount is in USD, and has no rate for EUR; add rates: {EUR: …} to the field"]);
});

test("capture: a unit no field measures stays a word; a field with no unit reads as it always did", () => {
  const r = parseFields("14.5 food 3 kg of rice", FIELDS, NOW, { name: "spend", units: UNITS });
  assert.deepEqual(r.params, { amount: "14.5", category: "food", note: "3 kg of rice" });
  assert.deepEqual(parseFields("12 food kg", FIELDS, NOW, { name: "spend" }).params, { amount: "12", category: "food", note: "kg" });
});

test("capture: a measure converts by its size", () => {
  const r = parseFields("180 lb", [["weight", "number"]], NOW, { name: "weigh", units: { weight: { unit: "kg" } } });
  assert.deepEqual(r.params, { weight: "81.647", weight_as: "180 lb" });
});

test("capture: a plain number keeps its field from a quantity after it, unless another number field can take it", () => {
  const weigh = parseFields("81.2 lifted 10kg", [["weight", "number"], ["note", "text"]], NOW, { name: "weigh", units: { weight: { unit: "kg" } } });
  assert.deepEqual(weigh.params, { weight: "81.2", note: "lifted 10kg" });
  const run = parseFields("2 5km", [["distance", "number"], ["laps", "number"]], NOW, { name: "run", units: { distance: { unit: "km" } } });
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.params, { distance: "5", laps: "2" });
});

test("a form's row keeps what a converted value was typed as, beside it", () => {
  const info = { amount: { unit: "USD", rates: { JPY: 150 } } };
  assert.deepEqual(formRow({ amount: "number", note: "text" }, info, { amount: "10", amount_as: "1500 JPY @150", note: "ramen" }, NOW), { row: { amount: 10, amount_as: "1500 JPY @150", note: "ramen" } });
  assert.deepEqual(formRow({ amount: "number" }, {}, { amount: "10", amount_as: "x" }, NOW), { row: { amount: 10 } }, "only a field with a unit keeps it");
  const byRow = { value: { unitBy: { field: "what", units: { weight: "kg" } } } };
  assert.deepEqual(formRow({ what: ["weight"], value: "number" }, byRow, { what: "weight", value: "81.647", value_as: "180 lb" }, NOW), { row: { what: "weight", value: 81.647, value_as: "180 lb" } }, "a unit that another field gives counts");
});

// ---- formulas -------------------------------------------------------------------------------------

test("formulas: units go through sums and products, and two that differ don't add or compare", () => {
  const units: Record<string, string> = { amount: "USD", local: "JPY", shares: "", price: "USD", weight: "kg" };
  const of = (f: string) => units[f] || undefined;
  assert.deepEqual(formulaUnit("amount + 5", of), { unit: "USD" });
  assert.deepEqual(formulaUnit("shares * price", of), { unit: "USD" });
  assert.deepEqual(formulaUnit("round(amount / 3, 2)", of), { unit: "USD" });
  assert.deepEqual(formulaUnit("amount / price", of), {}, "a ratio is a plain number");
  assert.deepEqual(formulaUnit("amount * $this.rate", of), {}, "dollars times a rate of the note's aren't dollars");
  assert.deepEqual(formulaUnit("round(amount / $rate, 2)", of), {});
  assert.deepEqual(formulaUnit("amount + $this.fee", of), { unit: "USD" });
  assert.deepEqual(formulaUnit("amount + local", of), { error: "can't add USD and JPY" });
  assert.deepEqual(formulaUnit("if(amount > weight, 1, 0)", of), { error: "can't compare USD and kg" });
  assert.deepEqual(formulaUnit("max(amount, local)", of), { error: "can't take the max of USD and JPY" });
  assert.deepEqual(formulaUnit("if(shares > 0, amount, price)", of), { unit: "USD" });
});

// ---- in an app ------------------------------------------------------------------------------------

const KIND = "Kinds/Spend.md";
const DATA = "Kinds/Spend data.md";
const APP = "Apps/Trip.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/[  ]/g, " ");
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

function open(notes: Record<string, { fm: Record<string, unknown> }>, path: string) {
  const t = fakeEnv(notes);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, t.env);
  started.push(c);
  c.load();
  return { ...t, root };
}

const SPEND = { kind: "spend", fields: { amount: { type: "USD", rates: { JPY: 150 } }, category: ["food", "home"], note: "text" } };

test("in an app: a line in yen saves dollars at the rate, the row keeps both, and the figure shows as money", async () => {
  const t = open({
    [KIND]: { fm: SPEND },
    [APP]: { fm: { app: "Trip", panels: [
      { view: "form", title: "Spent", save: "[[Spend]]" },
      { view: "number", title: "Total", source: "[[Spend]]", field: "amount", agg: "sum" },
    ] } },
  }, APP);
  await settle();
  typeLine(t.root, "1500 jpy food ramen");
  assert.match(underLine(t.root), /10/);
  addLine(t.root, "1500 jpy food ramen");
  await settle();
  const rows = listsIn(t.f.files.get(DATA)?.fm)!.spend as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 10);
  assert.equal(rows[0].amount_as, "1500 JPY @150");
  assert.equal(text(t.root.querySelector(".gz-view-number .gz-big")), "$10.00");
});

test("in an app: a formula that adds two units is refused at its line; a product of a unit shows in it", () => {
  const notes = { read: () => undefined, resolve: () => undefined, frontmatter: () => undefined };
  const bad = readSpec({ app: "x", data: { buys: { source: "buys", fields: { shares: "number", price: "USD", fee: "EUR" } } }, panels: [
    { view: "table", source: "buys", compute: { cost: "shares * price + fee" } },
  ] }, { path: "A.md", notes: notes as never });
  assert.deepEqual(bad!.errors, ["panel 1: compute.cost: can't add USD and EUR"]);
  const good = readSpec({ app: "x", data: { buys: { source: "buys", fields: { shares: "number", price: "USD" } } }, panels: [
    { view: "number", source: "buys", compute: { cost: "shares * price" }, field: "cost", agg: "sum" },
  ] }, { path: "A.md", notes: notes as never });
  assert.deepEqual(good!.errors, []);
  assert.deepEqual(good!.spec!.panels[0].panel.format, { cost: "$0,0.00", price: "$0,0.00" });
});

const MEASURE = { source: "m", fields: { what: ["weight", "systolic", "sleep"], value: { type: "number", unit: { what: { weight: "kg", systolic: "mmHg", sleep: "h" } } } } };

test("in an app: an average over rows in different units is refused; pinned to one, it shows in that unit", () => {
  const notes = { read: () => undefined, resolve: () => undefined, frontmatter: () => undefined };
  const spec = (panel: Record<string, unknown>) => readSpec({ app: "x", data: { m: MEASURE }, panels: [panel] }, { path: "A.md", notes: notes as never })!;
  assert.deepEqual(spec({ view: "number", source: "m", field: "value", agg: "avg" }).errors, [
    "panel 1: the avg of value would mix kg, mmHg, h: the unit of value depends on what; add where: {what: weight}, or group: what",
  ]);
  assert.deepEqual(spec({ view: "line", source: "m", x: "at", y: "value" }).errors, [
    "panel 1: a chart of value would mix kg, mmHg, h: the unit of value depends on what; add where: {what: weight}, or group: what",
  ]);
  const pinned = spec({ view: "number", source: "m", field: "value", agg: "avg", where: { what: "weight" } });
  assert.deepEqual(pinned.errors, []);
  assert.deepEqual(pinned.spec!.panels[0].panel.format, { value: "unit:kg" });
  assert.deepEqual(spec({ view: "number", source: "m", agg: "count" }).errors, [], "a count mixes nothing");
  assert.deepEqual(spec({ view: "table", source: "m" }).errors, [], "a table shows each row as it is");
});

test("a quantity for a field whose unit another field gives is converted once that field is read", () => {
  const fields: [string, string | string[]][] = [["what", ["weight", "systolic", "pulse"]], ["value", "number"], ["note", "text"]];
  const units = { value: { by: "what", units: { weight: "kg", systolic: "mmHg" } } };
  const read = (line: string) => parseFields(line, fields, NOW, { name: "measure", units });
  assert.deepEqual(read("weight 180 lb").params, { what: "weight", value: "81.647", value_as: "180 lb" });
  assert.deepEqual(read("weight 81.2kg after a run").params, { what: "weight", value: "81.2", note: "after a run" });
  assert.deepEqual(read("weight 81.2").params, { what: "weight", value: "81.2" });
  assert.deepEqual(read("systolic 180 lb").errors, ["value is in mmHg, and lb measures something else"]);
  assert.deepEqual(read("pulse 60 kg").errors, ["value has no unit when what is pulse; type the number alone"]);
  assert.deepEqual(parseFields("180 lb", fields, NOW, { name: "measure", units, loose: true }).errors, ["value is typed in lb; say which what it is"]);
});

test("a small quantity converted into a large unit keeps its size", () => {
  assert.deepEqual(convert(5, unitDef("in")!, { unit: "km" }), { value: 0.000127 });
  assert.deepEqual(convert(500, unitDef("mg")!, { unit: "kg" }), { value: 0.0005 });
  assert.deepEqual(convert(0.5, unitDef("lb")!, { unit: "kg" }), { value: 0.2268 });
});

test("capture: `in` is inches when joined or at the end of the line; in a sentence it is a word", () => {
  const fields: [string, string][] = [["distance", "number"], ["note", "text"]];
  const read = (line: string) => parseFields(line, fields, NOW, { name: "move", units: { distance: { unit: "km" } } }).params;
  assert.deepEqual(read("5 in the park"), { distance: "5", note: "in the park" });
  assert.deepEqual(read("5 in"), { distance: "0.000127", distance_as: "5 in" });
  assert.deepEqual(read("5in the park"), { distance: "0.000127", distance_as: "5 in", note: "the park" });
});

test("capture: a currency code that is also a word says how to keep it as a word", () => {
  const loose = (line: string) => parseFields(line, FIELDS, NOW, { name: "spend", units: UNITS, loose: true });
  assert.deepEqual(loose("20 try tacos").errors, ['amount is in USD, and has no rate for TRY; add rates: {TRY: …} to the field, or put the words in quotes if "try" isn\'t money']);
  const quoted = loose('20 "try tacos"');
  assert.deepEqual(quoted.errors, []);
  assert.deepEqual([quoted.params.amount, quoted.params.note], ["20", "try tacos"]);
});

const BY_ROW = { kind: "measure", fields: { what: ["weight", "sleep"], value: { type: "number", unit: { what: { weight: "kg", sleep: "h" } } }, note: "text" } };
const MEASURE_KIND = "Kinds/Measure.md";
const MEASURE_DATA = "Kinds/Measure data.md";

function vitals(table = false) {
  return open({
    [MEASURE_KIND]: { fm: BY_ROW },
    [APP]: { fm: { app: "Vitals", panels: [
      { view: "form", title: "Measured", save: "[[Measure]]" },
      ...(table ? [{ view: "table", source: "[[Measure]]", columns: ["what", "value", "value_as"], edit: ["what", "value"] }] : []),
    ] } },
  }, APP);
}
const pickChip = (root: Element, label: string) => ([...root.querySelectorAll(".gz-addline-under .gz-chip")].find((c) => c.textContent === label) as HTMLElement).click();
const canSave = (root: Element) => !(root.querySelector(".gz-addline-go") as HTMLButtonElement).disabled;
const measured = (t: ReturnType<typeof vitals>) => (listsIn(t.f.files.get(MEASURE_DATA)?.fm)?.measure ?? []) as Record<string, unknown>[];

test("an add line: a chip that makes the value another measure refuses it", async () => {
  const t = vitals();
  await settle();
  typeLine(t.root, "weight 177 lb");
  assert.equal(canSave(t.root), true);
  pickChip(t.root, "sleep");
  assert.match(underLine(t.root), /value is in h, and lb measures something else/);
  assert.equal(canSave(t.root), false);
});

test("an add line: a quantity typed first is converted once a chip says what it is", async () => {
  const t = vitals();
  await settle();
  typeLine(t.root, "177 lb");
  assert.equal(canSave(t.root), false);
  pickChip(t.root, "weight");
  assert.equal(canSave(t.root), true);
  t.root.querySelector(".gz-addline")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(measured(t).map((r) => [r.what, r.value, r.value_as]), [["weight", 80.286, "177 lb"]]);
});

test("a table's day heading doesn't average rows in different units, even when the field that says so isn't shown", async () => {
  const dayHeading = async (lines: string[]) => {
    const t = open({
      [MEASURE_KIND]: { fm: BY_ROW },
      [APP]: { fm: { app: "Vitals", panels: [
        { view: "form", title: "Measured", save: "[[Measure]]" },
        { view: "table", source: "[[Measure]]", sort: "-at", columns: ["at", "value"] },
      ] } },
    }, APP);
    await settle();
    for (const line of lines) {
      addLine(t.root, line);
      await settle();
    }
    return text(t.root.querySelector("table"));
  };
  assert.doesNotMatch(await dayHeading(["weight 80", "sleep 7"]), /avg/);
  assert.match(await dayHeading(["weight 80", "weight 82"]), /avg 81/);
});

test("in an app: a table edit of a converted number, or of what gives its unit, drops what it was typed as", async () => {
  for (const [column, value, expected] of [[1, "81", { what: "weight", value: 81 }], [0, "sleep", { what: "sleep", value: 80.286 }]] as const) {
    const t = vitals(true);
    await settle();
    addLine(t.root, "weight 177 lb");
    await settle();
    const cell = t.root.querySelectorAll("tbody .gz-edit")[column] as HTMLInputElement;
    if (cell.tagName === "SELECT") for (const o of cell.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === value);
    else cell.value = value;
    cell.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    const [row] = measured(t);
    assert.deepEqual({ what: row.what, value: row.value }, expected);
    assert.equal(Object.hasOwn(row, "value_as"), false);
  }
});
