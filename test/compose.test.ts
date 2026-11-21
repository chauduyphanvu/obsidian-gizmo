import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController, type Hosting } from "../src/app.ts";
import { answerGroups, compose, roleOf, type ValueKeys } from "../src/compose.ts";
import { composedWidth } from "../src/layout.ts";
import { readSpec, type Panel } from "../src/spec.ts";
import { VIEW_DEFS, viewDef, type PanelCtx } from "../src/views/registry.ts";
import { fakeEnv } from "./support/fakes.ts";

// The composed layout: each panel takes a role from its view, and an app reads as its answer, its
// line to add things, then the rest as written; a panel waiting for a pick waits in the sheet.

const APP = "Apps/W.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
const classes = (el: Element) => [...el.classList];
/** What an element holds, by its first class, or its view for a panel. */
const kinds = (el: Element) => [...el.children].map((c) => (c.classList.contains("gz-panel") ? c.className.split(" ")[1] : c.className.split(" ")[0]));

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/**
 * A controller on a fake vault, for APP in its own tab or, hosted, for the note it sits in (as an embed
 * is); `edit` changes a note the way Obsidian would and delivers the change.
 */
function setup(notes: Parameters<typeof fakeEnv>[0], hosting?: Hosting) {
  const t = fakeEnv(notes);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, hosting?.hostPath ?? APP, t.env, hosting);
  started.push(app);
  const edit = async (path: string, change: (fm: Record<string, unknown>) => void) => {
    const note = t.f.files.get(path) ?? {};
    note.fm ??= {};
    change(note.fm);
    t.f.files.set(path, note);
    t.changed(path);
    await settle();
  };
  /** Draws the app at this width, as a resize of its pane would. */
  const widen = async (width: number) => {
    Object.defineProperty(root.querySelector(".gizmo"), "clientWidth", { value: width, configurable: true });
    app.resize();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { ...t, app, root, edit, widen };
}

const SPEND = { spend: [{ at: "2026-11-17", amount: 5 }, { at: "2026-11-18", amount: 7 }] };
/** Every role, written in no particular order: two verbs, an answer with a meter, evidence, records and a sheet. */
const BUDGET = {
  app: "What I spend",
  panels: [
    { view: "form", title: "Spent", fields: { amount: "number" }, save: "spend" },
    { view: "number", title: "Spent so far", source: "spend", field: "amount", agg: "sum" },
    { view: "line", title: "Each day", source: "spend", x: "at", y: "amount" },
    { view: "progress", title: "Of my limit", source: "spend", field: "amount", agg: "sum", max: 100 },
    { view: "table", title: "Recent", source: "spend", columns: ["at", "amount"], select: "pick" },
    { view: "text", text: "Picked $pick.amount" },
    { view: "countdown", title: "Payday", to: "2026-12-01" },
    { view: "button", label: "Add one", save: "spend" },
  ],
};

// ---- Roles -----------------------------------------------------------------------------------------

test("each view has a role: the answer, a verb, evidence, a workspace or records", () => {
  assert.deepEqual(Object.fromEntries(VIEW_DEFS.map((d) => [d.id, roleOf({ view: d.id }, false)])), {
    number: "answer", text: "answer", countdown: "answer", progress: "answer",
    button: "verb", form: "verb",
    line: "evidence", bar: "evidence", pie: "evidence", scatter: "evidence",
    calendar: "workspace", board: "workspace", timeline: "workspace", timer: "workspace",
    table: "records", list: "records", checklist: "records", alerts: "records",
  });
  // A year of days is evidence; a month is a place to work. A form that writes the note's own properties is too.
  assert.equal(roleOf({ view: "calendar", layout: "year" }, false), "evidence");
  assert.equal(roleOf({ view: "form", save: "this" }, false), "workspace");
  assert.equal(roleOf({ view: "form", save: "log" }, false), "verb");
  assert.equal(roleOf({ view: "something new" }, false), "records");
});

