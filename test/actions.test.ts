import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyOf, fileName, fillBody, fillRow, runActions, type ActionDeps } from "../src/actions.ts";
import { AppController } from "../src/app.ts";
import { askersOf, checkPanel, describePermission, permissionsOf, readSpec, resolvePanel, type Panel } from "../src/spec.ts";
import { fakeEnv } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12, 0);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

/** Deps over an in-memory vault, logging every call in order. */
function deps(existing: Record<string, string> = {}) {
  const log: string[] = [];
  const data: Record<string, unknown> = {};
  const notes = new Map<string, { fm: Record<string, unknown>; body: string }>();
  const d: ActionDeps = {
    now: () => NOW,
    dataPath: "Apps/X data.md",
    appPath: "Apps/X.md",
    writeFrontmatter: async (path, fn) => { log.push(`write ${path}`); fn(data); },
    appendLine: async (path, line) => { log.push(`append ${path}: ${line}`); },
    createNote: async (path, fm, body) => {
      if (notes.has(path) || path in existing) return false;
      log.push(`create ${path}`);
      notes.set(path, { fm, body });
      return true;
    },
    readBody: async (path) => {
      log.push(`read ${path}`);
      return "Notes on {title} by {author}.\n";
    },
    notify: (m) => { log.push(`notify ${m}`); },
    openNote: (path, from) => { log.push(`open ${path} from ${from}`); },
  };
  return { d, log, data, notes };
}

const panel = (raw: Record<string, unknown>): Panel => {
  const r = checkPanel(raw, true);
  assert.deepEqual(r.errors, []);
  return r.panel!;
};

test("append, save to a list, notify: in that order, as before", async () => {
  const { d, log, data } = deps();
  const p = panel({ view: "form", fields: { weight: "number" }, save: "weights", append: "Daily", notify: "Logged {weight} at {time}" });
  assert.deepEqual(await runActions(p, { weight: 80 }, d), { ok: true, path: undefined });
  assert.deepEqual(log, ["append Daily.md: - 2026-11-18 12:00 weight: 80", "write Apps/X data.md", "notify Logged 80 at 12:00"]);
  assert.deepEqual(data, { weights: [{ weight: 80, at: "2026-11-18T12:00" }] });

  const failing = deps();
  failing.d.writeFrontmatter = async () => { throw new Error("disk full"); };
  assert.deepEqual(await runActions(p, { weight: 80 }, failing.d), { ok: false });
  assert.deepEqual(failing.log.at(-1), "notify Couldn't save: disk full");
});

test("row: shapes what is saved; one whole placeholder keeps the value's type", async () => {
  const doc = { title: "Dune", author_name: ["Frank Herbert", "x"], first_publish_year: 1965, subject: ["sf"] };
  assert.deepEqual(fillRow({ title: "{title}", author: "{author_name.0}", year: "{first_publish_year}", tags: "{subject}", label: "{title} by {author_name.0}", gone: "{nope}" }, doc), {
    title: "Dune", author: "Frank Herbert", year: 1965, tags: ["sf"], label: "Dune by Frank Herbert", gone: null,
  });
  const { d, data, log } = deps();
  const p = panel({ view: "list", source: "s", action: "Keep", save: "picks", row: { title: "{title}", year: "{first_publish_year}", on: "{date}" }, notify: "Kept {title}" });
  await runActions(p, doc, d);
  assert.deepEqual(data, { picks: [{ title: "Dune", year: 1965, on: "2026-11-18", at: "2026-11-18T12:00" }] });
  assert.equal(log.at(-1), "notify Kept Dune");
});

test("row: a value that is exactly one $reference keeps the referenced value's type", async () => {
  const r = readSpec({
    app: "x",
    inputs: { n: [3, 4] },
    panels: [
      { view: "table", source: "a", select: "tx", columns: ["x"] },
      {
        view: "form", fields: { why: "text" }, save: "flagged",
        row: { amount: "$tx.Amount", paid: "$tx.paid", who: "$tx.Who", id: "$tx.id", text: "$tx.Amount units", count: "$n", literal: 5, why: "{why}" },
      },
      { view: "form", fields: { why: "text" }, save: "flagged", row: { amount: "$tx.Amount" } },
    ],
  })!;
  assert.deepEqual(r.errors, []);
  const form = r.spec!.panels[1];
  const tx = { Amount: -489.99, paid: false, Who: "Apple", id: "7" };
  const p = resolvePanel(form, { tx, n: 3 }).panel!;
  assert.deepEqual(p.row, { amount: -489.99, paid: false, who: "Apple", id: "7", text: "-489.99 units", count: 3, literal: "5", why: "{why}" });
  const { d, data } = deps();
  await runActions(p, { why: "too much" }, d);
  assert.deepEqual(data, { flagged: [{ amount: -489.99, paid: false, who: "Apple", id: "7", text: "-489.99 units", count: 3, literal: "5", why: "too much", at: "2026-11-18T12:00" }] });

  // A row or a list where one value is expected is still the error it was.
  const only = r.spec!.panels[2];
  assert.deepEqual(resolvePanel(only, { tx: { Amount: [1, 2] } }).errors, ['"row" has the wrong type (expected a set of name: text)']);
  assert.deepEqual(resolvePanel(only, { tx: { Amount: { a: 1 } } }).errors, ['"row" has the wrong type (expected a set of name: text)']);
});

