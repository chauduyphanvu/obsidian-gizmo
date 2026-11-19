import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { permissionsOf, readSpec } from "../src/spec.ts";
import { fakeEnv } from "./support/fakes.ts";
import { vaultNote } from "./support/yaml.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const key = (el: Element, name: string) => {
  const e = new window.Event("keydown", { bubbles: true }) as Event & { key: string };
  e.key = name;
  el.dispatchEvent(e);
};
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

const SEARCH = "https://openlibrary.org/search.json";
const DOCS = {
  numFound: 2,
  docs: [
    { key: "/works/OL893415W", title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, edition_count: 81 },
    { key: "/works/OL893527W", title: "Dune Messiah", author_name: ["Frank Herbert"], first_publish_year: 1969, edition_count: 52 },
  ],
};

/** The Books folder of the test vault, as notes. */
function books() {
  const names = readdirSync(new URL("./vault/Books", import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => [`Books/${n}`, { fm: vaultNote(`Books/${n}`).fm }]));
}

function openApp(path: string, notes: Parameters<typeof fakeEnv>[0], responses: Record<string, unknown> = {}) {
  const t = fakeEnv({ [path]: { fm: vaultNote(path).fm }, ...notes }, responses);
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, path, t.env).load();
  return { ...t, root };
}

test("Library: search Open Library, read about a pick, add it to Books, set its status", async () => {
  const spec = readSpec(vaultNote("Apps/Library.md").fm, { path: "Apps/Library.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Library.md"), ["create:Books", "edit:Books", "net:openlibrary.org", "read:Books"]);

  const { root, f, notices } = openApp("Apps/Library.md", books(), { [SEARCH]: DOCS });
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [results, about, shelf] = [...root.querySelectorAll(".na-panel")];
  assert.equal(text(results.querySelector(".na-waiting")), "Type in “q”");
  assert.equal(text(about.querySelector(".na-waiting")), "Pick a row in “Search results”");
  assert.deepEqual([...shelf.querySelectorAll("tbody tr td:first-child")].map((td) => text(td)), ["Dune", "Middlemarch", "Piranesi", "The Overstory"]);

  const box = root.querySelector('.na-inputs input[type="search"]') as HTMLInputElement;
  box.value = "dune";
  key(box, "Enter");
  await settle();
  assert.deepEqual(f.requests, ["https://openlibrary.org/search.json?q=dune&limit=10"]);
  const items = [...results.querySelectorAll("li")];
  assert.deepEqual(items.map((li) => text(li)), ["Dune · Frank HerbertAdd", "Dune Messiah · Frank HerbertAdd"]);

  (items[1] as HTMLElement).click();
  await settle();
  assert.equal(text(about.querySelector(".na-text")), "Dune Messiah, by Frank Herbert. First published in 1969; 52 editions.");

  // Dune is already on the shelf; Dune Messiah isn't.
  (items[0].querySelector("button.na-row-action") as HTMLButtonElement).click();
  await settle();
  (items[1].querySelector("button.na-row-action") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(notices, ["“Dune” already exists", "Added Dune Messiah to Books"]);
  assert.deepEqual(f.files.get("Books/Dune Messiah.md")!.fm,
    { title: "Dune Messiah", author: "Frank Herbert", year: 1969, status: "to read", at: "2026-11-18T12:00" });
  const rows = [...shelf.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => text(tr.querySelector("td"))), ["Dune", "Dune Messiah", "Middlemarch", "Piranesi", "The Overstory"]);
  assert.equal(text(rows[1].querySelectorAll("td")[1]), "Frank Herbert");

  choose(rows[1].querySelector("select")!, "reading");
  await settle();
  assert.equal(f.files.get("Books/Dune Messiah.md")!.fm!.status, "reading");
});

test("Chores: a form shaped by the block saves chores; ticking one off moves it to done", async () => {
  const spec = readSpec(vaultNote("Apps/Chores.md").fm, { path: "Apps/Chores.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Chores.md"), []);

  const { root, f } = openApp("Apps/Chores.md", {});
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const form = root.querySelector("form.na-form")!;
  assert.deepEqual([...form.querySelectorAll(".na-field span")].map((s) => text(s)), ["task", "room", "done"]);
  (form.querySelector("input") as HTMLInputElement).value = "Water the plants";
  choose(form.querySelector("select")!, "garden");
  form.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(f.files.get("Apps/Chores data.md")!.fm!.chores, [{ task: "Water the plants", room: "garden", done: false, at: "2026-11-18T12:00" }]);
  const todo = root.querySelector(".na-view-table")!;
  assert.equal(text(todo.querySelector("tbody tr")), "Water the plantsgarden");
  assert.equal(text(root.querySelector(".na-view-number .na-big")), "0");

  const tick = todo.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((f.files.get("Apps/Chores data.md")!.fm!.chores as { done: boolean }[])[0].done, true);
  assert.equal(text(todo.querySelector(".na-empty")), "Nothing here yet.");
  assert.equal(text(root.querySelector(".na-view-number .na-big")), "1");
});