test("a panel that reads a pick waits in the sheet, whatever its view", () => {
  for (const view of ["number", "form", "table", "line"]) assert.equal(roleOf({ view }, true), "sheet");
});

// ---- The answer --------------------------------------------------------------------------------------

const num = (keys: Partial<ValueKeys> = {}): ValueKeys => ({ view: "number", source: "log", ...keys });
const bar = (keys: Partial<ValueKeys> = {}): ValueKeys => ({ view: "progress", source: "log", ...keys });

test("the headline is the first number, else the first progress, else the first answer; the rest are facts", () => {
  assert.deepEqual(answerGroups([{ view: "text" }, bar({ source: "other" }), num(), { view: "countdown" }]), { headline: 2, facts: [0, 1, 3], meters: new Map() });
  assert.deepEqual(answerGroups([{ view: "countdown" }, bar(), { view: "text" }]), { headline: 1, facts: [0, 2], meters: new Map() });
  assert.deepEqual(answerGroups([{ view: "countdown" }, { view: "text" }]), { headline: 0, facts: [1], meters: new Map() });
  assert.deepEqual(answerGroups([]), { headline: undefined, facts: [], meters: new Map() });
});

test("a progress over the same value as a number is its meter, not a fact", () => {
  const spent = { source: "month", field: "amount", agg: "sum" as const };
  assert.deepEqual(answerGroups([num(spent), bar(spent)]), { headline: 0, facts: [], meters: new Map([[0, 1]]) });
  // A missing field or agg is the same as another missing one: both count the rows.
  const today = { where: { at: "today" } };
  assert.deepEqual(answerGroups([bar(today), num(today)]), { headline: 1, facts: [], meters: new Map([[1, 0]]) });
  // Another source, field, aggregate or where is another value.
  for (const other of [{ source: "spend" }, { field: "price" }, { agg: "avg" as const }, { where: { at: "this week" } }]) {
    assert.deepEqual(answerGroups([num(spent), bar({ ...spent, ...other })]), { headline: 0, facts: [1], meters: new Map() }, JSON.stringify(other));
  }
});

test("each number takes the first progress that matches it, and a progress goes to the first number", () => {
  // A second progress over the same value is a fact of its own.
  assert.deepEqual(answerGroups([num(), bar(), bar()]), { headline: 0, facts: [2], meters: new Map([[0, 1]]) });
  // Two numbers over one value share out the progress panels in turn.
  assert.deepEqual(answerGroups([num(), num(), bar(), bar()]), { headline: 0, facts: [1], meters: new Map([[0, 2], [1, 3]]) });
  // A fact keeps its meter too.
  assert.deepEqual(answerGroups([num({ source: "a" }), num({ source: "b" }), bar({ source: "b" })]), { headline: 0, facts: [1], meters: new Map([[1, 2]]) });
});

test("an app is composed scope by scope: outside any tab first, then each tab as first written", () => {
  const p = (panel: Panel, inputs: string[] = []) => ({ panel, inputs });
  const { scopes, placements } = compose([
    p({ view: "line", tab: "Chart" }),
    p({ view: "form" }),
    p({ view: "number", source: "log" }),
    p({ view: "table", select: "pick" }),
    p({ view: "text" }, ["pick"]),
    p({ view: "number", tab: "Chart" }),
    p({ view: "progress", source: "log" }),
    p({ view: "list", tab: "Other" }, ["q"]),
  ], ["pick"]);
  assert.deepEqual(scopes, [
    { tab: undefined, answer: { headline: 2, facts: [], meters: new Map([[2, 6]]) }, compose: [1], flow: [3], sheet: [4] },
    { tab: "Chart", answer: { headline: 5, facts: [], meters: new Map() }, compose: [], flow: [0], sheet: [] },
    { tab: "Other", answer: { headline: undefined, facts: [], meters: new Map() }, compose: [], flow: [7], sheet: [] },
  ]);
  assert.deepEqual(placements, [
    { role: "evidence", slot: "flow" },
    { role: "verb", slot: "compose" },
    { role: "answer", slot: "headline" },
    { role: "records", slot: "flow" },
    { role: "sheet", slot: "sheet" },
    { role: "answer", slot: "headline" },
    { role: "answer", slot: "meter" },
    { role: "records", slot: "flow" },
  ]);
});

