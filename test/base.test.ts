import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { baseTarget, compileBase, type BaseNote } from "../src/sources/base.ts";
import { sourceDef } from "../src/sources/registry.ts";
import { checkPanel, readSpec, type Panel } from "../src/spec.ts";
import { describePermission, editPermissions, permissionsOf } from "../src/permissions.ts";
import { editErrors } from "../src/edit.ts";
import { fakeEnv, fakeHost } from "./support/fakes.ts";
import { parseYaml } from "./support/yaml.ts";

const NOW = new Date(2026, 10, 18, 12);
const FILES = { appPath: "Apps/S.md", dataPath: "Apps/S data.md" };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const SRC = "[[Books.base]]";

const note = (path: string, props: Record<string, unknown> = {}, tags: string[] = []): BaseNote => ({ path, props, tags });

/** The paths of the notes a base's YAML text matches. */
function matching(yaml: string, notes: BaseNote[]): string[] {
  const keep = compileBase(parseYaml(yaml), SRC);
  return notes.filter(keep).map((n) => n.path);
}

/** The paths one filter string matches. */
const where = (leaf: string, notes: BaseNote[]) => notes.filter(compileBase({ filters: leaf }, SRC)).map((n) => n.path);

/** Why one filter string can't be read. */
const why = (filters: unknown) => {
  try {
    compileBase({ filters }, SRC);
  } catch (e) {
    return (e as Error).message;
  }
  return "read fine";
};

test("a base is a [[link]] or a path ending in .base", () => {
  assert.equal(baseTarget("[[Books.base]]"), "Books.base");
  assert.equal(baseTarget("[[Bases/Books.base|my books]]"), "Bases/Books.base");
  assert.equal(baseTarget("Bases/Books.base"), "Bases/Books.base");
  assert.equal(baseTarget("[[Books]]"), undefined);
  assert.equal(baseTarget("books"), undefined);
  assert.equal(sourceDef("[[Books.base]]").id, "base");
  assert.equal(sourceDef("Bases/Books.base").id, "base");
  assert.equal(sourceDef("https://example.com/Books.base").id, "url");
  assert.equal(sourceDef("bases").id, "list");
});

// The example at the top of https://obsidian.md/help/bases/syntax, as published.
const DOCS_EXAMPLE = `
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
`;

const SHELF = [
  note("Textbooks/Calculus.md", { price: 3 }, ["#book"]),
  note("Required Reading/Odyssey.md", { price: 1 }),
  note("Inbox/Idea.md", {}, ["#tag/sub"]),
  note("Inbox/Plain.md"),
];

test("the docs' example base: its file.hasLink is named, then its view's filters; without both, its and/or/not filters are read", () => {
  assert.throws(() => compileBase(parseYaml(DOCS_EXAMPLE), SRC), { message: "[[Books.base]] uses file.hasLink, which Gizmo can't read" });
  const without = DOCS_EXAMPLE.replace('        - file.hasLink("Textbook")\n', "");
  // A view's own filters narrow what the base shows there; read as every note, they would let an edit reach any note.
  assert.throws(() => compileBase(parseYaml(without), SRC), { message: '[[Books.base]] filters its view "My table"; Gizmo reads only the base\'s own filters' });
  // Formulas, properties, summaries and a view's order, grouping and limit aren't read.
  const unfiltered = without.replace(/    filters:\n      and:\n        - 'status != "done"'\n        - or:\n            - "formula.ppu > 5"\n            - "price > 2.1"\n/, "");
  assert.notEqual(unfiltered, without);
  // or: tagged #tag (or under it); and: tagged #book; not: neither #book nor in Required Reading.
  assert.deepEqual(matching(unfiltered, SHELF), ["Textbooks/Calculus.md", "Inbox/Idea.md", "Inbox/Plain.md"]);
});

test("a base's filters may be one filter string; with none, every note matches", () => {
  assert.deepEqual(matching(`filters: 'file.hasTag("book")'`, SHELF), ["Textbooks/Calculus.md"]);
  assert.throws(() => matching("views:\n  - type: table\n    name: All\n    filters: 'file.hasTag(\"book\")'", SHELF),
    { message: '[[Books.base]] filters its view "All"; Gizmo reads only the base\'s own filters' });
  assert.throws(() => matching("views:\n  - type: table\n  - type: cards\n    filters: 'file.hasTag(\"book\")'", SHELF),
    { message: '[[Books.base]] filters its view "view 2"; Gizmo reads only the base\'s own filters' });
  assert.deepEqual(matching("views:\n  - type: table\n    name: All\n    limit: 2\n    order: [file.name]", SHELF).length, 4);
  assert.deepEqual(SHELF.filter(compileBase(null, SRC)).length, 4);
  assert.throws(() => compileBase(["a"], SRC), { message: "[[Books.base]] isn't a base: it should hold keys such as filters and views" });
});

