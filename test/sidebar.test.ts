import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsksCard } from "../src/app-asks.ts";
import type { Ask } from "../src/asks.ts";
import { buildMap, type VaultMap } from "../src/map.ts";
import { sidebarModel } from "../src/sidebar.ts";
import { fakeBackground } from "./support/fakes.ts";

// The Gizmo sidebar: every app with where it stands and how many asks wait on it, counted from the
// same asks Next shows, and those asks answered the same way.

const KIND = "Kinds/Spend.md";
const SPEND = { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home"], memo: "text" } };
const OTHER = { app: "Other", panels: [{ view: "button", label: "Log", save: "done" }] };
const HOUR = 3_600_000;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

test("the sidebar's apps are the map's, each with as many asks as Next has for it, and its latest change", async () => {
  const t = fakeBackground({ [KIND]: { fm: SPEND }, "Apps/Other.md": { fm: OTHER }, "Apps/New.md": { fm: { app: "New", view: "number", source: "x" } } });
  await t.bg.start();
  await settle();
  assert.ok((await t.bg.capture("spend 1200 home rent @2026-11-19 12:00")).ok);
  t.advance(25 * HOUR);
  await t.bg.tick();
  await settle();
  const asks = t.bg.asks.list();
  assert.equal(asks.length, 1);
  const map = buildMap(t.bg.list(), t.grants, [], await t.activity.list());
  const m = sidebarModel(map, asks);
  assert.equal(m.asks.length, asks.length, "the count is Next's");
  assert.deepEqual(m.apps.map((a) => [a.name, a.asks, a.stateText]), map.apps.map((a) => [a.name, a.path === KIND ? 1 : 0, a.state === "allowed" ? "" : a.state === "not-opened" ? "needs OK" : a.state]));
  const spend = m.apps.find((a) => a.path === KIND)!;
  assert.match(spend.last?.what ?? "", /1200/);
});

test("a map's states read as words beside the name; allowed says nothing", () => {
  const app = (name: string, state: VaultMap["apps"][number]["state"]) => ({ path: `Apps/${name}.md`, name, state }) as VaultMap["apps"][number];
  const map = { apps: [app("A", "allowed"), app("B", "not-opened"), app("C", "paused"), app("D", "blocked"), app("E", "revoked")], embeds: [], lenses: [] } as VaultMap;
  assert.deepEqual(sidebarModel(map, []).apps.map((a) => a.stateText), ["", "needs OK", "paused", "blocked", "revoked"]);
});

test("in the sidebar the asks card lists every app's asks, each named, and an ask that opens its app opens it", async () => {
  const asks: Ask[] = [
    { id: "a", path: "Apps/Floss.md", app: "Floss", text: "Flossed? by 22:00", due: 1, answer: { line: "flossed", cursor: 7, ready: true } },
    { id: "b", path: "Kinds/Spend.md", app: "Spend", text: "3 rows from a file to check in Spend", due: 2, answer: { open: true } },
  ];
  const opened: string[] = [];
  const host = document.body.createDiv();
  const card = new AsksCard({
    asks: {
      list: () => asks, subscribe: () => () => {}, settle: async () => ({ ok: true }), skip: async () => {},
      run: async () => ({ ok: true }), fill: () => {}, open: (path) => { opened.push(path); },
    },
    host: () => host,
    said: () => {},
    notify: () => {},
  });
  card.draw();
  const rows = [...host.querySelectorAll("li")];
  assert.deepEqual(rows.map((li) => [text(li.querySelector(".gz-asks-app")), text(li.querySelector(".gz-asks-text"))]), [["Floss", "Flossed? by 22:00"], ["Spend", "3 rows from a file to check in Spend"]]);
  assert.deepEqual([...rows[1].querySelectorAll("button")].map(text), ["Skip", "Open Spend"]);
  rows[1].querySelector<HTMLElement>("button.mod-cta")!.click();
  await settle();
  assert.deepEqual(opened, ["Kinds/Spend.md"]);
  card.stop();
  host.remove();
});

test("an app's own tab tells its headline when it changes, for the sidebar to show in place of its last change; a block tells nothing", async () => {
  const { fakeEnv } = await import("./support/fakes.ts");
  const { AppController } = await import("../src/app.ts");
  const fm = { app: "W", panels: [{ view: "number", title: "Spent", source: "spend", field: "amount", agg: "sum" }, { view: "table", title: "Rows", source: "spend", columns: ["amount"] }] };
  const told: [string, string | undefined][] = [];
  const t = fakeEnv({ "Apps/W.md": { fm }, "Apps/W data.md": { fm: { spend: [{ amount: 5 }, { amount: 7 }] } }, "Daily.md": { fm: {} } });
  t.env.headline = (path, text) => { told.push([path, text]); };
  const root = document.body.createDiv();
  const c = new AppController(root, "Apps/W.md", t.env);
  c.load();
  await settle();
  assert.deepEqual(told, [["Apps/W.md", "Spent: 12"]]);
  c.dispose();
  const block = new AppController(document.body.createDiv(), "Apps/W.md", t.env, { kind: "app", grantKey: "Daily.md#gizmo", hostPath: "Daily.md", definition: () => fm });
  block.load();
  await settle();
  assert.equal(told.length, 1);
  block.dispose();

  const app = (name: string, state: VaultMap["apps"][number]["state"]) => ({ path: `Apps/${name}.md`, name, state, last: { at: 1, actor: "you", what: "Saved" } }) as VaultMap["apps"][number];
  const map = { apps: [app("W", "allowed"), app("P", "paused")], embeds: [], lenses: [] } as VaultMap;
  const m = sidebarModel(map, [], new Map([["Apps/W.md", "Spent: 12"], ["Apps/P.md", "Old: 1"]]));
  assert.deepEqual(m.apps.map((a) => a.headline), ["Spent: 12", undefined], "a paused app's figure isn't shown");
});
