import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASES_VIEWS, basesPanel, entryIds, entryRow, fieldOf, optionValues, writeErrors, type BaseEntry, type BasesKind } from "../src/bases-rows.ts";
import type { Row } from "../src/data.ts";
import { DataLayer } from "../src/datalayer.ts";
import { compilePipeline } from "../src/pipeline.ts";
import type { Panel } from "../src/spec.ts";
import { mountView } from "../src/views/common.ts";
import { viewDef, type PanelCtx } from "../src/views/registry.ts";
import { fakeHost } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12);
const BASE = "Bases/Projects.base";
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const NOTES = {
  "Projects/Garden beds.md": { fm: { status: "doing", due: "2026-11-30", hours: 3 }, tags: ["#home"] },
  "Projects/Kitchen remodel.md": { fm: { status: "doing", due: "2026-11-30", hours: 5 } },
  "Projects/Tax filing.md": { fm: { status: "done", due: "2026-11-04", hours: 2 } },
};

/** An entry as Bases hands it over: the note's file, and the values only Bases knows (formulas, some file properties). */
function entry(path: string, values: Record<string, unknown> = {}, stat = { mtime: 0, ctime: 0 }): BaseEntry {
  return { file: { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), stat }, getValue: (id) => values[id] ?? null };
}

/** The rows a base over NOTES gives, as a view converts its entries. */
function baseRows(): Row[] {
  const f = fakeHost(NOTES);
  return Object.keys(NOTES).map((path) => entryRow(entry(path), [], f.host));
}

/** Builds a panel from option values (property options as Bases keeps them, by property id). */
const build = (kind: BasesKind, options: Record<string, unknown>) => basesPanel(kind, (key) => options[key], BASE);

function built(kind: BasesKind, options: Record<string, unknown>): Panel {
  const { panel, errors } = build(kind, options);
  assert.deepEqual(errors, []);
  return panel!;
}

/** What a view mounted from a base may ask; edits and opened notes are recorded. */
function fakeCtx() {
  const edits: { row: Row; field: string; value: unknown }[] = [];
  const opened: string[] = [];
  const ctx = {
    now: NOW,
    width: () => 600,
    openNote: (path: string) => { opened.push(path); },
    editRow: async (row: Row, field: string, value: unknown) => { edits.push({ row, field, value }); },
    select: () => {},
    selected: () => undefined,
  } as unknown as PanelCtx;
  return { ctx, edits, opened };
}

/** Mounts a built panel in a panel element, as the Bases view does, and feeds it rows through its pipeline. */
function mount(panel: Panel, rows: Row[], ctx = fakeCtx().ctx) {
  const el = document.createElement("div");
  el.className = "gz-panel";
  document.body.appendChild(el);
  const handle = mountView(viewDef(panel.view)!, el, panel, ctx, "bases");
  handle.update(compilePipeline(panel, NOW)(rows));
  return el;
}

test("a base's note is the row source: notes gives, with the values only Bases knows under their ids", () => {
  const f = fakeHost(NOTES);
  const path = "Projects/Garden beds.md";
  const notesRow = new DataLayer(f.host).notes("Projects").find((r) => r.path === path);
  const row = entryRow(entry(path, { "formula.left": 12, "file.ext": "md" }), ["formula.left", "file.ext"], f.host);
  assert.deepEqual(row.tags, ["#home"]);
  assert.equal(row.name, "Garden beds");
  assert.deepEqual(row, { ...notesRow, "formula.left": 12, "file.ext": "md" });
});

test("a row's file times are the note's, as local date and time, over properties of those names", () => {
  const stat = { mtime: new Date(2026, 10, 18, 9, 30).getTime(), ctime: new Date(2026, 0, 2, 8, 5).getTime() };
  const row = entryRow(entry("Projects/Garden beds.md", {}, stat), [], { frontmatter: () => ({ mtime: "typed", area: "home" }), tags: () => [] });
  assert.deepEqual(row, { area: "home", name: "Garden beds", path: "Projects/Garden beds.md", tags: [], mtime: "2026-11-18T09:30", ctime: "2026-01-02T08:05" });
  const bare = entryRow(entry("Inbox/Loose.md", {}, stat), [], { frontmatter: () => undefined, tags: () => [] });
  assert.deepEqual(bare, { name: "Loose", path: "Inbox/Loose.md", tags: [], mtime: "2026-11-18T09:30", ctime: "2026-01-02T08:05" });
});

