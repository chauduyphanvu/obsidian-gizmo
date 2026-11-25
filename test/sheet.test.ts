import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController, type Hosting } from "../src/app.ts";
import { PAST } from "../src/ledger-store.ts";
import { pastEnv } from "../src/replay.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";

// The side sheet: in an app's own tab, a row, card, bar or day picked opens one sheet beside the app,
// holding what was picked (its name, detail and fields), the panels that wait for the pick, and its
// actions. On the grid, in an embed or a lens, a pick stays in its panel as before.

const APP = "Apps/W.md";
const DATA = "Apps/W data.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const key = (el: Element, k: string) => {
  const e = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
  Object.defineProperty(e, "key", { value: k });
  el.dispatchEvent(e);
};

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** Every icon drawn, by the element it was drawn in. */
const icons = new Map<Element, string>();

/**
 * APP on a fake vault, in its own tab as AppView opens it (with a sheet), or `grid`ded, or hosted;
 * `edit` changes a note as Obsidian would and delivers the change.
 */
function setup(notes: Parameters<typeof fakeEnv>[0], opts: { hosting?: Hosting; env?: (env: ReturnType<typeof fakeEnv>["env"]) => ReturnType<typeof fakeEnv>["env"] } = {}) {
  const t = fakeEnv(notes);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, opts.hosting?.hostPath ?? APP, opts.env ? opts.env(t.env) : t.env, opts.hosting);
  app.openInPlace((el, name) => icons.set(el, name));
  started.push(app);
  app.load();
  const edit = async (path: string, change: (fm: Record<string, unknown>) => void) => {
    const note = t.f.files.get(path) ?? {};
    note.fm ??= {};
    change(note.fm);
    t.f.files.set(path, note);
    t.changed(path);
    await settle();
  };
  const widen = async (width: number) => {
    Object.defineProperty(root.querySelector(".gizmo"), "clientWidth", { value: width, configurable: true });
    app.resize();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const sheet = () => root.querySelector("aside.gz-sheet") as HTMLElement | null;
  const isOpen = () => !!sheet()?.classList.contains("is-open");
  const panel = (title: string) => [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-title")) === title) as HTMLElement | undefined;
  const rows = (title: string) => [...panel(title)!.querySelectorAll("tbody tr:not(.gz-ledger-group)")];
  return { ...t, app, root, edit, widen, sheet, isOpen, panel, rows };
}

const SPEND = { spend: [{ at: "2026-11-17", amount: 5, note: "Coffee" }, { at: "2026-11-18", amount: 7, note: "Lunch" }] };
const RECENT = { view: "table", title: "Recent", source: "spend", columns: ["at", "amount", "note"], select: "pick" };
const PICKED = { view: "text", title: "Picked", text: "Picked $pick.amount" };

test("a pick opens one sheet beside the app: the panel's title, the row's name, and the panels that wait for the pick, moved in", async () => {
  const s = setup({ [APP]: { fm: { app: "x", panels: [RECENT, PICKED] } }, [DATA]: { fm: SPEND } });
  await settle();
  const shell = s.root.querySelector(".gizmo")!;
  const aside = s.sheet()!;
  // Closed, it waits last in the shell, out of sight and out of reach.
  assert.equal(shell.lastElementChild, aside);
  assert.deepEqual([aside.getAttribute("role"), aside.getAttribute("aria-modal"), aside.getAttribute("tabindex")], ["dialog", "false", "-1"]);
  assert.ok(!s.isOpen() && aside.hasAttribute("inert") && aside.getAttribute("aria-hidden") === "true");
  const waiting = s.panel("Picked") ?? s.root.querySelector(".gz-sheet-slot > .gz-panel")!;
  assert.ok(waiting.classList.contains("gz-collapsed"));
  assert.equal(waiting.parentElement, s.root.querySelector(".gz-flow > .gz-sheet-slot"));

  const [coffee, lunch] = s.rows("Recent");
  click(lunch);
  await settle();
  assert.ok(s.isOpen() && !aside.hasAttribute("inert") && !aside.hasAttribute("aria-hidden"));
  assert.ok(shell.classList.contains("gz-sheet-open"));
  assert.equal(document.activeElement, aside, "the focus moves into the sheet");
  assert.deepEqual([...aside.children].map((c) => c.className), ["gz-sheet-top", "gz-sheet-body"]);
  assert.equal(text(aside.querySelector(".gz-sheet-top .gz-sheet-kicker")), "Recent");
  assert.equal(aside.getAttribute("aria-label"), "Recent");
  const close = aside.querySelector(".gz-sheet-top button.gz-sheet-close")!;
  assert.deepEqual([close.getAttribute("aria-label"), close.getAttribute("title"), icons.get(close)], ["Close", "Close (Esc)", "x"]);
  assert.equal(text(aside.querySelector("h2.gz-sheet-title")), "Lunch");
  // The panel that waited for the pick is in the sheet now, shown, and its slot is empty.
  assert.equal(waiting.parentElement, aside.querySelector(".gz-sheet-body > .gz-sheet-panels"));
  assert.ok(!waiting.classList.contains("gz-collapsed"));
  assert.equal(text(waiting.querySelector(".gz-text")), "Picked 7");
  assert.equal(s.root.querySelector(".gz-sheet-slot")!.children.length, 0);
  assert.ok(lunch.classList.contains("gz-selected"));

  // Another row switches what the one sheet shows.
  click(coffee);
  await settle();
  assert.equal(s.root.querySelectorAll("aside.gz-sheet").length, 1);
  assert.equal(text(aside.querySelector(".gz-sheet-title")), "Coffee");
  assert.equal(text(waiting.querySelector(".gz-text")), "Picked 5");
  assert.deepEqual([coffee, lunch].map((r) => r.classList.contains("gz-selected")), [true, false]);

  // The same row again closes it: the pick is taken back and the panel waits in its slot again.
  click(coffee);
  await settle();
  assert.ok(!s.isOpen() && !shell.classList.contains("gz-sheet-open"));
  assert.equal(waiting.parentElement, s.root.querySelector(".gz-sheet-slot"));
  assert.ok(waiting.classList.contains("gz-collapsed"));
  assert.equal(s.root.querySelectorAll(".gz-selected").length, 0);
  assert.equal(s.app.closeSheet(), false, "nothing is left to close");
});

const DECISIONS = {
  "Decisions/Phone plan.md": { fm: { expect: "Coverage is as good", confidence: 80, made: "2026-10-20", review: "2026-11-15", outcome: "open" } },
  "Decisions/Running.md": { fm: { expect: "Still running in February", confidence: 60, made: "2026-11-09", review: "2027-02-09", outcome: "open" } },
};
const TIMELINE = {
  view: "timeline", title: "Still waiting", source: "notes", from: "Decisions", where: { outcome: "open" }, start: "made", end: "review",
  detail: "I expected: {expect} ({confidence}% sure).",
};

test("a detail is the sheet's line, and nothing is drawn under the rows; a note's record shows its fields and Open", async () => {
  const s = setup({ [APP]: { fm: { app: "x", panels: [TIMELINE] } }, ...structuredClone(DECISIONS) });
  await settle();
  const timeline = s.panel("Still waiting")!;
  click(timeline.querySelector(".gz-tl-bar")!);
  await settle();
  const aside = s.sheet()!;
  assert.ok(s.isOpen());
  assert.equal(s.root.querySelector(".gz-detail"), null);
  assert.equal(text(aside.querySelector(".gz-sheet-kicker")), "Still waiting");
  assert.equal(text(aside.querySelector(".gz-sheet-title")), "Phone plan");
  assert.equal(text(aside.querySelector(".gz-sheet-title + .gz-sheet-line")), "I expected: Coverage is as good (80% sure).");
  // A timeline's record: the note's fields in order, without its file details.
  const fields = [...aside.querySelectorAll(".gz-sheet-fields > .gz-sheet-field")].map((f) => [text(f.querySelector("span.gz-sheet-label")), text(f.querySelector(".gz-sheet-value"))]);
  assert.deepEqual(fields, [["expect", "Coverage is as good"], ["confidence", "80"], ["made", "2026-10-20"], ["review", "2026-11-15"], ["outcome", "open"], ["name", "Phone plan"]]);
  const actions = aside.querySelector(".gz-sheet-body > .gz-sheet-actions")!;
  assert.equal(actions.previousElementSibling, aside.querySelector(".gz-sheet-panels"), "the actions come last");
  assert.deepEqual([...actions.children].map((a) => text(a)), ["Open"]);
  click(actions.querySelector("a")!);
  assert.deepEqual(s.opened, ["Decisions/Phone plan.md"]);
});

test("the sheet follows its row when the data changes, and closes when the row isn't shown any more", async () => {
  const s = setup({ [APP]: { fm: { app: "x", panels: [TIMELINE] } }, ...structuredClone(DECISIONS) });
  await settle();
  click(s.panel("Still waiting")!.querySelector(".gz-tl-bar")!);
  await settle();
  const title = s.sheet()!.querySelector(".gz-sheet-title");
  await s.edit("Decisions/Phone plan.md", (fm) => { fm.expect = "Coverage is fine at home"; });
  assert.equal(s.sheet()!.querySelector(".gz-sheet-title"), title, "shown again in place");
  assert.match(text(s.sheet()!.querySelector(".gz-sheet-line")), /Coverage is fine at home/);
  // Decided, it drops out of the timeline, and the sheet goes with it.
  await s.edit("Decisions/Phone plan.md", (fm) => { fm.outcome = "right"; });
  assert.ok(!s.isOpen());
  assert.equal(s.root.querySelectorAll(".gz-tl-bar").length, 1);
  assert.equal(s.root.querySelectorAll(".gz-selected").length, 0);
});

const CHOICES = {
  app: "x",
  data: { spend: { source: "spend", fields: { amount: "number", category: ["food", "rent"], note: "text" } } },
  panels: [{ view: "table", title: "Recent", source: "spend", columns: ["at", "amount", "category", "note"], labels: { at: "When" }, edit: ["category", "note"] }],
};

test("a table row with neither select nor detail opens in the sheet with its columns as fields; an edited one writes the row", async () => {
  const s = setup({ [APP]: { fm: CHOICES }, [DATA]: { fm: { spend: [{ at: "2026-11-17", amount: 5, category: "food", note: "Coffee" }, { at: "2026-11-18", amount: 700, category: "food", note: "Rent" }] } } });
  await settle();
  const [, rent] = s.rows("Recent");
  assert.ok(rent.classList.contains("gz-selectable"));
  click(rent);
  await settle();
  const aside = s.sheet()!;
  assert.ok(s.isOpen());
  assert.equal(text(aside.querySelector(".gz-sheet-kicker")), "Recent");
  assert.equal(text(aside.querySelector(".gz-sheet-title")), "Rent", "its first field of free text: not a date, nor one of a field's choices");
  assert.equal(aside.querySelector(".gz-sheet-line"), null, "nothing more to say");
  assert.deepEqual([...aside.querySelectorAll(".gz-sheet-actions > *")].map(text), ["Delete"], "a row of the app's own list can be deleted; no other action");
  const fields = [...aside.querySelectorAll(".gz-sheet-field")];
  assert.deepEqual(fields.map((f) => text(f.querySelector(".gz-sheet-label"))), ["When", "amount", "category", "note"]);
  // Its own list's row moves in time: When is a date and time to change.
  assert.equal((fields[0].querySelector("input[type=datetime-local]") as HTMLInputElement | null)?.value, "2026-11-18T00:00");
  assert.equal(text(fields[1].querySelector(".gz-sheet-value")), "700");
  // The edited fields are the controls the table's cells are.
  const category = fields[2].querySelector("select.gz-edit") as HTMLSelectElement;
  const note = fields[3].querySelector("input.gz-edit") as HTMLInputElement;
  assert.deepEqual([...category.querySelectorAll("option")].map((o) => o.textContent), ["food", "rent"]);
  assert.equal(note.value, "Rent");
  for (const o of category.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "rent");
  change(category);
  await settle();
  assert.deepEqual((listsIn(s.f.files.get(DATA)!.fm)!.spend as Record<string, unknown>[]).map((r) => r.category), ["food", "rent"]);
  // The sheet shows the new value in place, as does the table.
  assert.equal(s.sheet()!.querySelector(".gz-sheet-field select"), category);
  assert.equal(text(s.sheet()!.querySelector(".gz-sheet-title")), "Rent");
  assert.equal((s.rows("Recent")[1].querySelector("select") as HTMLSelectElement).value, "1");
  note.focus();
  note.value = "Rent for December";
  change(note);
  await settle();
  assert.equal((listsIn(s.f.files.get(DATA)!.fm)!.spend as Record<string, unknown>[])[1].note, "Rent for December");
  assert.equal(document.activeElement, note, "the field keeps the focus");
  assert.equal(text(s.sheet()!.querySelector(".gz-sheet-title")), "Rent for December", "the title follows the row");
});

test("a record's row actions and Open are the sheet's last part", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", panels: [{ view: "list", title: "Inbox", source: "notes", from: "Decisions", item: "{name}", action: "Done", notify: "Done with {name}" }] } },
    ...structuredClone(DECISIONS),
  });
  await settle();
  const running = [...s.panel("Inbox")!.querySelectorAll("li")].find((li) => text(li).startsWith("Running"))!;
  click(running);
  await settle();
  const aside = s.sheet()!;
  assert.equal(text(aside.querySelector(".gz-sheet-title")), "Running", "a list names it as its item does");
  const actions = aside.querySelector(".gz-sheet-actions")!;
  assert.deepEqual([...actions.children].map((a) => `${a.tagName.toLowerCase()} ${text(a)}`), ["button Done", "a Open"]);
  click(actions.querySelector("button")!);
  await settle();
  assert.deepEqual(s.notices, [], "said under the list, not as a notice");
  assert.equal(text(s.panel("Inbox")!.nextElementSibling?.querySelector(".gz-notice-text")), "Done with Running");
  click(actions.querySelector("a")!);
  assert.deepEqual(s.opened, ["Decisions/Running.md"]);
});

