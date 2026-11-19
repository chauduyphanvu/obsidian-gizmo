import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { mountView } from "../src/views/common.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { list } from "../src/views/rows.ts";
import { fakeEnv } from "./support/fakes.ts";

// `detail:` on a panel whose rows can be picked: picking a row draws a sentence about it under the
// rows, with an Open link for a note; picking it again takes it away.

const APP = "Apps/Waiting.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const key = (el: Element, k: string) => {
  const e = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
  Object.defineProperty(e, "key", { value: k });
  el.dispatchEvent(e);
};

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

const NOTES = {
  "Decisions/Phone plan.md": { fm: { expect: "Coverage is as good", confidence: 80, made: "2026-10-20", review: "2026-11-15", outcome: "open" } },
  "Decisions/Running.md": { fm: { expect: "Still running in February", confidence: 60, made: "2026-11-09", review: "2027-02-09", outcome: "open" } },
  "Decisions/Gym.md": { fm: { expect: "Work out as often", confidence: 90, made: "2026-03-01", review: "2026-06-01", outcome: "wrong" } },
};

function open(panels: Record<string, unknown>[]) {
  const t = fakeEnv({ [APP]: { fm: { app: "x", panels } }, ...structuredClone(NOTES) });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, APP, t.env);
  started.push(app);
  app.load();
  return { ...t, root, panels: () => [...root.querySelectorAll(".na-panel")] };
}

const TIMELINE = {
  view: "timeline", title: "Still waiting", source: "notes", from: "Decisions", where: { outcome: "open" }, start: "made", end: "review",
  detail: "I expected: {expect} ({confidence}% sure). I'll know by {review}.", format: { review: "date" },
};

test("picking a bar draws the detail under the rows, with an Open link for its note; picking it again takes it away", async () => {
  const app = open([TIMELINE]);
  await settle();
  const panel = app.panels()[0];
  const bars = [...panel.querySelectorAll(".na-tl-bar")];
  assert.equal(bars.length, 2);
  assert.equal(panel.querySelector(".na-detail"), null);
  event(bars[0], "click");
  const detail = panel.querySelector(".na-detail")!;
  assert.equal(panel.lastElementChild, detail, "the detail sits under the rows");
  assert.equal(text(detail.querySelector(".na-detail-text")), `I expected: Coverage is as good (80% sure). I'll know by ${new Date(2026, 10, 15).toLocaleDateString()}.`);
  assert.ok(bars[0].classList.contains("na-selected"));
  event(detail.querySelector("a")!, "click");
  assert.deepEqual(app.opened, ["Decisions/Phone plan.md"]);
  event(bars[1], "click");
  assert.match(text(panel.querySelector(".na-detail")), /Still running in February/);
  assert.equal(panel.querySelectorAll(".na-detail").length, 1);
  event(bars[1], "click");
  assert.equal(panel.querySelector(".na-detail"), null);
  assert.equal(panel.querySelectorAll(".na-selected").length, 0);
  // The keyboard picks as the mouse does.
  key(bars[1], "Enter");
  assert.match(text(panel.querySelector(".na-detail")), /Still running/);
});

test("the detail follows its row when the data changes, and goes when the row does", async () => {
  const app = open([TIMELINE]);
  await settle();
  event(app.panels()[0].querySelector(".na-tl-bar")!, "click");
  app.f.files.get("Decisions/Phone plan.md")!.fm!.expect = "Coverage is fine at home";
  app.changed("Decisions/Phone plan.md");
  await settle();
  assert.match(text(app.panels()[0].querySelector(".na-detail")), /Coverage is fine at home/);
  app.f.files.get("Decisions/Phone plan.md")!.fm!.outcome = "right";
  app.changed("Decisions/Phone plan.md");
  await settle();
  assert.equal(app.panels()[0].querySelector(".na-detail"), null);
  assert.equal(app.panels()[0].querySelectorAll(".na-tl-bar").length, 1);
});

test("with select too, the detail shows the selection other panels read", async () => {
  const app = open([
    { ...TIMELINE, select: "pick" },
    { view: "text", title: "Picked", text: "$pick.name, made $pick.made" },
  ]);
  await settle();
  const [timeline, picked] = app.panels();
  event(timeline.querySelector(".na-tl-bar")!, "click");
  await settle();
  assert.match(text(timeline.querySelector(".na-detail")), /Coverage is as good/);
  assert.equal(text(picked.querySelector(".na-text")), "Phone plan, made 2026-10-20");
});

