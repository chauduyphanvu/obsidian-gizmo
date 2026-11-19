import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { ROW_INDEX } from "../src/sources/list.ts";
import { checkPanel, describePermission, permissionsOf, readSpec, type Panel } from "../src/spec.ts";
import { editErrors, editPermissions } from "../src/views/common.ts";
import { fakeEnv, fakeHost } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12);
const APP = "Apps/W.md";
const DATA = "Apps/W data.md";
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const indexOf = (r: unknown) => (r as Record<symbol, unknown>)[ROW_INDEX];

function open(fm: Record<string, unknown>, notes: Record<string, { fm?: Record<string, unknown> }>) {
  const t = fakeEnv({ [APP]: { fm }, ...notes });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, APP, t.env).load();
  return { ...t, root };
}

const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));

test("a saved list's rows carry their place through where, sort and compute; the cache isn't touched", async () => {
  const chores = [{ task: "bins", done: true }, { task: "dishes", done: false }, { task: "plants", done: false }];
  const f = fakeHost({ [DATA]: { fm: { chores } } });
  const p = checkPanel({ view: "table", source: "chores", where: { done: false }, sort: "-task", compute: { loud: "upper(task)" } }, true).panel as Panel;
  const rows = await new DataLayer(f.host).panelData(p.source, p, { appPath: APP, dataPath: DATA }, { ttlMs: 0, now: NOW }) as Record<string, unknown>[];
  assert.deepEqual(rows, [{ task: "plants", done: false, loud: "PLANTS" }, { task: "dishes", done: false, loud: "DISHES" }]);
  assert.deepEqual(rows.map(indexOf), [2, 1]);
  assert.equal(Object.getOwnPropertySymbols(chores[0]).length, 0);
});

test("edit asks to change properties of the notes it reads; a saved list is the app's own", () => {
  const r = readSpec({
    app: "x",
    data: { books: { source: "notes", from: "Books", fields: { status: ["to read", "reading", "done"] } }, unread: { source: "books", where: { status: "to read" } } },
    panels: [
      { view: "table", source: "unread", columns: ["name", "status"], edit: ["status"] },
      { view: "table", source: "chores", edit: ["done"] },
    ],
  }, { path: APP })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, APP), ["edit:Books", "read:Books"]);
  assert.equal(describePermission("edit:Books"), "Change properties of notes in Books");
});

test("edit's checks see the chain: a column computed up the chain can't be edited", () => {
  const r = readSpec({
    app: "x",
    data: { log: { source: "sessions", compute: { hours: "minutes / 60" } }, recent: { source: "log", limit: 5 } },
    panels: [{ view: "table", source: "recent", edit: ["hours", "minutes"] }],
  })!;
  assert.deepEqual(r.errors, ['panel 1: edit: "hours" is computed']);
});

test("what a board needs to be editable: editErrors and editPermissions", () => {
  const board = { view: "board", source: "notes", from: "Projects", group: "status" } as Panel;
  assert.deepEqual(editErrors(board, ["status"]), []);
  assert.deepEqual(editErrors({ ...board, source: "https://api.example.com/x" }, ["status"]), ["edit works on notes and saved lists"]);
  assert.deepEqual(editErrors(board, ["tags"]), ['edit: "tags" comes from the note\'s file, not its properties']);
  assert.deepEqual(editPermissions(board, "group"), [["edit:Projects", "group"]]);
  assert.deepEqual(editPermissions({ ...board, source: "tasks_list" }, "group"), []);
});

