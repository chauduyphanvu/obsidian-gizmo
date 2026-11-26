import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runtimeAppEnv } from "../src/app-env.ts";
import { AppTab, type TabHost } from "../src/app-tab.ts";
import { permissionsOf } from "../src/permissions.ts";
import { STEP_MS } from "../src/rail.ts";
import { readSpec } from "../src/spec.ts";
import { runtimeOn } from "./support/runtime.ts";

// An app in a tab of its own, as Obsidian's AppView and the standalone app both open it: the time
// rail, ahead, History and Explain in the side sheet, the tab's keys and its menu, on a runtime that
// runs outside Obsidian.

const APP = "Apps/Spend.md";
const PANELS = [
  { view: "form", title: "Add", fields: { amount: "number" }, save: "spend", shortcut: "add" },
  { view: "number", title: "Spent", source: "spend", field: "amount", agg: "sum" },
  { view: "table", title: "Recent", source: "spend", columns: ["amount"] },
];
const wanted = (fm: Record<string, unknown>) => permissionsOf(readSpec(fm, { path: APP })!.spec!, APP);

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const key = (k: string, target: EventTarget = document.body) => {
  const e = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
  Object.defineProperty(e, "key", { value: k });
  Object.defineProperty(e, "target", { value: target });
  return e as unknown as KeyboardEvent;
};

const opened: AppTab[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.dispose();
});

/** The app in a tab, allowed, on a runtime of its own; what the host was asked to show is kept. */
async function tabOn(fm: Record<string, unknown>, host: Partial<TabHost> = {}) {
  const t = await runtimeOn({ [APP]: { fm, body: "" } }, { settings: { grants: { [APP]: wanted(fm) } } });
  await t.runtime.start();
  // The fake vault's clock starts in 1970; the rail shows the last 30 days.
  t.f.advance(Date.now() - 3_600_000 - t.f.host.now());
  const root = document.createElement("div");
  document.body.appendChild(root);
  const told: string[] = [];
  const windows: string[] = [];
  const tab = new AppTab(root, t.runtime, {
    env: () => runtimeAppEnv(t.runtime, {
      readBody: async () => "", notify: (m) => { told.push(m); }, openNote: () => {}, showSource: () => {}, showSourceAt: () => {},
      sourceLines: async () => [], copy: () => {}, fill: () => {}, explain: () => {},
    }),
    icon: () => {},
    notify: (m) => { told.push(m); },
    historyWindow: (path) => { windows.push(path); },
    ...host,
  });
  opened.push(tab);
  tab.open(APP, fm);
  await settle();
  const add = async (amount: string) => {
    t.f.advance(60_000);
    const r = await t.runtime.background.runFrom(APP, "add", { params: { amount }, trusted: true });
    assert.ok(r.ok, JSON.stringify(r));
    await settle();
  };
  const total = () => text(root.querySelector(".gz-panel .gz-number, .gz-panel .gz-value"));
  const rail = () => root.querySelector(".gz-rail") as HTMLElement | null;
  return { t, root, tab, told, windows, add, total, rail };
}

test("an app opens in its tab, History opens in the side sheet with what it did, and Escape closes the sheet before anything else", async () => {
  const s = await tabOn({ app: "Spend", panels: PANELS });
  assert.ok(s.tab.controller, "the app is shown");
  assert.ok(s.root.querySelector(".gizmo .gz-panel"), "its panels drawn in the tab's element");
  assert.ok(s.rail()?.isConnected, "the rail in the app's header");
  await s.add("5");

  s.tab.showHistory();
  await settle();
  assert.equal(s.tab.controller!.page, "history");
  assert.equal(text(s.root.querySelector(".gz-sheet-page > h2.gz-sheet-title")), "What Spend did");
  assert.equal(s.root.querySelectorAll(".gz-sheet-page .gz-activity-entry").length, 1, "the row it added");
  assert.deepEqual(s.windows, [], "no window while the sheet can show it");

  assert.equal(s.tab.key(key("Escape")), true);
  assert.equal(s.tab.controller!.page, undefined, "Escape closed the sheet");
  assert.equal(s.tab.key(key("Escape")), false, "showing now, with the rail folded, Escape is someone else's");
});

