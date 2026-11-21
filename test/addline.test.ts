import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { undoEntry, undoMessage } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import type { Row } from "../src/data.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { button, form } from "../src/views/inputs.ts";
import type { PanelCtx, PanelHandle, RunResult } from "../src/views/registry.ts";
import { addLine, lineIn, said, typeLine, underLine } from "./support/addline.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";

// Thursday 19 November 2026, 10:00.
const NOW = new Date(2026, 10, 19, 10, 0);
const MAC = /mac|iphone|ipad/i.test(navigator.platform ?? "");
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
/** A key pressed with nothing focused, as the document hears it; true when something took it. */
const press = (key: string, mods: { meta?: boolean; ctrl?: boolean } = {}) => {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: false, altKey: false });
  document.dispatchEvent(e);
  return e.defaultPrevented;
};
const undoKey = () => press("z", MAC ? { meta: true } : { ctrl: true });
/** linkedom reads a select's value from its selected option only, so pick one as a person would. */
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
};

const mounted: { handle: PanelHandle; el: HTMLElement }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.handle.destroy?.();
    m.el.closest(".workspace-leaf, .gz-embed")?.remove();
    m.el.remove();
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
});

function panel(raw: Record<string, unknown>): Panel {
  const r = checkPanel(raw, true);
  assert.deepEqual(r.errors, []);
  return r.panel!;
}

const SPEND = panel({
  view: "form", title: "Spent something", save: "spend", label: "Add", alias: "spend",
  fields: { amount: { type: "number", label: "Spent", format: "$0,0.00" }, category: ["food", "home", "transport", "fun", "other"], note: "text" },
});

/**
 * A panel's view of an app, faked: where it sits (the line to add things unless `slot` says
 * otherwise), what its runs return, and what was run and undone.
 */
function fakeCtx(opts: { slot?: "compose" | null; run?: (row: Row) => RunResult | void; undo?: boolean } = {}) {
  const runs: { row: Row; how?: { inPlace?: boolean } }[] = [];
  const undone: string[] = [];
  const ctx: PanelCtx = {
    now: NOW,
    width: () => 760,
    runActions: async (_p, row, how) => {
      runs.push({ row, how });
      return opts.run ? opts.run(row) : { ok: true, entry: `entry-${runs.length}` };
    },
    toggleChecked: async () => {},
    clearChecked: async () => {},
    openNote: () => {},
    timer: () => ({ remainingMs: 0 }),
    startTimer: () => {},
    pauseTimer: () => {},
    resetTimer: () => {},
    select: () => {},
    selected: () => undefined,
    editRow: async () => {},
    place: () => (opts.slot === null ? undefined : { role: "verb", slot: opts.slot ?? "compose" }),
    ...(opts.undo !== false && { undo: async (id: string) => { undone.push(id); return "Undone"; } }),
  };
  return { ctx, runs, undone };
}

/**
 * Mounts a form or button panel as an app in its own, active tab would: inside the active leaf's
 * `.gizmo`, unless `inside` names another wrapper (an embed). `rows` are the list it saves to.
 */
function mount(p: Panel, ctx: PanelCtx, opts: { key?: string; rows?: Row[]; inside?: string; root?: HTMLElement } = {}) {
  let root = opts.root;
  if (!root) {
    const outer = document.body.createDiv({ cls: opts.inside ?? "workspace-leaf mod-active" });
    root = outer.createDiv({ cls: "gizmo gz-composed" });
  }
  const el = root.createDiv({ cls: `gz-panel gz-view-${p.view}` });
  const def = p.view === "button" ? button : form;
  const handle = def.mount(el, p, ctx, opts.key ?? `k-${mounted.length}-${Math.random()}`);
  handle.update(opts.rows ?? []);
  mounted.push({ handle, el });
  return { el, handle, root };
}