test("editing a note's property writes its frontmatter; the table updates in place", async () => {
  const fm = {
    app: "Shelf",
    data: { books: { source: "notes", from: "Books", fields: { status: ["to read", "reading", "done"], rating: "number" } } },
    panels: [{ view: "table", source: "books", sort: "name", columns: ["name", "status", "rating", "owned"], edit: ["status", "rating", "owned"] }],
  };
  const { root, f, writes } = open(fm, {
    "Books/Dune.md": { fm: { status: "reading", rating: 4, owned: true } },
    "Books/Emma.md": { fm: { status: "abandoned", owned: false } },
  });
  await settle();
  const tbody = root.querySelector("tbody")!;
  const [dune, emma] = [...tbody.querySelectorAll("tr")];
  const status = dune.querySelector("select") as HTMLSelectElement;
  assert.deepEqual([...status.querySelectorAll("option")].map((o) => o.textContent), ["to read", "reading", "done"]);
  assert.equal(status.value, "1");
  // A value outside the choices is still shown as it is.
  assert.deepEqual([...emma.querySelectorAll("select option")].map((o) => o.textContent), ["abandoned", "to read", "reading", "done"]);
  const [rating, owned] = [...dune.querySelectorAll("input")] as HTMLInputElement[];
  assert.deepEqual([rating.type, rating.value, owned.type, owned.checked], ["number", "4", "checkbox", true]);

  for (const o of status.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "done");
  change(status);
  assert.equal(status.disabled, true);
  await settle();
  assert.equal(status.disabled, false);
  assert.deepEqual(writes, ["Books/Dune.md"]);
  assert.deepEqual(f.files.get("Books/Dune.md")!.fm, { status: "done", rating: 4, owned: true });
  assert.equal(root.querySelector("tbody"), tbody, "patched in place, not redrawn");
  assert.equal(status.value, "2");

  rating.value = "5";
  change(rating);
  owned.checked = false;
  change(owned);
  await settle();
  assert.deepEqual(f.files.get("Books/Dune.md")!.fm, { status: "done", rating: 5, owned: false });
});

test("a cell being typed in keeps its text and focus while another row's write comes back", async () => {
  const fm = { app: "Shelf", panels: [{ view: "table", source: "notes", from: "Books", sort: "name", columns: ["name", "note", "owned"], edit: ["note", "owned"] }] };
  const { root, f, changed } = open(fm, {
    "Books/Dune.md": { fm: { note: "sand", owned: false } },
    "Books/Emma.md": { fm: { note: "matchmaking", owned: false } },
  });
  await settle();
  const [dune, emma] = [...root.querySelectorAll("tbody tr")];
  const typing = emma.querySelector('input[type="text"]') as HTMLInputElement;
  typing.focus();
  typing.value = "matchmaking, half-typed";
  const box = dune.querySelector('input[type="checkbox"]') as HTMLInputElement;
  box.checked = true;
  change(box);
  await settle();
  assert.equal(f.files.get("Books/Dune.md")!.fm!.owned, true);
  assert.equal(root.querySelector("tbody tr:nth-child(2) input[type=text]"), typing);
  assert.equal(typing.value, "matchmaking, half-typed");
  assert.equal(document.activeElement, typing);
  assert.equal(box.checked, true);
  // A change to Emma's note from elsewhere doesn't overwrite what is being typed either.
  f.files.get("Books/Emma.md")!.fm = { note: "changed elsewhere", owned: true };
  changed("Books/Emma.md");
  await settle();
  assert.equal(typing.value, "matchmaking, half-typed");
  assert.equal((emma.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, true);
});

test("editing a saved list writes that row in the data note, found by its place", async () => {
  const fm = {
    app: "Chores",
    panels: [{ view: "table", source: "chores", where: { done: false }, columns: ["task", "done"], edit: ["done"] }],
  };
  const chores = [{ task: "bins", done: true, at: "2026-11-01T09:00" }, { task: "dishes", done: false, at: "2026-11-02T09:00" }, { task: "plants", done: false, at: "2026-11-03T09:00" }];
  const { root, f, notices } = open(fm, { [DATA]: { fm: { chores } } });
  await settle();
  const rows = [...root.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((r) => r.textContent), ["dishes", "plants"]);
  const plants = rows[1].querySelector("input") as HTMLInputElement;
  plants.checked = true;
  change(plants);
  await settle();
  assert.deepEqual(f.files.get(DATA)!.fm!.chores, [chores[0], chores[1], { ...chores[2], done: true }]);
  assert.deepEqual(chores[2].done, false, "the old list isn't changed in place");
  assert.deepEqual([...root.querySelectorAll("tbody tr")].map((r) => r.textContent), ["dishes"]);
  assert.deepEqual(notices, []);
});

test("a list row that changed since it was shown isn't written; the panel shows it as it is", async () => {
  const fm = { app: "Chores", panels: [{ view: "table", source: "chores", columns: ["task", "done"], edit: ["done"] }] };
  const { root, f, notices } = open(fm, { [DATA]: { fm: { chores: [{ task: "bins", done: false }, { task: "dishes", done: false }] } } });
  await settle();
  const box = root.querySelectorAll("tbody tr")[1].querySelector("input") as HTMLInputElement;
  // Someone else reorders the list without the app hearing of it yet.
  f.files.get(DATA)!.fm = { chores: [{ task: "dishes", done: false }, { task: "bins", done: false }] };
  box.checked = true;
  change(box);
  await settle();
  assert.deepEqual(notices, ["That row has changed; reload"]);
  assert.deepEqual(f.files.get(DATA)!.fm, { chores: [{ task: "dishes", done: false }, { task: "bins", done: false }] });
  assert.deepEqual([...root.querySelectorAll("tbody tr")].map((r) => [r.textContent, (r.querySelector("input") as HTMLInputElement).checked]),
    [["dishes", false], ["bins", false]]);
});

test("a list kept in the app note is copied to the data note when a row is edited", async () => {
  const fm = { app: "Chores", chores: [{ task: "bins", done: false }], panels: [{ view: "table", source: "chores", columns: ["task", "done"], edit: ["done"] }] };
  const { root, f } = open(fm, {});
  await settle();
  const box = root.querySelector("tbody input") as HTMLInputElement;
  box.checked = true;
  change(box);
  await settle();
  assert.deepEqual(f.files.get(DATA)!.fm, { chores: [{ task: "bins", done: true }] });
  assert.deepEqual(f.files.get(APP)!.fm!.chores, [{ task: "bins", done: false }]);
});

test("editing the selected row passes its new values to the panels that read it", async () => {
  const fm = {
    app: "Shelf",
    panels: [
      { view: "table", source: "notes", from: "Books", columns: ["name", "owned"], edit: ["owned"], select: "book" },
      { view: "text", text: "$book.name owned: $book.owned" },
    ],
  };
  const { root } = open(fm, { "Books/Dune.md": { fm: { owned: false } } });
  await settle();
  const tr = root.querySelector("tbody tr") as HTMLElement;
  tr.click();
  await settle();
  assert.equal(root.querySelector(".gz-text")!.textContent, "Dune owned: false");
  const box = tr.querySelector("input") as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new window.Event("click", { bubbles: true }));
  change(box);
  await settle();
  assert.ok(tr.classList.contains("gz-selected"), "clicking the box doesn't change the selection");
  assert.equal(root.querySelector(".gz-text")!.textContent, "Dune owned: true");
});

