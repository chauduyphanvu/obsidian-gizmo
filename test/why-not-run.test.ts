import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { undoEntry, undoMessage, type Entry } from "../src/activity.ts";
import { editWords } from "../src/app-cards.ts";
import { AppController } from "../src/app.ts";
import { dryLines } from "../src/background-shortcuts.ts";
import { WebError } from "../src/datalayer.ts";
import type { Op } from "../src/ledger.ts";
import { buildMap } from "../src/map.ts";
import { pastEnv } from "../src/replay.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";
// Loaded for its "obsidian" stand-in, which the map's view and Obsidian's host take their classes from.
import "./support/plugin.ts";

const { MapView } = await import("../src/map-view.ts");
const { obsidianHost } = await import("../src/host.ts");

// Say why it didn't run: each dead end gives its reason where the person is looking, and a next step
// where there is one.

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: { dispose(): void }[] = [];
afterEach(() => { for (const s of started.splice(0)) s.dispose(); });

// ---- A refused run says why -----------------------------------------------------------------------

const TASKS = { app: "Tasks", panels: [{ view: "form", title: "New task", fields: { task: "text" }, save: "Tasks/", name: "{task}", shortcut: "new-task" }] };
const TAKEN = { "Apps/Tasks.md": { fm: TASKS }, "Tasks/Renew passport.md": { fm: { due: "2026-12-01" } } };

test("a shortcut refused because its note already exists says why in one notice, and in its result", async () => {
  const t = fakeBackground(TAKEN);
  await t.bg.start();
  const why = "“New task” didn't run: “Renew passport” already exists";
  const ran = await t.bg.runFrom("Apps/Tasks.md", "new-task", { params: { task: "Renew passport" }, trusted: true });
  assert.deepEqual([ran.ok, ran.error], [false, why]);
  assert.deepEqual(t.notices, [why]);
  assert.deepEqual(t.f.files.get("Tasks/Renew passport.md")!.fm, { due: "2026-12-01" }, "never written over");
  // A dry run tells the same, and tells nothing for real.
  assert.ok(dryLines(await t.bg.dryRun("Apps/Tasks.md", "new-task", { task: "Renew passport" })).includes(`Tell you: ${why}`));
  assert.deepEqual(t.notices, [why]);
});

test("a run another app's then makes names that app when it's refused; one whose write fails says what failed", async () => {
  const CALLS = { app: "Calls", panels: [{ view: "button", label: "Called", save: "calls", shortcut: "called", then: { app: "[[Tasks]]", do: "new-task", fill: { task: "Renew passport" } } }] };
  const t = fakeBackground({ ...TAKEN, "Apps/Calls.md": { fm: CALLS } });
  await t.bg.start();
  await t.bg.runCommand("Apps/Calls.md:called");
  assert.deepEqual(t.notices, ["Calls: Called done", "Tasks: “New task” didn't run: “Renew passport” already exists"]);

  const LOG = { app: "Weight", panels: [{ view: "form", title: "Log", fields: { weight: "number" }, save: "weight", shortcut: "log" }] };
  const w = fakeBackground({ "Apps/Weight.md": { fm: LOG } });
  await w.bg.start();
  const store = w.env.store!;
  w.env.store = (dataPath, appPath) => ({ ...store(dataPath, appPath), add: async () => { throw new Error("disk full"); } });
  const ran = await w.bg.runFrom("Apps/Weight.md", "log", { params: { weight: "81" }, trusted: true });
  assert.deepEqual([ran.ok, ran.error], [false, "“Log” didn't run: disk full"]);
  assert.deepEqual(w.notices, ["“Log” didn't run: disk full"]);
});

test("in the app, a note that already exists is said where the form is, and what was typed stays", async () => {
  const t = fakeEnv(TAKEN);
  const root = document.body.createDiv();
  const c = new AppController(root, "Apps/Tasks.md", t.env);
  started.push({ dispose: () => { c.dispose(); root.remove(); } });
  c.load();
  await settle();
  const line = root.querySelector("input.gz-addline-input") as HTMLInputElement;
  line.value = "Renew passport";
  line.dispatchEvent(new window.Event("input"));
  root.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(text(root.querySelector(".gz-addline-error")), "Not saved: “Renew passport” already exists");
  assert.equal(line.value, "Renew passport");
});

