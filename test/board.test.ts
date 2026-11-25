import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import type { Row } from "../src/data.ts";
import { compilePipeline } from "../src/pipeline.ts";
import { checkPanel, readSpec, type Panel } from "../src/spec.ts";
import { permissionsOf } from "../src/permissions.ts";
import { board } from "../src/views/board.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { fakeEnv } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const event = (el: Element, type: string) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

const SCHEMA = { status: ["idea", "doing", "done"] };
const ROWS: Row[] = [
  { name: "Garden", path: "Projects/Garden.md", status: "doing", area: "home" },
  { name: "Rust", path: "Projects/Rust.md", status: "idea", area: "learning" },
  { name: "Taxes", path: "Projects/Taxes.md", status: "done", area: "money" },
  { name: "Kitchen", path: "Projects/Kitchen.md", status: "doing", area: "home" },
  { name: "Trip", path: "Projects/Trip.md", status: "blocked", area: "travel" },
  { name: "Loose end", path: "Projects/Loose end.md", area: "home" },
];

interface Edit { row: Row; field: string; value: unknown }

/** A ctx that records edits and selections; `editRow` waits on `gate` when one is given. */
function fakeCtx(gate?: Promise<void>) {
  const edits: Edit[] = [];
  const opened: string[] = [];
  const picked: (Row | undefined)[] = [];
  const selections = new Map<string, Row>();
  const ctx = {
    now: NOW,
    width: () => 600,
    openNote: (path: string) => { opened.push(path); },
    editRow: async (row: Row, field: string, value: unknown) => { edits.push({ row, field, value }); await gate; },
    select: (name: string, row: Row | undefined) => {
      picked.push(row);
      if (row) selections.set(name, row);
      else selections.delete(name);
    },
    selected: (name: string) => selections.get(name),
  } as unknown as PanelCtx;
  return { ctx, edits, opened, picked };
}

function mount(keys: Record<string, unknown>, data: unknown, ctx = fakeCtx().ctx, internal: Partial<Panel> = { schema: SCHEMA }) {
  const { panel, errors } = checkPanel({ view: "board", source: "notes", from: "Projects", group: "status", ...keys }, true, internal);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const handle = board.mount(el, panel as Panel, ctx, "k");
  handle.update(data);
  return { el, handle };
}

const names = (el: Element) => [...el.querySelectorAll(".gz-board-name")].map((n) => text(n));
const column = (el: Element, name: string) => [...el.querySelectorAll(".gz-board-col")].find((c) => text(c.querySelector(".gz-board-name")) === name)!;
const cards = (col: Element) => [...col.querySelectorAll(".gz-board-card")] as HTMLElement[];
const card = (el: Element, name: string) => cards(el).find((c) => text(c.querySelector(".gz-board-text")) === name)!;

test("a board is never grouped by the pipeline, so cards stay raw rows", () => {
  const p = checkPanel({ view: "board", source: "notes", from: "Projects", group: "status" }, true).panel as Panel;
  assert.equal(p.group, "status");
  assert.deepEqual(compilePipeline(p, NOW)([{ status: "a" }, { status: "a" }]), [{ status: "a" }, { status: "a" }]);
  // Without the board, the same keys would have grouped.
  assert.deepEqual(compilePipeline({ group: "status" }, NOW)([{ status: "a" }, { status: "a" }]), [{ status: "a", count: 2 }]);
});

test("columns follow the schema's choices, then other values as they appear, then (none) when used", () => {
  const { el } = mount({}, ROWS);
  assert.deepEqual(names(el), ["idea", "doing", "done", "blocked", "(none)"]);
  assert.deepEqual([...el.querySelectorAll(".gz-board-count")].map((n) => text(n)), ["1", "2", "1", "1", "1"]);
  assert.deepEqual(cards(column(el, "doing")).map((c) => text(c.querySelector(".gz-board-text"))), ["Garden", "Kitchen"]);
  assert.deepEqual(cards(column(el, "(none)")).map((c) => text(c.querySelector(".gz-board-text"))), ["Loose end"]);
});

test("a schema's empty column is still drawn to drop on; without one, order is first appearance and (none) is left out when empty", () => {
  const { el } = mount({}, [{ name: "Rust", path: "Projects/Rust.md", status: "idea" }]);
  assert.deepEqual(names(el), ["idea", "doing", "done"]);
  assert.equal(text(column(el, "doing").querySelector(".gz-empty")), "Nothing here");
  const loose = mount({}, [{ name: "b", status: "z" }, { name: "a", status: "y" }, { name: "c", status: "z" }], undefined, {});
  assert.deepEqual(names(loose.el), ["z", "y"]);
  assert.equal(text(mount({}, [], undefined, {}).el.querySelector(".gz-empty")), "Nothing here yet.");
});

