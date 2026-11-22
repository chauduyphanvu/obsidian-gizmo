import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parse } from "yaml";
import { AppController, type AppEnv, type Hosting } from "../src/app.ts";
import { compilePipeline, tracePipeline } from "../src/pipeline.ts";
import { pastEnv } from "../src/replay.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { mountView, whyWords } from "../src/views/common.ts";
import { viewDef, type EmptyWhy, type PanelCtx } from "../src/views/registry.ts";
import { panelLine } from "../src/yamlpos.ts";
import { fakeEnv } from "./support/fakes.ts";

// A panel that shows nothing though its source gave rows gets "Why?": what each of its steps kept,
// down to the one that lost the rows, so a wrong pick, a narrow where or a misspelled field no
// longer look like having no data. Wednesday 18 November 2026, noon, the fake vault's clock.
const NOW = new Date(2026, 10, 18, 12, 0);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/[  ]/g, " ");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const count = (v: unknown) => (Array.isArray(v) ? v.length : v === undefined ? "nothing" : "one");

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

function panel(keys: Record<string, unknown>, internal: Partial<Panel> = {}): Panel {
  const { panel: p, errors } = checkPanel(keys, true, internal);
  assert.deepEqual(errors, []);
  return p!;
}

/** 34 rows of spending, all in October. */
const SPEND = Array.from({ length: 34 }, (_, i) => ({
  amount: i + 1, category: i % 2 ? "food" : "fun", note: "", at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T09:00`,
}));

const why = (keys: Record<string, unknown>, input: unknown, internal: Partial<Panel> = {}) => {
  const p = panel(keys, internal);
  return whyWords(p, tracePipeline(p, NOW, input), NOW);
};

// ---- The trace is the stage's own steps --------------------------------------------------------------

test("tracing tells what each step had and kept, and ends with the rows the stage gives", () => {
  const rows = [{ amount: 5, category: "food" }, { amount: 9, category: "rent" }, { amount: 7, category: "food" }, { amount: 3, category: "food" }];
  const p = panel({ view: "table", source: "spend", where: { category: "food" }, sort: "-amount", limit: 2 });
  const { input, steps } = tracePipeline(p, NOW, rows);
  assert.equal(input, rows);
  assert.deepEqual(steps.map((s) => [s.stage, s.step, count(s.before), count(s.after)]), [[0, "pick", 4, 4], [0, "where", 4, 3], [0, "limit", 3, 2]]);
  assert.deepEqual(steps.at(-1)!.after, compilePipeline(p, NOW)(rows));
});

test("a chain is traced block by block, root first, with compute and group in the panel's own stage", () => {
  const p = panel({ view: "bar", source: "spend", compute: { double: "amount * 2" }, group: "category", y: "double", agg: "sum" }, { upstream: [{ where: { amount: "> 30" } }] });
  const { steps } = tracePipeline(p, NOW, SPEND);
  assert.deepEqual(steps.map((s) => [s.stage, s.step, count(s.before), count(s.after)]), [
    [0, "pick", 34, 34], [0, "where", 34, 4], [1, "pick", 4, 4], [1, "compute", 4, 4], [1, "group", 4, 2],
  ]);
  assert.deepEqual(steps.at(-1)!.after, compilePipeline(p, NOW)(SPEND));
});

// ---- What lost the rows, in words --------------------------------------------------------------------

test("a pick that finds nothing names the keys found where the path stops", () => {
  const keys = { view: "table", source: "https://x.example.com/c", pick: "chart.result.0" };
  assert.deepEqual(why(keys, { chart: { error: { code: "Not Found" } } }), {
    chain: "the answer → pick found nothing", lost: ["pick: chart.result.0 found nothing (the answer has: chart.error)"],
  });
  assert.deepEqual(why(keys, { chart: { result: [] } }).lost, ["pick: chart.result.0 found nothing (chart.result has 0 items)"]);
  assert.deepEqual(why(keys, { spark: 1, quote: 2 }).lost, ["pick: chart.result.0 found nothing (the answer has: spark, quote)"]);
  assert.deepEqual(why({ ...keys, pick: "chart.result" }, { chart: { result: [] } }), {
    chain: "the answer → pick found 0", lost: ["pick: chart.result found 0 rows"],
  });
});

test("a where that keeps none says so as typed, of how many", () => {
  assert.deepEqual(why({ view: "list", source: "spend", where: { at: "this month" }, item: "{note}" }, SPEND), {
    chain: "34 rows → where kept 0", lost: ["where {at: this month} kept 0 of 34 rows"],
  });
  assert.deepEqual(why({ view: "table", source: "spend", where: { category: "food", amount: "> 100" } }, SPEND), {
    chain: "34 rows → where kept 0", lost: ["where {category: food, amount: > 100} kept 0 of 34 rows"],
  });
});

test("a where over a field no row has says which, and the field it is one typo from", () => {
  assert.deepEqual(why({ view: "table", source: "spend", where: { categroy: "food" } }, SPEND), {
    chain: "34 rows → where kept 0",
    lost: ["where {categroy: food} kept 0 of 34 rows", "no row has categroy (rows have amount, category, note, at) — did you mean category?"],
  });
});

test("a compare panel's where counts only the window it shows, not the one before it keeps to compare", () => {
  const keys = { view: "number", source: "spend", field: "amount", agg: "avg", where: { at: "this month" }, compare: "previous" };
  const p = panel(keys);
  // The where kept October's rows, for the comparison.
  assert.ok((tracePipeline(p, NOW, SPEND).steps.find((s) => s.step === "where")!.after as unknown[]).length > 0);
  assert.deepEqual(why(keys, SPEND), { chain: "34 rows → where kept 0", lost: ["where {at: this month} kept 0 of 34 rows"] });
});

test("a where in a block the panel reads says it is there", () => {
  assert.deepEqual(why({ view: "list", source: "spend", item: "{note}" }, SPEND, { upstream: [{ where: { category: "rent" } }] }), {
    chain: "34 rows → where kept 0", lost: ["where {category: rent} kept 0 of 34 rows, in a data block it reads"],
  });
});

test("a group that makes no groups says so, and the field it reads that no row has", () => {
  assert.deepEqual(why({ view: "bar", source: "spend", group: "dat", per: "day" }, SPEND), {
    chain: "34 rows → group made 0",
    lost: ["group by dat per day made no groups from 34 rows", "no row has dat (rows have amount, category, note, at) — did you mean at?"],
  });
});

test("when every step kept rows, it is a field the view reads that no row has", () => {
  assert.deepEqual(why({ view: "number", source: "spend", field: "amout", agg: "sum" }, SPEND), {
    chain: "34 rows", lost: ["no row has amout (rows have amount, category, note, at) — did you mean amount?"],
  });
  // A grouped chart reads its y from the rows before they are grouped.
  assert.deepEqual(why({ view: "bar", source: "spend", group: "category", y: "amout", agg: "sum" }, SPEND), {
    chain: "34 rows → group made 2", lost: ["no row has amout (rows have amount, category, note, at) — did you mean amount?"],
  });
  assert.deepEqual(why({ view: "scatter", source: "spend", x: "amount", y: "wieght" }, SPEND).lost, ["no row has wieght (rows have amount, category, note, at)"]);
  // A dotted field is looked for under the part of it that is there.
  assert.deepEqual(why({ view: "number", source: "quakes", field: "properties.mga" }, [{ properties: { mag: 4.2, place: "Ridgecrest" } }]).lost, [
    "no row has properties.mga (rows have properties.mag, properties.place) — did you mean properties.mag?",
  ]);
});

test("rows that have the field but nothing in it are said to reach the panel with nothing to show", () => {
  assert.deepEqual(why({ view: "number", source: "weights", field: "weight", agg: "avg" }, [{ weight: null }, { weight: "" }]), {
    chain: "2 rows", lost: ["2 rows reach this panel, but none has a value it can show in weight"],
  });
});

// ---- The link, drawn by the views ----------------------------------------------------------------------

/** The hooks an app gives, counting what is asked of them. */
function hooks(p: Panel, input: unknown, has = true) {
  const asked = { hasData: 0, trace: 0, source: 0, answer: 0 };
  const why: EmptyWhy = {
    hasData: () => { asked.hasData++; return has; },
    trace: () => { asked.trace++; return tracePipeline(p, NOW, input); },
    showInSource: () => { asked.source++; },
    seeAnswer: () => { asked.answer++; },
  };
  return { why, asked };
}

/** Draws a panel over its data as the app would, with these hooks, in the answer band's `slot` or on the grid. */
function draw(keys: Record<string, unknown>, input: unknown, opts: { has?: boolean; slot?: string; why?: boolean } = {}) {
  const p = panel(keys);
  const h = hooks(p, input, opts.has);
  const el = document.createElement("div");
  const ctx = {
    now: NOW, width: () => 600, place: () => (opts.slot ? { role: "answer", slot: opts.slot } : undefined), ...(opts.why !== false && { why: h.why }),
  } as unknown as PanelCtx;
  mountView(viewDef(p.view)!, el, p, ctx, "k").update(compilePipeline(p, NOW)(input));
  return { el, ...h };
}

const link = (el: Element) => el.querySelector("button.gz-why-link") as HTMLButtonElement | null;
const box = (el: Element) => el.querySelector(".gz-why");

test("an empty sentence gets Why? beside it; selecting it shows the steps under the panel, and again hides them", () => {
  const { el, asked } = draw({ view: "table", title: "This month", source: "spend", where: { at: "this month" } }, SPEND);
  assert.equal(text(el.querySelector(".gz-empty")), "Nothing logged this month yet. Why?");
  // Deciding to offer it runs no step.
  assert.deepEqual(asked, { hasData: 1, trace: 0, source: 0, answer: 0 });
  assert.equal(link(el)!.getAttribute("aria-expanded"), "false");
  link(el)!.click();
  assert.equal(asked.trace, 1);
  assert.equal(link(el)!.getAttribute("aria-expanded"), "true");
  assert.ok(box(el)!.parentElement === el);
  assert.equal(text(box(el)!.querySelector(".gz-why-chain")), "34 rows → where kept 0");
  assert.match(text(box(el)), /where \{at: this month\} kept 0 of 34 rows/);
  const buttons = [...box(el)!.querySelectorAll(".gz-actions button")] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((b) => text(b)), ["Show in source", "See the answer"]);
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual([asked.source, asked.answer], [1, 1]);
  link(el)!.click();
  assert.ok(!box(el));
  assert.equal(link(el)!.getAttribute("aria-expanded"), "false");
});

test("no link when the source gave nothing, or the app can't explain, and nothing is asked of a panel that drew rows", () => {
  assert.ok(!link(draw({ view: "list", source: "spend", item: "{note}" }, [], { has: false }).el));
  assert.ok(!link(draw({ view: "table", source: "spend", where: { at: "this month" } }, SPEND, { why: false }).el));
  const drew = draw({ view: "table", source: "spend", where: { category: "food" } }, SPEND);
  assert.ok(drew.el.querySelector("tbody tr"));
  assert.ok(!link(drew.el));
  assert.deepEqual(drew.asked, { hasData: 0, trace: 0, source: 0, answer: 0 });
});

test("every view's empty line takes the link: list, board, timeline, scatter, pie and charts", () => {
  const empty = (keys: Record<string, unknown>) => text(draw(keys, SPEND).el.querySelector(".gz-empty"));
  assert.equal(empty({ view: "list", source: "spend", where: { at: "this month" }, item: "{note}" }), "Nothing logged this month yet. Why?");
  assert.equal(empty({ view: "board", source: "spend", group: "category", where: { at: "this month" } }), "Nothing logged this month yet. Why?");
  assert.equal(empty({ view: "timeline", source: "spend", start: "when" }), "Nothing here yet. Why?");
  assert.equal(empty({ view: "scatter", source: "spend", x: "amount", y: "wieght" }), "No data to chart yet. Why?");
  assert.equal(empty({ view: "pie", source: "spend", group: "category", where: { at: "this month" } }), "Nothing logged this month yet. Why?");
  assert.equal(empty({ view: "line", source: "spend", x: "at", y: "amout" }), "No data to chart yet. Why?");
  assert.equal(empty({ view: "bar", source: "spend", x: "at", y: "amount", where: { at: "this month" } }), "Nothing logged this month yet. Why?");
});

test("a number that shows a dash gets Why? on a line under it; one with an empty note, on that note", () => {
  const dash = draw({ view: "number", title: "Spent", source: "spend", field: "amout", agg: "sum" }, SPEND);
  assert.equal(text(dash.el.querySelector(".gz-big")), "—");
  assert.equal(text(link(dash.el)!.parentElement), "Why?");
  link(dash.el)!.click();
  assert.match(text(box(dash.el)), /no row has amout \(rows have amount, category, note, at\) — did you mean amount\?/);

  const note = draw({ view: "number", title: "Latest", source: "spend", field: "amount", agg: "last", where: { at: "this month" } }, SPEND);
  assert.equal(text(link(note.el)!.parentElement), "Nothing logged this month yet Why?");

  const headline = draw({ view: "number", title: "Latest", source: "spend", field: "amount", agg: "last", where: { at: "this month" } }, SPEND, { slot: "headline" });
  assert.equal(text(headline.el.querySelector(".gz-ans-label")), "Nothing logged this month yet Why?");
  const fact = draw({ view: "number", title: "Latest", source: "spend", field: "amount", agg: "avg", where: { at: "this month" } }, SPEND, { slot: "fact" });
  assert.equal(text(fact.el.querySelector(".gz-fact-note")), "Nothing logged this month yet Why?");
  const typo = draw({ view: "number", title: "Spent", source: "spend", field: "amout", agg: "sum", label: "so far" }, SPEND, { slot: "headline" });
  assert.equal(text(link(typo.el)!.parentElement), "Why?");

  const progress = draw({ view: "progress", title: "Pace", source: "spend", field: "amount", agg: "avg", max: 50, where: { at: "this month" } }, SPEND, { slot: "fact" });
  assert.equal(text(progress.el.querySelector(".gz-fact-note")), "Nothing logged this month yet Why?");
  // A count over nothing is 0, which is an answer, not nothing.
  assert.ok(!link(draw({ view: "number", source: "spend", agg: "count", where: { at: "this month" } }, SPEND).el));
});

// ---- In the app --------------------------------------------------------------------------------------

const APP = "Apps/Spend.md";
const NOTE = `---
app: Spend
spend:
  - {amount: 5, category: food, at: "2026-10-03T09:00"}
  - {amount: 12, category: fun, at: "2026-10-09T18:00"}
weights:
  - {kg: 71.2, at: "2026-10-20T07:00"}
  - {kg: 70.8, at: "2026-10-27T07:00"}
  - {kg: 70.5, at: "2026-11-03T07:00"}
panels:
  - view: table
    title: Everything
    source: spend
  - view: table
    title: Weighed this week
    source: weights
    where: {at: this week}
  - view: list
    title: Nothing yet
    source: none
    item: "{x}"
---
`;

/** The app note in its own tab, its text what the source shows, beside `notes`; `env` and `hosting` change where it runs. */
function open(note = NOTE, how: { env?: (env: AppEnv) => AppEnv; hosting?: Hosting; notes?: Record<string, { fm: Record<string, unknown> }> } = {}, responses: Record<string, unknown> = {}) {
  const fm = parse(/^---\n([\s\S]*?)\n---/.exec(note)![1]) as Record<string, unknown>;
  const t = fakeEnv({ [APP]: { fm }, ...how.notes }, responses);
  t.source.lines = note.split("\n");
  const leaf = document.body.createDiv();
  const root = leaf.createDiv();
  const app = new AppController(root, APP, how.env ? how.env(t.env) : t.env, how.hosting);
  app.openInPlace(() => {});
  started.push({ dispose: () => { app.dispose(); leaf.remove(); } });
  app.load();
  const panelNamed = (title: string) => [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-title")) === title) as HTMLElement;
  return { ...t, root, app, panelNamed };
}

test("in the app, only the panel whose steps lost its rows gets Why?, and it explains them", async () => {
  const t = open();
  await settle();
  assert.ok(t.panelNamed("Everything").querySelector("tbody tr"));
  assert.ok(!link(t.panelNamed("Everything")));
  // Nothing in the list: the empty sentence is the truth.
  assert.equal(text(t.panelNamed("Nothing yet").querySelector(".gz-empty")), "Nothing logged yet.");
  const weighed = t.panelNamed("Weighed this week");
  assert.equal(text(weighed.querySelector(".gz-empty")), "Nothing logged this week yet. Why?");
  link(weighed)!.click();
  assert.equal(text(box(weighed)!.querySelector(".gz-why-chain")), "3 rows → where kept 0");
  assert.match(text(box(weighed)), /where \{at: this week\} kept 0 of 3 rows/);
});

test("Show in source puts the cursor on the panel's line; See the answer opens Inspect data at its source", async () => {
  const scrolled: string[] = [];
  const proto = window.Element.prototype as unknown as { scrollIntoView?: (this: Element) => void };
  const was = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) { scrolled.push(text(this.querySelector(".gz-inspect-head"))); };
  try {
    const t = open();
    await settle();
    const weighed = t.panelNamed("Weighed this week");
    link(weighed)!.click();
    const [source, answer] = [...box(weighed)!.querySelectorAll(".gz-actions button")] as HTMLButtonElement[];
    source.click();
    await settle();
    assert.deepEqual(t.source.shownAt, [NOTE.split("\n").indexOf("    title: Weighed this week") - 1]);
    answer.click();
    await settle();
    assert.ok(t.root.querySelector(".gz-inspector"));
    assert.deepEqual([...t.root.querySelectorAll(".gz-inspect-head")].map((h) => text(h)), [
      "Everything · list: spend", "Weighed this week · list: weights", "Nothing yet · list: none",
    ]);
    assert.deepEqual(scrolled, ["Weighed this week · list: weights"]);
    // Asked again, it stays open, at the same source.
    answer.click();
    await settle();
    assert.ok(t.root.querySelector(".gz-inspector"));
    assert.deepEqual(scrolled, ["Weighed this week · list: weights", "Weighed this week · list: weights"]);
    // Opened from the menu, it scrolls nowhere.
    await t.app.toggleInspector();
    await t.app.toggleInspector();
    assert.equal(scrolled.length, 2);
  } finally {
    proto.scrollIntoView = was;
  }
});

test("a note that is one panel is shown at its view: line", () => {
  assert.equal(panelLine(["---", "app: Weights", "view: table", "source: weights", "---"], ""), 2);
  assert.equal(panelLine(NOTE.split("\n"), "panel 2"), NOTE.split("\n").indexOf("    title: Weighed this week") - 1);
  assert.equal(panelLine(["no frontmatter"], ""), undefined);
});

test("no link in an embed or a try, where neither the source nor Inspect data is at hand; the past view has both", async () => {
  const feed = { "https://api.example.com/feed": [{ kind: "run" }, { kind: "walk" }] };
  const keys = { app: "", view: "list", title: "Swims", source: "https://api.example.com/feed", where: { kind: "swim" }, item: "{kind}" };
  const embed = open(NOTE, { hosting: { kind: "embed", grantKey: `${APP}#k`, hostPath: APP, definition: () => keys } }, feed);
  await settle();
  assert.equal(text(embed.root.querySelector(".gz-empty")), "Nothing here yet.");
  assert.ok(!link(embed.root));

  const tried = open(NOTE, { env: (env) => ({ ...env, preview: true }) });
  await settle();
  assert.equal(text(tried.panelNamed("Weighed this week").querySelector(".gz-empty")), "Nothing logged this week yet.");

  const notes = `---
app: Health
panels:
  - view: list
    title: Today
    source: notes
    from: Health
    where: {date: today}
    item: "{name}"
---
`;
  const past = open(notes, { notes: { "Health/Dentist.md": { fm: { date: "2026-11-19" } } }, env: (env) => pastEnv(env, new Date(2026, 10, 17, 9).getTime()) });
  await settle();
  assert.equal(text(past.panelNamed("Today").querySelector(".gz-empty")), "Nothing here today. Why?");
});