test("the close button and Escape close the sheet, take the pick back and give the focus back to what was picked", async () => {
  const s = setup({ [APP]: { fm: { app: "x", panels: [RECENT, PICKED] } }, [DATA]: { fm: SPEND } });
  await settle();
  const coffee = s.rows("Recent")[0] as HTMLElement;
  coffee.focus();
  key(coffee, "Enter");
  await settle();
  assert.ok(s.isOpen());
  assert.equal(document.activeElement, s.sheet());
  click(s.sheet()!.querySelector(".gz-sheet-close")!);
  await settle();
  assert.ok(!s.isOpen());
  assert.equal(document.activeElement, coffee);
  assert.ok(!coffee.classList.contains("gz-selected"));
  assert.ok(s.panel("Picked") === undefined && s.root.querySelector(".gz-sheet-slot > .gz-panel")!.classList.contains("gz-collapsed"), "the pick is taken back");

  // Escape in the app's tab asks the controller to close it, before anything else Escape does.
  click(coffee);
  await settle();
  assert.ok(s.isOpen());
  assert.equal(s.app.closeSheet(), true);
  assert.ok(!s.isOpen());
  assert.equal(document.activeElement, coffee);
  assert.equal(s.root.querySelectorAll(".gz-selected").length, 0);
  assert.equal(s.app.closeSheet(), false);
  // Picking the row again opens it afresh.
  click(coffee);
  await settle();
  assert.ok(s.isOpen() && coffee.classList.contains("gz-selected"));
});

