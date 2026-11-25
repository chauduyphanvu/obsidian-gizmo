import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { undoEntry, undoMessage } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { ownAsks, type AppAsks } from "../src/app-asks.ts";
import type { Ask } from "../src/asks.ts";
import { pastEnv } from "../src/replay.ts";
import { aheadEnv } from "../src/ahead.ts";
import { fakeBackground } from "./support/fakes.ts";

// What Next asks of an app is asked in the app's own tab too, above its records, and answered the
// same way: Enter answers, x dismisses, s skips until tomorrow. Nowhere else: a block, the past, ahead, a try.

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const SPEND = {
  kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home"], memo: "text" }, match: { amount: "exact", category: "exact", at: "2d" },
  panels: [{ view: "table", title: "Spent", source: "spend", columns: ["amount", "memo"] }],
};
const HOUR = 3_600_000;

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
  (document.activeElement as HTMLElement | null)?.blur?.();
});
const key = (el: Element, k: string) => {
  const e = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

/** Spend with a row planned for Thursday noon, now Thursday 13:00: Next asks whether it happened. */
async function vault() {
  const t = fakeBackground({ [KIND]: { fm: SPEND } });
  await t.bg.start();
  await settle();
  assert.ok((await t.bg.capture("spend 1200 home rent @2026-11-19 12:00")).ok);
  t.advance(25 * HOUR);
  await t.bg.tick();
  await settle();
  const ran: string[] = [];
  const asks: AppAsks = {
    list: () => t.bg.asks.list(),
    subscribe: (cb) => t.bg.asks.subscribe(cb),
    settle: (ask, how) => t.bg.settleAsk(ask, how),
    skip: (id) => t.bg.skipAsk(id),
    run: async (line) => { ran.push(line); return { ok: true, told: `Ran ${line}` }; },
    fill: (line) => { ran.push(`fill ${line}`); },
  };
  t.env.asks = asks;
  t.env.log = (entry) => t.activity.add(entry);
  t.env.undo = async (id) => {
    const entry = (await t.activity.get(id))!;
    const r = await undoEntry(entry, t.undoIO);
    await t.activity.setUndone(id, r.undone);
    return undoMessage(r);
  };
  const open = (opts: { embed?: boolean; past?: boolean } = {}) => {
    const leaf = document.body.createDiv({ cls: "workspace-leaf mod-active" });
    const root = leaf.createDiv();
    const c = opts.embed
      ? new AppController(root, KIND, t.env, { kind: "app", grantKey: "Daily.md#gizmo", hostPath: "Daily.md", definition: () => SPEND })
      : new AppController(root, KIND, opts.past ? pastEnv(t.env, t.env.now().getTime() - HOUR) : t.env);
    started.push({ dispose: () => { c.dispose(); leaf.remove(); } });
    c.load();
    return root;
  };
  const rows = () => t.env.store!(KIND_DATA, KIND).rows("spend");
  return { ...t, open, rows, ran };
}

const card = (root: Element) => root.querySelector(".gz-asks");
const items = (root: Element) => [...(card(root)?.querySelectorAll("li") ?? [])] as HTMLElement[];

test("an app's own tab asks what Next asks of it, after the line to add things and before its records", async () => {
  const t = await vault();
  const root = t.open();
  await settle();
  assert.deepEqual(t.bg.asks.list().map((a) => a.text), ["1200 home rent, planned Thu Nov 19, 12:00: did it happen?"]);
  assert.equal(text(card(root)?.querySelector(".gz-title")), "Needs you · 1");
  assert.deepEqual(items(root).map((li) => text(li.querySelector(".gz-asks-text"))), ["1200 home rent, planned Thu Nov 19, 12:00: did it happen?"]);
  assert.deepEqual([...items(root)[0].querySelectorAll("button")].map(text), ["Skip", "Dismiss", "It happened"]);
  const body = root.querySelector(".gz-body")!;
  assert.ok(card(root)!.parentElement!.classList.contains("gz-attention"));
  assert.deepEqual([...body.children].map((c) => c.className), ["gz-compose", "gz-attention", "gz-flow"]);
});

test("Enter answers as Next does, in one entry said under the card with Undo; the card goes when nothing is asked", async () => {
  const t = await vault();
  const root = t.open();
  await settle();
  items(root)[0].focus();
  assert.equal(key(items(root)[0], "Enter"), true);
  await settle();
  const [plan, ...rest] = await t.rows();
  assert.equal(rest.length, 0);
  assert.equal(plan.line, undefined, "the planned row happened: it is logged");
  assert.deepEqual(t.bg.asks.list(), []);
  assert.equal(card(root), null);
  const notice = root.querySelector(".gz-notice-text");
  assert.match(text(notice), /\S/);
  assert.ok(root.querySelector(".gz-addline-under button.gz-undo"));
});

test("x dismisses and s skips until tomorrow, each said in place", async () => {
  const t = await vault();
  const root = t.open();
  await settle();
  assert.equal(key(items(root)[0], "s"), true);
  await settle();
  assert.equal(card(root), null, "skipped, it waits until tomorrow");
  assert.equal(text(root.querySelector(".gz-notice-text")), "Skipped until tomorrow");
  t.advance(24 * HOUR);
  await t.bg.tick();
  await settle();
  assert.equal(items(root).length, 1, "asked again the next day");
  assert.equal(key(items(root)[0], "x"), true);
  await settle();
  assert.equal(card(root), null);
  assert.equal((await t.rows())[0].line, "dismissed");
});

test("a block of the app asks nothing, nor the app shown as it was; ahead, nothing is asked either", async () => {
  const t = await vault();
  const block = t.open({ embed: true });
  const past = t.open({ past: true });
  await settle();
  assert.equal(card(block), null);
  assert.ok(past.querySelector(".gz-body"), "the past draws its panels");
  assert.equal(card(past), null);
  assert.equal(aheadEnv(t.env, t.data, t.env.now().getTime() + HOUR, { show: () => {}, back: () => {} }).asks, undefined);
});

test("only this app's asks, less those whose answer is only to open it", () => {
  const ask = (path: string, answer: Ask["answer"]): Ask => ({ id: `${path}${JSON.stringify(answer)}`, path, app: path, text: "?", due: 0, answer });
  const line = { line: "meds", cursor: 4, ready: true };
  const all = [ask("A.md", line), ask("B.md", line), ask("A.md", { open: true })];
  assert.deepEqual(ownAsks(all, "A.md").map((a) => a.answer), [line]);
});
