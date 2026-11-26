import assert from "node:assert/strict";
import { test } from "node:test";
// Loaded with nothing standing in for Obsidian: had install.ts reached anything that imports it, this file wouldn't load.
import { asksOf, existingNotes, galleryChoice, installNotes, notesToShare, planGallery, planShared, previewShared, readShared } from "../src/install.ts";
import { toBundle } from "../src/bundle.ts";
import { galleryApps } from "../src/gallery.ts";
import gallery from "../scripts/gallery-notes.ts";
import { parseYaml } from "./support/yaml.ts";
import { runtimeOn } from "./support/runtime.ts";

const reading = {
  app: "Reading",
  data: { books: { source: "notes", from: "Books" } },
  panels: [
    { view: "list", source: "books", action: "Add", save: "Books/", name: "{title}", template: "[[Book template]]" },
    { view: "number", title: "Due", source: "books", agg: "count", alert: "> 5", then: { app: "[[Errands]]", do: "add" } },
  ],
};

test("sharing an app takes its template notes along, and says what it runs that isn't included", async () => {
  const t = await runtimeOn({
    "Apps/Reading.md": { fm: reading, body: "" },
    "Templates/Book template.md": { body: "# {title}\n" },
    "Notes/Plain.md": { body: "plain" },
  });
  const got = await notesToShare(t.runtime, "Apps/Reading.md");
  assert.ok(!("error" in got), JSON.stringify(got));
  assert.deepEqual(got.notes.map((n) => n.name), ["Reading", "Book template"]);
  assert.equal(got.notes[1].text, "# {title}\n");
  assert.equal(got.about, "Reading");
  assert.deepEqual(got.runs, ["It runs “add” in Errands, which isn't included; whoever installs it needs an app of that name with that shortcut."]);
  assert.deepEqual(await notesToShare(t.runtime, "Notes/Plain.md"), { error: "Only an app or a component can be shared" });
});

test("shared text or a link is read as an install reads it, each refusal said ready to show", async () => {
  const bundle = toBundle([{ name: "Reading", text: "---\napp: Reading\n---\n" }], "Reading");
  assert.ok("text" in bundle);
  const none = async () => { throw new Error("no fetch expected"); };
  const parse = (yaml: string) => parseYaml(yaml);
  assert.deepEqual(await readShared(bundle.text, none, parse), { notes: [{ name: "Reading", text: "---\napp: Reading\n---\n" }] });
  assert.deepEqual(await readShared("http://example.com/app.md", none, parse), { error: "Only https links can be installed" });

  const fetched: string[] = [];
  const answers = async (url: string) => {
    if (url.includes("404")) return { status: 404, text: "", contentType: "" };
    if (url.includes("down")) throw new Error("ECONNREFUSED");
    return { status: 200, text: "---\napp: Remote\n---\n", contentType: "text/plain" };
  };
  assert.deepEqual(await readShared("https://example.com/404.md", answers, parse, (h) => fetched.push(h)), { error: "example.com answered 404" });
  assert.deepEqual(await readShared("https://down.example.com/a.md", answers, parse), { error: "Couldn't fetch it: ECONNREFUSED" });
  assert.deepEqual(await readShared("https://example.com/Remote.md", answers, parse), { notes: [{ name: "Remote", text: "---\napp: Remote\n---\n" }] });
  assert.deepEqual(fetched, ["example.com"], "told before fetching");
  const notApp = await readShared("not a bundle", none, parse);
  assert.ok("error" in notApp && /^[A-Z]/.test(notApp.error), "said with a capital");
});

test("installing goes where new notes go, the app last, waits for the host, and stops at a name taken meanwhile", async () => {
  const t = await runtimeOn({ "Old/book template.md": { body: "mine" } }, { folder: "Inbox" });
  const notes = [{ name: "Reading", text: "---\napp: Reading\n---\n" }, { name: "Shelf kit", text: "---\ncomponent: Shelf\n---\n" }];
  const previewed = await previewShared(t.runtime, notes);
  assert.ok(!("error" in previewed), JSON.stringify(previewed));
  assert.equal(previewed.folder, "Inbox");
  const plan = await planShared(t.runtime, notes);
  assert.ok(!("refusal" in plan));
  assert.deepEqual(plan.create.map((n) => n.path), ["Shelf kit.md", "Reading.md"]);
  assert.deepEqual(await installNotes(t.runtime, plan, "Reading"), { opened: "Inbox/Reading.md" });
  assert.deepEqual(t.f.files.get("Inbox/Reading.md")?.fm, { app: "Reading" });
  assert.ok(t.f.files.has("Inbox/Shelf kit.md"));

  // Made again: the first note is there now, so nothing more is made and the failure is said.
  assert.deepEqual(await installNotes(t.runtime, plan, "Reading"), { error: "Couldn't copy “Reading”: File already exists." });
  assert.deepEqual(await installNotes(t.runtime, { refusal: "“Reading” already exists" }, "Reading"), { error: "“Reading” already exists" });
  assert.deepEqual(Object.keys(await existingNotes(t.runtime, ["BOOK TEMPLATE"])), ["BOOK TEMPLATE"]);
  assert.deepEqual((await existingNotes(t.runtime, ["BOOK TEMPLATE"]))["BOOK TEMPLATE"], ["mine"], "by name, in any folder or case");
});

test("choosing a gallery app: yours when you have one of its name, else its components and the kit's values to ask for", async () => {
  const apps = galleryApps(gallery);
  const practice = apps.find((a) => a.name === "Practice")!;
  const mine = await runtimeOn({ "Somewhere/practice.md": { body: "my own" } });
  assert.deepEqual(galleryChoice(mine.runtime, practice, gallery), { yours: "Somewhere/practice.md" });
  const fresh = await runtimeOn({});
  const choice = galleryChoice(fresh.runtime, practice, gallery);
  assert.ok("components" in choice);
  assert.ok(choice.components.some((c) => c.path === "Components/Tracker kit.md"));
  const plan = await planGallery(fresh.runtime, practice.note, choice.components);
  assert.ok(!("refusal" in plan));
  assert.equal(plan.create.at(-1)!.path, practice.note.path, "the app last");
  assert.match(asksOf(fresh.runtime, practice.note, choice.components), /^(It asks for nothing|When you open it, it will ask your OK to)/);
});