test("a click on an edit cell, a link or a button in a row is that control's, and doesn't open the sheet", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", panels: [{ view: "table", title: "Shelf", source: "notes", from: "Decisions", columns: ["name", "outcome"], edit: ["outcome"], action: "Mark", notify: "Marked" }] } },
    ...structuredClone(DECISIONS),
  });
  await settle();
  const [row] = s.rows("Shelf");
  click(row.querySelector("input.gz-edit")!);
  click(row.querySelector("a")!);
  click(row.querySelector("button.gz-row-action")!);
  await settle();
  assert.ok(!s.isOpen());
  assert.deepEqual(s.opened, ["Decisions/Phone plan.md"]);
  click(row.querySelector("td:nth-child(2)")!);
  await settle();
  assert.ok(s.isOpen());
});

test("a board's card opens with its fields, and the field its cards move between is edited there", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", data: { projects: { source: "notes", from: "Projects", fields: { status: ["idea", "doing", "done"] } } }, panels: [{ view: "board", title: "Projects", source: "projects", group: "status", item: "{name} · {area}" }] } },
    "Projects/Garden.md": { fm: { status: "doing", area: "home" } },
  });
  await settle();
  click(s.root.querySelector(".gz-board-card")!);
  await settle();
  const aside = s.sheet()!;
  assert.equal(text(aside.querySelector(".gz-sheet-title")), "Garden", "the card's name, before its first \" · \"");
  const fields = [...aside.querySelectorAll(".gz-sheet-field")];
  assert.deepEqual(fields.map((f) => text(f.querySelector(".gz-sheet-label"))), ["status", "area", "name"]);
  const status = fields[0].querySelector("select.gz-edit") as HTMLSelectElement;
  for (const o of status.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "done");
  change(status);
  await settle();
  assert.equal(s.f.files.get("Projects/Garden.md")!.fm!.status, "done");
  assert.ok(s.isOpen(), "the card moved columns, and the sheet still shows it");
  assert.ok(s.root.querySelector(".gz-board-done .gz-board-card.gz-selected"));
});

