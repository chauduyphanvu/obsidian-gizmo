import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { aggregate, valueOf } from "../src/data.ts";
import type { NoteReader } from "../src/expand.ts";
import { checkPanel, readSpec, resolvePanel, type Panel } from "../src/spec.ts";
import { emptyText, mountView } from "../src/views/common.ts";
import { viewDef, type PanelCtx } from "../src/views/registry.ts";
import { panelValue } from "../src/panel-value.ts";
import { fakeBackground } from "./support/fakes.ts";
import { parseYaml } from "./support/yaml.ts";

// A panel with no rows reads as an answer: a sum of nothing is 0, a value that can't be had says
// nothing is logged, and every empty view names the window it looks at. Friday 20 November 2026, 19:42.
const NOW = new Date(2026, 10, 20, 19, 42);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/[  ]/g, " ");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

type Slot = "headline" | "fact" | "meter" | undefined;

function panel(keys: Record<string, unknown>, internal: Partial<Panel> = {}): Panel {
  const { panel: p, errors } = checkPanel(keys, true, internal);
  assert.deepEqual(errors, []);
  return p!;
}

/** Draws a panel as the app would, in the answer band's `slot` or on the grid. */
function draw(keys: Record<string, unknown>, data: unknown, slot?: Slot, internal: Partial<Panel> = {}): HTMLElement {
  const el = document.createElement("div");
  const ctx = { now: NOW, width: () => 600, place: () => (slot ? { role: "answer", slot } : undefined) } as unknown as PanelCtx;
  mountView(viewDef(keys.view as string)!, el, panel(keys, internal), ctx, "k").update(data);
  return el;
}

const said = (keys: Record<string, unknown>, data: unknown = []) => text(draw(keys, data).querySelector(".gz-empty"));

// ---- A sum of nothing is 0 -----------------------------------------------------------------------

test("a sum of no rows is 0; a count stays 0; the others have no value; a field no row has is no sum", () => {
  assert.equal(aggregate([], "amount", "sum"), 0);
  assert.equal(aggregate([], undefined, "count"), 0);
  for (const agg of ["avg", "min", "max", "first", "last", "share"] as const) assert.equal(aggregate([], "amount", agg), undefined, agg);
  // Rows that all lack the field: more likely a typo than a zero.
  assert.equal(aggregate([{ amount: 5 }, { amount: 7 }], "amonut", "sum"), undefined);
  assert.equal(aggregate([{ amount: 5 }, { note: "x" }], "amount", "sum"), 5);
});

test("a sum over no rows shows 0 in the panel's format or with its unit, and a progress over it 0 of its max", () => {
  const money = panel({ view: "number", source: "spend", field: "amount", agg: "sum", format: "$0,0.00" });
  assert.deepEqual(panelValue(money, [], NOW), { value: 0, text: "$0.00", unit: undefined });
  const water = panel({ view: "number", source: "water", field: "glasses", agg: "sum", unit: "glasses" });
  assert.deepEqual(panelValue(water, [], NOW), { value: 0, text: "0", unit: "glasses" });
  const typo = panel({ view: "number", source: "spend", field: "amonut", agg: "sum", format: "$0,0.00" });
  assert.equal(panelValue(typo, [{ amount: 5 }], NOW).text, "—");

  const el = draw({ view: "progress", title: "Against my limit", source: "spend", field: "amount", agg: "sum", max: 2000, format: "$0,0" }, [], "headline");
  assert.equal(text(el.querySelector(".gz-big")), "$0/ $2,000");
  assert.equal(text(el.querySelector(".gz-meter-legend")), "0% of $2,000$2,000 left");
  // A sum of nothing is 0, which says it already.
  assert.ok(!el.querySelector(".gz-ans-label"));
});

test("a headline sum over an empty window is $0.00 in its figure, with no note and its caption kept", () => {
  const el = draw({ view: "number", title: "This month", source: "spend", field: "amount", agg: "sum", where: { at: "this month" }, format: "$0,0.00", label: "spent so far" }, [], "headline");
  assert.equal(text(el.querySelector(".gz-big")), "$0.00");
  assert.ok(!el.querySelector(".gz-none"));
  assert.equal(text(el.querySelector(".gz-fig-cap")), "spent so far");
  assert.ok(!el.querySelector(".gz-ans-label"));
});

