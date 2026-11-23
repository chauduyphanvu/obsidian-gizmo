import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { DefinitionLog } from "../src/definitions.ts";
import { explain, rowWords, waterfall } from "../src/explain.ts";
import { drawExplain, howWords, type ExplainSource } from "../src/explain-view.ts";
import { ROW_ID } from "../src/ledger-store.ts";
import { knobsOf, readTarget, solve, type Knob } from "../src/pull.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { addLine } from "./support/addline.ts";
import { fakeEnv } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 20, 19, 42);
const DAY = 86_400_000;

function panel(keys: Record<string, unknown>, internal: Partial<Panel> = {}): Panel {
  const { panel: p, errors } = checkPanel(keys, true, internal);
  assert.deepEqual(errors, []);
  return p as Panel;
}

/** Rows as a saved list hands them out: each with its id. */
function saved(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r, i) => Object.defineProperty({ ...r }, ROW_ID, { value: `r${i + 1}` }));
}

const SPEND = saved([
  { at: "2026-11-03T09:00", amount: 700, category: "home", note: "rent" },
  { at: "2026-11-19T10:00", amount: 62.1, category: "food", note: "groceries" },
  { at: "2026-11-19T12:00", amount: 12, category: "food", note: "lunch" },
  { at: "2026-10-25T12:00", amount: 900, category: "travel", note: "flight" },
  { at: "2026-11-20T08:00", category: "food", note: "no amount" },
]);

const MONTH = { view: "number", title: "Spent this month", source: "spend", field: "amount", agg: "sum", where: { at: "this month" }, format: "$0,0.00" };

// ---- explain --------------------------------------------------------------------------------------

test("explain: a sum names the rows the panel's own steps kept, each with what it adds, and counts those with no number", () => {
  const e = explain(panel(MONTH), SPEND, NOW)!;
  assert.equal(e.value, 774.1);
  assert.equal(e.additive, true);
  assert.deepEqual(e.parts.map((x) => [x.id, x.adds]), [["r1", 700], ["r2", 62.1], ["r3", 12]]);
  assert.equal(e.left, 1);
  assert.equal(howWords(e), "The sum of amount over 3 rows. 1 row with no number in amount is left out.");
});

test("explain: a count adds 1 a row; an average and a last aren't sums of their rows", () => {
  const count = explain(panel({ view: "number", source: "spend", where: { category: "food" } }), SPEND, NOW)!;
  assert.equal(count.value, 3);
  assert.deepEqual(count.parts.map((x) => x.adds), [1, 1, 1]);
  assert.equal(howWords(count), "The count of 3 rows.");
  const avg = explain(panel({ view: "number", source: "spend", field: "amount", agg: "avg", where: { category: "food" } }), SPEND, NOW)!;
  assert.equal(avg.additive, false);
  assert.equal(avg.parts.length, 2);
  assert.equal(howWords(avg), "The average of amount over 2 rows. 1 row with no number in amount is left out.");
  const last = explain(panel({ view: "number", source: "spend", field: "note" }), SPEND, NOW)!;
  assert.deepEqual(last.parts.map((x) => x.id), ["r5"]);
  assert.equal(howWords(last), "The note of the last row.");
});

test("explain: a share says which rows match; a streak and a table have no one figure", () => {
  const share = explain(panel({ view: "number", source: "spend", agg: "share", of: { category: "food" } }), SPEND, NOW)!;
  assert.equal(howWords(share), "3 of 5 rows match.");
  assert.equal(explain(panel({ view: "number", source: "spend", group: "at", per: "day", agg: "streak" }), SPEND, NOW), undefined);
  assert.equal(explain(panel({ view: "table", source: "spend" }), SPEND, NOW), undefined);
});

test("explain: with compare, the rows are the current window's; a value read from an answer has no rows", () => {
  const e = explain(panel({ ...MONTH, compare: "previous" }), SPEND, NOW)!;
  assert.deepEqual(e.parts.map((x) => x.id), ["r1", "r2", "r3"]);
  const direct = explain(panel({ view: "number", source: "https://api.example.com/now", pick: "current", field: "t" }), { current: { t: 7 } }, NOW)!;
  assert.equal(direct.value, 7);
  assert.equal(direct.parts.length, 0);
  assert.match(direct.direct!, /read as it is/);
});