test("an empty add line: the verb, an example as its placeholder, / to focus it, a disabled button, and examples to try", () => {
  const { ctx } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  const line = el.querySelector("form.gz-addline")!;
  assert.equal(text(line.querySelector(".gz-addline-verb")), "spend");
  const input = lineIn(el);
  assert.equal(input.type, "text");
  assert.equal(input.getAttribute("aria-label"), "Spent something");
  assert.equal(input.getAttribute("placeholder"), "12.50 food lunch");
  assert.equal(text(line.querySelector("kbd.gz-addline-key")), "/");
  assert.equal(line.querySelector("kbd.gz-addline-key")!.hasAttribute("hidden"), false);
  const go = line.querySelector("button.gz-addline-go.mod-cta") as HTMLButtonElement;
  assert.equal(text(go), "Add");
  assert.ok(go.querySelector("svg"), "an enter icon");
  assert.equal(go.disabled, true);
  assert.equal(el.querySelector(".gz-form"), null, "no fields");
  const under = el.querySelector(".gz-addline-under")!;
  assert.equal(text(under.querySelector(".gz-addline-try")), "Try");
  const examples = [...under.querySelectorAll("button.gz-addline-example")];
  assert.deepEqual(examples.map(text), ["9.80 coffee", "42 home groceries"]);
  // Taking an example fills the line, focuses it and shows what it would save.
  click(examples[1]);
  assert.equal(input.value, "42 home groceries");
  assert.equal(document.activeElement, input);
  assert.deepEqual([...el.querySelectorAll(".gz-pv-label")].map(text), ["Spent", "category", "note"]);
  assert.equal(go.disabled, false);
  assert.equal(line.querySelector("kbd.gz-addline-key")!.hasAttribute("hidden"), true, "no / once something is typed");
});

test("while typing: each field's value in order, a choice of six or fewer as chips, a missing value as —, and errors", () => {
  const { ctx } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  typeLine(el, "lunch with Sam 14.5");
  const pv = [...el.querySelectorAll(".gz-pv")];
  assert.deepEqual(pv.map((x) => text(x.querySelector(".gz-pv-label"))), ["Spent", "category", "note"]);
  assert.equal(text(pv[0].querySelector(".gz-pv-value")), "$14.50", "in the field's format");
  assert.equal(text(pv[2].querySelector(".gz-pv-value")), "lunch with Sam");
  const chips = [...pv[1].querySelectorAll("button.gz-chip")];
  assert.deepEqual(chips.map(text), ["food", "home", "transport", "fun", "other"]);
  // Nothing typed for it: the form's default, the first choice, shown as a default.
  assert.deepEqual(chips.filter((c) => c.classList.contains("is-default")).map(text), ["food"]);
  assert.equal(pv[1].classList.contains("is-default"), true);
  assert.equal(el.querySelector(".gz-chip.is-on"), null);

  typeLine(el, "lunch tra");
  assert.equal(text(el.querySelector(".gz-chip.is-on")), "transport", "three letters of one choice pick it");
  assert.equal(text(el.querySelector(".gz-pv.is-missing .gz-pv-value")), "—");
  assert.equal((el.querySelector(".gz-addline-go") as HTMLButtonElement).disabled, true, "nothing to save without the amount");

  typeLine(el, "5 colour=red");
  assert.equal(text(el.querySelector(".gz-addline-error")), "spend has no field “colour”; its fields are amount, category, note");
  assert.equal((el.querySelector(".gz-addline-go") as HTMLButtonElement).disabled, true);
});

