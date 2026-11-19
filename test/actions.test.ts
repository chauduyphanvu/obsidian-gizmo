import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyOf, fileName, fillRow, runActions, type ActionDeps } from "../src/actions.ts";
import { AppController } from "../src/app.ts";
import { askersOf, checkPanel, describePermission, permissionsOf, readSpec, type Panel } from "../src/spec.ts";
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
    "panel 8: save needs a folder before the /, e.g. save: Books/",
    "panel 9: form needs fields",
  ]);
  const targets = r.spec!.panels.map((ps) => ps.panel.target);
  assert.deepEqual(targets, [
    { kind: "list", name: "doses" },
    { kind: "folder", folder: "Ideas" },
    { kind: "list", name: "weights_log" },
    { kind: "folder", folder: "Books" },
    { kind: "list", name: "web" },
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