test("explain: rows without ids are told apart by what they hold, twins included", () => {
  const rows = [{ amount: 5, note: "a" }, { amount: 5, note: "a" }, { amount: 7, note: "b" }];
  const e = explain(panel({ view: "number", source: "x", field: "amount", agg: "sum" }), rows, NOW)!;
  assert.equal(new Set(e.parts.map((x) => x.key)).size, 3);
});

test("rowWords: the fields in the schema's order, without the figure's own field or the time", () => {
  const show = (_f: string, v: unknown) => String(v);
  assert.equal(rowWords(SPEND[1], show, ["note", "category"], "amount"), "groceries · food");
  assert.equal(rowWords({ at: "x", line: "planned", amount: 4 }, show), "4");
});

// ---- waterfall ------------------------------------------------------------------------------------

test("waterfall: rows that came, went and changed, the largest move first, with what each did to a sum", () => {
  const p = panel(MONTH);
  const before = explain(p, SPEND, NOW)!;
  const later = saved([
    { at: "2026-11-03T09:00", amount: 700, category: "home", note: "rent" },
    { at: "2026-11-19T10:00", amount: 80, category: "food", note: "groceries" },
  ]);
  Object.defineProperty(later[1], ROW_ID, { value: "r2" });
  const added = Object.defineProperty({ at: "2026-11-20T18:00", amount: 300, category: "travel", note: "train" }, ROW_ID, { value: "r9" });
  const w = waterfall(before, explain(p, [...later, added], NOW)!);
  assert.equal(w.before, 774.1);
  assert.equal(w.after, 1080);
  assert.ok(Math.abs(w.delta! - 305.9) < 1e-9);
  assert.deepEqual(w.moves.map((m) => [m.kind, m.id, Math.round((m.delta ?? 0) * 100) / 100]), [["added", "r9", 300], ["changed", "r2", 17.9], ["removed", "r3", -12]]);
  assert.equal(w.same, 1);
  assert.equal(w.moves.reduce((s, m) => s + (m.delta ?? 0), 0).toFixed(2), w.delta!.toFixed(2), "the moves add up to the change");
});

test("waterfall: where the figure isn't a sum, the moves carry no amounts", () => {
  const p = panel({ view: "number", source: "spend", field: "amount", agg: "avg" });
  const w = waterfall(explain(p, SPEND.slice(0, 2), NOW)!, explain(p, SPEND.slice(0, 3), NOW)!);
  assert.equal(w.additive, false);
  assert.deepEqual(w.moves.map((m) => [m.kind, m.delta]), [["added", undefined]]);
});

// ---- pull -----------------------------------------------------------------------------------------

const PLANS = saved([
  { at: "2026-11-03T09:00", amount: 700, note: "rent" },
  { at: "2026-11-28T19:00", amount: 160, note: "dinner out", line: "planned" },
  { at: "2026-11-29T10:00", amount: 90, note: "groceries", line: "planned" },
]);
const LANDS = { view: "number", title: "The month lands at", source: "spend", field: "amount", agg: "sum" };

test("pull: the knobs are the number fields of planned rows behind the figure; logged rows aren't offered", () => {
  const knobs = knobsOf(panel(LANDS), PLANS, NOW);
  assert.deepEqual(knobs.map((k) => (k.kind === "row" ? [k.id, k.field, k.value] : k.name)), [["r2", "amount", 160], ["r3", "amount", 90]]);
});

test("pull: a sum is solved in one step, to the cent", () => {
  const p = panel(LANDS);
  const [dinner] = knobsOf(p, PLANS, NOW);
  assert.deepEqual(solve(p, PLANS, NOW, dinner, 810), { value: 20 });
  assert.deepEqual(solve(p, PLANS, NOW, dinner, 950), { value: 160 }, "already there");
});