test("save to a folder creates a note named from the row, never over an existing one", async () => {
  const doc = { title: "Dune: Messiah?", author_name: ["Frank Herbert"], first_publish_year: 1969 };
  const p = panel({
    view: "list", source: "s", action: "Add", save: "Books/", name: "{title}",
    row: { title: "{title}", author: "{author_name.0}", year: "{first_publish_year}" },
    template: "[[Book template]]", notify: "Added {path}", open: "{path}",
  });
  const { d, log, notes } = deps();
  assert.deepEqual(await runActions(p, doc, d), { ok: true, path: "Books/Dune Messiah.md" });
  assert.deepEqual(log, ["read [[Book template]]", "create Books/Dune Messiah.md", "notify Added Books/Dune Messiah.md", "open Books/Dune Messiah.md from Apps/X.md"]);
  assert.deepEqual(notes.get("Books/Dune Messiah.md"), {
    fm: { title: "Dune: Messiah?", author: "Frank Herbert", year: 1969, at: "2026-11-18T12:00" },
    body: "Notes on Dune: Messiah? by Frank Herbert.\n",
  });

  const again = await runActions(p, doc, d);
  assert.deepEqual(again, { ok: false });
  assert.deepEqual(log.slice(4), ["read [[Book template]]", "notify “Dune Messiah” already exists"]);
});

test("a template note's {{placeholders}} read like {placeholders}; other templates keep their braces", async () => {
  assert.equal(fillBody("# {{title}} ({{ year }})\n{author} {{nope}}|{{{title}}}", { title: "Dune", year: 1965, author: "Herbert" }), "# Dune (1965)\nHerbert |{Dune}");
  const { d, notes, log } = deps();
  d.readBody = async () => "# {{title}}\nby {{author_name.0}}\n";
  const p = panel({ view: "list", source: "s", action: "Add", save: "Books/", name: "{title}", template: "[[Book template]]", notify: "Added {{title}}" });
  await runActions(p, { title: "Dune", author_name: ["Frank Herbert"] }, d);
  assert.equal(notes.get("Books/Dune.md")!.body, "# Dune\nby Frank Herbert\n");
  assert.equal(log.at(-1), "notify Added {Dune}");
});

test("a note's name: name:, else the row's name (then not kept as a property), its title, or the time", async () => {
  const save = async (raw: Record<string, unknown>, row: Record<string, unknown>) => {
    const { d, notes } = deps();
    const r = await runActions(panel({ view: "form", fields: { x: "text" }, save: "Ideas/", ...raw }), row, d);
    return [r.path, r.path && notes.get(r.path)!.fm];
  };
  assert.deepEqual(await save({}, { name: "Tea [2]", note: "green" }), ["Ideas/Tea 2.md", { note: "green", at: "2026-11-18T12:00" }]);
  assert.deepEqual(await save({}, { title: "#1 idea", note: "x" }), ["Ideas/1 idea.md", { title: "#1 idea", note: "x", at: "2026-11-18T12:00" }]);
  assert.deepEqual(await save({}, { note: "x" }), ["Ideas/2026-11-18 12.00.md", { note: "x", at: "2026-11-18T12:00" }]);
  assert.deepEqual(await save({ name: "{note}" }, { note: "///" }), ["Ideas/2026-11-18 12.00.md", { note: "///", at: "2026-11-18T12:00" }]);
  assert.deepEqual(await save({ name: "../{note}" }, { note: "up" }), ["Ideas/up.md", { note: "up", at: "2026-11-18T12:00" }]);
  assert.equal(fileName(' a\\b/c:d*e?f"g<h>i|j#k^l[m]n '), "a b c d e f g h i j k l m n");
});

