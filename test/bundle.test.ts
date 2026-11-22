import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromBundle, fromFetched, nameProblem, previewInstall, sharedUrl, toBundle, type BundleNote, type InstallTarget,
} from "../src/bundle.ts";
import type { NoteReader } from "../src/expand.ts";
import { componentsNeeded, galleryApps } from "../src/gallery.ts";
import { basename } from "../src/store.ts";
import gallery from "../src/gallery-notes.ts";
import { parseYaml } from "./support/yaml.ts";

const note = (name: string, text: string): BundleNote => ({ name, text });

/** A vault holding these notes (path → text), as an install sees it. */
function vault(files: Record<string, string> = {}, folder = ""): InstallTarget {
  const fm = (text: string) => {
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    return m ? parseYaml(m[1]) as Record<string, unknown> : undefined;
  };
  const notes: NoteReader = {
    resolve: (link) => Object.keys(files).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
    frontmatter: (path) => (files[path] === undefined ? undefined : fm(files[path])),
  };
  return {
    folder,
    existing: (name) => Object.entries(files).filter(([p]) => basename(p).toLowerCase() === name.toLowerCase()).map(([, t]) => t),
    notes,
    parse: parseYaml,
  };
}

function bundled(notes: BundleNote[], about = ""): string {
  const r = toBundle(notes, about);
  assert.ok("text" in r, JSON.stringify(r));
  return r.text;
}

test("every gallery app, shared with the components it uses, comes back word for word and installs as it reads in the gallery", () => {
  for (const app of galleryApps(gallery)) {
    const parts = componentsNeeded(app.note, gallery);
    const notes = [app.note, ...parts].map((n) => note(basename(n.path), n.text));
    const back = fromBundle(bundled(notes, app.about));
    assert.ok("notes" in back, app.name);
    assert.deepEqual(back.notes, notes, app.name);
    const preview = previewInstall(back.notes, vault({}, "Inbox"));
    assert.ok(!("error" in preview), app.name);
    assert.deepEqual(preview.errors, [], app.name);
    assert.equal(preview.name, app.name);
    assert.equal(preview.about, app.about);
    assert.equal(preview.kind, "app");
    assert.ok(!("refusal" in preview.plan), app.name);
    assert.deepEqual(preview.plan.create.map((n) => basename(n.path)), [...parts.map((p) => basename(p.path)), app.name]);
  }
});

test("the shared text says what it is and how to install it, and reads as Markdown", () => {
  const kit = gallery.find((n) => n.path === "Components/Tracker kit.md")!;
  const practice = gallery.find((n) => n.path === "Apps/Practice.md")!;
  const text = bundled([note("Practice", practice.text), note("Tracker kit", kit.text)], "Log how long I practise and see this week against the last and the trend toward my goal");
  assert.ok(text.startsWith("# Practice\n\nLog how long I practise and see this week against the last and the trend toward my goal\n\nA Gizmo app for Obsidian: Practice and the note it uses (Tracker kit). To install it, run “Gizmo: Install an app from a link or text”"), text.slice(0, 300));
  assert.ok(text.includes("\n````gizmo-note Practice\n---\napp: Log how long I practise"));
  assert.ok(text.includes("\n````gizmo-note Tracker kit\n---\ncomponent:"));
});

test("a note holding fences of its own, even long ones, is wrapped in a longer fence and comes back whole", () => {
  const today = note("Today", "---\ntags: [daily]\n---\nWater:\n\n```gizmo\napp: \"[[Water]]\"\n```\n\n``````\nsix\n``````\n\n````gizmo-note Fake\nnot a note\n````\n");
  const water = note("Water", "---\napp: Count glasses\nview: number\n---\n");
  const text = bundled([today, water]);
  assert.ok(text.includes("```````gizmo-note Today\n"), "seven backticks: one more than the longest run inside");
  const back = fromBundle(text);
  assert.deepEqual(back, { notes: [today, water] });
});

test("shared text with Windows line endings, or a note without a final line break, reads the same", () => {
  const app = note("Plain", "---\napp: Do one thing\nview: text\ntext: hi\n---\nBody\n");
  const crlf = bundled([app]).replace(/\n/g, "\r\n");
  assert.deepEqual(fromBundle(crlf), { notes: [app] });
  assert.deepEqual(fromBundle(bundled([note("Plain", app.text.trimEnd())])), { notes: [app] });
});

test("a bundle can't name a note outside the folder it installs into, twice, or not at all", () => {
  for (const bad of ["../Secrets", "Apps/Evil", "a\\b", ".obsidian", "x#y", "[[x]]", " padded", "a:b", "tab\there"]) {
    assert.ok(nameProblem(bad), bad);
    const text = `# x\n\n\`\`\`\`gizmo-note ${bad}\n---\napp: x\n---\n\`\`\`\`\n`;
    assert.ok("error" in fromBundle(text), bad);
    assert.ok("error" in toBundle([note(bad, "---\napp: x\n---\n")], ""), bad);
  }
  for (const good of ["Weight", "Trip planner", "Café log", "Q3 (draft)", "Mom's meds"]) assert.equal(nameProblem(good), undefined, good);
  assert.deepEqual(fromBundle("````gizmo-note A\n---\napp: a\n---\n````\n````gizmo-note a\n---\napp: b\n---\n````\n"), { error: "it holds two notes called “a”" });
  assert.deepEqual(fromBundle("````gizmo-note A\n---\napp: a\n"), { error: "the note “A” isn't closed; the text was cut short" });
  assert.deepEqual(fromBundle("---\napp: just a note\n---\n"), { error: "this isn't a shared Gizmo app; share one with “Share this app”" });
  assert.deepEqual(toBundle([note("A", "x"), note("a", "y")], ""), { error: "two of the notes it uses are called “a”; rename one to share it" });
});

