import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController, type AppEnv } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { shiftDay } from "../src/toolbar.ts";
import { fakeHost } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

function setup(notes: Parameters<typeof fakeHost>[0]) {
  const f = fakeHost(notes);
  const data = new DataLayer(f.host);
  const edit = async (path: string, change: (fm: Record<string, unknown>) => void) => {
    const note = f.files.get(path)!;
    change(note.fm!);
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
    isGranted: () => true,
    granted: () => [],
    grant: async () => {},
    storePath: (store) => `${store}.md`,
    writeFrontmatter: async () => {},
    appendLine: async () => {},
    createNote: async () => false,
    readBody: async () => "",
    notify: () => {},
    openNote: () => {},
    showSource: () => {},
    now: () => new Date(2026, 10, 18, 12, 0),
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  return { root, edit, f, start: () => { const app = new AppController(root, "Apps/S.md", env); app.load(); return app; } };
}

/** linkedom reads a select's value from its selected option, so pick by moving that attribute. */
function choose(root: Element, name: string, label: string) {
  const select = root.querySelector(`select[aria-label="${name}"]`)!;
  for (const o of select.querySelectorAll("option")) {
    if (o.textContent === label) o.setAttribute("selected", "");
    else o.removeAttribute("selected");
  }
  select.dispatchEvent(new window.Event("change"));
}

const STOCKS = {
  app: "Stocks",
  inputs: { symbol: ["SPY", "QQQ"] },
  data: { quote: { source: "https://api.example.com/quote/$symbol" } },
  panels: [
    { view: "number", title: "$symbol", source: "quote", pick: "current", field: "t" },
    { view: "form", fields: { note: "text" }, save: "ideas" },
    { view: "countdown", to: "2027-01-01" },
  ],
};

test("a choice reloads only the panels that use it, in place, and keeps typed text", async () => {
  const { root, f, start } = setup({ "Apps/S.md": { fm: STOCKS } });
  start();
  await settle();
  assert.deepEqual(f.requests, ["https://api.example.com/quote/SPY"]);
  const number = root.querySelector(".na-view-number")!;
  const form = root.querySelector(".na-view-form")!;
  const input = form.querySelector("input") as HTMLInputElement;
  input.value = "watch earnings";
  assert.equal(text(number.querySelector(".na-title")), "SPY");

  choose(root, "symbol", "QQQ");
  assert.ok(number.classList.contains("na-stale"));
  await settle();
  assert.deepEqual(f.requests, ["https://api.example.com/quote/SPY", "https://api.example.com/quote/QQQ"]);
  assert.equal(root.querySelector(".na-view-number"), number);
  assert.equal(text(number.querySelector(".na-title")), "QQQ");
  assert.ok(!number.classList.contains("na-stale"));
  assert.equal(root.querySelector(".na-view-form"), form);
  assert.equal(form.querySelector("input"), input);
  assert.equal(input.value, "watch earnings");
});

test("switching quickly ends on the last choice", async () => {
  const { root, start } = setup({ "Apps/S.md": { fm: STOCKS } });
  start();
  await settle();
  choose(root, "symbol", "QQQ");
  choose(root, "symbol", "SPY");
  await settle();
  assert.equal(text(root.querySelector(".na-view-number .na-title")), "SPY");
});

test("choices are kept across edits to the note and start over when it's reopened", async () => {
  const { root, edit, start } = setup({ "Apps/S.md": { fm: structuredClone(STOCKS) } });
  const first = start();
  await settle();
  choose(root, "symbol", "QQQ");
  await settle();
  await edit("Apps/S.md", (fm) => { (fm.panels as unknown[]).push({ view: "countdown", to: "2027-06-01" }); });
  assert.equal(text(root.querySelector(".na-view-number .na-title")), "QQQ");
  assert.equal(text(root.querySelector("select option[selected]")), "QQQ");
  first.dispose();
  start();
  await settle();
  assert.equal(text(root.querySelector(".na-view-number .na-title")), "SPY");
});

test("the date bar steps days, jumps to today, and takes a typed date", async () => {
  const { root, start } = setup({
    "Apps/S.md": { fm: {
      app: "Day",
      inputs: { day: "date" },
      view: "list", source: "notes", from: "Health", where: { date: "$day" }, item: "{name}",
    } },
    "Health/Dentist.md": { fm: { date: "2026-11-19" } },
    "Health/Eye exam.md": { fm: { date: "2027-01-15" } },
  });
  start();
  await settle();
  const list = () => text(root.querySelector(".na-view-list .na-list")) || text(root.querySelector(".na-view-list .na-empty"));
  const button = (label: string) => [...root.querySelectorAll(".na-inputs button")].find((b) => b.textContent === label) as HTMLButtonElement;
  const date = root.querySelector('.na-inputs input[type="date"]') as HTMLInputElement;
  assert.equal(date.value, "2026-11-18");
  assert.equal(list(), "Nothing here yet.");
  button("›").click();
  await settle();
  assert.equal(date.value, "2026-11-19");
  assert.equal(list(), "Dentist");
  button("Today").click();
  await settle();
  assert.equal(list(), "Nothing here yet.");
  date.value = "2027-01-15";
  date.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(list(), "Eye exam");
});

test("days step across month and year ends", () => {
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});