test("open alone is an action; on a notes row {path} is that note", async () => {
  const { d, log } = deps();
  await runActions(panel({ view: "button", label: "Today", open: "Daily/{date}" }), {}, d);
  await runActions(panel({ view: "table", source: "notes", from: "Inbox", action: "Open", open: "{path}" }), { name: "Idea", path: "Inbox/Idea.md" }, d);
  assert.deepEqual(log, ["open Daily/2026-11-18 from Apps/X.md", "open Inbox/Idea.md from Apps/X.md"]);
});

test("a template's body is the text after its frontmatter", () => {
  assert.equal(bodyOf("---\ntags: [x]\n---\n# {title}\n"), "# {title}\n");
  assert.equal(bodyOf("---\n---\nbody"), "body");
  assert.equal(bodyOf("no frontmatter\n---\n"), "no frontmatter\n---\n");
  assert.equal(bodyOf("---\r\na: 1\r\n---\r\nwindows"), "windows");
});

test("save is settled from the keys: a list, a folder, or what the block it names reads", () => {
  const r = readSpec({
    app: "x",
    data: {
      log: { source: "weights_log", sort: "-at" },
      recent: { source: "log", limit: 5 },
      books: { source: "notes", from: "Books/", fields: { title: "text", status: ["to read", "done"] } },
      tagged: { source: "notes", from: "#book" },
      several: { source: "notes", from: "Books, Archive" },
      web: { source: "https://api.example.com/x" },
    },
    panels: [
      { view: "button", save: "doses" },
      { view: "button", save: "Ideas/" },
      { view: "button", save: "recent" },
      { view: "form", save: "books", name: "{title}", template: "Templates/Book" },
      { view: "button", save: "tagged" },
      { view: "button", save: "several" },
      { view: "button", save: "web" },
      { view: "button", save: "/" },
      { view: "form", save: "log" },
      { view: "checklist", items: ["a"], save: "books" },
    ],
  }, { path: "Apps/X.md" })!;
  assert.deepEqual(r.errors, [
    'panel 5: save: "tagged" reads #book; name a folder to save notes into',
    'panel 6: save: "several" reads Books, Archive; name a folder to save notes into',
    'panel 7: save: "web" reads a web address; name a list or a folder',
    "panel 8: save needs a folder before the /, e.g. save: Books/",
    "panel 9: form needs fields",
  ]);
  const targets = r.spec!.panels.map((ps) => ps.panel.target);
  assert.deepEqual(targets, [
    { kind: "list", name: "doses" },
    { kind: "folder", folder: "Ideas" },
    { kind: "list", name: "weights_log" },
    { kind: "folder", folder: "Books" },
    undefined,
  ]);
  // The form takes the fields of the block it saves to.
  assert.deepEqual(r.spec!.panels[3].panel.schema, { title: "text", status: ["to read", "done"] });
  assert.deepEqual(permissionsOf(r.spec!, "Apps/X.md"), ["create:Books", "create:Ideas", "read:Templates/Book.md"]);
  assert.deepEqual([...askersOf(r.spec!, "Apps/X.md").get("read:Templates/Book.md")!], ["Apps/X.md"]);
  assert.deepEqual(["create:Books", "read:Templates/Book.md", "read:Books", "read:#book"].map(describePermission),
    ["Create notes in Books", "Read Templates/Book.md", "Read notes in Books", "Read notes in #book"]);
});

test("a component's save to a folder asks in the component's name", () => {
  const notes: Record<string, Record<string, unknown>> = {
    "Components/Saver.md": { component: "s", params: ["into"], panels: [{ view: "button", label: "New", save: "$into" }] },
  };
  const reader = { resolve: (l: string) => Object.keys(notes).find((p) => p.endsWith(`/${l}.md`)), frontmatter: (p: string) => notes[p] };
  const r = readSpec({ app: "x", panels: [{ use: "[[Saver]]", with: { into: "Ideas/" } }] }, { notes: reader, path: "Apps/X.md" })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels[0].panel.target, { kind: "folder", folder: "Ideas" });
  assert.deepEqual([...askersOf(r.spec!, "Apps/X.md").get("create:Ideas")!], ["Components/Saver.md"]);
});