test("a day opens through select: its date as the title, its value as the line; without select a day opens nothing", async () => {
  const doses = { doses: [{ at: "2026-11-17T09:00" }, { at: "2026-11-17T21:00" }, { at: "2026-11-18T08:30" }] };
  const s = setup({
    [APP]: { fm: { app: "x", panels: [
      { view: "calendar", title: "My year", source: "doses", group: "at", select: "day" },
      { view: "list", title: "Doses on the day I pick", source: "doses", where: { at: "$day.at" }, item: "{at}", format: { at: "time" } },
      { view: "calendar", title: "Plain", source: "doses", group: "at" },
    ] } },
    [DATA]: { fm: doses },
  });
  await settle();
  const plain = s.panel("Plain")!;
  click(plain.querySelector('.gz-cal-day[data-date="2026-11-17"]')!);
  await settle();
  assert.ok(!s.isOpen());
  assert.equal(plain.querySelector(".gz-selectable"), null);

  click(s.panel("My year")!.querySelector('.gz-cal-day[data-date="2026-11-17"]')!);
  await settle();
  const aside = s.sheet()!;
  assert.equal(text(aside.querySelector(".gz-sheet-kicker")), "My year");
  assert.equal(text(aside.querySelector(".gz-sheet-title")), new Date(2026, 10, 17).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }));
  assert.equal(text(aside.querySelector(".gz-sheet-line")), "2 entries");
  assert.equal(aside.querySelector(".gz-sheet-fields, .gz-sheet-actions"), null, "a day has no fields of its own");
  const list = s.panel("Doses on the day I pick")!;
  assert.equal(list.parentElement, aside.querySelector(".gz-sheet-panels"));
  assert.deepEqual([...list.querySelectorAll("li:not(.gz-ledger-group)")].map(text), [new Date(2026, 10, 17, 9).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), new Date(2026, 10, 17, 21).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })]);
});

