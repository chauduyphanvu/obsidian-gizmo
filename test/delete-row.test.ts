import { document, scrolled } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { describeChange, undoEntry, undoInFrontmatter, undoMessage, type Change } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { frontmatterStore, ledgerStore } from "../src/datastore.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { railModel, tickLabel } from "../src/rail.ts";
import { pastEnv } from "../src/replay.ts";
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