test("a date shows as Today, Yesterday or its day, a number's default and a choice of seven as text", () => {
  const p = panel({
    view: "form", title: "Run", save: "runs",
    fields: { km: { type: "number", default: 5 }, on: "date", day: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  });
  const { ctx } = fakeCtx();
  const { el } = mount(p, ctx);
  const values = () => [...el.querySelectorAll(".gz-pv")].map((x) => text(x.querySelector(".gz-pv-value")));
  typeLine(el, "sat");
  assert.deepEqual(values(), ["5", "Today", "sat"]);
  assert.equal(el.querySelectorAll(".gz-chip").length, 0);
  typeLine(el, "8 yday");
  assert.deepEqual(values(), ["8", "Yesterday", "mon"]);
  typeLine(el, "8 2026-11-27");
  assert.deepEqual(values(), ["8", "Fri Nov 27", "mon"]);
  typeLine(el, "8 2027-01-01");
  assert.deepEqual(values(), ["8", "Fri Jan 1, 2027", "mon"]);
});

test("a choice left out is guessed from the latest row sharing a word with what was typed, and saved so", async () => {
  const { ctx, runs } = fakeCtx();
  const rows = [
    { amount: 9, category: "fun", note: "Lunch with Sam" },
    { amount: 4, category: "home", note: "coffee beans" },
    { amount: 12, category: "food", note: "lunch at work" },
    { amount: 3, category: "picnic", note: "lunch outside" },
  ];
  const { el } = mount(SPEND, ctx, { rows });
  typeLine(el, "14 lunch with Sam");
  // The newest row sharing a word is the last one, but its category isn't a choice; the one before is.
  assert.equal(text(el.querySelector(".gz-chip.is-on")), "food");
  assert.equal(text(el.querySelector(".gz-pv-guess")), "guessed from “lunch”");
  typeLine(el, "14 Sam");
  assert.equal(text(el.querySelector(".gz-chip.is-on")), "fun");
  assert.equal(text(el.querySelector(".gz-pv-guess")), "guessed from “sam”");
  typeLine(el, "14 go");
  assert.equal(el.querySelector(".gz-pv-guess"), null, "words of fewer than 3 letters guess nothing");
  typeLine(el, "14 home lunch");
  assert.equal(el.querySelector(".gz-pv-guess"), null, "a choice typed is never guessed over");
  addLine(el, "14 coffee");
  await settle();
  assert.deepEqual(runs.at(-1)!.row, { amount: 14, category: "home", note: "coffee" });
});

test("a chip sets its choice and puts the cursor back in the line", async () => {
  const { ctx, runs } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  const input = typeLine(el, "12.50 food lunch");
  click([...el.querySelectorAll(".gz-chip")].find((c) => text(c) === "fun")!);
  assert.equal(text(el.querySelector(".gz-chip.is-on")), "fun");
  assert.equal(document.activeElement, input);
  input.closest("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.deepEqual(runs[0].row, { amount: 12.5, category: "fun", note: "lunch" });
});

test("Enter saves the row typed as the form types it, clears the line, and says what was saved with Undo", async () => {
  const { ctx, runs, undone } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  addLine(el, "bus pass 2.90 tra");
  await settle();
  assert.deepEqual(runs, [{ row: { amount: 2.9, category: "transport", note: "bus pass" }, how: { inPlace: true } }]);
  assert.equal(lineIn(el).value, "");
  const notice = el.querySelector(".gz-addline-under .gz-notice")!;
  assert.ok(notice.querySelector("svg"), "a check");
  assert.equal(said(el), "Added $2.90 to spend");
  assert.equal(text(notice.querySelector("button.gz-undo")), "Undo");
  assert.equal(text(notice.querySelector("kbd")), MAC ? "⌘Z" : "Ctrl Z");
  // Typing again shows the preview; an empty line brings back what was said.
  typeLine(el, "3");
  assert.equal(el.querySelector(".gz-notice"), null);
  typeLine(el, "");
  assert.equal(said(el), "Added $2.90 to spend");

  click(notice.isConnected ? notice.querySelector("button.gz-undo")! : el.querySelector("button.gz-undo")!);
  await settle();
  assert.deepEqual(undone, ["entry-1"]);
  assert.equal(said(el), "Undone");
  assert.equal(el.querySelector("button.gz-undo"), null, "Undo is gone once used");
});

test("what was said goes after six seconds, and what Undo did after three", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  addLine(el, "4 coffee");
  // The save is a promise; let it land before moving the clock.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(said(el), "Added $4.00 to spend");
  t.mock.timers.tick(5900);
  assert.equal(said(el), "Added $4.00 to spend");
  t.mock.timers.tick(200);
  assert.equal(said(el), undefined);
  assert.equal(text(el.querySelector(".gz-addline-try")), "Try", "back to the hint");
  addLine(el, "5 coffee");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  click(el.querySelector("button.gz-undo")!);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(said(el), "Undone");
  t.mock.timers.tick(3100);
  assert.equal(said(el), undefined);
});

test("the panel's notify, filled, is said in place of the default; without undo in the app there is no Undo", async () => {
  const p = panel({ view: "form", title: "Weigh", fields: { weight: "number" }, save: "weights", notify: "Logged {weight}" });
  const { ctx } = fakeCtx({ run: () => ({ ok: true, told: "Logged 80", entry: "e" }), undo: false });
  const { el } = mount(p, ctx);
  addLine(el, "80");
  await settle();
  assert.equal(said(el), "Logged 80");
  assert.equal(el.querySelector("button.gz-undo"), null);
  assert.equal(el.querySelector(".gz-notice kbd"), null);
});

test("a value rule's refusal keeps the line and says why; a run that failed keeps it too and says nothing", async () => {
  let answer: RunResult = { error: "amount 9000 isn't below 5000", ok: false };
  const { ctx } = fakeCtx({ run: () => answer });
  const { el } = mount(SPEND, ctx);
  addLine(el, "9000 food rent");
  await settle();
  assert.equal(lineIn(el).value, "9000 food rent");
  assert.equal(text(el.querySelector(".gz-addline-error")), "Not saved: amount 9000 isn't below 5000");
  typeLine(el, "900 food rent");
  assert.equal(el.querySelector(".gz-addline-error"), null, "typing again clears it");
  answer = { ok: false };
  addLine(el, "900 food rent");
  await settle();
  assert.equal(lineIn(el).value, "900 food rent");
  assert.equal(el.querySelector(".gz-notice"), null);
});

test("Escape clears the line and leaves it", () => {
  const { ctx } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  const input = typeLine(el, "12 fun");
  input.focus();
  click([...el.querySelectorAll(".gz-chip")].find((c) => text(c) === "home")!);
  const esc = Object.assign(new window.Event("keydown", { cancelable: true }), { key: "Escape" });
  input.dispatchEvent(esc);
  assert.equal(input.value, "");
  assert.notEqual(document.activeElement, input);
  assert.equal(text(el.querySelector(".gz-addline-try")), "Try");
  typeLine(el, "12");
  assert.equal(el.querySelector(".gz-chip.is-on"), null, "the chip picked is let go too");
});

test("⌘Z (Ctrl Z) takes the latest Undo while nothing editable has focus, only in the active app's own tab", async () => {
  const { ctx, undone } = fakeCtx();
  const { el } = mount(SPEND, ctx);
  addLine(el, "4 coffee");
  await settle();
  const input = lineIn(el);
  input.focus();
  assert.equal(undoKey(), false, "the line's own undo while it has focus");
  input.blur();
  assert.equal(undoKey(), true);
  await settle();
  assert.deepEqual(undone, ["entry-1"]);
  assert.equal(undoKey(), false, "nothing left to undo");

  // Two add lines: the latest thing said is the one undone.
  const second = mount(SPEND, ctx, { root: el.closest(".gizmo") as HTMLElement });
  addLine(el, "5 coffee");
  await settle();
  addLine(second.el, "6 coffee");
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
  undoKey();
  await settle();
  assert.deepEqual(undone, ["entry-1", "entry-3"]);

  // In an embed, or a tab that isn't the active one, the keys are left alone.
  const embedded = mount(SPEND, fakeCtx().ctx, { inside: "gz-embed workspace-leaf mod-active" });
  addLine(embedded.el, "7 coffee");
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
  assert.equal(undoKey(), false);
  const behind = mount(SPEND, fakeCtx().ctx, { inside: "workspace-leaf" });
  addLine(behind.el, "8 coffee");
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
  assert.equal(undoKey(), false);
});

test("/ focuses the first add line on screen in the active app's own tab, unless something editable has focus", () => {
  const { ctx } = fakeCtx();
  const first = mount(SPEND, ctx);
  const root = first.el.closest(".gizmo") as HTMLElement;
  // The second sits in a tab pane, shown; the first is outside any tab, so it comes first.
  const pane = root.createDiv({ cls: "gz-tabpane" });
  const second = mount(SPEND, ctx, { root: pane });
  assert.equal(press("/"), true);
  assert.equal(document.activeElement, lineIn(first.el));
  // Typing in it, / is a character.
  assert.equal(press("/"), false);
  lineIn(first.el).blur();
  // Only the open tab's line, when the first is in a tab that is hidden.
  first.el.closest(".gizmo")!.prepend(first.el);
  const hidden = root.createDiv({ cls: "gz-tabpane gz-off" });
  hidden.appendChild(first.el);
  assert.equal(press("/"), true);
  assert.equal(document.activeElement, lineIn(second.el));
  lineIn(second.el).blur();
  // Not in an embed, a lens or a base, nor in an app whose tab isn't the active one.
  for (const inside of ["workspace-leaf mod-active gz-embed", "workspace-leaf mod-active gz-lens", "workspace-leaf"]) {
    hidden.remove();
    pane.remove();
    const other = mount(SPEND, fakeCtx().ctx, { inside });
    assert.equal(press("/"), false, inside);
    other.handle.destroy?.();
  }
});

test("a destroyed add line stops listening", () => {
  const { ctx } = fakeCtx();
  const { el, handle } = mount(SPEND, ctx);
  handle.destroy!();
  assert.equal(press("/"), false);
  assert.notEqual(document.activeElement, lineIn(el));
});

test("a form with a text box, a tick box or more than five fields keeps its fields, on a quiet surface, and says what it saved", async () => {
  const journal = panel({ view: "form", title: "Journal", fields: { title: "text", body: "textarea" }, save: "Journal/" });
  const { ctx, runs } = fakeCtx();
  const { el } = mount(journal, ctx);
  assert.equal(el.querySelector(".gz-addline"), null);
  const f = el.querySelector("form.gz-form")!;
  assert.deepEqual([...f.querySelectorAll(".gz-field > span")].map(text), ["title", "body"]);
  assert.equal(el.querySelector(".gz-addline-more"), null, "one line can't hold a text box");
  (f.querySelector("input") as HTMLInputElement).value = "Rain";
  (f.querySelector("textarea") as HTMLTextAreaElement).value = "All day.";
  f.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(runs, [{ row: { title: "Rain", body: "All day." }, how: { inPlace: true } }]);
  assert.equal(said(el), "Added “Rain” to Journal");
  assert.ok(el.querySelector("button.gz-undo"));

  const six = panel({ view: "form", title: "Six", save: "six", fields: { a: "number", b: "number", c: "number", d: "number", e: "number", f: "number" } });
  const ticked = panel({ view: "form", title: "Ticked", save: "t", fields: { what: "text", done: "checkbox" } });
  for (const p of [six, ticked]) assert.ok(mount(p, fakeCtx().ctx).el.querySelector("form.gz-form"), p.title ?? "");
});

test("Use the form and Use one line switch a form that fits one line, remembered for the panel while Obsidian runs", async () => {
  const { ctx, runs } = fakeCtx();
  const { el, handle } = mount(SPEND, ctx, { key: "budget-form" });
  click(el.querySelector("button.gz-addline-more")!);
  assert.equal(el.querySelector(".gz-addline"), null);
  const f = el.querySelector("form.gz-form")!;
  assert.equal(text(el.querySelector("button.gz-addline-more")), "Use one line");
  (f.querySelector('input[type="number"]') as HTMLInputElement).value = "7";
  choose(f.querySelector("select")!, "food");
  f.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(runs[0].row, { amount: 7, category: "food", note: "" });
  assert.equal(said(el), "Added $7.00 to spend");
  // Drawn again for the same panel, it is still the form.
  handle.destroy!();
  el.remove();
  const again = mount(SPEND, ctx, { key: "budget-form" });
  assert.ok(again.el.querySelector("form.gz-form"));
  click(again.el.querySelector("button.gz-addline-more")!);
  assert.ok(again.el.querySelector("form.gz-addline"));
  assert.equal(text(again.el.querySelector("button.gz-addline-more")), "Use the form");
});

test("a button in the line to add things: one big button with a check, and what it did beside it with Undo", async () => {
  const meds = panel({ view: "button", title: "Meds", label: "Took meds", save: "doses", notify: "Dose logged" });
  const { ctx, runs, undone } = fakeCtx({ run: () => ({ ok: true, told: "Dose logged", entry: "dose-1" }) });
  const { el } = mount(meds, ctx);
  const b = el.querySelector("button.gz-verb.mod-cta") as HTMLButtonElement;
  assert.equal(text(b), "Took meds");
  assert.ok(b.querySelector("svg"));
  assert.equal(said(el), undefined);
  click(b);
  await settle();
  assert.deepEqual(runs, [{ row: {}, how: { inPlace: true } }]);
  assert.equal(said(el), "Dose logged");
  click(el.querySelector("button.gz-undo")!);
  await settle();
  assert.deepEqual(undone, ["dose-1"]);
  // Without a notify: where it saved. A button that only opens a note says nothing.
  const water = mount(panel({ view: "button", label: "Water", save: "water" }), fakeCtx().ctx);
  click(water.el.querySelector("button.gz-verb")!);
  await settle();
  assert.equal(said(water.el), "Added to water");
  const today = mount(panel({ view: "button", label: "Today", open: "Daily/{date}" }), fakeCtx({ run: () => ({ ok: true }) }).ctx);
  click(today.el.querySelector("button.gz-verb")!);
  await settle();
  assert.equal(said(today.el), undefined);
});

test("on the grid, a form keeps its fields and a button its button, exactly as before", async () => {
  const { ctx, runs } = fakeCtx({ slot: null, run: () => undefined });
  const f = mount(SPEND, ctx).el;
  assert.equal(f.querySelector(".gz-addline"), null);
  assert.equal(text(f.querySelector(".gz-title")), "Spent something");
  assert.equal(f.querySelector(".gz-addline-title"), null);
  assert.deepEqual([...f.querySelectorAll(".gz-field > span")].map(text), ["Spent", "category", "note"]);
  assert.equal(text(f.querySelector("button.mod-cta")), "Add");
  assert.equal(f.querySelector(".gz-addline-more, .gz-addline-under"), null);
  (f.querySelector('input[type="number"]') as HTMLInputElement).value = "3";
  choose(f.querySelector("select")!, "food");
  f.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(runs, [{ row: { amount: 3, category: "food", note: "" }, how: undefined }]);
  assert.equal(f.querySelector(".gz-notice"), null);

  const b = mount(panel({ view: "button", title: "Meds", label: "Took meds", save: "doses" }), ctx).el;
  assert.equal(b.querySelector(".gz-verb"), null);
  assert.equal(text(b.querySelector(".gz-title")), "Meds");
  assert.equal(text(b.querySelector("button.mod-cta.gz-button")), "Took meds");
  // In a grid tab with an add line elsewhere, / and ⌘Z don't reach it.
  assert.equal(press("/"), false);
});

test("in an app, the line saves through the app and Undo takes the row back out", async () => {
  const t = fakeEnv({
    "Apps/Budget.md": { fm: { app: "Budget", panels: [SPEND_RAW, { view: "number", title: "Spent", source: "spend", field: "amount", agg: "sum" }] } },
    "Apps/Budget data.md": { fm: { spend: [{ amount: 9, category: "fun", note: "lunch with Sam", at: "2026-11-17T12:00" }] } },
  });
  const env = {
    ...t.env,
    log: (entry: Parameters<NonNullable<typeof t.env.log>>[0]) => t.activity.add(entry),
    undo: async (id: string) => undoMessage(await undoEntry((await t.activity.get(id))!, t.undoIO)),
  };
  const leaf = document.body.createDiv({ cls: "workspace-leaf mod-active" });
  const app = new AppController(leaf, "Apps/Budget.md", env);
  app.load();
  await settle();
  // The form reads the list it saves to, so a category left out is guessed from it.
  typeLine(leaf, "12 lunch");
  assert.equal(text(leaf.querySelector(".gz-chip.is-on")), "fun");
  addLine(leaf, "12 lunch");
  await settle();
  const rows = () => (listsIn(t.f.files.get("Apps/Budget data.md")!.fm)!.spend as Row[]).map((r) => [r.amount, r.category, r.note]);
  assert.deepEqual(rows(), [[9, "fun", "lunch with Sam"], [12, "fun", "lunch"]]);
  assert.equal(text(leaf.querySelector(".gz-view-number .gz-big")), "21");
  assert.equal(said(leaf), "Added $12.00 to spend");
  assert.deepEqual(t.notices, []);
  click(leaf.querySelector("button.gz-undo")!);
  await settle();
  assert.equal(said(leaf), "Undone");
  assert.deepEqual(rows(), [[9, "fun", "lunch with Sam"]]);
  assert.equal(text(leaf.querySelector(".gz-view-number .gz-big")), "9");
  assert.match(underLine(leaf), /Undone/);
  app.dispose();
  leaf.remove();
});

const SPEND_RAW = {
  view: "form", title: "Spent something", save: "spend", label: "Add", alias: "spend",
  fields: { amount: { type: "number", label: "Spent", format: "$0,0.00" }, category: ["food", "home", "transport", "fun", "other"], note: "text" },
};