test("pull: an average is a straight line too; a least that can't land on the target says so", () => {
  const avg = panel({ ...LANDS, agg: "avg" });
  const [dinner] = knobsOf(avg, PLANS, NOW);
  const s = solve(avg, PLANS, NOW, dinner, 300);
  assert.ok("value" in s && Math.abs(s.value - 110) < 1e-9);
  const min = panel({ ...LANDS, agg: "min" });
  const knob: Knob = { kind: "row", id: "r2", field: "amount", row: PLANS[1], value: 160, whatIf: false };
  assert.deepEqual(solve(min, PLANS, NOW, knob, 500), { none: "no value gets the figure there" });
  const down = solve(min, PLANS, NOW, knob, 50);
  assert.ok("value" in down && Math.abs(down.value - 50) < 0.005, "below the others, the row is the least");
});

test("pull: a property a formula reads as $this is a knob, solved through the formula", () => {
  const vars = { this: { rate: 150, limit: 2500 } };
  const p = panel({ view: "number", source: "spend", field: "usd", agg: "sum", compute: { usd: "amount / $this.rate" } }, { vars });
  const knobs = knobsOf(p, PLANS.slice(0, 1), NOW);
  assert.deepEqual(knobs, [{ kind: "property", name: "rate", value: 150 }]);
  const s = solve(p, PLANS.slice(0, 1), NOW, knobs[0], 5);
  assert.ok("value" in s && Math.abs(s.value - 140) < 1e-6, "700 / 140 = 5, found by closing in, as 1/x is no straight line");
});

// ---- the window -----------------------------------------------------------------------------------

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/[  ]/g, " ");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };

function sourceOf(p: Panel, rows: Record<string, unknown>[], more: Partial<ExplainSource> = {}): ExplainSource {
  return {
    panel: p, now: NOW,
    shown: async () => explain(p, rows, NOW),
    at: async () => explain(p, rows.slice(0, 1), NOW),
    since: async () => waterfall(explain(p, rows.slice(0, 1), NOW)!, explain(p, rows, NOW)!),
    origins: async () => new Map([["r2", { at: new Date(2026, 10, 19, 10, 1).getTime(), device: "d1", sets: 1 }]]),
    deviceName: (id) => (id === "d1" ? "Mac" : undefined),
    ...more,
  };
}

test("the window: the figure, how it is worked out, and its rows with where each came from", async () => {
  const el = document.createElement("div");
  await drawExplain(el, sourceOf(panel(MONTH), SPEND));
  assert.equal(text(el.querySelector(".gz-explain-head .gz-big")), "$774.10");
  assert.equal(text(el.querySelector(".gz-explain-how")), "The sum of amount over 3 rows. 1 row with no number in amount is left out.");
  const rows = [...el.querySelectorAll(".gz-explain-row")];
  assert.deepEqual(rows.map((r) => text(r.querySelector(".gz-explain-adds"))), ["$700.00", "$62.10", "$12.00"]);
  assert.match(text(rows[1].querySelector(".gz-explain-origin")), /written Thu Nov 19, 10:01 on Mac · changed once since/);
  assert.equal(el.querySelector(".gz-explain-pull")!.childElementCount, 0, "nothing to pull by");
});

test("the window: two rows the same on one day are marked, and Delete takes one out with Undo", async () => {
  const twins = saved([
    { at: "2026-11-19T10:00", amount: 17.99, note: "STREAMFLIX" },
    { at: "2026-11-19T10:00", amount: 17.99, note: "STREAMFLIX" },
    { at: "2026-11-19T12:00", amount: 12, note: "lunch" },
  ]);
  const removed: string[] = [];
  const el = document.createElement("div");
  const p = panel({ view: "number", source: "spend", field: "amount", agg: "sum", format: "$0,0.00" });
  await drawExplain(el, sourceOf(p, twins, {
    shown: async () => explain(p, twins.filter((r) => !removed.includes((r as Record<symbol, string>)[ROW_ID])), NOW),
    remove: async (part) => {
      removed.push(part.id!);
      return { text: "Deleted the row.", undo: async () => { removed.length = 0; return "Put back"; } };
    },
  }));
  assert.equal(el.querySelectorAll(".gz-explain-twin").length, 2);
  assert.match(text(el.querySelector(".gz-explain-twin .gz-explain-origin")), /the same as another row here/);
  (el.querySelector(".gz-explain-twin button") as HTMLElement).click();
  await settle();
  assert.equal(text(el.querySelector(".gz-explain-head .gz-big")), "$29.99");
  assert.equal(text(el.querySelector(".gz-explain-said span")), "Deleted the row.");
  (el.querySelector(".gz-explain-said button") as HTMLElement).click();
  await settle();
  assert.equal(text(el.querySelector(".gz-explain-head .gz-big")), "$47.98");
  assert.equal(text(el.querySelector(".gz-explain-said span")), "Put back");
});

