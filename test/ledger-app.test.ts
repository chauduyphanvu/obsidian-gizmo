import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { Ledger, rowIdOf } from "../src/ledger-store.ts";
import { fakeEnv, listsIn, savedAt } from "./support/fakes.ts";

const APP = "Apps/Chores.md";
const DATA = "Apps/Chores data.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

const CHORES = {
  app: "Chores",
  panels: [
    { view: "form", title: "Add", fields: { task: "text" }, save: "chores" },
    { view: "table", title: "Chores", source: "chores", columns: ["task", "who"], edit: ["who"] },
  ],
};

function open() {
  const t = fakeEnv({ [APP]: { fm: CHORES } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, APP, t.env);
  started.push(c);
  c.load();
  const add = async (task: string) => {
    (root.querySelector("form input") as HTMLInputElement).value = task;
    root.querySelector("form")!.dispatchEvent(new window.Event("submit"));
    await settle();
  };
  /** Another device on the same synced files. */
  const other = new Ledger({
    filesIn: (f) => t.f.host.filesIn!(f), readFile: (p) => t.f.host.readFile(p), append: (p, s) => t.f.host.append!(p, s),
    writeFile: (p, s) => t.f.host.writeFile!(p, s), frontmatter: (p) => t.f.host.frontmatter(p),
  }, () => "phone000", () => t.f.host.now());
  return { ...t, root, add, other };
}

test("a data note edited by hand shows a card; Import takes the edit in, as events, and the card goes", async () => {
  const t = open();
  await settle();
  await t.add("bins");
  await t.add("dishes");
  assert.equal(t.root.querySelector(".gz-hand-edit"), null);
  const fm = t.f.files.get(DATA)!.fm!;
  fm.chores = [{ task: "bins", at: savedAt("2026-11-18T12:00") }, { task: "laundry", at: savedAt("2026-11-18T12:00") }];
  t.changed(DATA);
  await settle();
  assert.equal(text(t.root.querySelector(".gz-hand-edit .gz-title")), "Chores data was edited by hand");
  assert.deepEqual([...t.root.querySelectorAll(".gz-hand-edit li")].map(text), ["chores: 1 row added or changed; 1 row taken out or changed"]);
  // Until then the app shows what it keeps.
  assert.deepEqual([...t.root.querySelectorAll("tbody tr td:first-child")].map(text), ["bins", "dishes"]);
  [...t.root.querySelectorAll(".gz-hand-edit button")].find((b) => b.textContent === "Import the edit")!.dispatchEvent(new window.Event("click"));
  await settle();
  assert.equal(t.root.querySelector(".gz-hand-edit"), null);
  assert.deepEqual([...t.root.querySelectorAll("tbody tr td:first-child")].map(text), ["bins", "laundry"]);
  assert.deepEqual((listsIn(t.f.files.get(DATA)!.fm)!.chores as { task: string }[]).map((r) => r.task), ["bins", "laundry"]);
});

test("Discard writes the note back as the app keeps it", async () => {
  const t = open();
  await settle();
  await t.add("bins");
  t.f.files.get(DATA)!.fm!.chores = [];
  t.changed(DATA);
  await settle();
  assert.ok(t.root.querySelector(".gz-hand-edit"));
  [...t.root.querySelectorAll(".gz-hand-edit button")].find((b) => b.textContent === "Discard it")!.dispatchEvent(new window.Event("click"));
  await settle();
  assert.equal(t.root.querySelector(".gz-hand-edit"), null);
  assert.deepEqual((listsIn(t.f.files.get(DATA)!.fm)!.chores as { task: string }[]).map((r) => r.task), ["bins"]);
});

test("a cell two devices set at once shows the other value as a chip; picking it keeps that one", async () => {
  const t = open();
  await settle();
  await t.add("bins");
  const [row] = (await t.data.ledger!.state(DATA)).lists.get("chores")!.rows;
  const id = rowIdOf(row)!;
  // Both set who from nothing, neither having seen the other's.
  await t.data.ledger!.write(DATA, [{ op: "set", l: "chores", row: id, f: "who", v: "Ann", from: undefined }]);
  await t.other.write(DATA, [{ op: "set", l: "chores", row: id, f: "who", v: "Bo", from: undefined }]);
  for (const p of t.f.others.keys()) t.changed(p);
  await settle();
  const cell = t.root.querySelectorAll("tbody tr td")[1];
  const shown = (cell.querySelector("input") as HTMLInputElement).value;
  const chip = cell.querySelector(".gz-conflict")!;
  assert.ok(["Ann", "Bo"].includes(shown));
  assert.equal(text(chip), `or ${shown === "Ann" ? "Bo" : "Ann"}`);
  chip.dispatchEvent(new window.Event("click"));
  await settle();
  const after = t.root.querySelectorAll("tbody tr td")[1];
  assert.equal((after.querySelector("input") as HTMLInputElement).value, shown === "Ann" ? "Bo" : "Ann");
  assert.equal(after.querySelector(".gz-conflict"), null, "picking one settles it");
});