// ---- A value that can't be had says nothing is logged ----------------------------------------------

const LATEST = { view: "number", title: "Latest", source: "weight", sort: "at", field: "value", agg: "last", unit: "kg" };
const WEEK = { view: "number", title: "This week", source: "weight", where: { at: "this week" }, field: "value", agg: "avg", compare: "previous", unit: "kg", decimals: 1, label: "average" };

test("a last or an average of nothing keeps its dash and says nothing is logged under it, naming its window", () => {
  const head = draw(LATEST, [], "headline");
  assert.equal(text(head.querySelector(".gz-big")), "—");
  assert.equal(text(head.querySelector(".gz-ans-label")), "Nothing logged yet");
  // It is under the figure row, where the change would go.
  assert.equal(head.lastElementChild?.className, "gz-label gz-ans-label");

  // With compare and nothing in either window, the note says it, not "Nothing to compare with yet".
  const week = draw(WEEK, [], "headline");
  assert.equal(text(week.querySelector(".gz-ans-label")), "Nothing logged this week yet");
  assert.ok(!week.querySelector(".gz-compare"));
  assert.equal(text(week.querySelector(".gz-fig-cap")), "average");

  // A fact has one line under its figure, and the note is it.
  const fact = draw(WEEK, [{ at: "2026-11-10T08:00", value: 80 }], "fact");
  assert.equal(text(fact.querySelector(".gz-big")), "—");
  assert.deepEqual([...fact.querySelectorAll(".gz-fact-note")].map(text), ["Nothing logged this week yet"]);

  // On the grid it is a line under the value and its label.
  const grid = draw(WEEK, [], undefined);
  assert.deepEqual([...grid.querySelectorAll(".gz-label")].map(text), ["average", "Nothing logged this week yet"]);
  assert.ok(!grid.querySelector(".gz-compare"));
});