test("the window: a time to compare with gives what moved the figure since", async () => {
  const el = document.createElement("div");
  await drawExplain(el, sourceOf(panel(MONTH), SPEND));
  ([...el.querySelectorAll(".gz-explain-bar button")].find((b) => text(b) === "A week ago") as HTMLElement).click();
  await settle();
  const fall = el.querySelector(".gz-explain-waterfall")!;
  assert.match(text(fall.querySelector(".gz-explain-then")), /^\$700\.00 on Fri Nov 13, 19:42 → \$774\.10 now: \$74\.10 more$/);
  assert.deepEqual([...fall.querySelectorAll(".gz-explain-move")].map((m) => text(m)), [
    "+$62.10Added · Nov 19, 10:00 · food · groceries",
    "+$12.00Added · Nov 19, 12:00 · food · lunch",
  ]);
  assert.equal(text(fall.querySelector(".gz-explain-same")), "1 row is the same.");
});

test("the window: a target solves each knob, and Keep sets it", async () => {
  const p = panel({ ...LANDS, format: "$0,0.00" });
  const rows = PLANS.map((r) => Object.defineProperty({ ...r }, ROW_ID, { value: (r as Record<symbol, string>)[ROW_ID] }));
  const kept: [string, number][] = [];
  const el = document.createElement("div");
  await drawExplain(el, sourceOf(p, rows, {
    pull: {
      knobs: async () => knobsOf(p, rows, NOW),
      solve: async (k, target) => solve(p, rows, NOW, k, target),
      keep: async (k, value) => {
        if (k.kind === "row") {
          kept.push([k.id, value]);
          rows.find((r) => (r as Record<symbol, string>)[ROW_ID] === k.id)!.amount = value;
        }
        return { text: "Set amount to 20" };
      },
    },
  }));
  const form = el.querySelector(".gz-explain-pull form")!;
  (form.querySelector("input") as HTMLInputElement).value = "$810";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const knobs = [...el.querySelectorAll(".gz-explain-knob")];
  assert.equal(knobs.length, 2);
  assert.match(text(knobs[0]), /amount of the planned row Nov 28, 19:00 · dinner out/);
  assert.equal(text(knobs[0].querySelector(".gz-explain-origin")), "$160.00 → $20.00");
  assert.equal(text(knobs[1].querySelector(".gz-explain-origin")), "$90.00 → −$50.00".replace("−", "-"));
  (knobs[0].querySelector("button") as HTMLElement).click();
  await settle();
  assert.deepEqual(kept, [["r2", 20]]);
  assert.equal(text(el.querySelector(".gz-explain-head .gz-big")), "$810.00");
});

// ---- in an app ------------------------------------------------------------------------------------

const KIND = "Kinds/Spend.md";
const BUDGET = "Apps/Budget.md";
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