test("a panel in the sheet keeps its own picks: its detail is drawn under its rows, and a plain record in it opens nothing", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", panels: [
      RECENT,
      { view: "list", title: "Same day", source: "spend", where: { at: "$pick.at" }, item: "{note}", detail: "{note}: {amount}" },
      { view: "list", title: "Same amount", source: "spend", where: { amount: "$pick.amount" }, item: "{note}" },
    ] } },
    [DATA]: { fm: SPEND },
  });
  await settle();
  click(s.rows("Recent")[0]);
  await settle();
  const aside = s.sheet()!;
  const sameDay = s.panel("Same day")!, sameAmount = s.panel("Same amount")!;
  assert.deepEqual([sameDay, sameAmount].map((p) => p.parentElement), [aside.querySelector(".gz-sheet-panels"), aside.querySelector(".gz-sheet-panels")]);
  assert.equal(sameAmount.querySelector(".gz-selectable"), null);
  click(sameDay.querySelector("li.gz-selectable")!);
  await settle();
  assert.equal(text(sameDay.querySelector(".gz-detail-text")), "Coffee: 5");
  assert.equal(text(aside.querySelector(".gz-sheet-title")), "Coffee", "the sheet still shows the row picked in Recent");
  assert.ok(s.isOpen());
});

test("a panel in the sheet is drawn at the sheet's width, and again when the app narrows to a bottom sheet", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", panels: [RECENT, { view: "line", title: "That day", source: "spend", where: { at: "$pick.at" }, x: "at", y: "amount" }] } },
    [DATA]: { fm: SPEND },
  });
  await settle();
  const viewBox = () => s.panel("That day")?.querySelector(".gz-chart-svg")?.getAttribute("viewBox");
  click(s.rows("Recent")[0]);
  await settle();
  assert.equal(viewBox(), "0 0 331 220", "380 px less its border and padding");
  const shell = s.root.querySelector(".gizmo")!;
  await s.widen(500);
  assert.ok(shell.classList.contains("gz-narrow") && s.root.querySelector(".gizmo.gz-narrow > aside.gz-sheet.is-open"), "under 600 px it is the bottom sheet");
  assert.equal(viewBox(), "0 0 452 220", "as wide as the app, less its padding");
  await s.widen(900);
  assert.ok(!shell.classList.contains("gz-narrow"));
  assert.equal(viewBox(), "0 0 331 220");
});