test("property ids become row fields: note properties by name, file properties as a notes row names them", () => {
  assert.equal(fieldOf("note.status"), "status");
  assert.equal(fieldOf("note.a.b"), "a.b");
  assert.equal(fieldOf("formula.left"), "formula.left");
  assert.equal(fieldOf("file.name"), "name");
  assert.equal(fieldOf("file.basename"), "name");
  assert.equal(fieldOf("file.path"), "path");
  assert.equal(fieldOf("file.mtime"), "mtime");
  assert.equal(fieldOf("file.ctime"), "ctime");
  assert.equal(fieldOf("file.tags"), "tags");
  assert.equal(fieldOf("file.folder"), "file.folder");
});

test("only formulas and file properties a notes row lacks are read from the entry, each once", () => {
  assert.deepEqual(
    entryIds(["note.status", "formula.left", "file.name", "file.mtime", "file.folder", "formula.left", "file.tags"]),
    ["formula.left", "file.folder"],
  );
});

test("board: group by and card text become the board's group and item, over the base's notes", () => {
  assert.deepEqual(built("board", { group: "note.status", item: "{name} · {due}" }), { view: "board", source: BASE, group: "status", item: "{name} · {due}" });
  assert.deepEqual(build("board", {}).errors, ["board needs group (the field its columns come from)"]);
  assert.equal(build("board", { item: "  " }).panel, undefined);
});

test("board: a group it couldn't write to is refused, whoever works it out", () => {
  assert.deepEqual(build("board", { group: "formula.stage" }).errors, ['edit: "formula.stage" is a formula in the base']);
  assert.deepEqual(build("board", { group: "file.folder" }).errors, ['edit: "file.folder" comes from the note\'s file, not its properties']);
  assert.deepEqual(build("board", { group: "file.name" }).errors, ['edit: "name" comes from the note\'s file, not its properties']);
});

test("calendar: a date counts per day by default; a total other than count needs a value", () => {
  assert.deepEqual(built("calendar", { date: "note.due" }), { view: "calendar", source: BASE, group: "due" });
  assert.deepEqual(built("calendar", { date: "note.due", layout: "year" }), { view: "calendar", source: BASE, group: "due", layout: "year" });
  assert.deepEqual(built("calendar", { date: "note.due", layout: "month", agg: "sum", value: "note.hours" }), { view: "calendar", source: BASE, group: "due", y: "hours", agg: "sum" });
  // Counting reads no value, so one left over from a total isn't used.
  assert.deepEqual(built("calendar", { date: "note.due", agg: "count", value: "note.hours" }), { view: "calendar", source: BASE, group: "due" });
  assert.deepEqual(build("calendar", { date: "note.due", agg: "avg" }).errors, ["Average needs a value"]);
  assert.deepEqual(build("calendar", {}).errors, ["calendar needs group (a date field)"]);
});

test("timeline: start, end and row text; start is required", () => {
  assert.deepEqual(built("timeline", { start: "note.start", end: "note.due", item: "{name}" }), { view: "timeline", source: BASE, start: "start", end: "due", item: "{name}" });
  assert.deepEqual(built("timeline", { start: "file.ctime" }), { view: "timeline", source: BASE, start: "ctime" });
  assert.deepEqual(build("timeline", { end: "note.due" }).errors, ["timeline needs start (a date field)"]);
});

test("chart: a bar of notes counted per x by default; a total, a period and a goal", () => {
  assert.deepEqual(built("chart", { x: "note.area" }), { view: "bar", source: BASE, group: "area" });
  assert.deepEqual(
    built("chart", { chart: "line", x: "note.due", per: "week", agg: "sum", y: "note.hours", goal: "40" }),
    { view: "line", source: BASE, group: "due", per: "week", y: "hours", agg: "sum", goal: 40 },
  );
  // Typed straight into the .base file, a goal reads back as a number.
  assert.equal(built("chart", { chart: "bar", x: "note.area", goal: 7 }).goal, 7);
  assert.deepEqual(build("chart", { x: "note.area", goal: "high" }).errors, ['"goal" has the wrong type (expected number)']);
  assert.deepEqual(build("chart", { x: "note.due", agg: "max" }).errors, ["Max needs y"]);
  assert.deepEqual(build("chart", {}).errors, ["bar needs x and y"]);
});

