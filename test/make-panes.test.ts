import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFromLines } from "../src/examples-make.ts";
import { planOf } from "../src/examples-view.ts";
import { galleryApps } from "../src/gallery.ts";
import { drawHaveIt, drawSetUp } from "../src/gallery-pane.ts";
import { galleryChoice } from "../src/install.ts";
import { drawNewApp, makeApp } from "../src/new-app-pane.ts";
import { defaultDataPath } from "../src/store.ts";
import { drawTry } from "../src/try-pane.ts";
import { vaultTry } from "../src/try.ts";
import notes from "../scripts/gallery-notes.ts";
import { runtimeOn } from "./support/runtime.ts";

// New app, New app from lines, the gallery's Set up and Have it, and Try it first as panes any
// host draws into its own window: Obsidian's modals and the standalone app's windows wrap these.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T, ms = 2000): Promise<T> => {
  for (let t = 0; t < ms; t += 20) {
    const v = fn();
    if (v) return v;
    await wait(20);
  }
  return fn();
};
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const button = (el: Element, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
};
const enter = (input: HTMLInputElement) => {
  const e = new window.Event("keydown", { cancelable: true }) as Event & { key: string };
  Object.defineProperty(e, "key", { value: "Enter" });
  input.dispatchEvent(e);
};

test("New app: a taken name is said as it's typed, an empty purpose once Create is tried; Enter makes it", async () => {
  const el = document.createElement("div");
  const made: [string, string][] = [];
  let closed = 0;
  drawNewApp(el, { where: "in Apps", taken: () => ["Water.md", "Old"], create: async (n, p) => { made.push([n, p]); return undefined; }, close: () => { closed++; } });
  assert.deepEqual([...el.querySelectorAll(".setting-item-name")].map(text), ["Name", "What is it for?"]);
  assert.equal(text(el.querySelector(".setting-item-description")), "The note's name; it goes in Apps.");
  const [name, purpose] = [...el.querySelectorAll(".setting-item-control input")] as HTMLInputElement[];
  type(name, "water");
  assert.equal(text(el.querySelector(".gz-new-app-problem")), "There is already a note named water in this folder");
  type(name, "Tea");
  assert.equal(text(el.querySelector(".gz-new-app-problem")), "");
  button(el, "Create").click();
  await wait(10);
  assert.equal(text(el.querySelector(".gz-new-app-problem")), "Say what it is for");
  assert.equal(made.length, 0);
  type(purpose, "Count the cups of tea I drink");
  enter(purpose);
  await until(() => closed);
  assert.deepEqual(made, [["Tea", "Count the cups of tea I drink"]]);
});

test("New app: a failure to make the note is said in place, and Create can be pressed again", async () => {
  const el = document.createElement("div");
  drawNewApp(el, { where: "at the top of the vault", taken: () => [], create: async () => "Couldn't make the note: the disk is full", close: () => assert.fail("closed") });
  const [name, purpose] = [...el.querySelectorAll(".setting-item-control input")] as HTMLInputElement[];
  type(name, "Tea");
  type(purpose, "Tea");
  button(el, "Create").click();
  await until(() => text(el.querySelector(".gz-new-app-problem")));
  assert.equal(text(el.querySelector(".gz-new-app-problem")), "Couldn't make the note: the disk is full");
  assert.equal(button(el, "Create").disabled, false);
});

test("makeApp writes a note of only its app line, in its folder, and never over one there", async () => {
  const t = await runtimeOn({});
  const made = await makeApp(t.runtime, "Apps", "Tea", "Count the cups of tea I drink");
  assert.deepEqual(made, { path: "Apps/Tea.md", text: "---\napp: Count the cups of tea I drink\n---\n" });
  assert.equal(t.f.files.get("Apps/Tea.md")?.fm?.app, "Count the cups of tea I drink");
  assert.deepEqual(await makeApp(t.runtime, "Apps", "Tea", "Something else"), { error: "Couldn't make the note: File already exists." });
  assert.equal(t.f.files.get("Apps/Tea.md")?.fm?.app, "Count the cups of tea I drink", "the first one stays");
  assert.deepEqual(await makeApp(t.runtime, "", "Top", "At the top"), { path: "Top.md", text: "---\napp: At the top\n---\n" });
});