const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

/** The Projects folder of the test vault, as notes. */
function projects() {
  const names = readdirSync(new URL("./vault/Projects", import.meta.url)).filter((n) => n.endsWith(".md")).sort();
  return Object.fromEntries(names.map((n) => [`Projects/${n}`, { fm: vaultNote(`Projects/${n}`).fm }]));
}

test("Projects: drag projects along a board, see the schedule, pick one, see what is due", async () => {
  const spec = readSpec(vaultNote("Apps/Projects.md").fm, { path: "Apps/Projects.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Projects.md"), ["edit:Projects", "read:Projects"]);

  const { root, f } = openApp("Apps/Projects.md", projects());
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [board, schedule, picked, due] = [...root.querySelectorAll(".na-panel")];
  const column = (name: string) => [...board.querySelectorAll(".na-board-col")].find((c) => text(c.querySelector(".na-board-name")) === name)!;
  const cards = (name: string) => [...column(name).querySelectorAll(".na-board-text")].map((c) => text(c));
  assert.deepEqual(cards("idea"), ["Japan trip · travel", "Learn Rust · learning"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Kitchen remodel · home"]);
  assert.deepEqual(cards("done"), ["Tax filing · money"]);

  // The schedule runs by start date and shows today; nothing is picked yet.
  assert.deepEqual([...schedule.querySelectorAll(".na-tl-label")].map((l) => text(l)), ["Tax filing", "Kitchen remodel", "Garden beds", "Japan trip", "Learn Rust"]);
  assert.equal(schedule.querySelectorAll(".na-tl-today").length, 1);
  assert.equal(text(picked.querySelector(".na-waiting")), "Pick a row in “Schedule”");

  const bars = [...schedule.querySelectorAll(".na-tl-bar")] as HTMLElement[];
  bars[2].click();
  await settle();
  assert.equal(text(picked.querySelector(".na-text")), "Garden beds is due 2026-11-30");

  // November is shown: the garden is due on the 30th. December has the kitchen.
  const day = (date: string) => due.querySelector(`[data-date="${date}"]`)!;
  assert.equal(text(day("2026-11-30").querySelector(".na-cal-val")), "1");
  assert.ok(day("2026-11-18").classList.contains("na-today"));
  (due.querySelector('button[aria-label="Next month"]') as HTMLButtonElement).click();
  assert.equal(text(day("2026-12-15").querySelector(".na-cal-val")), "1");

  // Drag Japan trip to doing: its note's status changes and the board follows.
  const trip = [...board.querySelectorAll(".na-board-card")].find((c) => text(c.querySelector(".na-board-text")).startsWith("Japan"))!;
  event(trip, "dragstart");
  event(column("doing"), "drop");
  await settle();
  assert.equal(f.files.get("Projects/Japan trip.md")!.fm!.status, "doing");
  assert.deepEqual(cards("idea"), ["Learn Rust · learning"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Japan trip · travel", "Kitchen remodel · home"]);
  // The picked project survived the reload, and the calendar stayed on December.
  assert.equal(text(picked.querySelector(".na-text")), "Garden beds is due 2026-11-30");
  assert.equal(text(due.querySelector(".na-cal-title")), "December 2026");
});

test("Stretch year: log a stretch, and the streak and today's square follow", async () => {
  const spec = readSpec(vaultNote("Apps/Stretch year.md").fm, { path: "Apps/Stretch year.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Stretch year.md"), []);

  const { root, f } = openApp("Apps/Stretch year.md", { "Apps/Stretch year data.md": { fm: vaultNote("Apps/Stretch year data.md").fm } });
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const streak = () => text(root.querySelector(".na-view-number .na-big"));
  const square = (date: string) => root.querySelector(`rect[data-date="${date}"]`)!;
  assert.equal(root.querySelectorAll("rect").length, 365);
  assert.equal(streak(), "3days");
  // Two stretches on the 14th of March; none yet today.
  assert.equal(square("2026-03-14").getAttribute("aria-label"), "2026-03-14: 2");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 0");
  assert.ok(square("2026-11-18").classList.contains("na-today"));
  assert.ok(!/na-step/.test(square("2026-11-18").getAttribute("class")!));

  (root.querySelector("button.na-button") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual((f.files.get("Apps/Stretch year data.md")!.fm!.stretches as { at: string }[]).at(-1), { at: "2026-11-18T12:00" });
  assert.equal(streak(), "4days");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 1");
  assert.ok(/na-step/.test(square("2026-11-18").getAttribute("class")!));
});
