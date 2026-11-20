import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { readFor, type NoteReader } from "../src/expand.ts";
import { LensIndex, LensStack, lensDefinition } from "../src/lenses.ts";
import { readComponentPreview, readSpec } from "../src/spec.ts";
import { describePermission, permissionsOf } from "../src/permissions.ts";
import { fakeEnv } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));

const PROGRESS = {
  component: "Where I am in this book",
  for: "Books/",
  params: ["pages"],
  panels: [
    { view: "text", title: "Progress", text: "Page $this.page of $pages" },
    { view: "form", fields: { page: "number" }, save: "this" },
  ],
};

type Notes = Parameters<typeof fakeEnv>[0];

/** Component notes for expansion, found by name or path as links find them. */
const reading = (notes: Record<string, Record<string, unknown>>): NoteReader => ({
  resolve: (link) => Object.keys(notes).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
  frontmatter: (path) => notes[path],
});

/** A vault, its lens index, and a stack of lenses over `host`, with grants and folds kept as the plugin keeps them. */
function lenses(notes: Notes, grants: Record<string, string[]> = {}) {
  const t = fakeEnv(notes);
  t.env.isGranted = (key, wanted) => wanted.length === 0 || (grants[key] ?? []).join("\n") === wanted.join("\n");
  t.env.granted = (key) => grants[key] ?? [];
  t.env.grant = async (key, wanted) => { grants[key] = wanted; };
  const index = new LensIndex(t.data);
  const folded = new Set<string>();
  const folds = { folded: (c: string) => folded.has(c), setFolded: (c: string, f: boolean) => { if (f) folded.add(c); else folded.delete(c); } };
  const stack = (host: string) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const s = new LensStack(el, index, () => t.env, folds);
    s.show(host);
    return s;
  };
  return { ...t, index, stack, folded, grants };
}

test("for is a folder or #tag, like from; a $name can't choose it", () => {
  assert.deepEqual(readFor("Books/"), { scope: "Books" });
  assert.deepEqual(readFor("Books/Fiction, #book/sf"), { scope: "Books/Fiction, #book/sf" });
  for (const bad of [5, "", "[[Books]]", "#", "Books, ", "/", "Journal\nPrivate", "Journal\u0007"]) {
    assert.deepEqual(readFor(bad), { error: "for must be a folder or #tag, e.g. for: Books/" }, JSON.stringify(bad));
  }
  assert.deepEqual(readFor("Books/$genre"), { error: '$genre can\'t be used in "for"' });
  assert.deepEqual(readFor("$this.folder"), { error: '$this can\'t be used in "for"' });
  // A component with a broken for says so wherever it is used, and is still used.
  const reader = reading({ "C.md": { component: "c", for: "[[Books]]", panels: [{ view: "countdown", to: "2027-01-01" }] } });
  const r = readSpec({ app: "x", panels: [{ use: "[[C]]" }] }, { notes: reader, path: "A.md" })!;
  assert.deepEqual(r.errors, ["panel 1: [[C]]: for must be a folder or #tag, e.g. for: Books/"]);
  assert.equal(r.spec!.panels.length, 1);
});

test("a component with for still works with use; its save: this form works where an app sits in a note", () => {
  const reader = reading({ "Components/Progress.md": PROGRESS });
  const use = { app: "", panels: [{ use: "[[Progress]]", with: { pages: 300 } }] };
  const inNote = readSpec(use, { notes: reader, path: "Books/Dune.md", host: {} })!;
  assert.deepEqual(inNote.errors, []);
  assert.deepEqual(inNote.spec!.panels.map((ps) => ps.panel.view), ["text", "form"]);
  const onItsOwn = readSpec({ ...use, app: "Reading" }, { notes: reader, path: "Apps/Reading.md" })!;
  assert.deepEqual(onItsOwn.errors, ['panel 1 (from [[Progress]] panel 2): save: this works in an embed or a lens, where "this" is the note it sits in']);
  // Opened on its own, a lens shows how it is used and where, without drawing.
  const preview = readComponentPreview(PROGRESS, { path: "Components/Progress.md", notes: reader });
  assert.deepEqual(preview.result.errors, []);
  assert.equal(preview.lens, "Books");
});

test("a lens's params come from the note's properties of the same name; a missing one without a default hides it", () => {
  const component = { component: "c", for: "Books", params: { pages: null, shelf: "main" }, panels: [] };
  assert.deepEqual(lensDefinition("Components/C.md", component, { pages: 300, name: "Dune" }),
    { app: "", use: "[[Components/C]]", with: { pages: "$this.pages" } });
  assert.deepEqual(lensDefinition("Components/C.md", component, { pages: 300, shelf: "attic" })?.with, { pages: "$this.pages", shelf: "$this.shelf" });
  assert.equal(lensDefinition("Components/C.md", component, { shelf: "attic" }), undefined);
  assert.equal(lensDefinition("Components/C.md", component, { pages: "" }), undefined);
});

