import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { HostedApp, Memories, blockKey, dropGrants, moveGrants, parseHosted } from "../src/hosted.ts";
import { SAVE_THIS_HOSTED, permissionsOf, readSpec, resolvePanel } from "../src/spec.ts";
import { fakeEnv } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  change(select);
};

const HOST = "Journal/2026-11-18.md";

type Notes = Parameters<typeof fakeEnv>[0];

/** A note-app block in `host`, drawn; `grants` keeps what was allowed, by key, as the plugin does. */
function embed(value: unknown, notes: Notes, opts: { host?: string; grants?: Record<string, string[]>; responses?: Record<string, unknown> } = {}) {
  const host = opts.host ?? HOST;
  const t = fakeEnv({ [host]: { fm: {} }, ...notes }, opts.responses);
  const asked: string[] = [];
  if (opts.grants) {
    const grants = opts.grants;
    t.env.isGranted = (key, wanted) => { asked.push(key); return wanted.length === 0 || (grants[key] ?? []).join("\n") === wanted.join("\n"); };
    t.env.granted = (key) => grants[key] ?? [];
    t.env.grant = async (key, wanted) => { grants[key] = wanted; };
  }
  const root = document.createElement("div");
  document.body.appendChild(root);
  const source = JSON.stringify(value);
  const draw = (memory?: Parameters<typeof Memories.prototype.of>[0]) => {
    const h = new HostedApp(root, value, source, host, t.env, memory === undefined ? undefined : memories.of(memory, host));
    h.load();
    return h;
  };
  const memories = new Memories();
  const app = draw();
  return { ...t, root, app, draw, memories, asked, key: blockKey(host, source) };
}

/** Changes a note's frontmatter the way editing it in Obsidian would, and delivers the change. */
async function edit(t: ReturnType<typeof fakeEnv>, path: string, fm: Record<string, unknown>) {
  t.f.files.set(path, { ...t.f.files.get(path), fm });
  t.changed(path);
  await settle();
}

test("a block holds an app's keys, or a link to an app and the panels to show", () => {
  assert.deepEqual(parseHosted({ view: "countdown", to: "2027-01-01" }), { kind: "embed", definition: { view: "countdown", to: "2027-01-01", app: "" } });
  assert.deepEqual(parseHosted({ app: "My week", view: "countdown" }), { kind: "embed", definition: { app: "My week", view: "countdown" } });
  assert.deepEqual(parseHosted(null), { kind: "embed", definition: { app: "" } });
  assert.deepEqual(parseHosted({ app: "[[Meds]]" }), { kind: "app", link: "Meds" });
  // Without quotes, YAML reads [[Meds]] as a list holding a list.
  assert.deepEqual(parseHosted({ app: [["Meds"]], panels: ["Took meds", 2] }), { kind: "app", link: "Meds", panels: ["Took meds", "2"] });
  assert.deepEqual(parseHosted({ app: "[[Meds]]", view: "number" }), { error: 'beside app: "[[Meds]]" only panels can go' });
  assert.deepEqual(parseHosted({ app: "[[Meds]]", panels: "Took meds" }), { error: "panels must be a list of panel titles, e.g. panels: [Took meds]" });
  assert.deepEqual(parseHosted("view: countdown"), { error: "a note-app block holds an app's keys, e.g. view: countdown" });
});

