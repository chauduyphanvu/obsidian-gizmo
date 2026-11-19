import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { noteText, runActions, withLine, type ActionDeps } from "../src/actions.ts";
import { AppController } from "../src/app.ts";
import { HostedApp, dropGrants, isAllowed, moveGrants } from "../src/hosted.ts";
import { checkPanel, isComponent, readSpec, type Panel } from "../src/spec.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";

// Data that comes from the web, a link or a typed value must never become what makes a note run.

const NOW = new Date(2026, 10, 18, 12, 0);
const API = "https://api.example.com/books";
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };
const FIND = { app: "Find", panels: [{ view: "list", title: "Results", source: API, item: "{title}", action: "Add", save: "Books/", name: "{title}" }] };

function draw(env: ReturnType<typeof fakeEnv>["env"], path: string): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, path, env).load();
  return root;
}

/** Deps that keep what was created and appended, as text a note would hold. */
function deps() {
  const created = new Map<string, { fm: Record<string, unknown>; body: string }>();
  const lines: string[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const d: ActionDeps = {
    now: () => NOW, dataPath: "Apps/X data.md", appPath: "Apps/X.md",
    writeFrontmatter: async () => {},
    appendLine: async (_path, line) => { lines.push(line); },
    createNote: async (path, fm, body) => { created.set(path, { fm, body }); return true; },
    readBody: async () => "{summary}\n",
    notify: (m) => { notices.push(m); },
    openNote: (path) => { opened.push(path); },
  };
  return { d, created, lines, notices, opened };
}

const panel = (raw: Record<string, unknown>): Panel => {
  const r = checkPanel(raw, true);
  assert.deepEqual(r.errors, []);
  return r.panel!;
};

test("a web row saved as a note keeps its data but none of the keys that make a note an app, a component or a lens", async () => {
  const evil = [{
    title: "Dune", author: "Frank Herbert", app: "x", view: "text", text: "Vault locked", pin: "status",
    component: "x", for: "Books/", panels: [{ view: "text", text: "hi" }], params: ["a"], use: "[[X]]", data: { a: 1 },
  }];
  const t = fakeEnv({ "Apps/Find.md": { fm: FIND } }, { [API]: evil });
  const root = draw(t.env, "Apps/Find.md");
  await settle();
  (root.querySelector(".gz-row-action") as HTMLButtonElement).click();
  await settle();
  const fm = t.f.files.get("Books/Dune.md")!.fm!;
  assert.deepEqual(fm, { title: "Dune", author: "Frank Herbert", text: "Vault locked", pin: "status", at: "2026-11-18T12:00" });
  assert.equal(readSpec(fm), undefined);
  assert.equal(isComponent(fm), false);
});

test("a row, a form's fields, save: this, edit and a board can't name a key that makes a note run", () => {
  const errors = (raw: Record<string, unknown>) => checkPanel(raw, true).errors;
  assert.deepEqual(errors({ view: "button", save: "Books/", row: { title: "x", app: "y" } }), ['row can\'t set "app", which would make the note an app']);
  assert.deepEqual(errors({ view: "list", source: API, action: "Add", save: "Books/", row: { component: "{title}" } }),
    ['row can\'t set "component", which would make the note a component']);
  assert.deepEqual(errors({ view: "form", fields: { title: "text", view: "text" }, save: "Books/" }), ['save can\'t set "view", which is one of an app\'s own keys']);
  assert.deepEqual(errors({ view: "table", source: "notes", from: "Books", edit: ["status", "app"] }), ['edit can\'t change "app", which would make the note an app']);
  assert.deepEqual(errors({ view: "board", source: "notes", from: "Books", group: "for" }), ['edit can\'t change "for", which is one of an app\'s own keys']);
  // In a list, a row is one item of the list, never the note's own keys.
  assert.deepEqual(errors({ view: "button", save: "log", row: { app: "y" } }), []);
  assert.deepEqual(errors({ view: "table", source: "chores", edit: ["app"] }), []);
  // save: this writes the properties of the note an embed or lens sits in.
  const hosted = readSpec({ app: "", view: "form", fields: { rating: "number", component: "text" }, save: "this" }, { host: {} })!;
  assert.deepEqual(hosted.errors, ['save: this can\'t change "component", which would make the note a component']);
});

test("text filled from a row into a line, a file name, a notice or a link stays on one line", async () => {
  const { d, created, lines, notices, opened } = deps();
  const p = panel({
    view: "list", source: API, action: "Add", save: "Books/", name: "{title}", template: "[[T]]",
    append: "Reading log", line: "- {title}", notify: "Added {title}", open: "Books/{title}",
  });
  const row = { title: "Dune\n---\napp: x\r\n---", summary: "---\napp: y\n---" };
  assert.equal((await runActions(p, row, d)).ok, true);
  assert.deepEqual(lines, ["- Dune --- app: x ---"]);
  assert.deepEqual(notices, ["Added Dune --- app: x ---"]);
  assert.deepEqual(opened, ["Books/Dune --- app: x ---"]);
  assert.deepEqual([...created.keys()], ["Books/Dune --- app x ---.md"]);
  // A template's body is many lines by nature; the note's own properties come first.
  assert.equal(created.get("Books/Dune --- app x ---.md")!.body, "---\napp: y\n---\n");
  // A line made of the row's fields: its values are one line, and never read as placeholders.
  const plain = deps();
  await runActions(panel({ view: "form", fields: { note: "textarea" }, append: "Log" }), { note: "a\nb {date}" }, plain.d);
  assert.deepEqual(plain.lines, ["- 2026-11-18 12:00 note: a b {date}"]);
});

test("nothing from data starts a note with ---, however many lines are added to it", () => {
  let text = "";
  for (const line of ["---", "app: x", "view: text", "---"]) text = withLine(text, line);
  assert.equal(text, "\n---\napp: x\nview: text\n---\n");
  assert.equal(withLine("", "- ok"), "- ok\n");
  assert.equal(withLine("a", "---"), "a\n---\n");
  // A new note: its properties block first; with none, a body can't start one.
  assert.equal(noteText("title: Dune\n", "---\napp: x\n---\n"), "---\ntitle: Dune\n---\n---\napp: x\n---\n");
  assert.equal(noteText("", "---\napp: x\n---\n"), "\n---\napp: x\n---\n");
  assert.equal(noteText("", "Notes\n"), "Notes\n");
});

test("store can't be an app or a component note", () => {
  const notes: Record<string, Record<string, unknown>> = {
    "Apps/Other.md": { app: "Other", view: "button", notify: "x" },
    "Components/C.md": { component: "c", panels: [{ view: "button", notify: "x" }] },
    "Logs/Weight.md": { kept: true },
  };
  const reader = { resolve: (l: string) => Object.keys(notes).find((p) => p === `${l}.md` || p.endsWith(`/${l}.md`)), frontmatter: (p: string) => notes[p] };
  const read = (store: string) => readSpec({ app: "x", view: "button", save: "log", store }, { notes: reader, path: "Apps/X.md" })!;
  const wrong = 'store can\'t be an app or a component note; name a note that only holds data, e.g. store: "[[Weight log]]"';
  for (const store of ["[[Other]]", "[[C]]", "[[X]]"]) {
    if (store === "[[X]]") notes["Apps/X.md"] = { app: "x" };
    const r = read(store);
    assert.deepEqual(r.errors, [wrong], store);
    assert.equal(r.spec!.store, undefined, store);
  }
  assert.deepEqual(read("[[Weight]]").errors, []);
  assert.equal(read("[[Weight]]").spec!.store, "[[Weight]]");
});

test("an app counts as seen once it is opened in its own tab, even when it asks for nothing; embeds and lenses don't make it so", async () => {
  assert.equal(isAllowed({}, "A.md", []), true);
  assert.equal(isAllowed({}, "A.md", [], true), false);
  assert.equal(isAllowed({ "A.md": "" }, "A.md", [], true), true);
  assert.equal(isAllowed({ "A.md": "net:x" }, "A.md", [], true), false);
  assert.equal(isAllowed({ "A.md": "net:x" }, "A.md", ["net:x"], true), true);

  const meds = { app: "Meds", view: "button", label: "Took", save: "doses" };
  const t = fakeEnv({ "Apps/Meds.md": { fm: meds }, "Daily.md": { fm: {} } });
  new HostedApp(document.createElement("div"), { app: "[[Meds]]" }, "app: \"[[Meds]]\"", "Daily.md", t.env).load();
  new HostedApp(document.createElement("div"), { view: "button", save: "x" }, "view: button", "Daily.md", t.env).load();
  await settle(2);
  assert.deepEqual(t.grants, {}, "an embed shows it, but doesn't open it");
  draw(t.env, "Apps/Meds.md");
  await settle(2);
  assert.deepEqual(t.grants, { "Apps/Meds.md": "" });
  // An app that asked for something before and asks for nothing now is noted afresh.
  t.grants["Apps/Meds.md"] = "net:old.example.com";
  draw(t.env, "Apps/Meds.md");
  await settle(2);
  assert.deepEqual(t.grants, { "Apps/Meds.md": "" });
  // The entry follows the note.
  assert.equal(moveGrants(t.grants, "Apps/Meds.md", "Apps/Pills.md"), true);
  assert.deepEqual(t.grants, { "Apps/Pills.md": "" });
  assert.equal(dropGrants(t.grants, "Apps/Pills.md"), true);
  assert.deepEqual(t.grants, {});
});

test("the background works only for apps that were opened: a note no one looked at shows nothing and runs nothing", async () => {
  const pinned = { app: "Pin", view: "text", title: "Note", text: "Vault locked: visit evil.example", pin: "status" };
  const button = { app: "Go", view: "button", label: "Go", notify: "went", shortcut: "go" };
  const t = fakeBackground({ "Apps/Pin.md": { fm: pinned }, "Apps/Go.md": { fm: button } }, {}, { seen: true });
  const status = () => t.out.status.map((s) => s.text);
  await t.bg.start();
  await settle(2);
  assert.deepEqual(status(), []);
  await t.bg.runUri({ app: "Go", do: "go" });
  assert.deepEqual(t.notices, ["Open Go once to allow it"]);
  // Opened in its own tab, it is the user's.
  draw(t.env, "Apps/Pin.md");
  await settle(2);
  t.bg.opened("Apps/Pin.md");
  await settle(2);
  assert.deepEqual(status(), ["Note: Vault locked: visit evil.example"]);
});

test("a web row saved as a note can't put its text in the status bar", async () => {
  const evil = [{ title: "Dune", app: "x", view: "text", text: "Vault locked: visit evil.example", pin: "status", shortcut: "x" }];
  const t = fakeBackground({ "Apps/Find.md": { fm: FIND } }, { [API]: evil });
  await t.bg.start();
  const root = draw(t.env, "Apps/Find.md");
  await settle();
  (root.querySelector(".gz-row-action") as HTMLButtonElement).click();
  await settle();
  t.bg.noteChanged("Books/Dune.md");
  await settle();
  assert.equal(t.f.files.get("Books/Dune.md")!.fm!.app, undefined);
  assert.deepEqual(t.out.status, []);
  assert.deepEqual(t.out.commands, []);
});