test("the lens index: which notes a lens shows on, in name order, kept current as notes change", () => {
  const { index, f, data } = lenses({
    "Components/Progress.md": { fm: PROGRESS },
    "Components/Book tags.md": { fm: { component: "t", for: "#book", panels: [{ view: "text", text: "$this.tags" }] } },
    "Components/Plain.md": { fm: { component: "p", panels: [{ view: "countdown", to: "2027-01-01" }] } },
    "Books/Dune.md": { fm: { pages: 412 }, tags: ["#book"] },
    "Books/Emma.md": { fm: {} },
    "Books/Dune data.md": { fm: { pages: 1 } },
    "Books/Shelf.md": { fm: { app: "Shelf", view: "countdown", to: "2027-01-01" } },
    "Notes/Wishlist.md": { fm: {}, tags: ["#book/wish"] },
  });
  assert.deepEqual(index.lensesFor("Books/Dune.md"), ["Components/Book tags.md", "Components/Progress.md"]);
  assert.deepEqual(index.lensesFor("Books/Emma.md"), [], "no pages, and Progress has no default for it");
  assert.deepEqual(index.lensesFor("Notes/Wishlist.md"), ["Components/Book tags.md"]);
  assert.deepEqual(index.lensesFor("Books/Dune data.md"), [], "a data note");
  assert.deepEqual(index.lensesFor("Books/Shelf.md"), [], "an app");
  assert.deepEqual(index.lensesFor("Components/Progress.md"), [], "a component");

  // A note gaining the property, or leaving the folder.
  f.files.set("Books/Emma.md", { fm: { pages: 474 } });
  data.fileChanged("Books/Emma.md");
  index.changed("Books/Emma.md");
  assert.deepEqual(index.lensesFor("Books/Emma.md"), ["Components/Progress.md"]);

  // A component gaining or losing for, moving, or going.
  f.files.set("Components/Plain.md", { fm: { component: "p", for: "Notes", panels: [{ view: "countdown", to: "2027-01-01" }] } });
  index.changed("Components/Plain.md");
  assert.deepEqual(index.lensesFor("Notes/Wishlist.md"), ["Components/Book tags.md", "Components/Plain.md"]);
  f.files.set("Components/Book tags.md", { fm: { component: "t", panels: [] } });
  index.changed("Components/Book tags.md");
  assert.deepEqual(index.lensesFor("Books/Dune.md"), ["Components/Progress.md"]);
  f.files.set("Lenses/Progress.md", f.files.get("Components/Progress.md")!);
  f.files.delete("Components/Progress.md");
  index.renamed("Lenses/Progress.md", "Components/Progress.md");
  assert.deepEqual(index.lensesFor("Books/Dune.md"), ["Lenses/Progress.md"]);
  index.deleted("Lenses/Progress.md");
  assert.deepEqual(index.lensesFor("Books/Dune.md"), []);
});

