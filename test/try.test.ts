import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleTry, leftOut, vaultTry } from "../src/try.ts";
import { parseYaml } from "./support/yaml.ts";
import { runtimeOn } from "./support/runtime.ts";

const reading = {
  app: "Reading",
  data: { books: { source: "notes", from: "Books" } },
  panels: [
    { view: "list", source: "books", action: "Add", save: "Books/", name: "{title}", template: "[[Book template]]" },
    { view: "table", source: "books" },
  ],
};

test("an app in the vault is tried on its own note and the templates it names, and nothing else", async () => {
  const t = await runtimeOn({
    "Apps/Reading.md": { fm: reading, body: "" },
    // A template is read where its link names it, as the permission it asks for says.
    "Book template.md": { body: "# {title}\n" },
    "Books/Dune.md": { fm: { title: "Dune" }, body: "" },
  });
  const tried = await vaultTry(t.runtime, "Apps/Reading.md");
  assert.ok(tried);
  assert.equal(tried.name, "Reading");
  assert.deepEqual([...tried.notes.keys()].sort(), ["Apps/Reading.md", "Book template.md"]);
  assert.equal(tried.notes.get("Book template.md")!.text, "# {title}\n");
  assert.deepEqual(tried.wanted, ["create:Books", "read:Book template.md", "read:Books"]);
  assert.deepEqual(leftOut(tried.wanted), ["Read notes in Books: none of them here"]);
  assert.equal(await vaultTry(t.runtime, "Apps/Gone.md"), undefined);
});

test("a shared app is tried where the install would put it, on the shared notes alone", () => {
  const app = "---\napp: Reading\npanels:\n  - view: list\n    source: books\n    action: Add\n    save: Books/\n    name: \"{title}\"\n    template: \"[[Book template]]\"\ndata:\n  books: {source: notes, from: Books}\n---\n";
  const tried = bundleTry([{ name: "Reading", text: app }, { name: "Book template", text: "# {title}\n" }], "Inbox", (y) => parseYaml(y));
  assert.equal(tried.appPath, "Inbox/Reading.md");
  assert.deepEqual([...tried.notes.keys()], ["Inbox/Reading.md", "Inbox/Book template.md"]);
  assert.deepEqual(tried.notes.get("Inbox/Reading.md")!.frontmatter?.app, "Reading");
  assert.deepEqual(tried.wanted, ["create:Books", "read:Book template.md", "read:Books"]);
});