test("New app from lines makes the kind, its rows in the ledger, then the app", async () => {
  const t = await runtimeOn({});
  const acts = { now: () => new Date(2026, 2, 10), taken: () => false, make: async () => undefined, cancel: () => {} };
  const plan = planOf("mar 3 groceries 62.10 weekly shop\nmar 4 coffee 4.50\nmar 9 transport 31 train", "spend", "", 0, acts).plan!;
  assert.ok(plan, "the lines read as a plan");
  const made = await makeFromLines(t.runtime, "Money", plan);
  assert.deepEqual(made, { path: `Money/${plan.appNote}.md` });
  const kindPath = `Money/${plan.kindNote}.md`;
  assert.equal(t.f.files.get(kindPath)?.fm?.kind, "spend");
  assert.ok(t.f.files.get(`Money/${plan.appNote}.md`)?.fm, "the app note is there");
  const state = await t.runtime.dataLayer.ledger!.state(defaultDataPath(kindPath));
  assert.equal(state.lists.get("spend")?.rows.length, 3, "the three lines are the kind's rows");
  assert.deepEqual(await makeFromLines(t.runtime, "Money", plan), { error: "Couldn't make the notes: File already exists." });
});

test("the gallery: Set up shows the kit's values, and Copy copies the note with the values typed; Have it opens yours", async () => {
  const t = await runtimeOn({});
  const practice = galleryApps(notes).find((g) => g.name === "Practice")!;
  const choice = galleryChoice(t.runtime, practice, notes);
  assert.ok("params" in choice && choice.params.length, "Practice is a kit with values to give");
  const el = document.createElement("div");
  const copied: string[] = [];
  let closed = 0;
  drawSetUp(el, practice, choice.params, "It asks for nothing.", { copy: (note) => copied.push(note.text), close: () => { closed++; } });
  const inputs = [...el.querySelectorAll(".setting-item-control input")] as HTMLInputElement[];
  assert.deepEqual([...el.querySelectorAll(".setting-item-name")].map(text), choice.params.map((p) => p.name));
  assert.deepEqual(inputs.map((i) => i.value), choice.params.map((p) => String(p.value ?? "")));
  assert.equal(text(el.querySelector(".gz-muted")), "It asks for nothing.");
  const goal = inputs[choice.params.findIndex((p) => p.name === "goal")];
  type(goal, "45");
  button(el, "Copy").click();
  assert.equal(closed, 1);
  assert.match(copied[0], /goal: 45/);

  const have = document.createElement("div");
  const did: string[] = [];
  drawHaveIt(have, "Practice", { open: () => did.push("open"), close: () => did.push("close") });
  assert.equal(text(have.querySelector("p")), "You already have “Practice”.");
  button(have, "Open yours").click();
  assert.deepEqual(did, ["open", "close"]);
});

test("Try it first: the app on copies of its notes; what it did is listed, the vault is untouched, and Allow runs", async () => {
  const meds = { app: "Meds", panels: [{ view: "button", label: "Took meds", save: "doses" }, { view: "number", title: "Doses", source: "doses", agg: "count" }] };
  const t = await runtimeOn({ "Apps/Meds.md": { fm: meds, body: "" } });
  const snapshot = () => JSON.stringify([...t.f.files].map(([p, n]) => [p, n.fm, n.body]));
  const before = snapshot();
  const tried = (await vaultTry(t.runtime, "Apps/Meds.md"))!;
  const el = document.createElement("div");
  const said: string[] = [];
  const stop = drawTry(el, t.runtime, { ...tried, done: { label: "Allow", run: () => { said.push("allowed"); } }, copy: () => {}, close: () => said.push("closed") });
  assert.deepEqual([...el.querySelectorAll(".gz-effects li")].map(text), ["Nothing yet."]);
  const took = await until(() => [...el.querySelectorAll(".gz-try-app button")].find((b) => b.textContent?.includes("Took meds")) as HTMLButtonElement | undefined);
  assert.ok(took, el.innerHTML.slice(0, 300));
  took.click();
  await until(() => !text(el.querySelector(".gz-effects")).includes("Nothing yet."));
  assert.notDeepEqual([...el.querySelectorAll(".gz-effects li")].map(text), ["Nothing yet."]);
  assert.equal(snapshot(), before, "the vault is untouched");
  button(el, "Allow").click();
  await until(() => said.includes("allowed"));
  assert.deepEqual(said, ["closed", "allowed"]);
  stop();
});