const BOOKS = [
  note("Books/Dune.md", { status: "reading", pages: 412, owned: true, finished: "2026-02-10", rating: "4" }, ["#book", "#book/sci-fi"]),
  note("Books/Classics/Middlemarch.md", { status: "done", pages: 880, owned: false, finished: "2025-12-30" }, ["#Book"]),
  note("Books/Piranesi.md", { status: "to read", pages: 272 }),
  note("Inbox/Notes.txt.md", { status: "done", tags: ["x"] }),
];
const paths = (...names: string[]) => names.map((n) => BOOKS.find((b) => b.path.includes(n))!.path);

test("file.hasTag takes several tags, counts nested ones, ignores # and case; file.inFolder counts sub-folders", () => {
  assert.deepEqual(where('file.hasTag("sci-fi", "book")', BOOKS), paths("Dune", "Middlemarch"));
  assert.deepEqual(where('file.hasTag("#book/sci-fi")', BOOKS), paths("Dune"));
  assert.deepEqual(where('file.hasTag("sci")', BOOKS), []);
  assert.deepEqual(where('file.inFolder("Books")', BOOKS), paths("Dune", "Middlemarch", "Piranesi"));
  assert.deepEqual(where('file.inFolder("Books/Classics/")', BOOKS), paths("Middlemarch"));
  assert.deepEqual(where('!file.inFolder("Books")', BOOKS), paths("Notes"));
});

test("a property compared with text, a number, true or false, or a date", () => {
  assert.deepEqual(where('status == "done"', BOOKS), paths("Middlemarch", "Notes"));
  assert.deepEqual(where("note.status != 'done'", BOOKS), paths("Dune", "Piranesi"));
  assert.deepEqual(where("pages > 400", BOOKS), paths("Dune", "Middlemarch"));
  assert.deepEqual(where("pages >= 412", BOOKS), paths("Dune", "Middlemarch"));
  assert.deepEqual(where("pages < 412", BOOKS), paths("Piranesi"));
  assert.deepEqual(where("pages <= 412", BOOKS), paths("Dune", "Piranesi"));
  assert.deepEqual(where("300 > pages", BOOKS), paths("Piranesi"));
  assert.deepEqual(where("pages > -1", BOOKS).length, 3);
  // Numbers in text compare as numbers.
  assert.deepEqual(where("rating >= 4", BOOKS), paths("Dune"));
  assert.deepEqual(where("owned == true", BOOKS), paths("Dune"));
  assert.deepEqual(where("owned != true", BOOKS), paths("Middlemarch", "Piranesi", "Notes"));
  assert.deepEqual(where('finished > date("2026-01-01")', BOOKS), paths("Dune"));
  assert.deepEqual(where('finished < date("2026-02-10 12:00:00")', BOOKS), paths("Dune", "Middlemarch"));
  // Text order, for text that is no date.
  assert.deepEqual(where('status < "reading"', BOOKS), paths("Middlemarch", "Notes"));
});

test("file properties, and a property read as true or false", () => {
  assert.deepEqual(where('file.name == "Notes.txt.md"', BOOKS), paths("Notes"));
  assert.deepEqual(where('file.basename == "Notes.txt"', BOOKS), paths("Notes"));
  assert.deepEqual(where('file.path == "Books/Piranesi.md"', BOOKS), paths("Piranesi"));
  assert.deepEqual(where('file.folder == "Books/Classics"', BOOKS), paths("Middlemarch"));
  assert.deepEqual(where('file.folder == "/"', [note("Top.md")]), ["Top.md"]);
  assert.deepEqual(where('file.ext == "md"', BOOKS).length, 4);
  assert.deepEqual(where("owned", BOOKS), paths("Dune"));
  assert.deepEqual(where("!owned", BOOKS), paths("Middlemarch", "Piranesi", "Notes"));
  assert.deepEqual(where("note.finished", BOOKS), paths("Dune", "Middlemarch"));
  assert.deepEqual(where("!!finished", BOOKS), paths("Dune", "Middlemarch"));
  assert.deepEqual(where("tags", BOOKS), paths("Notes"), "bare tags is the note's tags property");
});

test("and, or and not nest", () => {
  const yaml = `
filters:
  and:
    - file.inFolder("Books")
    - or:
        - status == "reading"
        - not:
            - file.hasTag("book")
            - pages > 500
`;
  assert.deepEqual(matching(yaml, BOOKS), paths("Dune", "Piranesi"));
  assert.deepEqual(matching("filters:\n  and: []", BOOKS).length, 4);
  assert.deepEqual(matching("filters:\n  or: []", BOOKS), []);
});