// ---- The composed page -------------------------------------------------------------------------------

test("an app in its own tab reads as a page: title and description, the answer, the line to add things, then the rest", async () => {
  const { app, root } = setup({ [APP]: { fm: BUDGET }, "Apps/W data.md": { fm: SPEND } });
  app.load();
  await settle();
  const shell = root.querySelector(".gizmo")!;
  assert.ok(shell.classList.contains("gz-composed"));
  assert.equal(root.querySelector(".gz-grid"), null);
  assert.deepEqual(kinds(shell), ["gz-header", "gz-body"]);

  // The head: the note's name and what it's for, then the rail slot, empty for now.
  const header = root.querySelector(".gz-header")!;
  assert.deepEqual(kinds(header), ["gz-head", "gz-rail-slot"]);
  assert.equal(text(header.querySelector(".gz-head .gz-app-title")), "W");
  assert.equal(text(header.querySelector(".gz-head .gz-description")), "What I spend");
  assert.equal(app.railSlot(), header.querySelector(".gz-rail-slot"));
  assert.equal(app.railSlot()!.childNodes.length, 0);

  const body = root.querySelector(".gz-body")!;
  assert.deepEqual([...body.children].map((c) => `${c.tagName.toLowerCase()}.${c.className}`), ["section.gz-answer", "section.gz-compose", "div.gz-flow"]);
  // The answer: the headline with its meter in one slot, and the facts beside it.
  const [answer, line, flow] = [...body.children];
  assert.deepEqual(kinds(answer), ["gz-slot", "gz-facts"]);
  const [lead, facts] = [...answer.children];
  assert.deepEqual(kinds(lead), ["gz-view-number", "gz-view-progress"]);
  assert.deepEqual(classes(lead.children[0]).filter((c) => c !== "gz-loading"), ["gz-panel", "gz-view-number", "gz-role-answer", "gz-headline"]);
  assert.deepEqual(classes(lead.children[1]).filter((c) => c !== "gz-loading"), ["gz-panel", "gz-view-progress", "gz-role-answer", "gz-meter"]);
  assert.equal(text(lead.querySelector(".gz-view-number .gz-big")), "12");
  assert.deepEqual([...facts.children].map(kinds), [["gz-view-countdown"]]);
  assert.ok(facts.querySelector(".gz-view-countdown")!.classList.contains("gz-fact"));
  // The verbs in the order written, then the evidence and the records, and the sheet last.
  assert.deepEqual(kinds(line), ["gz-view-form", "gz-view-button"]);
  assert.deepEqual(kinds(flow), ["gz-view-line", "gz-view-table", "gz-sheet-slot"]);
  assert.deepEqual([...root.querySelectorAll(".gz-panel")].map((el) => classes(el).find((c) => c.startsWith("gz-role-"))),
    ["gz-role-answer", "gz-role-answer", "gz-role-answer", "gz-role-verb", "gz-role-verb", "gz-role-evidence", "gz-role-records", "gz-role-sheet"]);
});

