import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController, type AppEnv } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { fakeHost } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

/** A controller on a fake vault, with grants kept the way the plugin keeps them. */
function setup(notes: Parameters<typeof fakeHost>[0], grants: Record<string, string[]> = {}, appPath = "Apps/W.md") {
  const f = fakeHost(notes);
  const data = new DataLayer(f.host);
  const change = async (path: string, fm: Record<string, unknown>) => {
    f.files.set(path, { fm });
    data.fileChanged(path);
    f.flush();
    await settle();
  };
  const env: AppEnv = {
    data,
    frontmatter: (path) => f.files.get(path)?.fm,
    notes: {
      resolve: (link) => [...f.files.keys()].find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
      frontmatter: (path) => f.files.get(path)?.fm,
    },
    isGranted: (path, wanted) => wanted.length === 0 || (grants[path] ?? []).join("\n") === wanted.join("\n"),
    granted: (path) => grants[path] ?? [],
    grant: async (path, wanted) => { grants[path] = wanted; },
    storePath: (store) => `${store}.md`,
    writeFrontmatter: async () => {},
    appendLine: async () => {},
    createNote: async () => false,
    readBody: async () => "",
    notify: () => {},
    openNote: () => {},
    showSource: () => {},
    showSourceAt: () => {},
    sourceLines: async () => [],
    now: () => new Date(2026, 10, 18, 12, 0),
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, appPath, env);
  app.load();
  return { root, change };
}

const COUNTDOWN = { component: "c", params: { when: "2027-01-01" }, panels: [{ view: "countdown", to: "$when", label: "until $when" }] };

test("editing a component redraws the apps that use it", async () => {
  const { root, change } = setup({
    "Apps/W.md": { fm: { app: "x", panels: [{ use: "[[C]]" }] } },
    "Components/C.md": { fm: COUNTDOWN },
  });
  await settle();
  assert.match(text(root.querySelector(".na-label")), /^until 2027-01-01/);
  await change("Components/C.md", { ...COUNTDOWN, params: { when: "2027-02-01" } });
  assert.match(text(root.querySelector(".na-label")), /^until 2027-02-01/);
});

test("creating a missing component clears its error", async () => {
  const { root, change } = setup({ "Apps/W.md": { fm: { app: "x", panels: [{ use: "[[Later]]" }, { view: "countdown", to: "2026-11-25" }] } } });
  await settle();
  assert.match(text(root.querySelector(".na-card.na-error")), /can't find \[\[Later\]\]/);
  assert.equal(root.querySelectorAll(".na-panel").length, 1);
  await change("Components/Later.md", COUNTDOWN);
  assert.equal(root.querySelector(".na-card.na-error"), null);
  assert.equal(root.querySelectorAll(".na-panel").length, 2);
});

test("a component that adds a host asks again, naming itself and marking what's new", async () => {
  const ticker = { component: "t", panels: [{ view: "number", source: "https://a.example.com/q" }] };
  const { root, change } = setup(
    { "Apps/W.md": { fm: { app: "x", panels: [{ use: "[[T]]" }, { view: "number", source: "https://a.example.com/q2" }] } }, "T.md": { fm: ticker } },
    { "Apps/W.md": ["net:a.example.com"] },
  );
  await settle();
  assert.equal(root.querySelectorAll(".na-panel").length, 2);
  await change("T.md", { ...ticker, panels: [...ticker.panels, { view: "number", source: "https://b.example.com/q" }] });
  assert.equal(root.querySelectorAll(".na-panel").length, 0);
  assert.deepEqual([...root.querySelectorAll(".na-card li")].map((li) => text(li)), [
    "Fetch data from a.example.com — for this note, [[T]]",
    "NewFetch data from b.example.com — for [[T]]",
  ]);
  (root.querySelector(".na-card button.mod-cta") as HTMLButtonElement).click();
  await settle();
  assert.equal(root.querySelectorAll(".na-panel").length, 3);
});

test("a component opened on its own shows how to use it and previews with its defaults", async () => {
  const { root } = setup({ "Components/C.md": { fm: COUNTDOWN } }, {}, "Components/C.md");
  await settle();
  assert.equal(text(root.querySelector(".na-example")), 'panels:\n  - use: "[[C]]"\n    with: {when: 2027-01-01}');
  assert.equal(root.querySelectorAll(".na-panel").length, 1);
  assert.match(text(root.querySelector(".na-label")), /^until 2027-01-01/);
});

test("a component with a required param isn't drawn, but its problems are shown", async () => {
  const fm = { component: "t", params: ["symbol"], panels: [{ view: "number", source: "https://a.example.com/$symbol", colour: "red" }] };
  const { root } = setup({ "T.md": { fm } }, {}, "T.md");
  await settle();
  assert.equal(text(root.querySelector(".na-example")), 'panels:\n  - use: "[[T]]"\n    with: {symbol: …}');
  assert.match(text(root.querySelector(".na-card")), /Give every param a default to preview it here\./);
  assert.deepEqual([...root.querySelectorAll(".na-card.na-error li")].map((li) => text(li)), ['[[T]] panel 1: unknown key "colour"']);
  assert.equal(root.querySelectorAll(".na-panel").length, 0);
});