/** `fm`'s app in its own tab on a fake vault, with Undo, whose list saves fail with `disk full`. */
function failingSaves(fm: Record<string, unknown>) {
  const t = fakeEnv({ [`Apps/${fm.app}.md`]: { fm } });
  t.env.log = (entry) => t.activity.add(entry);
  t.env.undo = async (id) => {
    const r = await undoEntry((await t.activity.get(id))!, t.undoIO);
    await t.activity.setUndone(id, r.undone);
    return undoMessage(r);
  };
  const store = t.env.store!;
  t.env.store = (dataPath, appPath) => ({ ...store(dataPath, appPath), add: async () => { throw new Error("disk full"); } });
  const root = document.body.createDiv();
  const c = new AppController(root, `Apps/${fm.app}.md`, t.env);
  c.openInPlace(() => {});
  started.push({ dispose: () => { c.dispose(); root.remove(); } });
  c.load();
  return { ...t, root };
}

test("in the app, a save that fails after its line was added says so with Undo and lets go of what was typed; one that wrote nothing keeps it", async () => {
  const notSaved = failingSaves({ app: "Weight", panels: [{ view: "form", title: "Log", fields: { weight: "number" }, save: "weight" }] });
  await settle();
  const line = () => notSaved.root.querySelector("input.gz-addline-input") as HTMLInputElement;
  line().value = "81";
  line().dispatchEvent(new window.Event("input"));
  notSaved.root.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(text(notSaved.root.querySelector(".gz-addline-error")), "Not saved: disk full");
  assert.equal(line().value, "81", "nothing was written, so what was typed stays to try again");

  const t = failingSaves({ app: "Weight", panels: [{ view: "form", title: "Log", fields: { weight: "number" }, save: "weight", append: "Daily", line: "- weighed {weight}" }] });
  await settle();
  const input = t.root.querySelector("input.gz-addline-input") as HTMLInputElement;
  input.value = "81";
  input.dispatchEvent(new window.Event("input"));
  t.root.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(t.f.files.get("Daily.md")!.body, "- weighed 81\n");
  assert.ok(!t.root.querySelector(".gz-addline-error"), "not said to be not saved");
  assert.equal(input.value, "", "let go of, so trying again doesn't add the line twice");
  assert.equal(text(t.root.querySelector(".gz-notice .gz-notice-text")), "Added the line to Daily, but couldn't save the row: disk full");
  assert.deepEqual((await t.activity.list()).map((e) => [e.what, e.changes.map((ch) => ch.kind)]), [["Log", ["line-added"]]]);
  (t.root.querySelector(".gz-notice button.gz-undo") as HTMLButtonElement).click();
  await settle();
  assert.equal(t.f.files.get("Daily.md")?.body ?? "", "", "Undo takes the line out");
});