test("a card says what item says, else name, title or its first text; a note's card is a link", () => {
  const { ctx, opened } = fakeCtx();
  const { el } = mount({ item: "{name} · {area}" }, ROWS, ctx);
  assert.equal(text(card(el, "Garden · home").querySelector(".gz-board-text")), "Garden · home");
  const link = card(el, "Garden · home").querySelector("a.internal-link") as HTMLElement;
  link.click();
  assert.deepEqual(opened, ["Projects/Garden.md"]);
  const plain = mount({ source: "todos" }, [{ title: "Pay rent", status: "idea" }, { room: "kitchen", status: "idea" }], undefined, { schema: SCHEMA });
  assert.deepEqual(cards(plain.el).map((c) => [text(c.querySelector(".gz-board-text")), c.querySelector("a")]), [["Pay rent", null], ["kitchen", null]]);
});

test("dropping a card on another column writes the group field through editRow", async () => {
  const { ctx, edits } = fakeCtx();
  const { el } = mount({}, ROWS, ctx);
  const garden = card(el, "Garden");
  assert.equal(garden.getAttribute("draggable"), "true");
  event(garden, "dragstart");
  assert.ok(garden.classList.contains("gz-dragging"));
  // Over its own column nothing is accepted; over another one the drop is allowed.
  assert.equal(event(column(el, "doing"), "dragover").defaultPrevented, false);
  const over = event(column(el, "done"), "dragover");
  assert.equal(over.defaultPrevented, true);
  assert.ok(column(el, "done").classList.contains("gz-over"));
  const drop = event(column(el, "done"), "drop");
  assert.equal(drop.defaultPrevented, true);
  assert.ok(!column(el, "done").classList.contains("gz-over"));
  await settle();
  assert.deepEqual(edits, [{ row: ROWS[0], field: "status", value: "done" }]);
});

test("dropping on (none) clears the field; dropping on the same column, or after the drag ended, writes nothing", async () => {
  const { ctx, edits } = fakeCtx();
  const { el } = mount({}, ROWS, ctx);
  event(card(el, "Garden"), "dragstart");
  event(column(el, "(none)"), "drop");
  await settle();
  assert.deepEqual(edits, [{ row: ROWS[0], field: "status", value: null }]);
  event(card(el, "Rust"), "dragstart");
  event(column(el, "idea"), "drop");
  event(card(el, "Rust"), "dragend");
  event(column(el, "done"), "drop");
  await settle();
  assert.equal(edits.length, 1);
});

test("a card is dimmed while its write runs, and is back to normal after", async () => {
  let release!: () => void;
  const { ctx } = fakeCtx(new Promise<void>((r) => { release = r; }));
  const { el } = mount({}, ROWS, ctx);
  event(card(el, "Rust"), "dragstart");
  event(column(el, "doing"), "drop");
  assert.ok(card(el, "Rust").classList.contains("gz-busy"));
  release();
  await settle();
  assert.ok(!card(el, "Rust").classList.contains("gz-busy"));
  // Nothing moved on its own: the data reload decides where a card is.
  assert.ok(cards(column(el, "idea")).includes(card(el, "Rust")));
});

test("every card has a Move to… menu with the other columns; choosing one moves it", async () => {
  const { ctx, edits } = fakeCtx();
  const { el } = mount({}, ROWS, ctx);
  const menu = card(el, "Garden").querySelector("select") as HTMLSelectElement;
  assert.equal(menu.getAttribute("aria-label"), "Move Garden");
  assert.deepEqual([...menu.querySelectorAll("option")].map((o) => text(o)), ["Move to…", "idea", "done", "blocked", "(none)"]);
  choose(menu, "idea");
  await settle();
  assert.deepEqual(edits, [{ row: ROWS[0], field: "status", value: "idea" }]);
  assert.equal(menu.value, "");
  choose(card(el, "Loose end").querySelector("select")!, "blocked");
  await settle();
  assert.deepEqual(edits.at(-1), { row: ROWS[5], field: "status", value: "blocked" });
  choose(card(el, "Garden").querySelector("select")!, "(none)");
  await settle();
  assert.equal(edits.at(-1)!.value, null);
});