test("the sheet keeps its panels when the app is drawn again, and closes when the panel it opened from goes", async () => {
  const s = setup({ [APP]: { fm: { app: "x", panels: [RECENT, PICKED] } }, [DATA]: { fm: SPEND } });
  await settle();
  click(s.rows("Recent")[1]);
  await settle();
  await s.edit(APP, (fm) => { fm.description = "Changed"; (fm.panels as unknown[]).push({ view: "countdown", to: "2027-01-01" }); });
  assert.ok(s.isOpen());
  assert.equal(text(s.sheet()!.querySelector(".gz-sheet-panels .gz-text")), "Picked 7");
  assert.equal(s.root.querySelector(".gz-sheet-slot")!.children.length, 0);
  await s.edit(APP, (fm) => { fm.panels = [PICKED, { view: "countdown", to: "2027-01-01" }]; });
  assert.ok(!s.isOpen());
  assert.equal(s.sheet()!.querySelector(".gz-sheet-panels")!.children.length, 0);
});

test("in the past the table and the sheet show what they would edit as text, with no controls or actions", async () => {
  const t0 = new Date(2026, 10, 18, 12).getTime();
  const app = { ...CHOICES, panels: [{ ...CHOICES.panels[0], action: "Again", save: "spend" }] };
  const s = setup({ [APP]: { fm: app }, [DATA]: { fm: { spend: [{ at: "2026-11-17", amount: 5, category: "food", note: "Coffee" }] } } }, { env: (env) => pastEnv(env, t0) });
  await settle();
  const [row] = s.rows("Recent");
  assert.equal(row.querySelectorAll("input, select, button").length, 0);
  assert.deepEqual([...row.querySelectorAll("td")].map(text).slice(1, 4), ["5", "food", "Coffee"]);
  click(row);
  await settle();
  const sheet = s.sheet()!;
  assert.ok(s.isOpen());
  assert.equal(sheet.querySelectorAll(".gz-sheet-field input, .gz-sheet-field select, .gz-row-action").length, 0);
  assert.match(text(sheet), /food/);
  assert.equal((listsIn(s.f.files.get(DATA)!.fm)!.spend as Record<string, unknown>[])[0].category, "food");
});