test("a note that has gone isn't brought back by an edit or a board move; the data note still is made when needed", async () => {
  const fm = {
    app: "Shelf",
    panels: [
      { view: "table", source: "notes", from: "Books", columns: ["name", "status"], edit: ["status"] },
      { view: "board", source: "notes", from: "Books", group: "status" },
    ],
  };
  const { root, f, writes, notices, env } = open(fm, { "Books/Dune.md": { fm: { status: "reading" } }, "Books/Emma.md": { fm: { status: "done" } } });
  await settle();
  // Deleted (or renamed) after it was drawn, before the vault said so.
  f.files.delete("Books/Dune.md");
  const input = root.querySelector("tbody tr input") as HTMLInputElement;
  input.value = "done";
  change(input);
  await settle();
  const move = root.querySelector(".gz-board-card select.gz-move") as HTMLSelectElement;
  for (const o of move.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "done");
  change(move);
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(f.files.has("Books/Dune.md"), false);
  assert.deepEqual(notices, ["That note is gone", "That note is gone"]);
  // The app's own data note is created on its first save, as before.
  await env.writeFrontmatter(DATA, (data) => { data.log = [1]; });
  assert.deepEqual(f.files.get(DATA)!.fm, { log: [1] });
  assert.equal(await env.updateFrontmatter("Books/Gone.md", (data) => { data.x = 1; }), false);
  assert.equal(f.files.has("Books/Gone.md"), false);
});