test("anything else in the filters is an error naming it", () => {
  const cases: [unknown, string][] = [
    ['file.hasLink("Textbook")', "uses file.hasLink"],
    ["formula.ppu > 5", "uses formula.ppu"],
    ['status.contains("read")', "uses status.contains"],
    ['file.name.startsWith("D")', "uses file.name.startsWith"],
    ["file.mtime > now()", "uses file.mtime"],
    ['finished > today()', "uses today"],
    ["this.status == status", "uses this.status"],
    ['note["page count"] > 3', "uses note[…]"],
    ["price * 2 > 3", 'uses "*"'],
    ['status == "done" && owned', 'uses "&&"'],
    ['(status == "done")', 'uses "("'],
    ["pages > rating", "uses pages > rating"],
    ['file.hasTag("a") == true', 'uses file.hasTag("a") == true'],
    ["author.name == 'x'", "uses author.name"],
  ];
  for (const [filter, what] of cases) assert.equal(why(filter), `[[Books.base]] ${what}, which Gizmo can't read`, String(filter));
  assert.equal(why({ and: ["pages > 3", { or: ["formula.x"] }] }), "[[Books.base]] uses formula.x, which Gizmo can't read");
  assert.equal(why("status =="), "[[Books.base]] has a filter Gizmo can't read: status ==");
  assert.equal(why('"done"'), '[[Books.base]] has a filter Gizmo can\'t read: "done"');
  assert.equal(why('file.inFolder("a", "b")'), '[[Books.base]] has a filter Gizmo can\'t read: file.inFolder("a", "b")');
  assert.equal(why('date("soon") < finished'), '[[Books.base]] has a filter Gizmo can\'t read: date("soon") < finished');
  assert.equal(why({ and: ["a"], or: ["b"] }), "[[Books.base]] has a filter group with and, or in it; a group holds one of and, or, not");
  assert.equal(why({ any: ["a"] }), "[[Books.base]] has a filter group with any in it; a group holds one of and, or, not");
  assert.equal(why({ and: "a" }), '[[Books.base]] has "and" without a list of filters under it');
  assert.equal(why({ and: [3] }), "[[Books.base]] has a filter Gizmo can't read: 3");
});

const BASE_TEXT = `filters:
  and:
    - file.inFolder("Books")
    - 'status != "abandoned"'
views:
  - type: table
    name: Books
`;

function vault() {
  const f = fakeHost({
    "Books/Dune.md": { fm: { status: "reading" }, tags: ["#book"] },
    "Books/Emma.md": { fm: { status: "abandoned" } },
    "Inbox/Idea.md": { fm: { status: "reading" } },
  });
  f.others.set("Bases/Books.base", BASE_TEXT);
  return f;
}

test("rows from a base are the notes rows source: notes gives", async () => {
  const f = vault();
  const dl = new DataLayer(f.host);
  const p = checkPanel({ view: "table", source: SRC }, true).panel as Panel;
  const rows = await dl.panelData(p.source, p, FILES, { ttlMs: 0, now: NOW });
  assert.deepEqual(rows, dl.notes("Books").filter((r) => r.name === "Dune"));
  const missing = checkPanel({ view: "table", source: "[[Shelf.base]]" }, true).panel as Panel;
  await assert.rejects(dl.panelData(missing.source, missing, FILES, { ttlMs: 0, now: NOW }), { message: "can't find [[Shelf.base]]" });
  f.others.set("Bases/Books.base", "filters: [");
  f.host.parseYaml = () => { throw new Error("unexpected end of the stream"); };
  await assert.rejects(dl.panelData(p.source, p, FILES, { ttlMs: 0, now: NOW }), { message: "can't read [[Books.base]]: unexpected end of the stream" });
});

test("a base reads any note, and edits any note's properties", () => {
  const r = readSpec({
    app: "Shelf",
    data: { shelf: { source: SRC, fields: { status: ["to read", "reading", "done"] } } },
    panels: [{ view: "table", source: "shelf", columns: ["name", "status"], edit: ["status"] }],
  }, { path: "Apps/S.md" })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Apps/S.md"), ["edit:*", "read:*"]);
  assert.equal(describePermission("read:*"), "Read any note in the vault");
  assert.equal(describePermission("edit:*"), "Change properties of notes anywhere in the vault");
  const p = { view: "table", source: SRC } as Panel;
  assert.deepEqual(editErrors(p, ["status", "path"]), ['edit: "path" comes from the note\'s file, not its properties']);
  assert.deepEqual(editPermissions(p, "edit"), [["edit:*", "edit"]]);
  assert.deepEqual(checkPanel({ view: "table", source: SRC, from: "Books" }, true).errors, ['"from" doesn\'t apply to a base; its filters choose the notes']);
  // Like any source, a base can't be chosen by what someone types.
  assert.equal(readSpec({ app: "x", inputs: { b: ["Books"] }, view: "table", source: "[[$b.base]]" })!.errors[0],
    '$b can\'t choose the source; use it in a URL\'s path or query, or in where');
});