test("every view that picks rows takes detail: a list, a table, a bar, a pie, a calendar, a board, a scatter", async () => {
  const app = open([
    { view: "list", source: "notes", from: "Decisions", item: "{name}", detail: "{name}: {outcome}" },
    { view: "table", source: "notes", from: "Decisions", columns: ["name", "outcome"], edit: ["outcome"], detail: "{name} is {outcome}" },
    { view: "bar", source: "notes", from: "Decisions", group: "outcome", detail: "{count} {outcome}" },
    { view: "pie", source: "notes", from: "Decisions", group: "outcome", detail: "{count} {outcome}" },
    { view: "calendar", source: "notes", from: "Decisions", group: "made", detail: "{count} on {made}" },
    { view: "board", source: "notes", from: "Decisions", group: "outcome", detail: "{name} in {outcome}" },
    { view: "scatter", source: "notes", from: "Decisions", x: "made", y: "confidence", item: "{name}", detail: "{name} at {confidence}%" },
  ]);
  await settle();
  const [listP, tableP, barP, pieP, calP, boardP, scatterP] = app.panels();
  const pickIn = (panel: Element, selector: string) => {
    event(panel.querySelector(selector)!, "click");
    return text(panel.querySelector(".na-detail-text"));
  };
  assert.match(pickIn(listP, "li"), /^(Phone plan|Running|Gym): (open|wrong)$/);
  assert.ok(listP.querySelector(".na-detail a"), "a note's row gets an Open link");
  // A field being edited in a row is that field's, not a pick.
  event(tableP.querySelector("input")!, "click");
  assert.equal(tableP.querySelector(".na-detail"), null);
  assert.match(pickIn(tableP, "tbody tr"), /^(Phone plan|Running|Gym) is (open|wrong)$/);
  assert.match(pickIn(barP, ".na-bar"), /^\d (open|wrong)$/);
  assert.equal(barP.querySelector(".na-detail a"), null, "a group isn't a note");
  assert.match(pickIn(pieP, ".na-slice"), /^\d (open|wrong)$/);
  assert.match(pickIn(calP, ".na-cal-day[data-date='2026-11-09']"), /^1 on 2026-11-09$/);
  assert.match(pickIn(boardP, ".na-board-card"), / in (open|wrong)$/);
  assert.match(pickIn(scatterP, ".na-scatter-dot"), / at \d+%$/);
});

test("on a board, the detail is the card picked, not the first card of its column", async () => {
  const app = open([{ view: "board", source: "notes", from: "Decisions", group: "outcome", detail: "{name}: {expect}" }]);
  await settle();
  const board = app.panels()[0];
  const open_ = [...board.querySelectorAll(".na-board-col")].find((c) => c.getAttribute("aria-label") === "open")!;
  const cards = [...open_.querySelectorAll(".na-board-card")];
  assert.deepEqual(cards.map((c) => text(c.querySelector(".na-board-text"))), ["Phone plan", "Running"]);
  event(cards[1], "click");
  assert.equal(text(board.querySelector(".na-detail-text")), "Running: Still running in February");
  assert.deepEqual([...board.querySelectorAll(".na-board-card.na-selected")].map((c) => text(c.querySelector(".na-board-text"))), ["Running"]);
  event(board.querySelector(".na-detail a")!, "click");
  assert.deepEqual(app.opened, ["Decisions/Running.md"]);
  event(cards[0], "click");
  assert.equal(text(board.querySelector(".na-detail-text")), "Phone plan: Coverage is as good");
});

test("a view mounted without a detail is drawn as it was; one picks rows only with select or detail", () => {
  const ctx = { now: new Date(2026, 10, 18), width: () => 600, selected: () => undefined, select: () => {}, openNote: () => {} } as unknown as PanelCtx;
  const draw = (keys: Record<string, unknown>) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const p = checkPanel({ view: "list", source: "s", ...keys }, true).panel as Panel;
    mountView(list, el, p, ctx, "k").update([{ name: "a" }, { name: "b" }]);
    return el;
  };
  assert.equal(draw({}).querySelectorAll(".na-selectable").length, 0);
  const el = draw({ detail: "Picked {name}" });
  assert.equal(el.querySelectorAll(".na-selectable").length, 2);
  event(el.querySelectorAll("li")[1], "click");
  assert.equal(text(el.querySelector(".na-detail")), "Picked b");
});
