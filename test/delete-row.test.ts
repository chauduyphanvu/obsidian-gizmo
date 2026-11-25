import { document, scrolled } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { describeChange, undoEntry, undoInFrontmatter, undoMessage, type Change } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { AppWrites } from "../src/app-writes.ts";
import { frontmatterStore, ledgerStore } from "../src/datastore.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { railModel, tickLabel } from "../src/rail.ts";
import { pastEnv } from "../src/replay.ts";
import { readSpec, type Panel } from "../src/spec.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";
import { addLine } from "./support/addline.ts";

// Deleting a row from the side sheet: only a row of the app's own saved lists, as it is now. The row
// goes as a ledger event, the sheet closes, and a notice under the panel says so with Undo, which
// puts the same row back under the same id.

const APP = "Apps/W.md";
const DATA = "Apps/W data.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
const mac = () => document.body.classList.contains("mod-macos");
const undoKey = () => {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "z", metaKey: mac(), ctrlKey: !mac(), shiftKey: false, altKey: false });
  document.dispatchEvent(e);
  return e.defaultPrevented;
};

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** APP in its own tab, the active one, as AppView opens it (with a sheet and Undo); or as it was at `past`. */
function open(notes: Parameters<typeof fakeEnv>[0], opts: { past?: number } = {}) {
  const t = fakeEnv(notes);
  t.env.log = (entry) => t.activity.add(entry);
  t.env.undo = async (id) => {
    const entry = (await t.activity.get(id))!;
    const r = await undoEntry(entry, t.undoIO);
    await t.activity.setUndone(id, r.undone);
    return undoMessage(r);
  };
  const leaf = document.body.createDiv({ cls: "workspace-leaf mod-active" });
  const root = leaf.createDiv();
  const c = new AppController(root, APP, opts.past === undefined ? t.env : pastEnv(t.env, opts.past));
  c.openInPlace(() => {});
  started.push({ dispose: () => { c.dispose(); leaf.remove(); } });
  c.load();
  const sheet = () => root.querySelector("aside.gz-sheet")!;
  const isOpen = () => sheet().classList.contains("is-open");
  const panel = (title: string) => [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-title")) === title) as HTMLElement;
  const rows = (title: string) => [...panel(title).querySelectorAll("tbody tr:not(.gz-ledger-group)")];
  const actions = () => [...sheet().querySelectorAll(".gz-sheet-actions > *")].map(text);
  const list = (key: string) => (listsIn(t.f.files.get(DATA)?.fm)?.[key] ?? []) as Record<string, unknown>[];
  const ids = async (key: string) => ((await t.data.ledger!.state(DATA)).lists.get(key)?.rows ?? []).map(rowIdOf);
  return { ...t, root, sheet, isOpen, panel, rows, actions, list, ids };
}

const SPENT = { spend: [{ at: "2026-11-17T09:15", amount: 5, category: "food", note: "Coffee" }, { at: "2026-11-17T12:30", amount: 14.5, category: "food", note: "" }] };
const RECENT = { view: "table", title: "Recent", source: "spend", columns: ["amount", "category", "note"], format: { amount: "$0,0.00" } };

test("Delete in the sheet takes a saved row out, closes the sheet, and says so under the panel with Undo, which puts the same row back", async () => {
  const t = open({ [APP]: { fm: { app: "W", panels: [RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } });
  await settle();
  const before = await t.ids("spend");
  click(t.rows("Recent")[1]);
  await settle();
  assert.ok(t.isOpen());
  assert.deepEqual(t.actions(), ["Delete"]);
  const del = t.sheet().querySelector(".gz-sheet-actions > button")!;
  // Obsidian's warning look, so it doesn't read as an ordinary row action.
  assert.deepEqual([...del.classList], ["gz-small", "gz-row-action", "mod-warning"]);
  click(del);
  await settle();
  assert.ok(!t.isOpen(), "the sheet closes");
  assert.deepEqual(t.list("spend"), [SPENT.spend[0]]);
  assert.equal(t.rows("Recent").length, 1);
  // Said just under the panel the row was in, as the add line says what it saved.
  const recent = t.panel("Recent");
  const under = recent.nextElementSibling!;
  assert.ok(under.classList.contains("gz-addline-under"));
  assert.equal(text(under.querySelector(".gz-notice .gz-notice-text")), "Deleted $14.50 · food");
  // Under a long list it would be out of sight: the pane scrolls only as far as it must to show it.
  assert.ok(scrolled.at(-1)?.el === under, "the notice was brought into view");
  assert.deepEqual(scrolled.at(-1)?.options, { block: "nearest" });
  const [entry] = await t.activity.list(APP);
  assert.equal(entry.what, "Recent");
  assert.deepEqual(entry.changes.map(describeChange), ["Deleted amount 14.5, category food from spend in W data"]);
  assert.equal(entry.changes[0].kind, "row-deleted");

  click(under.querySelector("button.gz-undo")!);
  await settle();
  assert.deepEqual(t.list("spend"), SPENT.spend, "back in its place");
  assert.deepEqual(await t.ids("spend"), before, "under the same id, so edits from other devices still find it");
  assert.equal(text(under.querySelector(".gz-notice-text")), "Undone");
  assert.equal(under.querySelector("button.gz-undo"), null);
});

test("⌘Z takes a delete back too, and the activity log's Undo does, from any device", async () => {
  const t = open({ [APP]: { fm: { app: "W", panels: [RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } });
  await settle();
  click(t.rows("Recent")[0]);
  await settle();
  click(t.sheet().querySelector(".gz-sheet-actions > button")!);
  await settle();
  assert.deepEqual(t.list("spend").map((r) => r.note), [""]);
  assert.equal(undoKey(), true);
  await settle();
  assert.deepEqual(t.list("spend").map((r) => r.note), ["Coffee", ""]);

  click(t.rows("Recent")[1]);
  await settle();
  click(t.sheet().querySelector(".gz-sheet-actions > button")!);
  await settle();
  assert.equal(t.list("spend").length, 1);
  const [entry] = await t.activity.list(APP);
  assert.deepEqual(await undoEntry({ ...entry, device: "iPhone" }, t.undoIO), { undone: 1, total: 1 });
  await settle();
  assert.equal(t.list("spend").length, 2);
});

test("a delete said under its panel ends what the add line was saying, so one Undo and one ⌘Z are on screen; another app's stays", async () => {
  const SPEND = { view: "form", title: "Spent", alias: "spend", fields: { amount: "number", note: "text" }, save: "spend" };
  const t = open({ [APP]: { fm: { app: "W", panels: [SPEND, RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } });
  // Another app open beside it, saying what it saved.
  const other = fakeEnv({ "Apps/O.md": { fm: { app: "O", panels: [{ ...SPEND, save: "spent" }] } } });
  other.env.log = (entry) => other.activity.add(entry);
  other.env.undo = async () => "Undone";
  const otherRoot = document.body.createDiv();
  const o = new AppController(otherRoot, "Apps/O.md", other.env);
  started.push({ dispose: () => { o.dispose(); otherRoot.remove(); } });
  o.load();
  await settle();
  addLine(otherRoot, "3 tea");
  await settle();
  assert.equal(text(otherRoot.querySelector(".gz-notice-text")), "Added 3 to spent");

  const notices = () => [...t.root.querySelectorAll(".gz-notice")].map((n) => [text(n.querySelector(".gz-notice-text")), n.querySelectorAll("button.gz-undo").length]);
  addLine(t.root, "14.5 lunch");
  await settle();
  assert.deepEqual(notices(), [["Added 14.5 to spend", 1]]);
  click(t.rows("Recent")[0]);
  await settle();
  click(t.sheet().querySelector(".gz-sheet-actions > button")!);
  await settle();
  assert.deepEqual(notices(), [["Deleted $5.00 · food · Coffee", 1]], "the add line's notice went, as when its time is up");
  assert.ok(t.root.querySelector(".gz-addline-try"), "the add line shows its examples again");
  assert.equal(text(otherRoot.querySelector(".gz-notice-text")), "Added 3 to spent", "another app's notice is its own");
  // ⌘Z takes back the delete, the only Undo on screen.
  assert.equal(undoKey(), true);
  await settle();
  assert.deepEqual(t.list("spend").map((r) => r.note), ["Coffee", "", "lunch"]);
});

test("a delete is a tick on the time rail, said as the activity log says it", async () => {
  const t = open({ [APP]: { fm: { app: "W", panels: [RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } });
  await settle();
  click(t.rows("Recent")[0]);
  await settle();
  click(t.sheet().querySelector(".gz-sheet-actions > button")!);
  await settle();
  const entries = await t.activity.list(APP);
  const { ticks } = railModel(entries, t.env.now().getTime());
  assert.equal(ticks.length, 1);
  assert.match(tickLabel(ticks[0]), /· Recent: Deleted amount 5, category food, note Coffee from spend in W data$/);
});

test("a list's item and a board's card name what was deleted; a row of a saved list on a board can be deleted", async () => {
  const t = open({
    [APP]: { fm: { app: "W", panels: [
      { view: "list", title: "Spent", source: "spend", item: "{note} · {amount}" },
      { view: "board", title: "Tasks", source: "chores", group: "status", item: "{task}" },
    ] } },
    [DATA]: { fm: { ...structuredClone(SPENT), chores: [{ task: "Bins", status: "todo" }, { task: "Dishes", status: "done" }] } },
  });
  await settle();
  click(t.panel("Spent").querySelector("li.gz-selectable")!);
  await settle();
  assert.deepEqual(t.actions(), ["Delete"]);
  click(t.sheet().querySelector(".gz-sheet-actions > button")!);
  await settle();
  assert.equal(text(t.panel("Spent").nextElementSibling!.querySelector(".gz-notice-text")), "Deleted Coffee · 5");

  click(t.panel("Tasks").querySelector(".gz-board-card")!);
  await settle();
  assert.deepEqual(t.actions(), ["Delete"]);
  click(t.sheet().querySelector(".gz-sheet-actions > button")!);
  await settle();
  assert.deepEqual(t.list("chores").map((r) => r.task), ["Dishes"]);
  assert.equal(text(t.panel("Tasks").nextElementSibling!.querySelector(".gz-notice-text")), "Deleted Bins");
});

test("Delete is only for a row of the app's own lists as it is now: not a note, not a group, not in the past", async () => {
  const notes = open({
    [APP]: { fm: { app: "W", panels: [{ view: "table", title: "Shelf", source: "notes", from: "Books", columns: ["name", "rating"] }] } },
    "Books/Emma.md": { fm: { rating: 3 } },
  });
  await settle();
  click(notes.rows("Shelf")[0]);
  await settle();
  assert.ok(notes.isOpen());
  assert.deepEqual(notes.actions(), ["Open"]);

  const grouped = open({ [APP]: { fm: { app: "W", panels: [{ view: "list", title: "By kind", source: "spend", group: "category" }] } }, [DATA]: { fm: structuredClone(SPENT) } });
  await settle();
  click(grouped.panel("By kind").querySelector("li.gz-selectable")!);
  await settle();
  assert.ok(grouped.isOpen());
  assert.deepEqual(grouped.actions(), []);

  const past = open({ [APP]: { fm: { app: "W", panels: [RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } }, { past: new Date(2026, 10, 18, 12).getTime() });
  await settle();
  click(past.rows("Recent")[0]);
  await settle();
  assert.ok(past.isOpen());
  assert.deepEqual(past.actions(), []);
});

test("the ledger deletes a row by its id, once; one that is gone already is refused", async () => {
  const t = fakeEnv({ [DATA]: { fm: structuredClone(SPENT) } });
  const store = ledgerStore(t.data.ledger!, DATA);
  const [coffee] = await store.rows("spend");
  const id = rowIdOf(coffee)!;
  const r = await store.delete("spend", { id, shown: coffee });
  assert.ok("row" in r);
  assert.deepEqual(r.row, SPENT.spend[0]);
  assert.match(r.event ?? "", /^d1mac000@/);
  assert.deepEqual(await store.delete("spend", { id, shown: coffee }), { refused: "gone" });
  await store.undo([r.event!]);
  assert.deepEqual((await store.rows("spend")).map(rowIdOf)[0], id);
});

test("a list kept in a note's properties deletes the row at its place while it still holds what was shown, and undo puts it back there", async () => {
  const notes = new Map<string, Record<string, unknown>>([[DATA, structuredClone(SPENT)]]);
  const store = frontmatterStore(DATA, async (path, fn) => fn(notes.get(path)!), (path) => notes.get(path));
  const fm = notes.get(DATA)!;
  assert.deepEqual(await store.delete("spend", { index: 0, shown: { ...SPENT.spend[0], note: "Tea" } }), { refused: "changed" });
  const r = await store.delete("spend", { index: 0, shown: SPENT.spend[0] });
  assert.deepEqual(r, { row: SPENT.spend[0], index: 0 });
  assert.deepEqual(fm.spend, [SPENT.spend[1]]);
  const change: Change = { kind: "row-deleted", path: DATA, list: "spend", row: SPENT.spend[0], index: 0 };
  assert.equal(undoInFrontmatter(change, fm), undefined);
  assert.deepEqual(fm.spend, SPENT.spend);
  // A list that has grown shorter takes it at its end; one that is gone can't.
  const short = { spend: [] };
  assert.equal(undoInFrontmatter({ ...change, index: 3 }, short), undefined);
  assert.deepEqual(short.spend, [SPENT.spend[0]]);
  assert.equal(undoInFrontmatter(change, {}), "spend in W data is gone");
});

test("a kind's rows can be deleted or moved in time from the sheet only where they may be changed: in an app that asks to change them, or the kind's own note; one that only reads them can't, in the sheet or by its writes", async () => {
  const KIND = "Kinds/Spend.md";
  const KIND_DATA = "Kinds/Spend data.md";
  const SPEND = { kind: "spend", fields: { amount: "number", memo: "text" } };
  const rows = { spend: [{ at: "2026-11-17T09:15", amount: 5, memo: "Coffee" }, { at: "2026-11-17T12:30", amount: 14.5, memo: "Lunch" }] };
  const left = async (t: ReturnType<typeof fakeEnv>) => ((await t.data.ledger!.state(KIND_DATA)).lists.get("spend")?.rows ?? []).map((r) => r.memo);
  const pick = async (o: ReturnType<typeof open>) => {
    await settle();
    click(o.rows("Recent")[0]);
    await settle();
  };

  // Reads only: the sheet shows the row, with no Delete and no time to move it to; the writes refuse too.
  const reader = open({ [KIND]: { fm: SPEND }, [KIND_DATA]: { fm: rows }, [APP]: { fm: { app: "R", panels: [{ view: "table", title: "Recent", source: "[[Spend]]", columns: ["amount", "memo"] }] } } });
  await pick(reader);
  assert.ok(reader.isOpen());
  assert.deepEqual(reader.actions(), []);
  assert.ok(!reader.sheet().querySelector("input[type=datetime-local]"));
  const writes = new AppWrites(reader.env, { appPath: APP, hostPath: APP, dataPath: () => DATA, checklistName: (k) => k, expect: () => [], writesKind: () => false });
  const table = { view: "table", source: "[[Spend]]", kind: { path: KIND, name: "spend" } } as Panel;
  const [first] = (await reader.data.ledger!.state(KIND_DATA)).lists.get("spend")!.rows;
  assert.equal(await writes.deleteRow({ p: table }, first, () => {}), undefined);
  await writes.editRow({ p: table }, first, "at", "2026-11-16T09:15-08:00", () => {});
  assert.deepEqual([await left(reader), (await reader.data.ledger!.state(KIND_DATA)).lists.get("spend")!.rows[0].at], [["Coffee", "Lunch"], "2026-11-17T09:15"]);
  assert.ok(reader.notices.includes("Not deleted: this app reads the rows of Spend, and doesn't change them"), reader.notices.join(" | "));

  // An app that also saves to the kind asks to change its rows: its read-only table's sheet deletes.
  const writer = open({ [KIND]: { fm: SPEND }, [KIND_DATA]: { fm: rows }, [APP]: { fm: { app: "W", panels: [{ view: "form", save: "[[Spend]]" }, { view: "table", title: "Recent", source: "[[Spend]]", columns: ["amount", "memo"] }] } } });
  await pick(writer);
  assert.ok(writer.actions().includes("Delete"));
  click([...writer.sheet().querySelectorAll(".gz-sheet-actions > button")].find((b) => text(b) === "Delete")!);
  await settle();
  assert.deepEqual(await left(writer), ["Lunch"]);
});

test("on a shared kind, a row someone else wrote isn't changed or deleted here: its cells read as text and say why, its sheet says so and offers Not mine, and the writes refuse; a row of this vault's is changed as before", async () => {
  const KIND = "Kinds/Chore.md";
  const KIND_DATA = "Kinds/Chore data.md";
  const CHORE = { kind: "chore", fields: { task: "text", who: ["Alex", "Sam"] }, share: { relay: "https://relay.test", key: { secret: "chore-key" } } };
  const BO = "bbbbbbbbbbbbbbbb";
  const chores = { chore: [{ task: "Mop", who: "Sam", at: "2026-11-17T09:00" }, { task: "Dishes", who: "Alex", at: "2026-11-17T10:00", by: "Bo", writer: BO }] };
  const o = open({ [KIND]: { fm: CHORE }, [KIND_DATA]: { fm: chores }, [APP]: { fm: { app: "W", panels: [{ view: "form", save: "[[Chore]]" }, { view: "table", title: "Chores", source: "[[Chore]]", sort: "task", columns: ["task", "who", "by"], edit: ["task", "who"] }] } } });
  o.env.log = (entry) => o.activity.add(entry);
  await settle();
  const rowsNow = async () => (await o.data.ledger!.state(KIND_DATA)).lists.get("chore")!.rows;
  const [dishes, mop] = o.rows("Chores");
  assert.equal(dishes.querySelectorAll("input, select").length, 0, "Bo's row: nothing to type in");
  assert.equal(dishes.getAttribute("title"), "By Bo; only Bo can change it");
  assert.equal(mop.querySelectorAll("input, select").length, 2, "a row of mine is edited as before");
  assert.equal(mop.getAttribute("title"), null);

  // The writes refuse too, in an app and in the kind's own note.
  const bos = (await rowsNow()).find((r) => r.writer === BO)!;
  for (const [appPath, table] of [[APP, { view: "table", source: "[[Chore]]", kind: { path: KIND, name: "chore" } }], [KIND, { view: "table", source: "chore" }]] as const) {
    const writes = new AppWrites(o.env, { appPath, hostPath: appPath, dataPath: () => KIND_DATA, checklistName: (k) => k, expect: () => [], writesKind: () => true });
    await writes.editRow({ p: table as Panel }, bos, "who", "Sam", () => {});
    assert.equal(await writes.deleteRow({ p: table as Panel }, bos, () => {}), undefined);
  }
  assert.equal((await rowsNow()).find((r) => r.writer === BO)!.who, "Alex");
  assert.equal(o.notices.filter((n) => n === "Not saved: By Bo; only Bo can change it").length, 2, o.notices.join(" | "));
  assert.equal(o.notices.filter((n) => n === "Not deleted: By Bo; only Bo can change it; Not mine sets it aside").length, 2, o.notices.join(" | "));

  // Its sheet says whose it is and sets it aside with Not mine, which Undo takes back.
  click(dishes);
  await settle();
  assert.equal(text(o.sheet().querySelector(".gz-sheet-theirs")), "By Bo; only Bo can change it.");
  assert.equal(o.sheet().querySelectorAll(".gz-sheet-field input, .gz-sheet-field select").length, 0);
  assert.deepEqual(o.actions(), ["Not mine"]);
  click([...o.sheet().querySelectorAll(".gz-sheet-actions > button")].find((b) => text(b) === "Not mine")!);
  await settle();
  assert.equal((await rowsNow()).find((r) => r.writer === BO)!.line, "dismissed");
  assert.ok(!o.isOpen());
  assert.deepEqual(o.rows("Chores").map((tr) => (tr.querySelector("td input") as HTMLInputElement).value), ["Mop"]);
  const [entry] = await o.activity.list(APP);
  assert.equal(entry.what, "Set aside a row from Bo");
  await undoEntry(entry, o.undoIO);
  assert.equal((await rowsNow()).find((r) => r.writer === BO)!.line, undefined);
  // A row of mine still has Delete.
  await settle();
  click(o.rows("Chores")[1]);
  await settle();
  assert.deepEqual(o.actions(), ["Delete"]);
  assert.equal(o.sheet().querySelector(".gz-sheet-theirs"), null);
});

test("Gizmo's own fields on a kind's rows can't be edited: not in edit, not as a board's group, not through a write", async () => {
  const KIND = "Kinds/Spend.md";
  const SPEND = { kind: "spend", fields: { amount: "number", memo: "text" } };
  const notes = { resolve: (link: string) => (link === "Spend" ? KIND : undefined), frontmatter: (p: string) => (p === KIND ? SPEND : undefined) };
  const read = (panel: Record<string, unknown>) => readSpec({ app: "x", panels: [panel] }, { notes, path: APP })!.errors;
  assert.deepEqual(read({ view: "table", source: "[[Spend]]", lines: "all", columns: ["memo", "line", "matched"], edit: ["memo", "line", "matched"] }), [
    "panel 1: edit can't change \"line\", which Gizmo keeps on each row of a kind", "panel 1: edit can't change \"matched\", which Gizmo keeps on each row of a kind",
  ]);
  assert.deepEqual(read({ view: "board", source: "[[Spend]]", lines: "all", group: "writer" }), ["panel 1: edit can't change \"writer\", which Gizmo keeps on each row of a kind"]);
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Kinds/Spend data.md": { fm: { spend: [{ at: "2026-11-17T09:15", amount: 5, memo: "Coffee" }] } } });
  const writes = new AppWrites(t.env, { appPath: KIND, hostPath: KIND, dataPath: () => "Kinds/Spend data.md", checklistName: (k) => k, expect: () => [] });
  const table = { view: "table", source: "[[Spend]]", kind: { path: KIND, name: "spend" } } as Panel;
  const [row] = (await t.data.ledger!.state("Kinds/Spend data.md")).lists.get("spend")!.rows;
  await writes.editRow({ p: table }, row, "line", "planned", () => {});
  assert.equal((await t.data.ledger!.state("Kinds/Spend data.md")).lists.get("spend")!.rows[0].line, undefined);
});

const keyOn = (el: Element, key: string) => {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

test("⌫ on a focused row of the app's own list deletes it as Delete does, and the focus goes to the row now in its place", async () => {
  const t = open({ [APP]: { fm: { app: "W", panels: [RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } });
  await settle();
  const [first] = t.rows("Recent") as HTMLElement[];
  first.focus();
  assert.equal(keyOn(first, "Backspace"), true);
  await settle();
  assert.deepEqual(t.list("spend"), [SPENT.spend[1]]);
  assert.equal(text(t.panel("Recent").nextElementSibling?.querySelector(".gz-notice-text")), "Deleted $5.00 · food · Coffee");
  assert.equal(t.rows("Recent").length, 1);
  assert.equal(document.activeElement === t.rows("Recent")[0], true, "the keys carry on from the row now there");
  assert.equal(undoKey(), true);
  await settle();
  assert.deepEqual(t.list("spend"), SPENT.spend);
});

test("⌫ deletes nothing in the past, nor from a field being typed in", async () => {
  const past = open({ [APP]: { fm: { app: "W", panels: [RECENT] } }, [DATA]: { fm: structuredClone(SPENT) } }, { past: Date.now() + 60_000 });
  await settle();
  const row = past.rows("Recent")[0] as HTMLElement;
  assert.equal(keyOn(row, "Backspace"), false);
  await settle();
  assert.equal(past.list("spend").length, 2);
  const edits = { ...RECENT, edit: ["note"] };
  const t = open({ [APP]: { fm: { app: "W", panels: [edits] } }, [DATA]: { fm: structuredClone(SPENT) } });
  await settle();
  const input = t.rows("Recent")[0].querySelector("input")!;
  assert.equal(keyOn(input, "Backspace"), false);
  await settle();
  assert.equal(t.list("spend").length, 2);
});