test("the data layer tells listeners of every note's change under notes:*, and only notes'", () => {
  const f = vault();
  const dl = new DataLayer(f.host);
  dl.allNotes();
  const heard: string[][] = [];
  dl.subscribe(["notes:*"], (c) => heard.push([...c]));
  dl.fileChanged("Inbox/Idea.md");
  f.flush();
  dl.fileChanged("Bases/Books.base");
  f.flush();
  f.files.delete("Books/Emma.md");
  dl.fileDeleted("Books/Emma.md");
  f.flush();
  assert.deepEqual(heard, [["notes:*"], ["notes:*"]]);
});

function openShelf() {
  const fm = {
    app: "Shelf",
    data: { shelf: { source: SRC, fields: { status: ["to read", "reading", "done"] } } },
    panels: [{ view: "table", source: "shelf", sort: "name", columns: ["name", "status"], edit: ["status"] }],
  };
  const t = fakeEnv({
    "Apps/S.md": { fm },
    "Books/Dune.md": { fm: { status: "reading" } },
    "Books/Emma.md": { fm: { status: "abandoned" } },
    "Inbox/Idea.md": { fm: { status: "reading" } },
  });
  t.f.others.set("Bases/Books.base", BASE_TEXT);
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/S.md", t.env).load();
  const names = () => [...root.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
  return { ...t, root, names };
}

test("a panel over a base reloads when the base or any note changes, and edits the note's property", async () => {
  const { root, f, data, writes, names } = openShelf();
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.deepEqual(names(), ["Dune"]);

  // A note changes so that the base now matches it.
  f.files.get("Books/Emma.md")!.fm = { status: "to read" };
  data.fileChanged("Books/Emma.md");
  f.flush();
  await settle();
  assert.deepEqual(names(), ["Dune", "Emma"]);

  // The base itself changes.
  f.others.set("Bases/Books.base", 'filters: \'status == "reading"\'');
  data.fileChanged("Bases/Books.base");
  f.flush();
  await settle();
  assert.deepEqual(names(), ["Dune", "Idea"]);

  const select = root.querySelectorAll("tbody tr")[1].querySelector("select")!;
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "done");
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.deepEqual(writes, ["Inbox/Idea.md"]);
  assert.deepEqual(f.files.get("Inbox/Idea.md")!.fm, { status: "done" });
  assert.deepEqual(names(), ["Dune"]);
});

test("a base that can't be read shows why in its panel", async () => {
  const { root, f, data } = openShelf();
  await settle();
  f.others.set("Bases/Books.base", "filters:\n  - file.hasLink(\"Textbook\")");
  data.fileChanged("Bases/Books.base");
  f.flush();
  await settle();
  // A list needs and, or or not above it.
  assert.ok(root.querySelector(".gz-error")!.textContent!.endsWith("[[Books.base]] has a filter Gizmo can't read: [\"file.hasLink(\\\"Textbook\\\")\"]Try againShow in source"));
  f.others.set("Bases/Books.base", "filters:\n  or:\n    - file.hasLink(\"Textbook\")");
  data.fileChanged("Bases/Books.base");
  f.flush();
  await settle();
  assert.match(root.querySelector(".gz-error")!.textContent!, /\[\[Books\.base\]\] uses file\.hasLink, which Gizmo can't readTry againShow in source$/);
});

test("a base whose view has its own filters is the panel's error, so nothing it would show unfiltered can be edited", async () => {
  const { root, f, data, writes } = openShelf();
  await settle();
  f.others.set("Bases/Books.base", "views:\n  - type: table\n    name: Reading\n    filters: 'status == \"reading\"'");
  data.fileChanged("Bases/Books.base");
  f.flush();
  await settle();
  assert.match(root.querySelector(".gz-error")!.textContent!, /\[\[Books\.base\]\] filters its view "Reading"; Gizmo reads only the base's own filtersTry againShow in source$/);
  assert.equal(root.querySelector("tbody select"), null);
  assert.deepEqual(writes, []);
});
