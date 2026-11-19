import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { permissionsOf, readSpec } from "../src/spec.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";
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

const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const KP_READINGS = [
  { time_tag: "2026-11-18T10:58:00", kp_index: 4, estimated_kp: 4.33, kp: "4P" },
  { time_tag: "2026-11-18T10:59:00", kp_index: 5, estimated_kp: 5.33, kp: "5P" },
];

/** The background service on these vault notes, started; `open` draws an app as its tab would. */
async function background(paths: string[]) {
  const t = fakeBackground(Object.fromEntries(paths.map((p) => [p, { fm: vaultNote(p).fm }])), { [KP]: KP_READINGS });
  t.env.opened = (path) => t.bg.opened(path);
  t.env.alerts = t.bg.alerts;
  await t.bg.start();
  const open = async (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    new AppController(root, path, t.env).load();
    await settle();
    return root;
  };
  return { ...t, open };
}

test("Space weather: Kp now, told when a storm is likely, an hourly record of my own, and my sightings", async () => {
  const path = "Apps/Space weather.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:services.swpc.noaa.gov"]);

  // With the app closed: a sample recorded, the storm told once, the value in the status bar.
  const t = await background([path]);
  const data = () => t.f.files.get("Apps/Space weather data.md")!.fm!;
  assert.deepEqual(data().kp_log, [{ at: "2026-11-18T12:00", time_tag: "2026-11-18T10:59:00", kp_index: 5, estimated_kp: 5.33, kp: "5P" }]);
  assert.deepEqual(t.notices, ["Space weather: Kp now 5.33"]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Kp now: 5.33", title: "Space weather" }]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:saw-aurora`, name: "Space weather: Saw aurora" }]);

  const root = await t.open(path);
  assert.equal(root.querySelector(".na-error"), null);
  const [now, , record, sightings] = [...root.querySelectorAll(".na-panel")];
  assert.equal(text(now.querySelector(".na-big")), "5.33");
  assert.equal(text(record.querySelector(".na-title")), "My Kp record");
  assert.ok(record.querySelector(".na-chart-svg"));
  (root.querySelector("button.na-button") as HTMLButtonElement).click();
  await settle();
  assert.equal(text(sightings.querySelector(".na-list")), "2026-11-18T12:00");
  // From a hotkey or a link, without opening the app.
  t.advance(90 * 60_000);
  await t.bg.runUri({ app: "Space weather", do: "saw-aurora" });
  await t.bg.tick();
  await settle();
  assert.deepEqual((data().sightings as { at: string }[]).map((s) => s.at), ["2026-11-18T12:00", "2026-11-18T13:30"]);
  assert.equal((data().kp_log as unknown[]).length, 2);
  assert.deepEqual(t.notices.slice(1), ["Sighting saved", "Sighting saved"]);
});

test("Meds: took meds from a hotkey or a link, and today's doses in the status bar", async () => {
  const path = "Apps/Meds.md";
  assert.deepEqual(readSpec(vaultNote(path).fm, { path })!.errors, []);
  const t = await background([path]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:took-meds`, name: "Meds: Took meds" }]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Doses today: 0", title: "Meds" }]);
  await t.bg.runCommand(`${path}:took-meds`);
  await t.bg.runUri({ app: "Meds", do: "took-meds" });
  await settle();
  assert.equal((t.f.files.get("Apps/Meds data.md")!.fm!.doses as unknown[]).length, 2);
  assert.equal(t.writes.filter((w) => w === "Daily.md").length, 2);
  assert.deepEqual(t.notices, ["Logged", "Logged"]);
  assert.equal(t.out.status[0].text, "Doses today: 2");
});

test("Attention: what needs my attention across my apps, and the day's to-dos", async () => {
  const path = "Apps/Attention.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), []);
  const t = await background([path, "Apps/Space weather.md"]);
  const root = await t.open(path);
  const items = [...root.querySelectorAll(".na-alerts li")];
  assert.deepEqual(items.map((li) => [...li.children].map((c) => text(c))), [["Space weather", "Kp now", "5.33"]]);
  const box = root.querySelector(".na-checklist input") as HTMLInputElement;
  box.dispatchEvent(new window.Event("change"));
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Attention data.md")!.fm!.done_today, ["Take meds"]);
  assert.match(text(root.querySelector(".na-view-checklist .na-title")), /1\/4/);
});