function budget() {
  const t = fakeEnv({
    [KIND]: { fm: { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home"], memo: "text" } } },
    [BUDGET]: { fm: { app: "What I spend", panels: [
      { view: "form", title: "Spent", save: "[[Spend]]" },
      { view: "number", title: "Lands at", source: "[[Spend]]", lines: ["logged", "planned"], field: "amount", agg: "sum" },
    ] } },
  });
  const opened: ExplainSource[] = [];
  t.env.explain = (src) => { opened.push(src); };
  t.env.undo = async () => "Undone";
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, BUDGET, t.env);
  started.push(c);
  c.load();
  return { ...t, root, c, opened };
}

test("in an app: a figure opens its window, with the rows a save added and what moved it since before", async () => {
  const t = budget();
  await settle();
  addLine(t.root, "12 food lunch");
  await settle();
  t.f.advance(DAY);
  const mid = t.f.host.now();
  t.f.advance(DAY);
  addLine(t.root, "30 home lamp");
  await settle();
  const fig = t.root.querySelector(".gz-explainable") as HTMLElement;
  assert.ok(fig, "the figure can be asked");
  assert.equal(fig.getAttribute("role"), "button");
  fig.click();
  const src = t.opened[0];
  const e = (await src.shown())!;
  assert.equal(e.value, 42);
  assert.deepEqual(e.parts.map((x) => x.adds), [12, 30]);
  const origins = await src.origins();
  assert.deepEqual(e.parts.map((x) => origins.get(x.id!)?.device), ["d1mac000", "d1mac000"]);
  const w = (await src.since(mid))!;
  assert.equal(w.before, 12);
  assert.deepEqual(w.moves.map((m) => [m.kind, m.delta]), [["added", 30]]);
  assert.ok(t.c.explainFirst(), "= asks the first figure");
  assert.equal(t.opened.length, 2);
});

test("in an app: Delete from the window takes the row out of the kind; pulling sets a planned row", async () => {
  const t = budget();
  await settle();
  addLine(t.root, "12 food lunch");
  await settle();
  addLine(t.root, "160 food dinner @2026-12-01");
  await settle();
  (t.root.querySelector(".gz-explainable") as HTMLElement).click();
  const src = t.opened[0];
  let e = (await src.shown())!;
  assert.equal(e.value, 172);
  const knobs = await src.pull!.knobs();
  assert.deepEqual(knobs.map((k) => (k.kind === "row" ? [k.field, k.value] : k.name)), [["amount", 160]]);
  const solved = await src.pull!.solve(knobs[0], 100);
  assert.deepEqual(solved, { value: 88 });
  const done = await src.pull!.keep(knobs[0], 88);
  assert.equal(done.text, "Set amount to 88");
  await settle();
  e = (await src.shown())!;
  assert.equal(e.value, 100);
  const lunch = e.parts.find((x) => x.adds === 12)!;
  assert.equal((await src.remove!(lunch)).text, "Deleted the row.");
  await settle();
  assert.equal((await src.shown())!.value, 88);
});

test("the stylesheet has no stray \\n, which would turn the selector after it into one that matches nothing", () => {
  assert.doesNotMatch(readFileSync("styles.css", "utf8"), /^\\n$/m);
});

test("pull: a target is a number as a person writes it; anything else isn't read as one", () => {
  for (const [typed, n] of [["2500", 2500], ["$2,500", 2500], ["$2,500.50", 2500.5], ["-5", -5], ["−5", -5], ["-$5", -5], [".5", 0.5]] as const) assert.equal(readTarget(typed), n, typed);
  for (const typed of ["", "abc", "4.5k", "1e3", "4.500,00", "12 34", "--5"]) assert.equal(readTarget(typed), undefined, typed);
});

test("the window: for a last, a row no longer the last isn't called gone, and each shows its number", async () => {
  const rows = saved([{ at: "2026-11-10T07:00", value: 80.9 }, { at: "2026-11-19T07:00", value: 81.75 }]);
  const p = panel({ view: "number", source: "spend", field: "value", agg: "last", format: { value: "unit:kg" } });
  const el = document.createElement("div");
  await drawExplain(el, sourceOf(p, rows));
  ([...el.querySelectorAll(".gz-explain-bar button")].find((b) => text(b) === "A week ago") as HTMLElement).click();
  await settle();
  assert.deepEqual([...el.querySelectorAll(".gz-explain-move")].map((m) => text(m)), [
    "81.8 kgNow the last row · Nov 19, 07:00",
    "80.9 kgWas the last row · Nov 10, 07:00",
  ]);
});

test("in an app: pulling a property moves the window's figure at once, and Undo puts it back", async () => {
  const INVOICE = "Apps/Invoice.md";
  const t = fakeEnv({
    [KIND]: { fm: { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home"], memo: "text" } } },
    [INVOICE]: { fm: { app: "Invoice", rate: 85, panels: [
      { view: "form", title: "Worked", save: "[[Spend]]" },
      { view: "number", title: "Billed", source: "[[Spend]]", compute: { billed: "amount * $this.rate" }, field: "billed", agg: "sum" },
    ] } },
  });
  const opened: ExplainSource[] = [];
  t.env.explain = (src) => { opened.push(src); };
  t.env.undo = async () => "Undone";
  t.env.log = (async () => ({ id: "entry" })) as unknown as typeof t.env.log;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, INVOICE, t.env);
  started.push(c);
  c.load();
  await settle();
  addLine(root, "10 food work");
  await settle();
  (root.querySelector(".gz-explainable") as HTMLElement).click();
  const src = opened[0];
  assert.equal((await src.shown())!.value, 850);
  const [knob] = await src.pull!.knobs();
  const done = await src.pull!.keep(knob, 98.9010989);
  assert.equal(done.text, "Set rate to 98.9011");
  assert.ok(Math.abs(((await src.shown())!.value as number) - 989.010989) < 1e-6);
  assert.deepEqual((await src.pull!.knobs()).map((k) => k.value), [98.9010989], "the next Solve starts from the new value");
  assert.equal(typeof done.undo, "function");
  await done.undo!();
  assert.equal((await src.shown())!.value, 850);
});

// ---- the panel's own keys -------------------------------------------------------------------------

test("definitions: a panel's keys are kept when they change, and a later look says which keys and when", async () => {
  const file = { text: undefined as string | undefined };
  let clock = 1000;
  const log = new DefinitionLog({ read: async () => file.text, write: async (t) => { file.text = t; } }, () => clock);
  const keys = (where: string) => ({ Total: JSON.stringify({ view: "number", where: { at: where } }), Other: "{}" });
  await log.seen("Apps/Budget.md", keys("this week"));
  clock = 2000;
  await log.seen("Apps/Budget.md", keys("this week"));
  clock = 3000;
  await log.seen("Apps/Budget.md", keys("this month"));
  assert.deepEqual(await log.since("Apps/Budget.md", "Total", 1500), [{ at: 3000, keys: ["where"] }]);
  assert.deepEqual(await log.since("Apps/Budget.md", "Other", 0), []);
  assert.deepEqual(await log.since("Apps/Budget.md", "Total", 3000), []);
  // Read again from the file, as after a restart.
  const again = new DefinitionLog({ read: async () => file.text, write: async () => {} }, () => clock);
  assert.equal((await again.since("Apps/Budget.md", "Total", 0)).length, 1);
});

test("in an app: opening it keeps its panels' keys, and the window says when a figure's own keys changed", async () => {
  const t = budget();
  const file = { text: undefined as string | undefined };
  t.env.definitions = new DefinitionLog({ read: async () => file.text, write: async (x) => { file.text = x; } }, () => t.f.host.now());
  t.c.load();
  await settle();
  const before = t.f.host.now();
  t.f.advance(DAY);
  const fm = t.f.files.get(BUDGET)!.fm as { panels: Record<string, unknown>[] };
  fm.panels[1] = { ...fm.panels[1], lines: "all" };
  t.changed(BUDGET);
  await settle();
  (t.root.querySelector(".gz-explainable") as HTMLElement).click();
  const src = t.opened[0];
  assert.deepEqual((await src.keysSince!(before)).map((k) => k.keys), [["lines"]]);
  const el = document.createElement("div");
  await drawExplain(el, { ...src, now: new Date(t.f.host.now()) });
  ([...el.querySelectorAll(".gz-explain-bar button")].find((b) => text(b) === "Yesterday") as HTMLElement).click();
  await settle();
  assert.match(text(el.querySelector(".gz-explain-keys")), /^The panel's own keys changed on .*: lines\. Both figures here are worked out with the keys as they are now\.$/);
});

test("the window: a panel's one format is for its figure; a row's other fields show in their own", async () => {
  const p = panel(
    { view: "number", source: "hours", compute: { billed: "worked * 85" }, field: "billed", agg: "sum", format: "$0,0.00" },
    { fieldInfo: { worked: { unit: "h", format: "unit:h" } } },
  );
  const el = document.createElement("div");
  await drawExplain(el, sourceOf(p, saved([{ at: "2026-11-10T18:00", worked: 8, client: "Acme" }])));
  assert.equal(text(el.querySelector(".gz-explain-head .gz-big")), "$680.00");
  assert.match(text(el.querySelector(".gz-explain-row .gz-explain-what")), /8 h · Acme/);
});