test("on the grid nothing changes: no sheet, the detail under the rows, a waiting panel says what to pick, and a plain row picks nothing", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", layout: "grid", panels: [RECENT, PICKED, { ...TIMELINE }, { view: "table", title: "Plain", source: "spend", columns: ["at", "amount"] }] } },
    [DATA]: { fm: SPEND }, ...structuredClone(DECISIONS),
  });
  await settle();
  assert.equal(s.sheet(), null);
  assert.equal(text(s.root.querySelector(".gz-view-text .gz-waiting")), "Pick a row in “Recent”");
  assert.equal(s.panel("Plain")!.querySelector(".gz-selectable"), null);
  click(s.rows("Recent")[1]);
  click(s.panel("Still waiting")!.querySelector(".gz-tl-bar")!);
  await settle();
  assert.equal(text(s.root.querySelector(".gz-view-text .gz-text")), "Picked 7");
  assert.match(text(s.panel("Still waiting")!.querySelector(".gz-detail")), /Coverage is as good/);
  assert.equal(s.root.querySelector(".gz-sheet-open, .gz-sheet"), null);
});

test("hosted, nothing changes: the detail stays under the rows and a waiting panel shows in its slot once picked", async () => {
  const definition = { app: "", panels: [RECENT, PICKED, { view: "table", title: "Plain", source: "spend", columns: ["at", "amount"], detail: "Spent {amount}" }] };
  const s = setup({ "Notes/Day.md": { fm: {} }, "Notes/Day data.md": { fm: SPEND } }, {
    hosting: { kind: "embed", grantKey: "Notes/Day.md#k", hostPath: "Notes/Day.md", definition: () => definition },
  });
  await settle();
  assert.equal(s.sheet(), null);
  const slot = s.root.querySelector(".gz-flow > .gz-sheet-slot")!;
  assert.ok(slot.querySelector(".gz-panel")!.classList.contains("gz-collapsed"));
  click(s.rows("Recent")[0]);
  await settle();
  assert.equal(text(slot.querySelector(".gz-text")), "Picked 5");
  click(s.rows("Plain")[1]);
  assert.equal(text(s.panel("Plain")!.querySelector(".gz-detail-text")), "Spent 7");
  assert.equal(s.root.querySelector(".gz-sheet, .gz-sheet-open"), null);
});

test("switching tabs closes the sheet, since what it shows was picked in the tab being left", async () => {
  const s = setup({
    [APP]: { fm: { app: "x", panels: [{ ...RECENT, select: undefined, tab: "Spend" }, { view: "countdown", title: "Trip", to: "2027-01-01", tab: "Later" }] } },
    [DATA]: { fm: SPEND },
  });
  await settle();
  click(s.rows("Recent")[0]);
  await settle();
  assert.ok(s.isOpen());
  const [spend, later] = [...s.root.querySelectorAll("button.gz-tab")] as HTMLButtonElement[];
  spend.click();
  assert.ok(s.isOpen(), "the open tab again changes nothing");
  later.click();
  assert.ok(!s.isOpen());
});