test("chart: no total draws a point per note; pie and scatter take only what they use", () => {
  assert.deepEqual(built("chart", { chart: "line", x: "note.due", agg: "none", y: "formula.left", per: "week" }), { view: "line", source: BASE, x: "due", y: "formula.left" });
  assert.deepEqual(built("chart", { chart: "pie", x: "note.area", goal: "5" }), { view: "pie", source: BASE, group: "area" });
  assert.deepEqual(built("chart", { chart: "pie", x: "note.area", agg: "none", y: "note.hours" }), { view: "pie", source: BASE, x: "area", y: "hours" });
  assert.deepEqual(built("chart", { chart: "scatter", x: "note.hours", y: "file.size", agg: "sum", per: "day", goal: "3" }), { view: "scatter", source: BASE, x: "hours", y: "file.size" });
  assert.deepEqual(build("chart", { chart: "scatter", x: "note.hours" }).errors, ["scatter needs x and y"]);
  assert.deepEqual(build("chart", { chart: "line", x: "note.due", agg: "none" }).errors, ["line needs x and y"]);
});

test("chart: a type Bases doesn't know falls back to the first choice", () => {
  assert.equal(built("chart", { chart: "radar", x: "note.area" }).view, "bar");
});

test("number: counts the base's notes by default; other totals need a property", () => {
  assert.deepEqual(built("number", {}), { view: "number", source: BASE, agg: "count" });
  assert.deepEqual(built("number", { agg: "avg", field: "note.hours", label: "hours a project" }), { view: "number", source: BASE, agg: "avg", field: "hours", label: "hours a project" });
  assert.deepEqual(build("number", { agg: "last" }).errors, ["Last needs a property"]);
});

test("options Bases hides are the ones the others make meaningless", () => {
  const hidden = (kind: BasesKind, options: Record<string, unknown>) => BASES_VIEWS[kind].options
    .filter((o) => o.hidden?.(optionValues(kind, (key) => options[key]))).map((o) => o.key);
  assert.deepEqual(hidden("chart", {}), ["y"]);
  assert.deepEqual(hidden("chart", { agg: "sum" }), []);
  assert.deepEqual(hidden("chart", { chart: "pie", agg: "none" }), ["per", "goal"]);
  assert.deepEqual(hidden("chart", { chart: "scatter" }), ["agg", "per", "goal"]);
  assert.deepEqual(hidden("calendar", {}), ["value"]);
  assert.deepEqual(hidden("number", { agg: "max" }), []);
});

test("a write to a base's note: only a property of the note, never a formula, a file field or a definition", () => {
  const p = built("board", { group: "note.status" });
  assert.deepEqual(writeErrors(p, "status"), []);
  assert.deepEqual(writeErrors(p, "formula.stage"), ['edit: "formula.stage" is a formula in the base']);
  assert.deepEqual(writeErrors(p, "file.folder"), ['edit: "file.folder" comes from the note\'s file, not its properties']);
  assert.deepEqual(writeErrors(p, "mtime"), ['edit: "mtime" comes from the note\'s file, not its properties']);
  assert.match(writeErrors(p, "panels")[0], /^edit can't change "panels"/);
});

test("a board built from a base: a column per status, cards link to their notes, Move to… edits the note's row", () => {
  const { ctx, edits, opened } = fakeCtx();
  const el = mount(built("board", { group: "note.status", item: "{name} · due {due}" }), baseRows(), ctx);
  const columns = [...el.querySelectorAll(".gz-board-col")].map((c) => c.getAttribute("aria-label"));
  assert.deepEqual(columns, ["doing", "done"]);
  const card = [...el.querySelectorAll(".gz-board-card")].find((c) => text(c).startsWith("Tax filing"))!;
  assert.equal(text(card.querySelector(".gz-board-text")), "Tax filing · due 2026-11-04");
  card.querySelector("a")!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ["Projects/Tax filing.md"]);
  const move = card.querySelector("select.gz-move") as HTMLSelectElement;
  for (const o of move.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "doing");
  move.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(edits.length, 1);
  assert.equal(edits[0].row.path, "Projects/Tax filing.md");
  assert.equal(edits[0].field, "status");
  assert.equal(edits[0].value, "doing");
});

test("a calendar built from a base counts the notes due each day, or totals a value", () => {
  const counted = mount(built("calendar", { date: "note.due" }), baseRows());
  assert.equal(text(counted.querySelector(".gz-cal-title")), new Date(2026, 10, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }));
  assert.equal(text(counted.querySelector('[data-date="2026-11-30"] .gz-cal-val')), "2");
  assert.equal(text(counted.querySelector('[data-date="2026-11-04"] .gz-cal-val')), "1");
  assert.equal(counted.querySelector('[data-date="2026-11-05"] .gz-cal-val'), null);
  const summed = mount(built("calendar", { date: "note.due", agg: "sum", value: "note.hours" }), baseRows());
  assert.equal(text(summed.querySelector('[data-date="2026-11-30"] .gz-cal-val')), "8");
});