test("a lens asks once on its component for every note it shows on, naming what it would change", async () => {
  const notes = {
    "Components/Progress.md": { fm: PROGRESS },
    "Books/Dune.md": { fm: { page: 120, pages: 412 } },
    "Books/Emma.md": { fm: { page: 3, pages: 474 } },
  };
  const { stack, grants } = lenses(notes);
  const dune = stack("Books/Dune.md");
  await settle();
  const head = dune.el.querySelector(".gz-lens-head")!;
  assert.equal(text(head.querySelector("a.gz-lens-name")), "Progress");
  assert.deepEqual([...dune.el.querySelectorAll(".gz-card li")].map(text), ["Change properties of notes in Books"]);
  assert.equal(describePermission("edit:Books"), "Change properties of notes in Books");
  (dune.el.querySelector(".gz-card button.mod-cta") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(grants, { "Components/Progress.md": ["edit:Books"] });
  assert.equal(text(dune.el.querySelector(".gz-text")), "Page 120 of 412");

  const emma = stack("Books/Emma.md");
  await settle();
  assert.equal(emma.el.querySelector(".gz-card"), null, "already allowed");
  assert.equal(text(emma.el.querySelector(".gz-text")), "Page 3 of 474");
});

test("a lens's save: this form writes the note it is shown on, and the lens follows the note", async () => {
  const { stack, f, writes, changed } = lenses({
    "Components/Progress.md": { fm: PROGRESS },
    "Books/Dune.md": { fm: { page: 120, pages: 412 } },
  }, { "Components/Progress.md": ["edit:Books"] });
  const s = stack("Books/Dune.md");
  await settle();
  const page = s.el.querySelector("form input") as HTMLInputElement;
  assert.equal(page.value, "120");
  page.value = "150";
  change(page);
  await settle();
  assert.deepEqual(writes, ["Books/Dune.md"]);
  assert.deepEqual(f.files.get("Books/Dune.md")!.fm, { page: 150, pages: 412 });
  assert.equal(text(s.el.querySelector(".gz-text")), "Page 150 of 412");
  // Leaving the folder takes the lens away once the plugin shows the stack again.
  f.files.delete("Books/Dune.md");
  f.files.set("Archive/Dune.md", { fm: { page: 150, pages: 412 } });
  changed("Books/Dune.md");
  s.show("Books/Dune.md");
  assert.equal(s.size, 0);
  assert.equal(s.el.children.length, 0);
});

test("showing a note's lenses again leaves them in place, so a field being typed in keeps the focus", async () => {
  const notes = {
    "Components/Progress.md": { fm: PROGRESS },
    "Components/About.md": { fm: { component: "a", for: "Books", panels: [{ view: "text", text: "About $this.name" }] } },
    "Books/Dune.md": { fm: { page: 1, pages: 412 } },
  };
  const { stack, f, changed, index } = lenses(notes, { "Components/Progress.md": ["edit:Books"] });
  const s = stack("Books/Dune.md");
  await settle();
  const moves: string[] = [];
  new window.MutationObserver((records: MutationRecord[]) => {
    for (const r of records) moves.push(`-${r.removedNodes.length} +${r.addedNodes.length}`);
  }).observe(s.el, { childList: true });
  // What the plugin does on every change to the note: the note changes, and the stack is shown again.
  f.files.set("Books/Dune.md", { fm: { page: 2, pages: 412 } });
  changed("Books/Dune.md");
  s.show("Books/Dune.md");
  await settle();
  assert.deepEqual(moves, []);
  assert.deepEqual([...s.el.querySelectorAll(".gz-lens-name")].map(text), ["About", "Progress"]);
  // A lens that comes in still lands in name order.
  f.files.set("Components/Cover.md", { fm: { component: "c", for: "Books", panels: [{ view: "text", text: "Cover" }] } });
  changed("Components/Cover.md");
  index.changed("Components/Cover.md");
  s.show("Books/Dune.md");
  assert.deepEqual([...s.el.querySelectorAll(".gz-lens-name")].map(text), ["About", "Cover", "Progress"]);
});

test("lenses stack in name order; folding one stops it, and the fold is kept per component", async () => {
  const notes = {
    "Components/Progress.md": { fm: PROGRESS },
    "Components/About.md": { fm: { component: "a", for: "Books", panels: [{ view: "text", text: "About $this.name" }] } },
    "Books/Dune.md": { fm: { page: 1, pages: 412 } },
  };
  const { stack, folded } = lenses(notes, { "Components/Progress.md": ["edit:Books"] });
  const s = stack("Books/Dune.md");
  await settle();
  assert.deepEqual([...s.el.querySelectorAll(".gz-lens-name")].map(text), ["About", "Progress"]);
  const toggle = s.el.querySelector(".gz-lens-toggle") as HTMLButtonElement;
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.deepEqual([...folded], ["Components/About.md"]);
  assert.equal(s.el.querySelector(".gz-lens-item .gz-lens-body")!.children.length, 0, "a folded lens doesn't run");
  // Another note starts with it folded.
  const other = stack("Books/Dune.md");
  await settle();
  assert.equal(other.el.querySelector(".gz-lens-toggle")!.getAttribute("aria-expanded"), "false");
  toggle.click();
  await settle();
  assert.equal(text(s.el.querySelector(".gz-text")), "About Dune");
  s.dispose();
  assert.equal(s.el.children.length, 0);
});

test("a lens component opened on its own shows how it is used and where, and asks for nothing", async () => {
  const t = fakeEnv({ "Components/Progress.md": { fm: { ...PROGRESS, panels: [...PROGRESS.panels, { view: "number", source: "https://api.example.com/t" }] } } });
  t.env.isGranted = () => false;
  const root = document.createElement("div");
  new AppController(root, "Components/Progress.md", t.env).load();
  await settle();
  assert.equal(text(root.querySelector(".gz-card .gz-label")), "It is also a lens: it shows above every note in Books.");
  assert.equal(root.querySelectorAll(".gz-panel").length, 0);
  assert.equal(root.querySelector("button.mod-cta"), null);
});

test("a lens in a #tag scope asks to change the notes with that tag", () => {
  const reader = reading({ "Components/T.md": { ...PROGRESS, for: "#book" } });
  const def = lensDefinition("Components/T.md", PROGRESS, { pages: 3 })!;
  const r = readSpec(def, { notes: reader, path: "Components/T.md", host: { scope: "#book" } })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Components/T.md"), ["edit:#book"]);
});
