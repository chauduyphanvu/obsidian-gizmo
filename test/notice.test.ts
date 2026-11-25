import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { undoEntry, undoMessage } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";

// Every write made in an app's own tab says what it did under the panel that made it, with Undo
// and ⌘Z: an edited cell, a tick, a moved card, rows accepted from a file. An embed says nothing.

const APP = "Apps/W.md";
const DATA = "Apps/W data.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const mac = () => document.body.classList.contains("mod-macos");
const undoKey = () => {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "z", metaKey: mac(), ctrlKey: !mac(), shiftKey: false, altKey: false });
  document.dispatchEvent(e);
  return e.defaultPrevented;
};

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

/** APP in its own tab, the active one, with Undo; or embedded in a daily note. */
function open(fm: Record<string, unknown>, notes: Parameters<typeof fakeEnv>[0] = {}, opts: { embed?: boolean } = {}) {
  const t = fakeEnv({ [APP]: { fm }, ...notes });
  t.env.log = (entry) => t.activity.add(entry);
  t.env.undo = async (id) => {
    const entry = (await t.activity.get(id))!;
    const r = await undoEntry(entry, t.undoIO);
    await t.activity.setUndone(id, r.undone);
    return undoMessage(r);
  };
  const leaf = document.body.createDiv({ cls: opts.embed ? "workspace-leaf mod-active gz-embed" : "workspace-leaf mod-active" });
  const root = leaf.createDiv();
  const c = opts.embed
    ? new AppController(root, APP, t.env, { kind: "app", grantKey: "Daily.md#gizmo", hostPath: "Daily.md", definition: () => fm })
    : new AppController(root, APP, t.env);
  if (!opts.embed) c.openInPlace(() => {});
  started.push({ dispose: () => { c.dispose(); leaf.remove(); } });
  c.load();
  const panel = (title: string) => [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-title")).split(" · ")[0] === title) as HTMLElement;
  /** What is said just under a panel, and its Undo button. */
  const under = (title: string) => {
    const next = panel(title).nextElementSibling;
    return next?.classList.contains("gz-addline-under") ? next : null;
  };
  const list = (key: string) => (listsIn(t.f.files.get(DATA)?.fm)?.[key] ?? []) as Record<string, unknown>[];
  return { ...t, root, panel, under, list };
}

const CHORES = { app: "W", panels: [{ view: "table", title: "Chores", source: "chores", columns: ["task", "done"], edit: ["done"] }] };

test("an edited cell is said under its table with Undo, which puts the value back", async () => {
  const t = open(CHORES, { [DATA]: { fm: { chores: [{ task: "bins", done: false }, { task: "dishes", done: false }] } } });
  await settle();
  const box = t.panel("Chores").querySelectorAll("tbody tr")[1].querySelector("input") as HTMLInputElement;
  box.checked = true;
  change(box);
  await settle();
  assert.equal(t.list("chores")[1].done, true);
  assert.equal(text(t.under("Chores")?.querySelector(".gz-notice-text")), "Changed done from false to true");
  click(t.under("Chores")!.querySelector("button.gz-undo")!);
  await settle();
  assert.equal(t.list("chores")[1].done, false);
  assert.equal(text(t.under("Chores")?.querySelector(".gz-notice-text")), "Undone");
  assert.equal(t.under("Chores")?.querySelector("button.gz-undo"), null, "an undone change offers no Undo");
});

test("⌘Z takes back an edited cell while nothing editable has focus", async () => {
  const t = open(CHORES, { [DATA]: { fm: { chores: [{ task: "bins", done: false }] } } });
  await settle();
  const box = t.panel("Chores").querySelector("tbody tr input") as HTMLInputElement;
  box.checked = true;
  change(box);
  await settle();
  assert.equal(t.list("chores")[0].done, true);
  assert.equal(undoKey(), true);
  await settle();
  assert.equal(t.list("chores")[0].done, false);
  assert.equal(undoKey(), false, "nothing left to undo");
});

test("a tick is said under its checklist with Undo", async () => {
  const t = open({ app: "W", panels: [{ view: "checklist", title: "Packing", items: ["passport", "charger"] }] });
  await settle();
  const passport = t.panel("Packing").querySelector('input[type="checkbox"]') as HTMLInputElement;
  passport.checked = true;
  change(passport);
  await settle();
  assert.equal(text(t.under("Packing")?.querySelector(".gz-notice-text")), "Ticked “passport”");
  assert.ok(t.under("Packing")?.querySelector("button.gz-undo"));
});

test("a card moved on a board is said under the board with Undo", async () => {
  const t = open(
    { app: "W", panels: [{ view: "board", title: "Projects", source: "projects", group: "status", card: ["title"] }] },
    { [DATA]: { fm: { projects: [{ title: "Fence", status: "idea" }, { title: "Japan", status: "doing" }] } } },
  );
  await settle();
  const move = t.panel("Projects").querySelector("select.gz-move") as HTMLSelectElement;
  for (const o of move.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "doing");
  change(move);
  await settle();
  assert.equal(t.list("projects")[0].status, "doing");
  assert.equal(text(t.under("Projects")?.querySelector(".gz-notice-text")), "Changed status from idea to doing");
  click(t.under("Projects")!.querySelector("button.gz-undo")!);
  await settle();
  assert.equal(t.list("projects")[0].status, "idea");
});

test("embedded in a note, an edit says nothing in place", async () => {
  const t = open(CHORES, { [DATA]: { fm: { chores: [{ task: "bins", done: false }] } }, "Daily.md": { fm: {} } }, { embed: true });
  await settle();
  const box = t.root.querySelector(".gz-panel tbody tr input") as HTMLInputElement | null;
  if (!box) return assert.fail("the embed shows the table");
  box.checked = true;
  change(box);
  await settle();
  assert.equal(t.root.querySelector(".gz-notice"), null);
});