test("an embed draws its panels; its identity is its note and its block's text", async () => {
  const value = { panels: [{ view: "countdown", to: "2026-11-25", label: "Trip" }, { view: "checklist", items: ["Passport", "Tickets"], save: "packed" }] };
  const { root, f, key } = embed(value, {});
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  assert.equal(text(root.querySelector(".na-view-countdown .na-big")), "7days");
  (root.querySelector(".na-checklist input") as HTMLInputElement).click();
  change(root.querySelector(".na-checklist input")!);
  await settle();
  // Recorded data goes to the note's own data note, as an app note's does.
  assert.deepEqual(f.files.get("Journal/2026-11-18 data.md")!.fm, { packed: ["Passport"] });
  assert.match(key, /^Journal\/2026-11-18\.md#[0-9a-z]+$/);
  assert.equal(blockKey(HOST, `${JSON.stringify(value)}\n`), key, "a trailing line break isn't part of the text");
  assert.notEqual(blockKey(HOST, JSON.stringify({ ...value, title: "x" })), key);
});

test("an embed's grants are kept per block: asked once, and asked again when its text changes", async () => {
  const value = { view: "number", source: "https://api.example.com/t", pick: "current", field: "t" };
  const grants: Record<string, string[]> = {};
  const { root, key, asked, draw, app } = embed(value, {}, { grants });
  await settle();
  assert.deepEqual(asked, [key]);
  assert.deepEqual([...root.querySelectorAll(".na-card li")].map(text), ["Fetch data from api.example.com"]);
  assert.equal(root.querySelector(".na-card button:not(.mod-cta)"), null, "no Edit source button in an embed");
  (root.querySelector(".na-card button.mod-cta") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(grants, { [key]: ["net:api.example.com"] });
  assert.equal(text(root.querySelector(".na-view-number .na-big")), "7");
  // The same block drawn again (as the editor does) isn't asked about again.
  app.dispose();
  draw();
  await settle();
  assert.equal(text(root.querySelector(".na-view-number .na-big")), "7");
  assert.equal(root.querySelector(".na-card"), null);
  // The same keys in another block of another note are another app.
  const other = embed(value, {}, { grants, host: "Journal/2026-11-19.md" });
  await settle();
  assert.ok(other.root.querySelector(".na-card button.mod-cta"));
});

test("$this reads the note the block is in, and follows it as it changes", async () => {
  const value = {
    panels: [
      { view: "text", title: "Today", text: "$this.name: feeling $this.mood, in $this.folder" },
      { view: "countdown", to: "2027-01-01" },
      { view: "list", source: "notes", from: "Health", where: { who: "$this.doctor" }, item: "{name}" },
    ],
  };
  const t = embed(value, {
    [HOST]: { fm: { mood: "ok", doctor: "Dr. Lee", name: "not the name" }, tags: ["#journal"] },
    "Health/Dentist.md": { fm: { who: "Dr. Lee" } },
    "Health/Eye exam.md": { fm: { who: "Dr. Kim" } },
  });
  await settle();
  const [about, countdown, visits] = [...t.root.querySelectorAll(".na-panel")];
  // The note's name wins over a property called name.
  assert.equal(text(about.querySelector(".na-text")), "2026-11-18: feeling ok, in Journal");
  assert.equal(text(visits.querySelector("ul")), "Dentist");

  await edit(t, HOST, { mood: "great", doctor: "Dr. Kim" });
  assert.equal(text(t.root.querySelector(".na-text")), "2026-11-18: feeling great, in Journal");
  assert.equal(text(t.root.querySelector(".na-view-list ul")), "Eye exam");
  assert.equal(t.root.querySelector(".na-view-countdown"), countdown, "a panel that doesn't read $this stays as it is");

  // A property the note doesn't have is empty text, and a condition that matches nothing.
  await edit(t, HOST, {});
  assert.equal(text(t.root.querySelector(".na-text")), "2026-11-18: feeling , in Journal");
  assert.equal(text(t.root.querySelector(".na-view-list .na-empty")), "Nothing here yet.");
});

test("a $this property is untrusted: a secret or a line break in it stops the panel; in a URL it is encoded", async () => {
  const value = {
    panels: [
      { view: "number", title: "Lookup", source: "https://api.example.com/q?city=$this.city", pick: "current", field: "t" },
      { view: "text", text: "Hello $this.greeting" },
    ],
  };
  const t = embed(value, { [HOST]: { fm: { city: "São Paulo & Rio", greeting: "hi" } } });
  await settle();
  assert.deepEqual(t.f.requests, ["https://api.example.com/q?city=S%C3%A3o%20Paulo%20%26%20Rio"]);
  await edit(t, HOST, { city: "x{secret:demo}", greeting: "two\nlines" });
  const [lookup, hello] = [...t.root.querySelectorAll(".na-panel")];
  assert.match(text(lookup), /\$this\.city can't hold a secret or a line break/);
  assert.match(text(hello), /\$this\.greeting can't hold a secret or a line break/);
  assert.equal(t.f.requests.length, 1);
});

test("$this is checked like a selection: bare is an error, and it can't choose what an app touches", () => {
  const r = readSpec({
    app: "x",
    inputs: { this: ["a"] },
    panels: [
      { view: "text", text: "About $this" },
      { view: "list", source: "notes", from: "$this.folder" },
      { view: "list", source: "$this.list" },
      { view: "list", source: "https://$this.host/x" },
      { view: "list", source: "https://api.example.com/x", headers: { Authorization: "Bearer {secret:$this.key}" } },
      { view: "button", label: "Go", append: "$this.path" },
      { view: "list", source: "s", select: "this" },
      { view: "text", text: "Rated $this.rating, $thsi.name" },
    ],
  }, { path: "Apps/W.md" })!;
  assert.deepEqual(r.errors, [
    'inputs: "this" is taken: $this is the note the app is in',
    'panel 7: select: "this" is taken: $this is the note the app is in',
    "panel 1: say which property: $this.rating",
    'panel 2: $this can\'t be used in "from"',
    "panel 3: $this can't choose the source; use it in a URL's path or query, or in where",
    "panel 4: $this can't be part of a URL's host",
    "panel 5: $this can't name a secret",
    'panel 6: $this can\'t be used in "append"',
    'panel 8: "$thsi" isn\'t an input (did you mean $this?)',
  ]);
});

test("an app note opened on its own is its own $this, and save: this is an error there", async () => {
  const fm = {
    app: "Notes about this app",
    panels: [
      { view: "text", text: "This is $this.name, owned by $this.owner" },
      { view: "form", fields: { owner: "text" }, save: "this" },
    ],
    owner: "me",
  };
  const r = readSpec(fm, { path: "Apps/W.md" })!;
  assert.deepEqual(r.errors, [`panel 2: ${SAVE_THIS_HOSTED}`]);
  const t = fakeEnv({ "Apps/W.md": { fm } });
  const root = document.createElement("div");
  new AppController(root, "Apps/W.md", t.env).load();
  await settle();
  assert.equal(text(root.querySelector(".na-text")), "This is W, owned by me");
  assert.equal(root.querySelectorAll(".na-panel").length, 1);
});

test("save: this: a form holds the note's properties and writes each change back to the note", async () => {
  const value = { view: "form", title: "Where I am", fields: { page: "number", status: ["to read", "reading", "done"], note: "text" }, save: "this" };
  const host = "Books/Dune.md";
  const t = embed(value, { [host]: { fm: { page: 120, status: "reading", pages: 412 } } }, { host });
  await settle();
  const r = readSpec({ ...value, app: "" }, { path: host, host: {} })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, host), [], "an embed writing its own note needs no grant");
  const form = t.root.querySelector("form.na-form")!;
  assert.equal(form.querySelector("button"), null, "no submit button");
  const [page, note] = [...form.querySelectorAll("input")] as HTMLInputElement[];
  const status = form.querySelector("select") as HTMLSelectElement;
  assert.deepEqual([page.type, page.value, status.value, note.value], ["number", "120", "1", ""]);

  page.focus();
  page.value = "135";
  change(page);
  assert.equal(page.disabled, true);
  await settle();
  assert.equal(page.disabled, false);
  assert.equal(document.activeElement, page);
  assert.deepEqual(t.f.files.get(host)!.fm, { page: 135, status: "reading", pages: 412 });
  assert.equal(t.root.querySelector("form.na-form"), form, "updated in place, not redrawn");

  choose(status, "done");
  await settle();
  assert.equal(t.f.files.get(host)!.fm!.status, "done");
  assert.deepEqual(t.writes, [host, host], "only the note itself is written");

  // A change made elsewhere shows, except in a field being typed in.
  note.focus();
  note.value = "half-typed";
  await edit(t, host, { page: 140, status: "to read", pages: 412, note: "from elsewhere" });
  assert.equal(page.value, "140");
  assert.equal(status.value, "0");
  assert.equal(note.value, "half-typed");
});

test("save: this goes on a form only, and nothing else that acts goes beside it", () => {
  const r = readSpec({
    app: "",
    panels: [
      { view: "button", label: "Done", save: "this" },
      { view: "form", fields: { page: "number" }, save: "this", notify: "Saved" },
      { view: "checklist", items: ["a"], save: "this" },
    ],
  }, { path: HOST, host: {} })!;
  assert.deepEqual(r.errors, [
    "panel 1: save: this works on a form",
    'panel 2: "notify" doesn\'t apply with save: this, which saves each field as it changes',
    "panel 3: save: this works on a form",
  ]);
  const lists = readSpec({ app: "", data: { this: { source: "x" } }, view: "number", source: "s", into: "this" }, { path: HOST })!;
  assert.deepEqual(lists.errors, ['data: "this" can\'t be a name; source: this already means the note the app is in']);
});

test("source: this is one row, the note's properties, and follows the note", async () => {
  const value = { view: "progress", title: "Read", source: "this", field: "page", max: "$this.pages", unit: "pages" };
  const host = "Books/Dune.md";
  const t = embed(value, { [host]: { fm: { page: 120, pages: 400 } } }, { host });
  await settle();
  assert.equal(text(t.root.querySelector(".na-big")), "120/ 400 pages");
  await edit(t, host, { page: 200, pages: 400 });
  assert.equal(text(t.root.querySelector(".na-big")), "200/ 400 pages");
  const r = readSpec({ app: "", ...value }, { path: host, host: {} })!;
  assert.deepEqual(permissionsOf(r.spec!, host), []);
  assert.equal(resolvePanel(r.spec!.panels[0], { this: { pages: 10 } }).panel!.max, 10);
});

test("an embed of an app runs as that app: its grants, its data note, only the panels named", async () => {
  const meds = {
    app: "Log when I take my meds",
    panels: [
      { view: "button", label: "Took meds", save: "doses", append: "Daily.md" },
      { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count" },
    ],
  };
  const grants: Record<string, string[]> = {};
  const t = embed({ app: "[[Meds]]", panels: ["Took meds"] }, { "Apps/Meds.md": { fm: meds } }, { grants });
  await settle();
  assert.deepEqual(t.asked, ["Apps/Meds.md"]);
  assert.equal(text(t.root.querySelector(".na-waiting")), "Open [[Meds]] once to allow it");
  assert.equal(t.root.querySelector("button"), null, "no prompt here");
  (t.root.querySelector(".na-waiting a") as HTMLElement).click();
  assert.deepEqual(t.opened, ["Apps/Meds.md"]);

  // Allowed in the app itself; the embed looks again when asked to.
  grants["Apps/Meds.md"] = ["write:Daily.md"];
  t.app.recheck();
  await settle();
  assert.deepEqual([...t.root.querySelectorAll(".na-panel")].map((p) => p.className.split(" ")[1]), ["na-view-button"]);
  (t.root.querySelector("button.na-button") as HTMLButtonElement).click();
  await settle();
  assert.equal((t.f.files.get("Apps/Meds data.md")!.fm!.doses as unknown[]).length, 1);
  assert.deepEqual(t.writes, ["Daily.md", "Apps/Meds data.md"]);

  const all = embed({ app: "[[Meds]]" }, { "Apps/Meds.md": { fm: meds } });
  await settle();
  assert.equal(all.root.querySelectorAll(".na-panel").length, 2);
  assert.equal(text(all.root.querySelector(".na-description")), "Log when I take my meds");

  const unknown = embed({ app: "[[Meds]]", panels: ["Took meds", "Refills"] }, { "Apps/Meds.md": { fm: meds } });
  await settle();
  assert.deepEqual([...unknown.root.querySelectorAll(".na-error li")].map(text),
    ['panels: [[Meds]] has no panel called "Refills" (it has Took meds, Doses today)']);
  assert.equal(unknown.root.querySelectorAll(".na-panel").length, 1);
});

test("an embed of an app that can't be found says so, and draws once the note appears", async () => {
  const t = embed({ app: "[[Later]]" }, {});
  await settle();
  assert.equal(text(t.root.querySelector(".na-error")), "Can't find [[Later]]");
  t.f.files.set("Apps/Later.md", { fm: { app: "Later", view: "countdown", to: "2026-11-25" } });
  t.changed("Apps/Later.md");
  await settle();
  assert.equal(t.root.querySelector(".na-error"), null);
  assert.equal(text(t.root.querySelector(".na-big")), "7days");
  t.app.dispose();
  assert.equal(t.root.children.length, 0);
});

test("an embed drawn again keeps its input values and selections while its note is open", async () => {
  const value = {
    inputs: { period: ["week", "month"] },
    panels: [
      { view: "list", source: "log", title: "Log", item: "{what}", select: "entry" },
      { view: "text", text: "$entry.what this $period" },
    ],
  };
  const t = embed(value, { [`${HOST.replace(".md", "")} data.md`]: { fm: { log: [{ what: "ran" }, { what: "swam" }] } } });
  t.app.dispose();
  const first = t.draw("k");
  await settle();
  choose(t.root.querySelector(".na-inputs select")!, "month");
  (t.root.querySelectorAll(".na-view-list li")[1] as HTMLElement).click();
  await settle();
  assert.equal(text(t.root.querySelector(".na-text")), "swam this month");
  first.dispose();
  t.draw("k");
  await settle();
  assert.equal(text(t.root.querySelector(".na-text")), "swam this month");
  // Once the note is closed, its embeds start afresh.
  t.memories.keepOnly(new Set(["Other.md"]));
  t.root.empty();
  t.draw("k");
  await settle();
  assert.equal(text(t.root.querySelector(".na-waiting")), "Pick a row in “Log”");
});

test("a renamed or deleted note takes its embeds' grants along", () => {
  const grants = { "A.md": "net:x", "A.md#k1": "net:y", "A.md#k2": "", "AB.md#k3": "net:z", "B.md": "net:w" };
  assert.equal(moveGrants(grants, "A.md", "C.md"), true);
  assert.deepEqual(grants, { "AB.md#k3": "net:z", "B.md": "net:w", "C.md": "net:x", "C.md#k1": "net:y", "C.md#k2": "" });
  assert.equal(dropGrants(grants, "C.md"), true);
  assert.deepEqual(grants, { "AB.md#k3": "net:z", "B.md": "net:w" });
  assert.equal(dropGrants(grants, "Nope.md"), false);
});