test("in the app, a form kept as fields whose save fails after its line was added says so with Undo and is cleared", async () => {
  const t = failingSaves({ app: "Journal", panels: [{ view: "form", title: "Write", fields: { entry: "textarea" }, save: "entries", append: "Daily", line: "- {entry}" }] });
  await settle();
  const box = t.root.querySelector("form.gz-form textarea") as HTMLTextAreaElement;
  box.value = "a long day";
  t.root.querySelector("form.gz-form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(t.f.files.get("Daily.md")!.body, "- a long day\n");
  assert.ok(!t.root.querySelector(".gz-form-error"), "not said to be not saved");
  assert.equal(box.value, "");
  assert.equal(text(t.root.querySelector(".gz-notice .gz-notice-text")), "Added the line to Daily, but couldn't save the row: disk full");
  assert.ok(t.root.querySelector(".gz-notice button.gz-undo"));
});

// ---- A shortcut whose panel has a problem --------------------------------------------------------

test("a link to a shortcut whose panel has a problem says that problem, not that there's no such shortcut", async () => {
  const BUDGET = { app: "Budget", panels: [{ view: "form", title: "Spend", shortcut: "spend", save: "spend" }] };
  const t = fakeBackground({
    "Apps/Budget.md": { fm: BUDGET },
    "Apps/Bills.md": { fm: { app: "Bills", tabs: { Due: [{ view: "form", title: "Pay", alias: "pay", fields: { amount: "nmber" }, save: "paid" }] } } },
    "Apps/Water.md": { fm: { app: "Water", view: "form", shortcut: "glass", save: "water" } },
  });
  await t.bg.start();
  const why = "“Budget”'s shortcut “spend” has a problem: form needs fields";
  assert.deepEqual(await t.bg.runCommand("Apps/Budget.md:spend"), { ok: false, error: why });
  await t.bg.runUri({ app: "Budget", do: "spend", amount: "5" });
  assert.deepEqual(t.notices, [why, why]);
  // A panel in a tab, named by its alias; a note that is one panel.
  assert.equal((await t.bg.runCommand("Apps/Bills.md:pay")).error,
    "“Bills”'s shortcut “pay” has a problem: field \"amount\" type must be one of text, number, date, time, checkbox, textarea, a unit (kg, USD…) or a list of choices");
  assert.equal((await t.bg.runCommand("Apps/Water.md:glass")).error, "“Water”'s shortcut “glass” has a problem: form needs fields");
  // A name no panel gives is still no shortcut.
  assert.equal((await t.bg.runCommand("Apps/Budget.md:save")).error, "Budget has no shortcut “save”");

  // Fixed, it runs.
  t.f.files.get("Apps/Budget.md")!.fm = { ...BUDGET, panels: [{ ...BUDGET.panels[0], fields: { amount: "number" } }] };
  t.changed("Apps/Budget.md");
  await settle(2);
  const ran = await t.bg.runFrom("Apps/Budget.md", "spend", { params: { amount: "5" }, trusted: true });
  assert.equal(ran.ok, true);
});

// ---- The map tells a revoked app from one never opened --------------------------------------------

test("the map says an app you revoked is not allowed because you revoked it, and one never opened is never opened", async () => {
  const t = fakeBackground({
    "Apps/Meds.md": { fm: { app: "Meds", panels: [{ view: "button", label: "Took meds", save: "doses" }] } },
    "Apps/Projects.md": { fm: { app: "Projects", panels: [{ view: "number", source: "doses", agg: "count" }] } },
    "Apps/Inbox.md": { fm: { app: "Inbox", panels: [{ view: "button", label: "Add", save: "inbox" }] } },
  });
  await t.bg.start();
  const apps = t.bg.list();
  // Revoke took Meds's grant away; what it did is still in the log.
  const grants = { "Apps/Inbox.md": [] };
  const activity: Entry[] = [{ id: "1", at: 1000, app: "Apps/Meds.md", actor: "you", what: "Took meds", undone: 0, changes: [] }];
  const states = Object.fromEntries(buildMap(apps, grants, [], activity).apps.map((a) => [a.name, a.state]));
  assert.deepEqual(states, { Inbox: "allowed", Meds: "revoked", Projects: "not-opened" });

  const plugin = {
    runtime: {
      background: { list: () => apps },
      activity: { list: async () => activity },
      store: { grants },
      lenses: { lenses: () => [] },
      policyPending: () => false,
    },
  };
  const view = new MapView({} as never, plugin as never);
  const el = document.body.createDiv();
  Object.assign(view, { contentEl: el });
  await (view as unknown as { draw(): Promise<void> }).draw();
  assert.equal(text(el.querySelector(".gz-map-summary")), "3 apps: 1 allowed, 1 never opened, 1 revoked");
  const card = (name: string) => [...el.querySelectorAll(".gz-map-app")].find((c) => text(c.querySelector(".gz-title")) === name)!;
  const head = (name: string) => [text(card(name).querySelector(".gz-map-state")), [...card(name).querySelectorAll(".gz-map-app-head button")].map(text)];
  assert.deepEqual(head("Meds"), ["Not allowed: you revoked it", ["Activity"]]);
  assert.deepEqual(head("Projects"), ["Never opened", ["Activity"]]);
  assert.deepEqual(head("Inbox"), ["Allowed", ["Activity", "Revoke"]]);
  el.remove();
});

// ---- A hand edit's words -------------------------------------------------------------------------

test("a hand edit to a list of text says added and removed; only a list a checklist reads says ticked and unticked", () => {
  const ops: Op[] = [
    { op: "tick", l: "packed", item: "Charger" }, { op: "untick", l: "packed", item: "Passport" },
    { op: "tick", l: "places", item: "Oslo" }, { op: "untick", l: "places", item: "Rome" },
  ];
  assert.deepEqual(editWords(ops, new Set(["packed"])), ["packed: Charger ticked; Passport unticked", "places: Oslo added; Rome removed"]);
});

test("the card for a hand edit knows which of the app's lists its checklists read", async () => {
  const APP = "Apps/Trip.md";
  const DATA = "Apps/Trip data.md";
  const TRIP = { app: "Trip", panels: [
    { view: "checklist", title: "Packing", items: ["Passport", "Charger"], save: "packed" },
    { view: "list", title: "Places", source: "places" },
  ] };
  const t = fakeEnv({ [APP]: { fm: TRIP }, [DATA]: { fm: {} } });
  const root = document.body.createDiv();
  const c = new AppController(root, APP, t.env);
  started.push({ dispose: () => { c.dispose(); root.remove(); } });
  c.load();
  await settle();
  const box = root.querySelector(".gz-checklist input[type=checkbox]") as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new window.Event("change"));
  await settle();
  const fm = t.f.files.get(DATA)!.fm!;
  fm.packed = ["Passport", "Charger"];
  fm.places = ["Oslo"];
  t.changed(DATA);
  await settle();
  assert.deepEqual([...root.querySelectorAll(".gz-hand-edit li")].map(text), ["packed: Charger ticked", "places: Oslo added"]);
});