test("installing says what it would ask for, reuses a component already there word for word, and refuses a taken name", () => {
  const kit = gallery.find((n) => n.path === "Components/Tracker kit.md")!;
  const books = note("Books", "---\napp: Keep my books\ndata:\n  shelf: {source: notes, from: Books}\npanels:\n  - view: form\n    fields: {name: text}\n    save: Books/\n  - view: table\n    source: shelf\n---\n");
  const p = previewInstall([books], vault({}, "Inbox"));
  assert.ok(!("error" in p));
  assert.deepEqual(p.asks, ["Create notes in Books", "Read notes in Books"]);
  assert.deepEqual(p.plan, { create: [{ path: "Books.md", text: books.text }], reuse: [] });

  const practice = note("Practice", gallery.find((n) => n.path === "Apps/Practice.md")!.text);
  const shared = [practice, note("Tracker kit", kit.text)];
  const reused = previewInstall(shared, vault({ "Kits/Tracker kit.md": kit.text }));
  assert.ok(!("error" in reused) && !("refusal" in reused.plan));
  assert.deepEqual(reused.plan.reuse, ["Tracker kit"]);
  assert.deepEqual(reused.plan.create.map((n) => n.path), ["Practice.md"]);

  const changed = previewInstall(shared, vault({ "Kits/Tracker kit.md": `${kit.text}\nmine` }));
  assert.ok(!("error" in changed));
  assert.deepEqual(changed.plan, { refusal: "“Tracker kit” already exists and isn't the one “Practice” needs" });
  const taken = previewInstall(shared, vault({ "Old/practice.md": "mine" }));
  assert.ok(!("error" in taken));
  assert.deepEqual(taken.plan, { refusal: "“Practice” already exists" });
});

test("a link to a folder the install flattens shows as the app's own check error, and notes that act on their own are pointed out", () => {
  const app = note("Trip", "---\napp: Plan a trip\npanels:\n  - use: \"[[Components/Weather]]\"\n    with: {city: Tokyo}\n---\n");
  const weather = note("Weather", "---\ncomponent: Weather for a place\nparams: [city]\npanels:\n  - view: text\n    text: $city\n---\n");
  const p = previewInstall([app, weather], vault());
  assert.ok(!("error" in p));
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /Components\/Weather/);

  const lens = note("Score", "---\ncomponent: Score a decision\nfor: Decisions/\npanels:\n  - view: form\n    fields: {outcome: [right, wrong]}\n    save: this\n---\n");
  const other = note("Other", "---\napp: Another app\nview: text\ntext: hi\n---\n");
  const fine = note("Host", "---\napp: Uses the lens's folder\nview: text\ntext: hi\n---\n");
  const q = previewInstall([fine, lens, other], vault());
  assert.ok(!("error" in q));
  assert.deepEqual(q.extras, ["Score shows on every note in Decisions/", "Other is an app of its own"]);
  assert.deepEqual(previewInstall([note("Plain", "---\ntags: [x]\n---\n")], vault()), { error: "“Plain” isn't a Gizmo app or component" });
  const lensFirst = previewInstall([lens], vault());
  assert.ok(!("error" in lensFirst));
  assert.equal(lensFirst.kind, "lens");
  assert.deepEqual(lensFirst.asks, ["Change properties of notes in Decisions"]);
});

test("a link must be https; a gist's page is read as its raw text; a raw note is named after its file", () => {
  assert.equal(sharedUrl("http://example.com/app.md"), undefined);
  assert.equal(sharedUrl("file:///etc/passwd"), undefined);
  assert.equal(sharedUrl("not a link"), undefined);
  assert.equal(sharedUrl("https://gist.github.com/someone/0123abcd"), "https://gist.githubusercontent.com/someone/0123abcd/raw");
  assert.equal(sharedUrl(" https://example.com/apps/Weight.md "), "https://example.com/apps/Weight.md");

  const plain = "---\napp: Count glasses\nview: number\n---\nBody\n";
  assert.deepEqual(fromFetched(plain, "https://example.com/raw/Water%20log.md", parseYaml), { notes: [note("Water log", plain)] });
  assert.deepEqual(fromFetched("<html>nope</html>", "https://example.com/x", parseYaml), { error: "this isn't a shared Gizmo app; share one with “Share this app”" });
  assert.deepEqual(fromFetched(plain, "https://example.com/..%2Fx.md", parseYaml), { error: "“../x” can't be a note's name" });
  assert.deepEqual(fromFetched("x".repeat(1_000_001), "https://example.com/x.md", parseYaml), { error: "that link's text is too large to be an app" });
});

test("installing an app whose then runs another app says so when the vault has no app of that name", () => {
  const calls = note("Calls", "---\napp: Log calls\npanels:\n  - view: form\n    fields: {who: text}\n    save: calls\n    then: {app: \"[[Task inbox]]\", do: add, fill: {task: \"Call {who}\"}}\n---\n");
  const missing = previewInstall([calls], vault());
  assert.ok(!("error" in missing));
  assert.deepEqual(missing.extras, ["It runs “add” in Task inbox, which you don't have"]);
  assert.deepEqual(missing.asks, ["Run “add” in Task inbox"]);
  const there = previewInstall([calls], vault({ "Apps/Task inbox.md": "---\napp: Inbox\nview: text\ntext: hi\n---\n" }));
  assert.ok(!("error" in there));
  assert.deepEqual(there.extras, []);
});