test("cards pick their row with select, and two cards of one column are told apart", () => {
  const { ctx, picked } = fakeCtx();
  const { el } = mount({ select: "project" }, ROWS, ctx);
  const [garden, kitchen] = [card(el, "Garden"), card(el, "Kitchen")];
  // One Tab stop for the board: Rust, the first card, until one is picked.
  assert.deepEqual([garden.getAttribute("role"), garden.getAttribute("tabindex"), garden.getAttribute("aria-label")], ["button", "-1", "Garden"]);
  assert.equal(card(el, "Rust").getAttribute("tabindex"), "0");
  garden.click();
  assert.deepEqual(picked, [ROWS[0]]);
  assert.ok(garden.classList.contains("gz-selected"));
  assert.deepEqual([card(el, "Rust").getAttribute("tabindex"), garden.getAttribute("tabindex")], ["-1", "0"]);
  assert.ok(!kitchen.classList.contains("gz-selected"));
  // The Move to… menu is its own control: using it doesn't pick the card.
  choose(kitchen.querySelector("select")!, "done");
  assert.equal(picked.length, 1);
  garden.click();
  assert.equal(picked.at(-1), undefined);
});

test("a board over a list that isn't editable, or a computed or file field, says why", () => {
  const web = checkPanel({ view: "board", source: "https://api.example.com/tasks", group: "status" }, true);
  assert.deepEqual(web.errors, ["edit works on notes and saved lists"]);
  assert.equal(web.panel, undefined);
  assert.deepEqual(checkPanel({ view: "board", source: "notes", from: "P", group: "path" }, true).errors, ['edit: "path" comes from the note\'s file, not its properties']);
  assert.deepEqual(checkPanel({ view: "board", source: "notes", from: "P", compute: { lane: "upper(status)" }, group: "lane" }, true).errors, ['edit: "lane" is computed']);
  assert.deepEqual(checkPanel({ view: "board", source: "notes", from: "P" }, true).errors, ["board needs group (the field its columns come from)"]);
});

