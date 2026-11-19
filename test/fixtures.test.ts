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

test("Spending: log a purchase, see the week against last, the stack against the budget, and fix a category", async () => {
  const spec = readSpec(vaultNote("Apps/Spending.md").fm, { path: "Apps/Spending.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Spending.md"), []);

  const spend = [
    { amount: 40, category: "food", note: "groceries", at: "2026-11-02T09:00" },
    { amount: 300, category: "rent", note: "", at: "2026-11-03T08:00" },
    { amount: 80.5, category: "food", note: "market", at: "2026-11-10T12:30" },
    { amount: 45, category: "fun", note: "cinema", at: "2026-11-12T19:00" },
    { amount: 12, category: "transport", note: "bus pass", at: "2026-11-16T08:15" },
    { amount: 30.25, category: "food", note: "lunch", at: "2026-11-17T13:00" },
  ];
  const { root, f } = openApp("Apps/Spending.md", { "Apps/Spending data.md": { fm: { spend } } });
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [form, week, chart, recent] = [...root.querySelectorAll(".na-panel")];

  // This week ($42.25) against last week ($125.50).
  assert.equal(text(week.querySelector(".na-big")), "$42.25");
  assert.equal(text(week.querySelector(".na-compare")), "▼ $83.25 (66%) vs previous");
  assert.equal(week.querySelector(".na-compare")!.getAttribute("aria-label"), "down $83.25, 66 percent, versus previous");

  // Weekly totals stacked by category, with the budget line.
  assert.equal(text(chart.querySelector(".na-goal-label")), "goal $400");
  assert.equal(text(chart.querySelector(".na-legend")), "FoodRentTransportFunOther");
  assert.ok(chart.querySelectorAll("path.na-bar.na-stacked").length >= 6);
  assert.match(text(chart.querySelector(".na-readout")), /Food \$30.*Transport \$12/);

  // Recent purchases, newest first, in the panel's formats; category is a dropdown.
  assert.deepEqual([...recent.querySelectorAll("th")].map((th) => text(th)), ["When", "Spent", "category", "note"]);
  const rows = [...recent.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => [text(tr.querySelectorAll("td")[0]), text(tr.querySelectorAll("td")[1])]).slice(0, 2), [["23 hours ago", "$30.25"], ["2 days ago", "$12.00"]]);
  assert.deepEqual([...rows[0].querySelectorAll("select option")].map((o) => text(o)), ["food", "rent", "transport", "fun", "other"]);

  // Log a purchase.
  const [amount, note] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  amount.value = "20";
  note.value = "movie";
  choose(form.querySelector("select")!, "fun");
  form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  const saved = f.files.get("Apps/Spending data.md")!.fm!.spend as Record<string, unknown>[];
  assert.deepEqual(saved.at(-1), { amount: 20, category: "fun", note: "movie", at: "2026-11-18T12:00" });
  assert.equal(text(week.querySelector(".na-big")), "$62.25");
  assert.equal(text(week.querySelector(".na-compare")), "▼ $63.25 (50%) vs previous");
  assert.deepEqual([...recent.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelectorAll("td")[1])).slice(0, 2), ["$20.00", "$30.25"]);
  assert.equal(text(recent.querySelector("tbody tr td")), "just now");

  // The movie was food after all.
  choose(recent.querySelector("tbody tr select")!, "food");
  await settle();
  assert.equal((f.files.get("Apps/Spending data.md")!.fm!.spend as Record<string, unknown>[]).at(-1)!.category, "food");
  assert.equal(text(week.querySelector(".na-big")), "$62.25");
  assert.match(text(chart.querySelector(".na-readout")), /Food \$50/);
});
