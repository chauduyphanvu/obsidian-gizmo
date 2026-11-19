import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import type { Row } from "../src/data.ts";
import { compilePipeline } from "../src/pipeline.ts";
import { checkPanel, permissionsOf, readSpec, type Panel } from "../src/spec.ts";
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
  assert.deepEqual([garden.getAttribute("role"), garden.getAttribute("tabindex"), garden.getAttribute("aria-label")], ["button", "0", "Garden"]);
  garden.click();
  assert.deepEqual(picked, [ROWS[0]]);
  assert.ok(garden.classList.contains("gz-selected"));
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