test("a panel waiting for a pick waits in the sheet slot, out of sight, and shows once a row is picked", async () => {
  const { app, root } = setup({ [APP]: { fm: BUDGET }, "Apps/W data.md": { fm: SPEND } });
  app.load();
  await settle();
  const slot = root.querySelector(".gz-flow > .gz-sheet-slot")!;
  const waiting = slot.querySelector(".gz-panel")!;
  assert.deepEqual(kinds(slot), ["gz-view-text"]);
  assert.ok(waiting.classList.contains("gz-role-sheet"));
  assert.ok(waiting.classList.contains("gz-collapsed"));
  assert.equal(waiting.childNodes.length, 0);
  assert.equal(root.querySelector(".gz-waiting"), null);

  const row = root.querySelectorAll(".gz-view-table tbody tr")[1];
  click(row);
  await settle();
  assert.equal(root.querySelector(".gz-sheet-slot .gz-panel"), waiting);
  assert.ok(!waiting.classList.contains("gz-collapsed"));
  assert.equal(text(waiting.querySelector(".gz-text")), "Picked 7");
  // Picking it again clears the pick, and the panel waits out of sight again.
  click(row);
  await settle();
  assert.ok(waiting.classList.contains("gz-collapsed"));
  assert.equal(waiting.childNodes.length, 0);
});

test("a part of a scope with no panels is left out", async () => {
  const { app, root } = setup({ [APP]: { fm: { app: "x", panels: [{ view: "table", source: "spend", columns: ["at"] }] } }, "Apps/W data.md": { fm: SPEND } });
  app.load();
  await settle();
  assert.deepEqual(kinds(root.querySelector(".gz-body")!), ["gz-flow"]);
  assert.deepEqual(kinds(root.querySelector(".gz-flow")!), ["gz-view-table"]);
});

test("tabs: the panels outside any tab, the bar, then a pane per tab; switching keeps elements and typed text", async () => {
  const { app, root } = setup({
    [APP]: { fm: { app: "x", panels: [
      { view: "countdown", to: "2027-01-01" },
      { view: "form", fields: { weight: "number" }, save: "weights", tab: "Log" },
      { view: "line", source: "weights", x: "at", y: "weight", tab: "Chart" },
      { view: "countdown", to: "2027-02-01", tab: "Log" },
    ] } },
    "Apps/W data.md": { fm: { weights: [{ at: "2026-11-17", weight: 80 }, { at: "2026-11-18", weight: 79 }] } },
  });
  app.load();
  await settle();
  const body = root.querySelector(".gz-body")!;
  assert.deepEqual(kinds(body), ["gz-answer", "gz-tabs", "gz-tabpane", "gz-tabpane"]);
  const [, , log, chart] = [...body.children];
  assert.deepEqual(kinds(log), ["gz-answer", "gz-compose"]);
  assert.deepEqual(kinds(chart), ["gz-flow"]);
  const tabs = [...root.querySelectorAll("button.gz-tab")] as HTMLButtonElement[];
  assert.deepEqual(tabs.map((b) => [b.textContent, b.classList.contains("is-active")]), [["Log", true], ["Chart", false]]);
  assert.deepEqual([log, chart].map((p) => p.classList.contains("gz-off")), [false, true]);
  // A chart in a hidden tab is still drawn at its real width: the column's.
  assert.equal(root.querySelector(".gz-chart-svg")!.getAttribute("viewBox"), "0 0 760 220");

  const input = root.querySelector(".gz-form input") as HTMLInputElement;
  input.value = "77";
  tabs[1].click();
  assert.deepEqual([log, chart].map((p) => p.classList.contains("gz-off")), [true, false]);
  assert.deepEqual(tabs.map((b) => b.classList.contains("is-active")), [false, true]);
  tabs[0].click();
  assert.equal(root.querySelector(".gz-form input"), input);
  assert.equal(input.value, "77");
});