test("a row's Add button saves it as a note, and a notes panel on that folder shows it", async () => {
  const fm = {
    app: "Shelf",
    data: { found: { source: "found" } },
    panels: [
      {
        view: "list", title: "Found", source: "found", item: "{title}", action: "Add", save: "Books/", name: "{title}",
        row: { title: "{title}", author: "{author}" }, notify: "Added {title}",
      },
      { view: "table", title: "Books", source: "notes", from: "Books", columns: ["name", "author"] },
    ],
  };
  const { env, notices, f } = fakeEnv({
    "Apps/W.md": { fm },
    "Apps/W data.md": { fm: { found: [{ title: "Dune", author: "Herbert", key: "/w/1" }, { title: "Emma", author: "Austen", key: "/w/2" }] } },
    "Books/Middlemarch.md": { fm: { author: "Eliot" } },
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/W.md", env).load();
  await settle();
  const buttons = [...root.querySelectorAll("button.na-row-action")] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((b) => b.textContent), ["Add", "Add"]);
  buttons[1].click();
  assert.equal(buttons[1].disabled, true);
  await settle();
  assert.equal(buttons[1].disabled, false);
  assert.deepEqual(f.files.get("Books/Emma.md"), { fm: { title: "Emma", author: "Austen", at: "2026-11-18T12:00" }, body: "" });
  assert.deepEqual(notices, ["Added Emma"]);
  assert.deepEqual([...root.querySelectorAll(".na-view-table tbody tr")].map((tr) => text(tr)), ["MiddlemarchEliot", "EmmaAusten"]);
  buttons[1].click();
  await settle();
  assert.deepEqual(notices, ["Added Emma", "“Emma” already exists"]);
});

test("save can't name a block that reads a base, tasks, a file or the note itself: nothing would show what it saved", () => {
  const read = (block: Record<string, unknown>) => readSpec({
    app: "S", data: { shelf: { ...block, fields: { title: "text" } } },
    panels: [{ view: "form", save: "shelf" }, { view: "table", source: "shelf" }],
  }, { path: "Apps/S.md" })!;
  const cases: [Record<string, unknown>, string][] = [
    [{ source: "https://api.example.com/x" }, "a web address"],
    [{ source: "[[Books.base]]" }, "a base"],
    [{ source: "tasks", from: "Tasks" }, "tasks"],
    [{ source: "Finance/bank.csv" }, "a file"],
    [{ source: "[[family.ics]]" }, "a file"],
    [{ source: "this" }, "the note itself"],
  ];
  for (const [block, what] of cases) {
    const r = read(block);
    assert.deepEqual(r.errors, [`panel 1: save: "shelf" reads ${what}; name a list or a folder`], JSON.stringify(block));
    assert.equal(r.spec!.panels.length, 1, "the form isn't drawn");
  }
  // A block over a list, or a folder of notes, is where saving goes, as before.
  assert.deepEqual(read({ source: "books" }).errors, []);
  assert.deepEqual(read({ source: "notes", from: "Books" }).errors, []);
});

test("row: a value that is exactly one param keeps the param's type, as a whole $reference does", async () => {
  const notes: Record<string, Record<string, unknown>> = {
    "Components/Tally.md": { component: "Tally", params: ["n", "paid", "who"], panels: [
      { view: "button", label: "Add", save: "tally", row: { count: "$n", paid: "$paid", who: "$who", text: "$n items", literal: 5 } },
    ] },
  };
  const reader = { resolve: (l: string) => Object.keys(notes).find((p) => p.endsWith(`/${l}.md`)), frontmatter: (p: string) => notes[p] };
  const r = readSpec({ app: "x", inputs: { k: [7, 8] }, panels: [
    { use: "[[Tally]]", with: { n: 5, paid: false, who: "Ann" } },
    { use: "[[Tally]]", with: { n: "$k", paid: true, who: "Bo" } },
    { use: "[[Tally]]", with: { n: 1, paid: true, who: "Cy" }, row: { count: "$k", note: "x" } },
  ] }, { notes: reader, path: "Apps/X.md" })!;
  assert.deepEqual(r.errors, []);
  const [fixed, passed, beside] = r.spec!.panels;
  assert.deepEqual(fixed.panel.row, { count: 5, paid: false, who: "Ann", text: "5 items", literal: "5" });
  assert.deepEqual(resolvePanel(passed, { k: 8 }).panel!.row, { count: 8, paid: true, who: "Bo", text: "8 items", literal: "5" });
  assert.deepEqual(resolvePanel(beside, { k: 7 }).panel!.row, { count: 7, note: "x" });
  const { d, data } = deps();
  await runActions(fixed.panel, {}, d);
  assert.deepEqual(data, { tally: [{ count: 5, paid: false, who: "Ann", text: "5 items", literal: "5", at: "2026-11-18T12:00" }] });
});
