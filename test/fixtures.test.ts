import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

/** The notes of a test vault folder, each with its whole text as its body, so task lines count as in the file. */
function withText(folder: string) {
  const names = readdirSync(new URL(`./vault/${folder}`, import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => [`${folder}/${n}`, {
    fm: vaultNote(`${folder}/${n}`).fm,
    body: readFileSync(new URL(`./vault/${folder}/${n}`, import.meta.url), "utf8"),
  }]));
}

test("Tasks: what's open across project notes, ticked off in the note itself", async () => {
  const spec = readSpec(vaultNote("Apps/Tasks.md").fm, { path: "Apps/Tasks.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Tasks.md"), ["read:Tasks", "tasks:Tasks"]);

  const { root, f, notices } = openApp("Apps/Tasks.md", withText("Tasks"));
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [open, soon, done] = [...root.querySelectorAll(".na-panel")];
  const openRows = () => [...open.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(0, 3).map((td) => text(td)));
  // Undated tasks sort first; a code block's checkboxes aren't tasks.
  assert.deepEqual(openRows(), [
    ["Pour the base", "Garden shed", "—"],
    ["Draw the plans", "Garden shed", "—"],
    ["Write the about page", "Website", "—"],
    ["Download bank statements 📅 2026-11-19", "Tax return", "2026-11-19"],
    ["Order timber 📅 2026-11-20 #shopping", "Garden shed", "2026-11-20"],
    ["Hire a mixer [due:: 2026-11-24]", "Garden shed", "2026-11-24"],
    ["Renew the domain 📅 2026-11-25 #admin", "Website", "2026-11-25"],
    ["File the return 📅 2027-01-31", "Tax return", "2027-01-31"],
  ]);
  assert.equal(text(soon.querySelector(".na-big")), "4");
  assert.deepEqual([...done.querySelectorAll("li")].map((li) => text(li)),
    ["Measure the space 📅 2026-11-02 · Garden shed", "Find last year's return · Tax return", "Pick a theme · Website"]);

  const box = open.querySelectorAll("tbody tr")[3].querySelector('input[type="checkbox"]') as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.deepEqual(notices, []);
  assert.equal(f.files.get("Tasks/Tax return.md")!.body,
    "Everything for this year's return, in order.\n\n1. [x] Find last year's return\n2. [x] Download bank statements 📅 2026-11-19\n3. [ ] File the return 📅 2027-01-31\n");
  assert.equal(openRows().length, 7);
  assert.equal(text(soon.querySelector(".na-big")), "3");
  assert.equal(text(done.querySelectorAll("li")[2]), "Download bank statements 📅 2026-11-19 · Tax return");
});

test("Shelf: the books Books.base picks, by status, set in place", async () => {
  const spec = readSpec(vaultNote("Apps/Shelf.md").fm, { path: "Apps/Shelf.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Shelf.md"), ["edit:*", "read:*"]);

  // A note outside Books, which the base leaves out.
  const t = fakeEnv({ "Apps/Shelf.md": { fm: vaultNote("Apps/Shelf.md").fm }, ...books(), "Inbox/Dune notes.md": { fm: { status: "reading" } } });
  t.f.others.set("Books.base", readFileSync(new URL("./vault/Books.base", import.meta.url), "utf8"));
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Shelf.md", t.env).load();
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [shelf, byStatus] = [...root.querySelectorAll(".na-panel")];
  const rows = [...shelf.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => text(tr.querySelector("td"))), ["Dune", "Middlemarch", "Piranesi", "The Overstory"]);
  assert.deepEqual([...byStatus.querySelectorAll("li")].map((li) => text(li)), ["(none) · 4"]);

  choose(rows[0].querySelector("select")!, "reading");
  await settle();
  assert.deepEqual(t.f.files.get("Books/Dune.md")!.fm, { finished: "2026-02-10", status: "reading" });
  assert.deepEqual([...byStatus.querySelectorAll("li")].map((li) => text(li)), ["(none) · 3", "reading · 1"]);
});