test("every panel draws at the column's width: at most 760 px in its own tab, less 44 px each side, or 16 px when narrow", async () => {
  assert.deepEqual([0, 1400, 848, 700, 600, 599, 390].map((w) => composedWidth(w)), [760, 760, 760, 612, 512, 567, 358]);
  // Hosted, the host's width with no padding; not laid out yet, the widest app tab.
  assert.deepEqual([390, 1400, 0].map((w) => composedWidth(w, 0, Infinity)), [390, 1400, 848]);

  const line = { view: "line", source: "weights", x: "at", y: "kg" };
  const weights = { fm: { weights: [{ at: "2026-11-01", kg: 80 }, { at: "2026-11-02", kg: 79 }] } };
  const viewBox = (root: Element) => root.querySelector(".gz-chart-svg")!.getAttribute("viewBox");
  const own = setup({ [APP]: { fm: { app: "W", ...line } }, "Apps/W data.md": weights });
  own.app.load();
  await settle();
  const shell = own.root.querySelector(".gizmo")!;
  for (const [width, drawn, narrow] of [[1400, 760, false], [700, 612, false], [500, 468, true]] as const) {
    await own.widen(width);
    assert.equal(viewBox(own.root), `0 0 ${drawn} 220`, `at ${width}`);
    assert.equal(shell.classList.contains("gz-narrow"), narrow, `at ${width}`);
  }

  const embed = setup({ "Notes/Day.md": { fm: {} }, "Notes/Day data.md": weights }, { kind: "embed", grantKey: "Notes/Day.md#k", hostPath: "Notes/Day.md", definition: () => ({ app: "", ...line }) });
  embed.app.load();
  await settle();
  for (const width of [1400, 700, 500]) {
    await embed.widen(width);
    assert.equal(viewBox(embed.root), `0 0 ${width} 220`, `hosted at ${width}`);
  }
});

test("hosted, an app keeps its description alone: no title and no rail slot", async () => {
  const { app, root } = setup({ "Notes/Day.md": { fm: {} } }, {
    kind: "embed", grantKey: "Notes/Day.md#k", hostPath: "Notes/Day.md", definition: () => ({ app: "Days to go", view: "countdown", to: "2027-01-01" }),
  });
  app.load();
  await settle();
  assert.ok(root.querySelector(".gizmo")!.classList.contains("gz-composed"));
  assert.deepEqual(kinds(root.querySelector(".gz-header")!), ["gz-description"]);
  assert.equal(root.querySelector(".gz-app-title, .gz-rail-slot"), null);
  assert.equal(app.railSlot(), undefined);
  assert.ok(root.querySelector(".gz-answer .gz-view-countdown.gz-headline"));
});

test("a view asks where it sits; editing the app can move it, and it is drawn again there", async () => {
  const number = viewDef("number")!;
  const mount = number.mount;
  const drawn: { title?: string; ctx: PanelCtx }[] = [];
  number.mount = (el, p, ctx, key) => {
    drawn.push({ title: p.title, ctx });
    return mount(el, p, ctx, key);
  };
  try {
    const panels = [{ view: "number", title: "A", source: "spend" }, { view: "number", title: "B", source: "spend", field: "amount", agg: "sum" }];
    const { app, edit } = setup({ [APP]: { fm: { app: "x", panels } }, "Apps/W data.md": { fm: SPEND } });
    app.load();
    await settle();
    const last = (title: string) => drawn.filter((d) => d.title === title).at(-1)!.ctx;
    assert.deepEqual([last("A").place?.(), last("B").place?.()], [{ role: "answer", slot: "headline" }, { role: "answer", slot: "fact" }]);
    const before = drawn.length;
    // A new number first: A becomes a fact and is drawn again; B stays a fact and stays as it is.
    await edit(APP, (fm) => { fm.panels = [{ view: "number", title: "C", source: "spend" }, ...panels]; });
    assert.deepEqual(drawn.slice(before).map((d) => d.title).sort(), ["A", "C"]);
    assert.deepEqual([last("C").place?.(), last("A").place?.(), last("B").place?.()],
      [{ role: "answer", slot: "headline" }, { role: "answer", slot: "fact" }, { role: "answer", slot: "fact" }]);
    // On the grid there is no place to ask for.
    await edit(APP, (fm) => { fm.layout = "grid"; });
    assert.equal(last("A").place?.(), undefined);
  } finally {
    number.mount = mount;
  }
});

// ---- layout: grid ------------------------------------------------------------------------------------

