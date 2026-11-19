import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { fakeEnv } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

function open(path: string, notes: Parameters<typeof fakeEnv>[0], lines: string[] = [], responses: Record<string, unknown> = {}) {
  const t = fakeEnv(notes, responses);
  t.source.lines = lines;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, path, t.env);
  app.load();
  return { ...t, root, app };
}

const NOTE = ["---", "app: Meds", "refresh: soon", "panels:", "  - view: text", "    text: ok", "  - view: gauge", "---"];
const MEDS = { "Apps/Meds.md": { fm: { app: "Meds", refresh: "soon", panels: [{ view: "text", text: "ok" }, { view: "gauge" }] } } };

const links = (root: Element) => [...root.querySelectorAll(".na-error li")];

// ---- Errors that point at the line -------------------------------------------------------------------

test("the problems card links an error that names a panel, and leaves the others as text", async () => {
  const { root, source } = open("Apps/Meds.md", MEDS, NOTE);
  const items = links(root);
  assert.equal(items.length, 2);
  const placed = items.find((li) => li.querySelector(".na-error-link"))!;
  const plain = items.find((li) => !li.querySelector(".na-error-link"))!;
  const link = placed.querySelector("button.na-error-link") as HTMLButtonElement;
  assert.match(text(link), /^panel 2: view must be one of /);
  assert.equal(text(placed), text(link));
  assert.equal(plain.querySelector(".na-error-link"), null);
  assert.equal(text(plain), "refresh must look like 30s, 5m, 1h");

  link.click();
  await settle();
  assert.deepEqual(source.shownAt, [6]);
});

test("the line is looked up when the link is clicked, so it follows edits made since the card was drawn", async () => {
  const { root, source } = open("Apps/Meds.md", MEDS, NOTE);
  source.lines = ["---", "app: Meds", "# a note to self", "# another", ...NOTE.slice(2)];
  (root.querySelector("button.na-error-link") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(source.shownAt, [8]);
});

test("when the note no longer has that panel, the link just opens the source", async () => {
  const t = open("Apps/Meds.md", MEDS, NOTE);
  let opened = 0;
  t.env.showSource = () => { opened++; };
  t.source.lines = ["---", "app: Meds", "---"];
  (t.root.querySelector("button.na-error-link") as HTMLButtonElement).click();
  await settle();
  assert.equal(opened, 1);
  assert.deepEqual(t.source.shownAt, []);
});

test("an error from a component is a link to the app's panel that uses it", async () => {
  const lines = ["---", "app: Meds", "panels:", "  - view: text", "    text: ok", "  - use: \"[[Ticker]]\"", "---"];
  const { root, source } = open("Apps/Meds.md", {
    "Apps/Meds.md": { fm: { app: "Meds", panels: [{ view: "text", text: "ok" }, { use: "[[Ticker]]" }] } },
    "Components/Ticker.md": { fm: { component: "T", panels: [{ view: "gauge" }] } },
  }, lines);
  const link = root.querySelector("button.na-error-link") as HTMLButtonElement;
  assert.match(text(link), /^panel 2 \(from \[\[Ticker\]\] panel 1\): view must be one of /);
  link.click();
  await settle();
  assert.deepEqual(source.shownAt, [5]);
});

test("a data block's error links to the block", async () => {
  const lines = ["---", "app: Meds", "data:", "  doses:", "    colour: red", "    source: doses", "panels:", "  - view: text", "    text: ok", "---"];
  const { root, source } = open("Apps/Meds.md", {
    "Apps/Meds.md": { fm: { app: "Meds", data: { doses: { colour: "red", source: "doses" } }, panels: [{ view: "text", text: "ok" }] } },
  }, lines);
  const link = root.querySelector("button.na-error-link") as HTMLButtonElement;
  assert.equal(text(link), 'data.doses: unknown key "colour"');
  link.click();
  await settle();
  assert.deepEqual(source.shownAt, [3]);
});

test("a component note's own errors stay text, since they name the component, not a panel of this note", () => {
  const { root } = open("Components/T.md", { "Components/T.md": { fm: { component: "T", panels: [{ view: "gauge" }] } } }, ["---", "component: T", "panels:", "  - view: gauge", "---"]);
  assert.equal(links(root).length >= 1, true);
  assert.equal(root.querySelector(".na-error-link"), null);
});