test("History goes to a window where the side sheet can't show it: on the grid", async () => {
  const s = await tabOn({ app: "Spend", layout: "grid", panels: PANELS });
  s.tab.showHistory();
  assert.deepEqual(s.windows, [APP]);
});

test("the app as it was: read only with the rail open; [ steps once the rail shows, never while typing; Escape goes back to now", async () => {
  const s = await tabOn({ app: "Spend", panels: PANELS });
  const before = s.t.f.host.now();
  await s.add("5");
  await s.add("7");

  s.tab.showAt(before);
  await settle();
  assert.match(text(s.root.querySelector(".gz-past .gz-past-text")), /read only/);
  assert.ok(!s.rail()!.classList.contains("is-folded"), "the past opens the rail");
  assert.equal(s.root.querySelectorAll(".gizmo").length, 1, "one app drawn, not one per start");

  assert.equal(s.tab.key(key("Escape")), true);
  await settle();
  assert.equal(s.root.querySelector(".gz-past"), null, "back to now");
  assert.ok(s.rail()!.classList.contains("is-folded"), "coming back folds the rail");

  const field = document.createElement("input");
  assert.equal(s.tab.key(key("[", field)), false, "typing in a field, [ is the field's");
  assert.equal(s.tab.key(Object.assign(key("["), { metaKey: true })), false, "⌘[ is the browser's");
  assert.equal(s.tab.key(key("[")), true);
  await new Promise((r) => setTimeout(r, STEP_MS + 50));
  await settle();
  assert.ok(s.root.querySelector(".gz-past"), "a step back shows the app as it was before its latest change");
});

test("What if… shows the app ahead on a layer of its own; a start overtaken by another is dropped, and back to now stops it", async () => {
  const s = await tabOn({ app: "Spend", panels: PANELS });
  await s.add("5");
  s.tab.showAhead();
  s.tab.showAhead();
  await settle();
  assert.match(text(s.rail()?.querySelector(".gz-rail-label")), /^What if, as of /);
  assert.equal(s.root.querySelectorAll(".gizmo").length, 1, "the first start, overtaken, drew nothing");
  assert.equal(s.root.querySelector(".gz-empty")?.textContent === "Reading the what-if…", false);

  s.tab.showAt(undefined);
  await settle();
  assert.doesNotMatch(text(s.rail()?.querySelector(".gz-rail-label")), /What if/);
});

test("the tab's menu offers As of… and backtests only where the host can show them, and no backtest of the past", async () => {
  const s = await tabOn({ app: "Spend", panels: PANELS });
  assert.deepEqual(s.tab.actions().map((a) => a.id), ["activity", "what-if", "explain", "inspect", "reload"]);
  assert.equal(s.tab.actions().find((a) => a.id === "inspect")!.checked, false);

  const asked: string[] = [];
  const h = await tabOn({ app: "Spend", panels: PANELS }, { asOf: () => { asked.push("as-of"); }, backtest: (path) => { asked.push(`backtest ${path}`); } });
  assert.deepEqual(h.tab.actions().map((a) => a.id), ["activity", "as-of", "what-if", "explain", "inspect", "reload", "backtest"]);
  for (const a of h.tab.actions()) if (a.id === "as-of" || a.id === "backtest") a.run();
  assert.deepEqual(asked, ["as-of", `backtest ${APP}`]);
  h.tab.actions().find((a) => a.id === "explain")!.run();
  assert.deepEqual(h.told, [], "Spent is a figure worked out from rows");
  assert.equal(h.tab.controller!.page, "explain", "explained in the side sheet");
  h.tab.showAt(Date.now() - 1000);
  assert.ok(!h.tab.actions().some((a) => a.id.startsWith("backtest")), "a backtest is of the app as it is defined now");
});

test("drawn again at another time, the tab stays scrolled where it was", async () => {
  const s = await tabOn({ app: "Spend", panels: PANELS });
  Object.defineProperty(s.root.firstElementChild, "offsetHeight", { value: 900, configurable: true });
  s.root.scrollTop = 240;
  s.tab.showAt(Date.now() - 1000);
  assert.equal((s.root.firstElementChild as HTMLElement).style.minHeight, "900px", "keeps the old height while its data arrives");
  assert.equal(s.root.scrollTop, 240);
});