// ---- A panel whose source fails ------------------------------------------------------------------

const WEATHER = { app: "Weather", panels: [{ view: "number", title: "Now", source: "https://api.example.com/now", pick: "current", field: "t" }] };
const SOURCE = ["---", "app: Weather", "panels:", "  - view: number", "    title: Now", "    source: https://api.example.com/now", "---"];
type Answer = { status: number; text: string; contentType: string };

/** Weather in its own tab, its web source answered by `answer` (the 1st call, the 2nd…). */
function weather(answer: (call: number) => Promise<Answer>, opts: { preview?: boolean; past?: number } = {}) {
  const t = fakeEnv({ "Apps/Weather.md": { fm: WEATHER } });
  t.source.lines = SOURCE;
  let calls = 0;
  t.f.host.fetch = () => answer(++calls);
  if (opts.preview) t.env.preview = true;
  const root = document.body.createDiv();
  const c = new AppController(root, "Apps/Weather.md", opts.past === undefined ? t.env : pastEnv(t.env, opts.past));
  started.push({ dispose: () => { c.dispose(); root.remove(); } });
  c.load();
  const panel = () => root.querySelector(".gz-panel")!;
  const buttons = () => [...panel().querySelectorAll(".gz-actions button")] as HTMLButtonElement[];
  const button = (name: string) => buttons().find((b) => b.textContent === name)!;
  return { ...t, root, panel, buttons, button, calls: () => calls };
}

const json = (body: unknown, status = 200): Answer => ({ status, text: JSON.stringify(body), contentType: "application/json" });

test("a source that fails says why in plain words, with Try again and Show in source", async () => {
  const cases: [string, () => Promise<Answer>, string][] = [
    ["no network", async () => { throw new WebError("network", "api.example.com", "net::ERR_INTERNET_DISCONNECTED"); }, "Couldn't reach api.example.com. Check the connection."],
    ["429", async () => json({}, 429), "api.example.com answered 429: too many requests. Try again later."],
    ["500", async () => json({}, 500), "api.example.com answered 500."],
    ["not JSON", async () => ({ status: 200, text: "{\"current\": ", contentType: "application/json" }), "The answer from api.example.com isn't JSON."],
    ["anything else", async () => { throw new Error("Not fetched in a try: api.example.com"); }, "Not fetched in a try: api.example.com"],
  ];
  for (const [what, answer, words] of cases) {
    const t = weather(answer);
    await settle();
    assert.ok(t.panel().classList.contains("gz-error"), what);
    assert.equal(text(t.panel().querySelector(".gz-title")), "Now", what);
    assert.equal(text(t.panel().querySelector(".gz-title + div")), words, what);
    assert.deepEqual(t.buttons().map((b) => b.textContent), ["Try again", "Show in source"], what);
  }
});

test("Try again loads the panel again and shows what comes; Show in source goes to the panel's line", async () => {
  const t = weather(async (call) => (call === 1 ? json({}, 503) : json({ current: { t: 7 } })));
  await settle();
  t.button("Show in source").click();
  await settle(2);
  assert.deepEqual(t.source.shownAt, [3], "the panel's - view: line");
  t.button("Try again").click();
  await settle();
  assert.equal(t.calls(), 2);
  assert.equal(t.panel().classList.contains("gz-error"), false);
  assert.equal(text(t.panel().querySelector(".gz-big")), "7");
});

test("in a try there is no source to show, and in the past nothing to try again", async () => {
  const tryIt = weather(async () => json({}, 503), { preview: true });
  await settle();
  assert.deepEqual(tryIt.buttons().map((b) => b.textContent), ["Try again"]);
  const past = weather(async () => json({}, 503), { past: new Date(2026, 10, 17, 12).getTime() });
  await settle();
  assert.ok(past.panel().classList.contains("gz-error"));
  assert.deepEqual(past.buttons().map((b) => b.textContent), ["Show in source"]);
  assert.equal(past.calls(), 0, "the past is read from what was kept");
});

test("Obsidian's host says a request that got no answer is the network's failure, naming the host", async () => {
  // The stand-in requestUrl rejects, as Obsidian's does when nothing answers.
  const host = obsidianHost({ vault: {} } as never);
  await assert.rejects(host.fetch("https://api.example.com/now?key=s3cret", {}), (e: unknown) => e instanceof WebError && e.kind === "network" && e.host === "api.example.com");
});

// ---- Touch -----------------------------------------------------------------------------------------

test("on a touch screen the add line's button is at least 44 px tall", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  const block = coarse.slice(0, coarse.indexOf("\n}"));
  assert.match(block, /button\.gz-addline-go \{ min-height: 44px; \}/);
});