test("layout: grid draws the grid as before: panels as written, spans as classes, the placeholder for a pick", async () => {
  const { app, root } = setup({ [APP]: { fm: { ...BUDGET, layout: "grid" } }, "Apps/W data.md": { fm: SPEND } });
  app.load();
  await settle();
  const shell = root.querySelector(".gizmo")!;
  assert.deepEqual(classes(shell), ["gizmo"]);
  assert.deepEqual(kinds(shell), ["gz-header", "gz-grid"]);
  assert.deepEqual(kinds(root.querySelector(".gz-header")!), ["gz-description"]);
  assert.equal(root.querySelector(".gz-head, .gz-app-title, .gz-rail-slot, .gz-body, section"), null);
  assert.equal(app.railSlot()!.isConnected, false);
  const grid = root.querySelector(".gz-grid")!;
  assert.equal(grid.className, "gz-grid gz-cols-4");
  assert.deepEqual(kinds(grid), BUDGET.panels.map((p) => `gz-view-${p.view}`));
  assert.ok([...grid.children].every((el) => classes(el).some((c) => c.startsWith("gz-span-")) && !classes(el).some((c) => /^gz-(role-|headline|fact|meter|collapsed)/.test(c))));
  assert.equal(text(root.querySelector(".gz-view-text .gz-waiting")), "Pick a row in “Recent”");
});

test("changing the layout in the note draws every panel afresh in the new one", async () => {
  const { app, root, edit } = setup({ [APP]: { fm: BUDGET }, "Apps/W data.md": { fm: SPEND } });
  app.load();
  await settle();
  const composed = root.querySelector(".gz-view-number");
  await edit(APP, (fm) => { fm.layout = "grid"; });
  assert.equal(root.querySelector(".gz-body"), null);
  assert.ok(root.querySelector(".gz-grid .gz-view-number"));
  assert.notEqual(root.querySelector(".gz-view-number"), composed);
  assert.ok(!root.querySelector(".gizmo")!.classList.contains("gz-composed"));
  await edit(APP, (fm) => { delete fm.layout; });
  assert.equal(root.querySelector(".gz-grid"), null);
  assert.ok(root.querySelector(".gz-body .gz-answer .gz-view-number.gz-headline"));
  assert.equal(text(root.querySelector(".gz-app-title")), "W");
});

test("layout is composed or grid, composed when left out; in a note that is one panel, any other layout is the panel's", () => {
  const read = (fm: Record<string, unknown>) => readSpec(fm, { path: APP })!;
  const panels = [{ view: "countdown", to: "2027-01-01" }];
  assert.equal(read({ app: "x", panels }).spec!.layout, "composed");
  assert.equal(read({ app: "x", panels, layout: "grid" }).spec!.layout, "grid");
  assert.equal(read({ app: "x", panels, layout: "composed" }).spec!.layout, "composed");
  const wrong = read({ app: "x", panels, layout: "cards" });
  assert.deepEqual(wrong.errors, ["layout must be composed or grid, e.g. layout: grid"]);
  assert.equal(wrong.spec!.layout, "composed");
  // Only text is the setting: a list called layout is data.
  assert.deepEqual(read({ app: "x", panels, layout: [{ a: 1 }] }).errors, []);

  const cards = read({ app: "x", view: "table", source: "books", layout: "cards" });
  assert.deepEqual(cards.errors, []);
  assert.equal(cards.spec!.layout, "composed");
  assert.equal(cards.spec!.panels[0].panel.layout, "cards");
  const grid = read({ app: "x", view: "table", source: "books", layout: "grid" });
  assert.deepEqual(grid.errors, []);
  assert.equal(grid.spec!.layout, "grid");
  assert.equal(grid.spec!.panels[0].panel.layout, undefined);
  assert.deepEqual(read({ app: "x", view: "table", source: "books", layout: "rows" }).errors, ["layout must be cards"]);
});