test("min, max, first and a share of nothing say so too; a count, sum or streak of nothing doesn't", () => {
  for (const agg of ["min", "max", "first"]) {
    assert.equal(text(draw({ view: "number", source: "weight", field: "value", agg }, [], "fact").querySelector(".gz-fact-note")), "Nothing logged yet", agg);
  }
  const share = { view: "number", title: "Right so far", source: "decisions", agg: "share", of: { outcome: "right" }, label: "of the decisions I've scored" };
  assert.equal(text(draw(share, [], "fact").querySelector(".gz-fact-note")), "Nothing logged yet");
  // From notes, there is nothing here rather than nothing logged.
  assert.equal(text(draw({ ...share, source: "notes", from: "Decisions" }, [], "fact").querySelector(".gz-fact-note")), "Nothing here yet");

  const count = draw({ view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count" }, [], "headline");
  assert.equal(text(count.querySelector(".gz-big")), "0");
  assert.ok(!count.querySelector(".gz-ans-label"));
  const streak = draw({ view: "number", title: "Streak", source: "doses", group: "at", per: "day", agg: "streak", unit: "days" }, [], "fact");
  assert.equal(text(streak.querySelector(".gz-big")), "0days");
  assert.ok(!streak.querySelector(".gz-fact-note"));
  // Rows that aren't a list (a web answer's one object) aren't an empty panel.
  assert.ok(!draw({ view: "number", source: "https://api.example.com/now", field: "temp" }, { other: 1 }, "fact").querySelector(".gz-fact-note"));
});

test("a progress of nothing says so as a fact or headline, not as a number's meter", () => {
  const keys = { view: "progress", title: "Weight", source: "weight", field: "value", agg: "last", max: 100, label: "of my goal" };
  assert.equal(text(draw(keys, [], "fact").querySelector(".gz-fact-note")), "Nothing logged yet");
  const head = draw(keys, [], "headline");
  assert.equal(text(head.querySelector(".gz-fig-cap")), "of my goal");
  assert.equal(text(head.querySelector(".gz-ans-label")), "Nothing logged yet");
  assert.ok(!draw(keys, [], "meter").querySelector(".gz-label"));
  assert.deepEqual([...draw(keys, [], undefined).querySelectorAll(".gz-label")].map(text), ["of my goal", "Nothing logged yet"]);
});

// ---- The window, in words ------------------------------------------------------------------------

test("an empty panel names the window its where keeps, in an app's own list or elsewhere", () => {
  const list = (where?: Record<string, string>, source = "spend") => {
    const keys = { view: "table", source, ...(source === "notes" && { from: "Health" }), ...(where && { where }) };
    return emptyText(panel(keys), NOW, "Nothing here yet.");
  };
  assert.equal(list(), "Nothing logged yet.");
  assert.equal(list({ at: "today" }), "Nothing logged today yet.");
  assert.equal(list({ at: "this week" }), "Nothing logged this week yet.");
  assert.equal(list({ at: "this month" }), "Nothing logged this month yet.");
  assert.equal(list({ at: "this year" }), "Nothing logged this year yet.");
  assert.equal(list({ at: "last 30 days" }), "Nothing logged in the last 30 days yet.");
  assert.equal(list({ at: "last 8 weeks" }), "Nothing logged in the last 8 weeks yet.");
  assert.equal(list({ at: "last 6 months" }), "Nothing logged in the last 6 months yet.");
  assert.equal(list({ at: "last 2 years" }), "Nothing logged in the last 2 years yet.");
  // A window that is over has nothing more coming.
  assert.equal(list({ at: "yesterday" }), "Nothing logged yesterday.");
  assert.equal(list({ at: "2026-11-18" }), "Nothing logged on Nov 18.");
  assert.equal(list({ at: "2026-11-20" }), "Nothing logged today yet.");
  assert.equal(list({ at: "next 7 days" }), "Nothing logged for Nov 20–27 yet.");
  // Any date field, not only at; a condition that isn't a window names none.
  assert.equal(list({ due: "this week", status: "open" }), "Nothing logged this week yet.");
  assert.equal(list({ at: "past" }), "Nothing logged yet.");
  assert.equal(list({ amount: "> 5" }), "Nothing logged yet.");

  assert.equal(list({ date: "this week" }, "notes"), "Nothing here this week.");
  assert.equal(list({ date: "today" }, "https://api.example.com/x"), "Nothing here today.");
  assert.equal(list({ date: "upcoming" }, "notes"), "Nothing here yet.");
  assert.equal(list(undefined, "notes"), "Nothing here yet.");
  // A caption under a value has no full stop.
  assert.equal(emptyText(panel({ view: "number", source: "spend", where: { at: "this month" } }), NOW, "Nothing here yet", true), "Nothing logged this month yet");
});

test("the window may be in a block above the one the panel names", () => {
  const r = readSpec({
    app: "Budget",
    data: { spend: { source: "spend" }, month: { source: "spend", where: { at: "this month" }, sort: "-at" }, recent: { source: "month", limit: 5 } },
    panels: [{ view: "table", title: "Recent", source: "recent" }],
  }, { path: "Apps/Budget.md" })!;
  assert.deepEqual(r.errors, []);
  const p = r.spec!.panels[0].panel;
  assert.equal(emptyText(p, NOW, "Nothing here yet."), "Nothing logged this month yet.");
});

// ---- Every view that can be empty ----------------------------------------------------------------

test("tables, lists, boards, timelines, charts, pies and scatters with no rows name their window", () => {
  const month = { at: "this month" };
  assert.equal(said({ view: "table", source: "spend", where: month }), "Nothing logged this month yet.");
  assert.equal(said({ view: "table", source: "spend", where: month, layout: "cards" }), "Nothing logged this month yet.");
  assert.equal(said({ view: "list", source: "spend", where: month }), "Nothing logged this month yet.");
  assert.equal(said({ view: "board", source: "chores", group: "room", where: month }), "Nothing logged this month yet.");
  assert.equal(said({ view: "timeline", source: "trips", start: "date", where: { date: "this week" } }), "Nothing logged this week yet.");
  assert.equal(said({ view: "line", source: "weight", x: "at", y: "value", where: { at: "last 6 months" } }), "Nothing logged in the last 6 months yet.");
  assert.equal(said({ view: "bar", source: "spend", x: "at", y: "amount" }), "Nothing logged yet.");
  assert.equal(said({ view: "pie", source: "spend", group: "category", where: month }), "Nothing logged this month yet.");
  assert.equal(said({ view: "scatter", source: "notes", from: "Cars", x: "weight", y: "mpg", where: { made: "this year" } }), "Nothing here this year.");
  // From anywhere else without a window, each keeps its own words.
  assert.equal(said({ view: "list", source: "notes", from: "Books" }), "Nothing here yet.");
  assert.equal(said({ view: "line", source: "notes", from: "Health", x: "date", y: "kg" }), "No data to chart yet.");
  assert.equal(said({ view: "pie", source: "notes", from: "Books", group: "genre" }), "Nothing to show yet.");
  assert.equal(said({ view: "scatter", source: "notes", from: "Cars", x: "weight", y: "mpg" }), "No data to chart yet.");
});

test("rows with nothing a view can draw aren't an empty panel: the view keeps its own words", () => {
  assert.equal(said({ view: "line", source: "weight", x: "at", y: "value" }, [{ at: "2026-11-01", note: "no value" }]), "No data to chart yet.");
  assert.equal(said({ view: "pie", source: "spend", x: "category", y: "amount" }, [{ category: "food", amount: 0 }]), "Nothing to show yet.");
  assert.equal(said({ view: "scatter", source: "cars", x: "weight", y: "mpg" }, [{ weight: 1 }]), "No data to chart yet.");
  const timeline = draw({ view: "timeline", source: "trips", start: "date", empty: "No trips yet" }, [{ name: "Somewhere" }]);
  assert.deepEqual([...timeline.querySelectorAll(".gz-empty, .gz-label")].map(text), ["Nothing here yet.", "1 without a date"]);
});

// ---- empty: ---------------------------------------------------------------------------------------

test("empty: replaces the sentence of every view that can be empty", () => {
  const empty = "No doses yet today. Tap the button above.";
  assert.equal(said({ view: "table", source: "doses", where: { at: "today" }, empty }), empty);
  assert.equal(said({ view: "list", source: "notes", from: "Books", empty }), empty);
  assert.equal(said({ view: "board", source: "chores", group: "room", empty }), empty);
  assert.equal(said({ view: "timeline", source: "trips", start: "date", empty }), empty);
  assert.equal(said({ view: "line", source: "weight", x: "at", y: "value", empty }), empty);
  assert.equal(said({ view: "bar", source: "weight", x: "at", y: "value", empty }), empty);
  assert.equal(said({ view: "pie", source: "spend", group: "category", empty }), empty);
  assert.equal(said({ view: "scatter", source: "cars", x: "weight", y: "mpg", empty }), empty);
  assert.equal(text(draw({ view: "text", source: "doses", text: "{count} doses", empty }, []).querySelector(".gz-text")), empty);
  // With rows, it says nothing.
  assert.equal(text(draw({ view: "text", source: "doses", text: "{count} doses", empty }, [{ at: "x" }]).querySelector(".gz-text")), "1 doses");
});

test("empty: is the note of a number or progress with no rows, even a count or sum of 0", () => {
  const empty = "No doses yet today. Tap the button above.";
  const keys = { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", empty };
  const head = draw(keys, [], "headline");
  assert.equal(text(head.querySelector(".gz-big")), "0");
  assert.equal(text(head.querySelector(".gz-ans-label")), empty);
  assert.equal(text(draw(keys, [], "fact").querySelector(".gz-fact-note")), empty);
  assert.deepEqual([...draw(keys, [], undefined).querySelectorAll(".gz-label")].map(text), [empty]);
  assert.ok(!draw(keys, [{ at: "2026-11-20T08:00" }], "headline").querySelector(".gz-ans-label"));
  const last = draw({ ...LATEST, empty: "Weigh yourself to start" }, [], "fact");
  assert.equal(text(last.querySelector(".gz-fact-note")), "Weigh yourself to start");
  const bar = draw({ view: "progress", source: "water", field: "glasses", agg: "sum", max: 8, empty: "No water yet today" }, [], "fact");
  assert.equal(text(bar.querySelector(".gz-fact-note")), "No water yet today");
});

test("empty: is text on the views that can be empty, and no other", () => {
  for (const view of ["number", "text", "progress", "line", "bar", "pie", "scatter", "table", "list", "board", "timeline"]) {
    assert.ok(viewDef(view)!.keys.includes("empty"), view);
  }
  for (const view of ["button", "form", "timer", "countdown", "checklist", "calendar", "alerts"]) {
    assert.ok(!viewDef(view)!.keys.includes("empty"), view);
  }
  assert.deepEqual(checkPanel({ view: "button", label: "Took meds", save: "doses", empty: "x" }, true).errors, ['"empty" doesn\'t apply to button']);
  assert.deepEqual(checkPanel({ view: "table", source: "doses", empty: ["x"] }, true).errors, ['"empty" has the wrong type (expected string)']);
});

test("empty: fills $names as other text does", () => {
  const r = readSpec({
    app: "Spend",
    inputs: { category: ["food", "home"] },
    panels: [{ view: "list", source: "spend", where: { category: "$category" }, empty: "Nothing spent on $category yet." }],
  }, { path: "Apps/Spend.md" })!;
  assert.deepEqual(r.errors, []);
  assert.equal(resolvePanel(r.spec!.panels[0], { category: "home" }).panel!.empty, "Nothing spent on home yet.");
  const reader: NoteReader = {
    resolve: (link) => (link === "Kit" ? "Components/Kit.md" : undefined),
    frontmatter: () => ({ component: "A kit", params: { what: "weight" }, panels: [{ view: "table", source: "$what", empty: "No $what logged yet." }] }),
  };
  const kit = readSpec({ app: "Sleep", use: "[[Kit]]", with: { what: "sleep" } }, { path: "Apps/Sleep.md", notes: reader })!;
  assert.deepEqual(kit.errors, []);
  assert.equal(kit.spec!.panels[0].panel.empty, "No sleep logged yet.");
});

// ---- Background work -------------------------------------------------------------------------------

test("in the background a sum of nothing is 0 too: the status bar, a link's answer, and alerts read it", async () => {
  const t = fakeBackground({
    "Apps/Water.md": { fm: { app: "Water", panels: [
      { view: "form", fields: { glasses: "number" }, save: "water" },
      { view: "number", title: "Today", source: "water", where: { at: "today" }, field: "glasses", agg: "sum", unit: "glasses", pin: "status", alert: "< 8", shortcut: "water-today" },
      { view: "number", title: "Too much", source: "water", where: { at: "today" }, field: "glasses", agg: "sum", alert: ">= 12" },
      { view: "number", title: "Latest", source: "water", field: "glasses", agg: "last", pin: "status" },
    ] } },
  });
  await t.bg.start();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Today: 0 glasses", "Latest: —"]);
  // A too-little alert on a day with nothing logged holds; a too-much one doesn't.
  assert.deepEqual(t.bg.alerts.list().map((a) => [a.title, a.text]), [["Today", "0 glasses"]]);
  const spec = readSpec(t.f.files.get("Apps/Water.md")!.fm, { path: "Apps/Water.md" })!;
  const r = await t.bg.evaluate("Apps/Water.md", spec.spec!.panels[1]);
  assert.ok("shown" in r);
  assert.deepEqual([r.value, r.shown], [0, "0 glasses"]);
});

// ---- The gallery's first screens -------------------------------------------------------------------

const GALLERY = new URL("../gallery/", import.meta.url);
const gallery = (path: string) => parseYaml(readFileSync(new URL(path, GALLERY), "utf8").match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;

async function openEmpty(path: string, also: Parameters<typeof fakeBackground>[0] = {}): Promise<Element[]> {
  const t = fakeBackground({ [path]: { fm: gallery(path) }, ...also });
  t.env.opened = (p) => t.bg.opened(p);
  t.env.alerts = t.bg.alerts;
  await t.bg.start();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const controller = new AppController(root, path, t.env);
  started.push(controller, { dispose: () => t.bg.stop() });
  controller.load();
  await settle();
  assert.equal(text(root.querySelector(".gz-error")), "");
  return [...root.querySelectorAll(".gz-panel")];
}

test("Budget with nothing logged: the month lands at $0.00, the whole limit left, and each list says how it fills", async () => {
  const all = await openEmpty("Apps/Budget.md", { "Kinds/Spend.md": { fm: gallery("Kinds/Spend.md") } });
  const panel = (title: string) => all.find((p) => text(p.querySelector(".gz-title")) === title)!;
  const [lands, limit, spent, coming] = all;
  assert.equal(text(lands.querySelector(".gz-big")), "$0.00");
  assert.equal(text(limit.querySelector(".gz-meter-legend")), "0% of $2,500$2,500.00 left · $208.33 a day for 12 days");
  assert.equal(text(spent.querySelector(".gz-compare")), "Nothing to compare with yet");
  assert.equal(text(coming.querySelector(".gz-big")), "$0.00");
  assert.equal(text(panel("Bills still to pay this month").querySelector(".gz-empty")), 'No bill left to pay this month. Plan one with a day still to come, e.g. 65 home "FASTNET INTERNET" @+30d.');
  assert.equal(text(panel("Charges from the bank, not checked yet").querySelector(".gz-empty")), "No charge from the bank waits. Drop its CSV export in Inbox/Bank.");
  assert.equal(text(panel("Recent").querySelector(".gz-empty")), "Nothing logged yet.");
});

test("Bills and renewals with nothing planned: $0.00 and none to start, and each list says how to plan one", async () => {
  const kinds = { "Kinds/Spend.md": { fm: gallery("Kinds/Spend.md") }, "Kinds/Renewal.md": { fm: gallery("Kinds/Renewal.md") } };
  const all = await openEmpty("Apps/Bills and renewals.md", kinds);
  const panel = (title: string) => all.find((p) => text(p.querySelector(".gz-title")) === title)!;
  assert.equal(text(panel("Bills in the next 30 days").querySelector(".gz-big")), "$0.00");
  assert.equal(text(panel("Renewals to start").querySelector(".gz-big")), "0");
  assert.equal(text(panel("Overdue").querySelector(".gz-empty")), "No bill is overdue.");
  assert.equal(text(panel("Coming up").querySelector(".gz-empty")), "No bill planned in the next 30 days. Plan one with its day, e.g. 15.49 STREAMFLIX fun @+30d.");
  assert.equal(text(panel("Renewals by deadline").querySelector(".gz-empty")), 'No renewal planned. Plan one with its deadline and the day to start, e.g. "Renew passport" 2027-03-14 @2027-01-13.');
});

test("Medication log with nothing logged: no doses today, no dose planned and how to plan one, and nothing in today's list", async () => {
  const all = await openEmpty("Apps/Medication log.md", { "Kinds/Dose.md": { fm: gallery("Kinds/Dose.md") } });
  const panel = (title: string) => all.find((p) => text(p.querySelector(".gz-title")) === title)!;
  assert.equal(text(panel("Doses today").querySelector(".gz-big")), "0");
  assert.equal(text(panel("Next dose").querySelector(".gz-empty, .gz-text")), "No dose planned yet.");
  assert.equal(text(panel("Today's doses").querySelector(".gz-empty")), 'Nothing taken or planned today yet. To plan the schedule, type in Gizmo Do…, e.g. dose "Medication A" @every day 08:00 until 2027-02-28.');
});

test("Practice with nothing logged: dashes that say nothing is logged, and the chart and table say the same", async () => {
  const kit = { "Components/Tracker kit.md": { fm: gallery("Components/Tracker kit.md") } };
  const [latest, week, , chart, entries] = await openEmpty("Apps/Practice.md", kit);
  assert.equal(text(latest.querySelector(".gz-big")), "—");
  assert.match(text(latest), /Nothing logged yet/);
  assert.equal(text(week.querySelector(".gz-big")), "—");
  assert.match(text(week), /Nothing logged this week yet/);
  assert.ok(!/Nothing to compare/.test(text(week)));
  assert.equal(text(chart.querySelector(".gz-empty")), "Nothing logged in the last 6 months yet.");
  assert.equal(text(entries.querySelector(".gz-empty")), "Nothing logged yet.");
});

test("Vitals, Trades, Household chores and Trip planner with nothing logged: dashes and zeros, and each list says how it fills", async () => {
  const kinds = (...paths: string[]) => Object.fromEntries(paths.map((p) => [p, { fm: gallery(p) }]));
  const said = (all: Element[]) => (title: string) => {
    const p = all.find((x) => text(x.querySelector(".gz-title")) === title)!;
    return text(p.querySelector(".gz-empty, .gz-big"));
  };
  const vitals = said(await openEmpty("Apps/Vitals.md", kinds("Kinds/Measurement.md")));
  assert.deepEqual(["Weight", "Pulse", "Sleep"].map(vitals), ["—", "—", "—"]);
  assert.equal(vitals("Blood pressure, each sitting"), "No blood pressure yet. Type a reading's two numbers, e.g. systolic 128, then diastolic 82.");
  assert.equal(vitals("Each measure"), "Nothing measured yet. Weigh in above, or export your phone's health data into Inbox/Health.");
  assert.equal(vitals("From my health export, not checked yet"), "Nothing from your health export waits. Export it as CSV into Inbox/Health.");

  const trades = said(await openEmpty("Apps/Trades.md", kinds("Kinds/Trade.md")));
  assert.deepEqual(["Cost of what I hold", "Bought this month", "Realized this year", "Still to buy"].map(trades), ["$0.00", "$0.00", "$0.00", "$0.00"]);
  assert.equal(trades("What I hold"), "No shares held. Log a buy above, e.g. VTI buy 5 312.40, or drop your broker's export in Inbox/Broker.");
  assert.equal(trades("Realized gain each year, at average cost"), "No sell logged yet.");
  assert.equal(trades("Planned buys"), "No buy planned. Plan one with its day, e.g. VTI 5 310 @+14d, or each month with @every month from 2026-12-01 until 2027-06-01.");

  const chores = said(await openEmpty("Apps/Household chores.md", kinds("Kinds/Chore.md", "Kinds/Spend.md")));
  assert.deepEqual(["Done this week", "Still to do this week", "Overdue", "Upkeep paid this year"].map(chores), ["0", "0", "0", "$0.00"]);
  assert.equal(chores("Overdue turns"), "Nothing overdue.");
  assert.equal(chores("Upkeep each month"), "No upkeep planned in the next 12 months.");
  assert.equal(chores("What upkeep cost"), "No upkeep paid yet. Add what a job cost, e.g. 24.99 furnace filter.");

  // The trip's bookings are a calendar file of its own, not rows anyone logs.
  const ics = readFileSync(new URL("../gallery/Trips/Tokyo.ics", import.meta.url), "utf8");
  const trip = said(await openEmpty("Apps/Trip planner.md", { ...kinds("Kinds/Spend.md", "Components/Destination weather.md"), "Trips/Tokyo.ics": { raw: ics } }));
  assert.deepEqual(["The trip comes to", "Spent so far", "Still to come"].map(trip), ["$0.00", "$0.00", "$0.00"]);
  assert.equal(trip("The trip's money"), "Nothing planned for the trip yet. Plan a cost with its day, e.g. 780 Hotel in Shinjuku @2027-03-14.");
  assert.equal(trip("Expenses"), "Nothing spent on the trip yet. Type what you pay abroad in yen above, e.g. Ramen 1500.");
  assert.equal(trip("The bank's charges in the trip's days"), "No charge from the bank in the trip's days yet.");
});