test("the board asks to edit the notes it reads, and a drag in the app rewrites the note's property", async () => {
  const fm = {
    app: "Projects",
    data: { projects: { source: "notes", from: "Projects", fields: { status: ["idea", "doing", "done"] } } },
    panels: [{ view: "board", source: "projects", group: "status", item: "{name}" }],
  };
  const spec = readSpec(fm, { path: "Apps/P.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/P.md"), ["edit:Projects", "read:Projects"]);

  const t = fakeEnv({
    "Apps/P.md": { fm },
    "Projects/Garden.md": { fm: { status: "doing", due: "2026-11-30" } },
    "Projects/Rust.md": { fm: { status: "idea" } },
    "Projects/Loose.md": { fm: { area: "home" } },
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/P.md", t.env).load();
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.deepEqual(names(root), ["idea", "doing", "done", "(none)"]);
  assert.deepEqual(cards(column(root, "idea")).map((c) => text(c.querySelector(".gz-board-text"))), ["Rust"]);

  event(card(root, "Rust"), "dragstart");
  event(column(root, "doing"), "drop");
  await settle();
  assert.deepEqual(t.f.files.get("Projects/Rust.md")!.fm, { status: "doing" });
  // The reload redraws the board with the card where its note says.
  assert.deepEqual(cards(column(root, "doing")).map((c) => text(c.querySelector(".gz-board-text"))), ["Garden", "Rust"]);
  assert.deepEqual(cards(column(root, "idea")), []);

  // Moving by keyboard keeps the focus on that card's menu, though the board is drawn again.
  const menu = card(root, "Rust").querySelector("select") as HTMLSelectElement;
  menu.focus();
  choose(menu, "done");
  await settle();
  assert.deepEqual(t.f.files.get("Projects/Rust.md")!.fm, { status: "done" });
  assert.deepEqual(cards(column(root, "done")).map((c) => text(c.querySelector(".gz-board-text"))), ["Rust"]);
  assert.equal(document.activeElement, card(root, "Rust").querySelector("select"));

  choose(card(root, "Garden").querySelector("select")!, "(none)");
  await settle();
  assert.equal(t.f.files.get("Projects/Garden.md")!.fm!.status, null);
  assert.deepEqual(cards(column(root, "(none)")).map((c) => text(c.querySelector(".gz-board-text"))), ["Garden", "Loose"]);
  assert.deepEqual(cards(column(root, "doing")), []);
});

test("a board over a saved list moves rows by their place in the list", async () => {
  const fm = {
    app: "Chores",
    data: { chores: { source: "chores", fields: { room: ["kitchen", "garden"], task: "text" } } },
    panels: [{ view: "board", source: "chores", group: "room", item: "{task}", select: "chore" }, { view: "text", text: "$chore.task is in $chore.room" }],
  };
  const t = fakeEnv({
    "Apps/C.md": { fm },
    "Apps/C data.md": { fm: { chores: [{ task: "bins", room: "kitchen" }, { task: "plants", room: "garden" }] } },
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/C.md", t.env).load();
  await settle();
  assert.deepEqual(names(root), ["kitchen", "garden"]);

  (card(root, "bins") as HTMLElement).click();
  await settle();
  assert.equal(text(root.querySelector(".gz-text")), "bins is in kitchen");
  assert.ok(card(root, "bins").classList.contains("gz-selected"));
  assert.ok(!card(root, "plants").classList.contains("gz-selected"));

  event(card(root, "bins"), "dragstart");
  event(column(root, "garden"), "drop");
  await settle();
  assert.deepEqual(t.f.files.get("Apps/C data.md")!.fm!.chores, [{ task: "bins", room: "garden" }, { task: "plants", room: "garden" }]);
  assert.deepEqual(cards(column(root, "garden")).map((c) => text(c.querySelector(".gz-board-text"))), ["bins", "plants"]);
  // The selected card is still selected after the move, and what reads it sees the new room.
  assert.ok(card(root, "bins").classList.contains("gz-selected"));
  assert.equal(text(root.querySelector(".gz-text")), "bins is in garden");
});

test("item placeholders go through format and values, and the group field's values name the columns", () => {
  const rows: Row[] = [
    { name: "Garden", path: "Projects/Garden.md", status: "doing", budget: 1234.5 },
    { name: "Rust", path: "Projects/Rust.md", status: "idea", budget: 90 },
  ];
  const { el } = mount({ item: "{name} · {status} · {budget}", format: { budget: "$0,0" }, values: { status: { doing: "In progress", idea: "Someday" } } }, rows);
  assert.deepEqual(names(el), ["Someday", "In progress", "done"]);
  assert.equal(text(column(el, "In progress").querySelector(".gz-board-text")), "Garden · In progress · $1,235");
  assert.equal(text(column(el, "Someday").querySelector(".gz-board-text")), "Rust · Someday · $90");
  assert.equal(column(el, "In progress").getAttribute("aria-label"), "In progress");
  // A column's name is for the eye: dropping a card there still writes the group value.
  const { ctx, edits } = fakeCtx();
  const moved = mount({ values: { status: { doing: "In progress", idea: "Someday" } } }, rows, ctx).el;
  const select = card(moved, "Rust").querySelector("select.gz-move")!;
  assert.deepEqual([...select.querySelectorAll("option")].map((o) => text(o)), ["Move to…", "In progress", "done"]);
  choose(select, "In progress");
  assert.deepEqual(edits.map((e) => [e.field, e.value]), [["status", "doing"]]);
  assert.deepEqual(checkPanel({ view: "board", source: "notes", from: "Projects", group: "status", format: "dollars" }, true, { schema: SCHEMA }).errors, [
    'format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes',
  ]);
});

test("what a board's moves write can't be chosen while it runs: no $name in its group", () => {
  const components = { "C.md": { component: "Plan", params: ["by"], panels: [{ view: "board", source: "notes", from: "Projects", group: "$by" }] } };
  const notes = { resolve: (l: string) => (`${l}.md` in components ? `${l}.md` : undefined), frontmatter: (p: string) => (components as Record<string, Record<string, unknown>>)[p] };
  const errors = (fm: Record<string, unknown>) => readSpec({ app: "x", ...fm }, { notes, path: "Apps/X.md" })!.errors;
  const moved = 'can\'t be used in "group" on a board, where moving a card changes it';
  assert.deepEqual(errors({ inputs: { by: ["status", "area"] }, panels: [{ view: "board", source: "notes", from: "Projects", group: "$by" }] }), [`panel 1: $by ${moved}`]);
  assert.deepEqual(errors({ inputs: { q: "text" }, panels: [{ view: "board", source: "notes", from: "Projects", group: "$q" }] }), [`panel 1: $q ${moved}`]);
  assert.deepEqual(errors({ panels: [{ view: "board", source: "notes", from: "Projects", group: "$this.field" }] }), [`panel 1: $this ${moved}`]);
  // Through a component, and beside one.
  assert.deepEqual(errors({ inputs: { by: ["status", "area"] }, panels: [{ use: "[[C]]", with: { by: "$by" } }] }), [`panel 1 (from [[C]] panel 1): $by ${moved}`]);
  assert.deepEqual(errors({ inputs: { by: ["status", "area"] }, panels: [{ use: "[[C]]", with: { by: "status" }, group: "$by" }] }), [`panel 1 (from [[C]] panel 1): $by ${moved}`]);
  // A param fixed in the app is typed, not chosen; other views may still group by a $name.
  assert.deepEqual(errors({ panels: [{ use: "[[C]]", with: { by: "status" } }] }), []);
  assert.deepEqual(errors({ inputs: { by: ["status", "area"] }, panels: [{ view: "bar", source: "notes", from: "Projects", group: "$by" }] }), []);
});

test("a card's text splits at the first · into a name and a meta line, and its text stays whole", () => {
  const { ctx, opened } = fakeCtx();
  const { el } = mount({ item: "{name} · {area} · {status}", select: "project" }, ROWS, ctx);
  const garden = card(el, "Garden · home · doing");
  assert.equal(text(garden.querySelector(".gz-card-name")), "Garden");
  assert.equal(text(garden.querySelector(".gz-card-meta")), "home · doing");
  // The Move menu and the pick name the card by everything it says.
  assert.equal(garden.getAttribute("aria-label"), "Garden · home · doing");
  assert.equal(garden.querySelector("select")!.getAttribute("aria-label"), "Move Garden · home · doing");
  // The name is the note's link; the line under it isn't.
  const link = garden.querySelector("a.internal-link") as HTMLElement;
  assert.equal(text(link), "Garden");
  assert.equal(garden.querySelectorAll("a").length, 1);
  link.click();
  assert.deepEqual(opened, ["Projects/Garden.md"]);
});

test("a card whose text has no · has a name and no meta line, and one that ends in it has none to show", () => {
  const { el } = mount({}, ROWS);
  const garden = card(el, "Garden");
  assert.equal(text(garden.querySelector(".gz-card-name")), "Garden");
  assert.equal(garden.querySelector(".gz-card-meta"), null);
  const ends = mount({ item: "{name} · {due}" }, [{ name: "Rust", status: "idea" }, { name: "Garden", due: "2026-11-30", status: "idea" }]).el;
  const [rust, plan] = cards(ends);
  assert.equal(text(rust.querySelector(".gz-card-name")), "Rust");
  assert.equal(rust.querySelector(".gz-card-meta"), null);
  assert.equal(text(plan.querySelector(".gz-card-meta")), "2026-11-30");
  // A text that starts with it has no name to cut off, so it stays one piece.
  const starts = mount({ item: "{name}" }, [{ name: " · odd", status: "idea" }]).el;
  assert.equal(text(starts.querySelector(".gz-card-name")), " · odd");
  assert.equal(starts.querySelector(".gz-card-meta"), null);
});

test("the group field's last choice is the done column when it reads as done, whatever its case", () => {
  const done = (el: Element) => [...el.querySelectorAll(".gz-board-col")].filter((c) => c.classList.contains("gz-board-done")).map((c) => c.getAttribute("aria-label"));
  assert.deepEqual(done(mount({}, ROWS).el), ["done"]);
  for (const last of ["Done", "COMPLETE", "completed", "Finished"]) {
    const { el } = mount({}, [], undefined, { schema: { status: ["todo", "doing", last] } });
    assert.deepEqual(done(el), [last]);
  }
  // Only the last choice counts, and only from the schema; a column that just appears in the data doesn't.
  assert.deepEqual(done(mount({}, ROWS, undefined, { schema: { status: ["done", "doing"] } }).el), []);
  assert.deepEqual(done(mount({}, [{ name: "a", status: "done" }, { name: "b", status: "idea" }], undefined, {}).el), []);
  assert.deepEqual(done(mount({}, [{ name: "a", status: "closed" }], undefined, { schema: { status: ["open", "closed"] } }).el), []);
  // The extra columns after the choices (a value the schema doesn't know, then none) are not it either.
  assert.deepEqual(done(mount({}, ROWS).el), ["done"]);
  assert.deepEqual(names(mount({}, ROWS).el).slice(-2), ["blocked", "(none)"]);
});

test("a done column's cards are told apart from the others only by a class on the column", () => {
  const { el } = mount({}, ROWS);
  const taxes = card(el, "Taxes");
  assert.ok(taxes.closest(".gz-board-col")!.classList.contains("gz-board-done"));
  assert.ok(!card(el, "Garden").closest(".gz-board-col")!.classList.contains("gz-board-done"));
  for (const c of el.querySelectorAll(".gz-board-card")) assert.equal(c.getAttribute("style"), null);
});

test("in the past a card can't move: it isn't draggable and has no Move to; it can still be picked", () => {
  const { ctx, picked } = fakeCtx();
  const past = Object.assign(Object.create(ctx) as PanelCtx, { readOnly: true });
  const { el } = mount({ select: "project" }, ROWS, past);
  const garden = card(el, "Garden");
  assert.ok(!garden.hasAttribute("draggable"));
  assert.ok(!el.querySelector(".gz-move"));
  garden.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(picked.at(-1)?.name, "Garden");
  const live = mount({}, ROWS).el;
  assert.equal(card(live, "Garden").getAttribute("draggable"), "true");
  assert.ok(card(live, "Garden").querySelector(".gz-move"));
});

const keyOn = (el: Element, key: string, shiftKey = false) => {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, shiftKey, altKey: false, ctrlKey: false, metaKey: false });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

test("⇧→ and ⇧← on a card move it to the column beside; a plain arrow only moves the focus; at the end, nothing moves", async () => {
  const { ctx, edits } = fakeCtx();
  const { el } = mount({}, ROWS, ctx);
  const garden = card(el, "Garden");
  assert.equal(garden.getAttribute("tabindex") !== null, true, "a card the keys can reach, though the board picks nothing");
  garden.focus();
  assert.equal(keyOn(garden, "ArrowRight", true), true);
  await settle();
  assert.deepEqual(edits, [{ row: ROWS[0], field: "status", value: "done" }]);
  assert.equal(document.activeElement === card(el, "Garden"), true, "the focus stays on the card");
  assert.equal(keyOn(card(el, "Garden"), "ArrowLeft", true), true);
  await settle();
  assert.deepEqual(edits.at(-1), { row: ROWS[0], field: "status", value: "idea" });
  // A plain → moves the focus to the next column's card, and writes nothing.
  assert.equal(keyOn(card(el, "Garden"), "ArrowRight"), true);
  assert.equal(edits.length, 2);
  // The first column's card can't go further left.
  const rust = card(el, "Rust");
  assert.equal(keyOn(rust, "ArrowLeft", true), true);
  await settle();
  assert.equal(edits.length, 2);
});

test("on a board whose columns come from its rows, a column keeps its place as cards move, so ⇧→ walks a card to the last column and stops there", async () => {
  const { ctx, edits } = fakeCtx();
  const rows = (fence: string): Row[] => [
    { name: "Fence", path: "Projects/Fence.md", status: fence },
    { name: "Japan", path: "Projects/Japan.md", status: "doing" },
    { name: "Taxes", path: "Projects/Taxes.md", status: "done" },
  ];
  const { el, handle } = mount({}, rows("idea"), ctx, {});
  assert.deepEqual(names(el), ["idea", "doing", "done"]);
  card(el, "Fence").focus();
  keyOn(card(el, "Fence"), "ArrowRight", true);
  await settle();
  handle.update(rows("doing"));
  assert.deepEqual(names(el), ["doing", "done"], "an emptied column goes, as before");
  keyOn(card(el, "Fence"), "ArrowRight", true);
  await settle();
  handle.update(rows("done"));
  assert.deepEqual(names(el), ["doing", "done"], "Fence, now the first row that is done, doesn't put done first");
  assert.equal(document.activeElement === card(el, "Fence"), true);
  keyOn(card(el, "Fence"), "ArrowRight", true);
  await settle();
  assert.deepEqual(edits.map((e) => e.value), ["doing", "done"]);
  handle.update(rows("idea"));
  assert.deepEqual(names(el), ["idea", "doing", "done"], "a column that comes back takes its old place");
});

test("shown as it was, ⇧→ on a card moves nothing", async () => {
  const f = fakeCtx();
  const ctx = { ...f.ctx, readOnly: true } as PanelCtx;
  const { el } = mount({ select: "pick" }, ROWS, ctx);
  const garden = card(el, "Garden");
  keyOn(garden, "ArrowRight", true);
  await settle();
  assert.deepEqual(f.edits, []);
});
