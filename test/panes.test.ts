import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { runtimeAppEnv } from "../src/app-env.ts";
import type { AskHost } from "../src/ask-pane.ts";
import type { Ask } from "../src/asks.ts";
import { drawBacktest } from "../src/backtest-view.ts";
import { DoPane, type DoHost } from "../src/do-pane.ts";
import { LineBox, type LineHost } from "../src/line-box.ts";
import { NextPane } from "../src/next-pane.ts";
import { permissionsOf } from "../src/permissions.ts";
import type { GizmoRuntime } from "../src/runtime.ts";
import { readSpec } from "../src/spec.ts";
import { runtimeOn } from "./support/runtime.ts";

// Do…, its `?` pane, Next and a backtest as panes any host draws into its own window: Obsidian's
// modals and the standalone app's windows wrap these same panes.

const INBOX = { app: "Inbox", panels: [{ view: "form", title: "Add", fields: { task: "text" }, save: "todo", shortcut: "add", alias: "task" }] };
const SPEND_FM = parse(readFileSync(new URL("../gallery/Kinds/Spend.md", import.meta.url), "utf8").match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
const BUDGET = { app: "Budget", panels: [{ view: "button", label: "Spent", save: "spend" }] };

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const keydown = (target: Element, key: string, o: { meta?: boolean } = {}) => {
  const e = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
  Object.defineProperty(e, "key", { value: key });
  if (o.meta) Object.defineProperty(e, "metaKey", { value: true });
  target.dispatchEvent(e);
  return e;
};
/** A key as a window's own handler gets it, from `target` (linkedom clears an event's target once it's dispatched). */
const keyFrom = (target: Element, key: string) => {
  const e = new window.Event("keydown", { cancelable: true }) as Event & { key: string };
  Object.defineProperty(e, "key", { value: key });
  Object.defineProperty(e, "target", { value: target });
  return e as unknown as KeyboardEvent;
};

async function started() {
  const t = await runtimeOn({
    "Apps/Inbox.md": { fm: INBOX, body: "" },
    "Apps/Budget.md": { fm: BUDGET, body: "" },
    "Kinds/Spend.md": { fm: SPEND_FM, body: "" },
  });
  for (const path of ["Apps/Inbox.md", "Apps/Budget.md"]) {
    await t.runtime.grant(path, permissionsOf(readSpec(t.f.files.get(path)!.fm!, { path, notes: t.runtime.host.notes })!.spec!, path));
  }
  await t.runtime.start();
  return t;
}

/** A host that keeps what it was asked to do. */
function hostOn(rt: GizmoRuntime) {
  const said = { told: [] as [string, string | undefined][], told2: [] as string[], aheads: [] as [string, string][], opened: [] as string[], closed: 0, chosen: [] as string[][] };
  const line: LineHost = { rt, openApp: () => undefined, ahead: (app, l) => { said.aheads.push([app, l]); }, told: (t, e) => { said.told.push([t, e]); } };
  const ask: AskHost = {
    rt,
    env: () => runtimeAppEnv(rt, { readBody: async () => "", notify: () => {}, openNote: () => {}, showSource: () => {}, showSourceAt: () => {}, sourceLines: async () => [], copy: () => {}, fill: () => {} }),
    chooseApp: (paths, choose) => { said.chosen.push(paths); choose("Apps/Budget.md"); },
    notify: (m) => { said.told2.push(m); },
    copy: (_t, done) => done(),
    open: (path) => { said.opened.push(path); },
    modKey: "⌘",
  };
  const doHost: DoHost = {
    ...line, ask,
    apps: () => [{ name: "Inbox", path: "Apps/Inbox.md" }, { name: "Budget", path: "Apps/Budget.md" }],
    actions: () => [{ name: "Next", run: () => { said.opened.push("window:Next"); } }],
    open: (path) => { said.opened.push(path); },
    close: () => { said.closed++; },
  };
  return { said, line, doHost };
}

test("a line shows where it goes and what it would change, Tab completes a name, and Enter runs it and tells with Undo", async () => {
  const t = await started();
  const h = hostOn(t.runtime);
  const el = document.createElement("div");
  let entered = 0;
  const box = new LineBox(h.line, el, "", () => { entered++; });
  box.input.value = "ad";
  keydown(box.input, "Tab");
  assert.match(box.input.value, /^add /, "Tab took the shortcut's name");
  box.input.value = "add buy milk";
  await box.show();
  assert.ok(!el.querySelector(".gz-capture-hint")!.classList.contains("gz-error-text"));
  assert.match(text(el.querySelector(".gz-capture-hint")), /Inbox/);
  assert.ok(el.querySelectorAll(".gz-effects li").length > 0, "what it would change, by a dry run");
  keydown(box.input, "Enter");
  assert.equal(entered, 1);
  assert.equal(await box.submit(), true);
  const [[said, entryId]] = h.said.told;
  assert.equal(said, "Inbox: Add done.");
  assert.ok(entryId, "told with the entry, for Undo");
  assert.equal(await t.runtime.undoById(entryId), "Undone");
  box.stop();
});

test("Do…: a line no shortcut reads opens the app or window it names; a what-if is shown ahead; ? draws the answer, and Keep adds it to the app picked", async () => {
  const t = await started();
  const h = hostOn(t.runtime);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const pane = new DoPane(el, h.doHost);
  pane.box.input.value = "budget";
  await pane.box.show();
  assert.ok([...el.querySelectorAll(".gz-capture-open")].some((b) => text(b) === "Open Budget"));
  keydown(pane.box.input, "Enter");
  await settle();
  assert.deepEqual([h.said.opened, h.said.closed], [["Apps/Budget.md"], 1], "Enter opened it and closed Do…");

  pane.box.input.value = "next";
  await pane.box.show();
  keydown(pane.box.input, "Enter");
  await settle();
  assert.deepEqual(h.said.opened.at(-1), "window:Next", "a window of the host's, by name");

  pane.box.input.value = "what if add pick up glasses";
  keydown(pane.box.input, "Enter");
  await settle();
  assert.deepEqual(h.said.aheads, [["Apps/Inbox.md", "add pick up glasses"]]);

  pane.box.input.value = "? spend this month";
  await pane.box.show();
  await settle();
  assert.match(text(el.querySelector(".gz-capture-hint")), /^Asks Spend/);
  assert.ok(el.querySelector(".gz-ask-answer .gz-panel"), "the answer drawn as its panel");
  assert.match(text(el.querySelector(".gz-ask-yaml")), /view:/);
  keydown(pane.box.input, "Enter", { meta: true });
  await settle();
  assert.deepEqual(h.said.chosen, [["Apps/Budget.md", "Apps/Inbox.md"]], "Keep offered the vault's apps");
  assert.ok((t.f.files.get("Apps/Budget.md")!.fm as { panels: unknown[] }).panels.length === 2, "the answer is Budget's last panel");
  assert.match(h.said.told2.at(-1)!, /^Added .* to Budget$/);
  assert.equal(h.said.opened.at(-1), "Apps/Budget.md");
  pane.stop();
});

test("Next: one ask at a time; Enter answers, s skips, x dismisses, an ask to open an app opens it, and then nothing needs you", async () => {
  const t = await started();
  const list: Ask[] = [
    { id: "a", path: "Apps/Inbox.md", app: "Inbox", text: "Did the bins go out?", due: 1, answer: { change: { list: "todo", row: { id: "r1" }, field: "line", value: undefined, what: "Marked as happened" } }, dismiss: { list: "todo", row: { id: "r1" }, field: "line", value: "skipped", what: "Dismissed" } },
    { id: "b", path: "Apps/Inbox.md", app: "Inbox", text: "Water the plants?", due: 2, answer: { change: { list: "todo", row: { id: "r2" }, field: "line", value: undefined, what: "Marked as happened" } }, dismiss: { list: "todo", row: { id: "r2" }, field: "line", value: "skipped", what: "Dismissed" } },
    { id: "c", path: "Apps/Inbox.md", app: "Inbox", text: "Call the dentist?", due: 3, answer: { change: { list: "todo", row: { id: "r3" }, field: "line", value: undefined, what: "Marked as happened" } } },
    { id: "d", path: "Apps/Budget.md", app: "Budget", text: "Charges to check", due: 4, answer: { open: true } },
  ];
  const gone = new Set<string>();
  const acted: string[] = [];
  const subscribers = new Set<() => void>();
  const bg = t.runtime.background;
  const rt = {
    background: {
      asks: { list: () => list.filter((a) => !gone.has(a.id)), subscribe: (cb: () => void) => { subscribers.add(cb); return () => subscribers.delete(cb); } },
      skipAsk: async (id: string) => { acted.push(`skip ${id}`); gone.add(id); },
      settleAsk: async (ask: Ask, how: string) => { acted.push(`${how} ${ask.id}`); gone.add(ask.id); return { ok: true, what: how === "dismiss" ? "dismissed" : "marked", entryId: `e-${ask.id}` }; },
      captureIndex: () => bg.captureIndex(),
      previewLine: (line: string) => bg.previewLine(line),
    },
  } as unknown as GizmoRuntime;
  const h = hostOn(rt);
  const body = document.createElement("div");
  document.body.appendChild(body);
  let closed = 0;
  const pane = new NextPane(body, { ...h.line, notify: () => {}, open: (path) => { h.said.opened.push(path); }, close: () => { closed++; } });
  const shown = () => text(body.querySelector(".gz-next-text"));
  assert.equal(shown(), "Did the bins go out?");
  assert.equal(text(body.querySelector(".gz-next-count")), "Inbox · 1 of 4");
  assert.deepEqual([...body.querySelectorAll(".gz-next-buttons button")].map(text), ["Skip", "Dismiss", "It happened"]);

  pane.key(keyFrom(body, "Enter"));
  await settle();
  assert.deepEqual(h.said.told, [["Inbox: marked.", "e-a"]], "told with Undo");
  assert.equal(shown(), "Water the plants?");
  pane.key(keyFrom(body, "x"));
  await settle();
  assert.equal(shown(), "Call the dentist?");
  pane.key(keyFrom(body, "x"));
  await settle();
  assert.equal(shown(), "Call the dentist?", "x does nothing for an ask that can't be dismissed");
  const typed = document.createElement("input");
  body.appendChild(typed);
  pane.key(keyFrom(typed, "s"));
  await settle();
  assert.equal(shown(), "Call the dentist?", "an s typed in a field is the field's");
  pane.key(keyFrom(body, "s"));
  await settle();
  assert.equal(shown(), "Charges to check");
  pane.key(keyFrom(body, "Enter"));
  await settle();
  assert.deepEqual([h.said.opened, closed], [["Apps/Budget.md"], 1], "an ask to open its app opens it and closes Next");
  assert.deepEqual(acted, ["answer a", "dismiss b", "skip c"]);
  gone.add("d");
  for (const cb of subscribers) cb();
  assert.equal(text(body.querySelector(".gz-next-empty")), "Nothing needs you.");
  pane.stop();
  assert.equal(subscribers.size, 0, "it stops following the asks");
});

test("a backtest draws what fired when, with its timeline, and a refusal as a sentence", async () => {
  const t = await runtimeOn({
    "Apps/Quiet.md": { fm: { app: "Quiet", panels: [{ view: "number", source: "items", agg: "count" }] }, body: "" },
    "Apps/Loud.md": { fm: { app: "Loud", panels: [{ view: "number", title: "Many", source: "items", agg: "count", alert: "> 1" }] }, body: "" },
    "Apps/Loud data.md": { fm: { items: [{ n: 1, at: "2026-11-17T09:00" }, { n: 2, at: "2026-11-18T09:00" }] }, body: "" },
  });
  const quiet = document.createElement("div");
  await drawBacktest(quiet, t.runtime, "Apps/Quiet.md", undefined, { cancelled: () => false, close: () => {} });
  assert.match(text(quiet), /no alerts and no expect rules/);
  const loud = document.createElement("div");
  await drawBacktest(loud, t.runtime, "Apps/Loud.md", undefined, { cancelled: () => false, close: () => {} });
  assert.match(text(loud), /It would have fired (once|\d+ times)\./);
  assert.ok(loud.querySelector("svg.gz-backtest-line line.gz-backtest-axis"), "the timeline");
  assert.equal(loud.querySelector("progress"), null, "the progress gone once it's done");
});
