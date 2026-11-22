import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ActivityLog, MAX_PER_APP, describeActor, describeChange, eventsOf, undoEntry, undoMessage, undoneIn, type Entry,
} from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { fakeBackground, fakeEnv, savedAt } from "./support/fakes.ts";

const APP = "Apps/W.md";
const DATA = "Apps/W data.md";
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const click = (el: Element) => event(el, "click");
const change = (el: Element) => event(el, "change");
const submit = (el: Element) => el.dispatchEvent(new window.Event("submit"));
const panels = (root: Element) => [...root.querySelectorAll(".gz-panel")];

type Notes = Parameters<typeof fakeEnv>[0];
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

function open(fm: Record<string, unknown>, notes: Notes = {}) {
  const t = fakeEnv({ [APP]: { fm }, ...notes });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, APP, t.env);
  started.push(c);
  c.load();
  const entries = () => t.activity.list(APP);
  const undoLatest = async () => {
    const [latest] = await entries();
    const r = await undoEntry(latest, t.undoIO);
    await t.activity.setUndone(latest.id, r.undone);
    return r;
  };
  return { ...t, root, entries, undoLatest };
}

const data = (f: ReturnType<typeof fakeEnv>["f"], key: string) => f.files.get(DATA)?.fm?.[key];

test("a form's save is kept as what you did, in words, and undoing it takes the row out again", async () => {
  const fm = { app: "W", panels: [{ view: "form", title: "Weigh in", fields: { kg: "number" }, save: "weights" }] };
  const t = open(fm, { [DATA]: { fm: { weights: [{ kg: 80, at: "2026-11-17T08:00" }] } } });
  await settle();
  (t.root.querySelector("input") as HTMLInputElement).value = "79.4";
  submit(t.root.querySelector("form")!);
  await settle();
  assert.deepEqual(data(t.f, "weights"), [{ kg: 80, at: "2026-11-17T08:00" }, { kg: 79.4, at: savedAt("2026-11-18T12:00") }]);
  const [entry] = await t.entries();
  assert.equal(entry.actor, "you");
  assert.equal(entry.what, "Weigh in");
  assert.deepEqual(entry.changes.map(describeChange), ["Saved kg 79.4 to weights in W data"]);

  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.deepEqual(data(t.f, "weights"), [{ kg: 80, at: "2026-11-17T08:00" }]);
  const [after] = await t.entries();
  assert.equal(after.undone, 1);
  // Nothing is left to undo, so a second undo changes nothing.
  assert.deepEqual(await undoEntry(after, t.undoIO), { undone: 1, total: 1 });
  assert.deepEqual(data(t.f, "weights"), [{ kg: 80, at: "2026-11-17T08:00" }]);
});

test("an undo after the data note was edited by hand takes the row out of the app's data, and leaves the edited note alone", async () => {
  const fm = { app: "W", panels: [{ view: "button", label: "Coffee", save: "cups" }] };
  const t = open(fm);
  await settle();
  click(t.root.querySelector("button")!);
  await settle();
  (data(t.f, "cups") as Record<string, unknown>[])[0].note = "decaf";
  t.changed(DATA);
  await settle();
  const writes = t.writes.length;
  const r = await t.undoLatest();
  assert.deepEqual(r, { undone: 1, total: 1 });
  assert.deepEqual((await t.data.ledger!.state(DATA)).lists.get("cups")!.rows, []);
  assert.equal(t.writes.length, writes, "the note isn't rewritten over the hand edit, which waits for Import or Discard");
  assert.deepEqual(data(t.f, "cups"), [{ at: savedAt("2026-11-18T12:00"), note: "decaf" }]);
});

test("a run that added a line and saved a row is undone newest first, and stops where the vault changed", async () => {
  const fm = { app: "W", panels: [{ view: "form", title: "Walk", fields: { km: "number" }, save: "walks", append: "Daily", line: "- walked {km} km" }] };
  const t = open(fm, { "Daily.md": { body: "# Today\n" } });
  await settle();
  (t.root.querySelector("input") as HTMLInputElement).value = "3";
  submit(t.root.querySelector("form")!);
  await settle();
  assert.equal(t.f.files.get("Daily.md")!.body, "# Today\n- walked 3 km\n");
  const [entry] = await t.entries();
  assert.deepEqual(entry.changes.map(describeChange), ["Added to Daily the line “- walked 3 km”", "Saved km 3 to walks in W data"]);

  t.f.files.get("Daily.md")!.body = "# Today\n- walked 3 km, then ran\n";
  const r = await t.undoLatest();
  assert.deepEqual(r, { undone: 1, total: 2, refusal: "the line it added to Daily has changed or is gone" });
  assert.equal(undoMessage(r), "Undid 1 of 2, then stopped: the line it added to Daily has changed or is gone");
  assert.deepEqual(data(t.f, "walks"), []);

  // Put back as it was written, the rest can be undone where it stopped.
  t.f.files.get("Daily.md")!.body = "# Today\n- walked 3 km\nlater\n";
  assert.deepEqual(await t.undoLatest(), { undone: 2, total: 2 });
  assert.equal(t.f.files.get("Daily.md")!.body, "# Today\nlater\n");
});

test("a line that created its note takes the note away when undone, unless the note has more in it now", async () => {
  const fm = { app: "W", panels: [{ view: "button", label: "Note it", append: "Log/New", line: "- noted" }] };
  const t = open(fm);
  await settle();
  click(t.root.querySelector("button")!);
  await settle();
  const [entry] = await t.entries();
  assert.deepEqual(entry.changes.map(describeChange), ["Created New with the line “- noted”"]);
  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.equal(t.f.files.has("Log/New.md"), false);

  click(t.root.querySelector("button")!);
  await settle();
  t.f.files.get("Log/New.md")!.body += "- mine\n";
  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.equal(t.f.files.get("Log/New.md")!.body, "- mine\n");
});

test("a note saved into a folder is trashed by undo only while it's as the app wrote it", async () => {
  const fm = { app: "W", panels: [{ view: "form", title: "New book", fields: { name: "text" }, save: "Books/" }] };
  const t = open(fm);
  await settle();
  const add = async (name: string) => {
    (t.root.querySelector("input") as HTMLInputElement).value = name;
    submit(t.root.querySelector("form")!);
    await settle();
  };
  await add("Emma");
  const [entry] = await t.entries();
  assert.deepEqual(entry.changes.map(describeChange), ["Created the note Emma"]);
  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.equal(t.f.files.has("Books/Emma.md"), false);

  await add("Persuasion");
  t.f.files.get("Books/Persuasion.md")!.fm!.rating = 5;
  const r = await t.undoLatest();
  assert.deepEqual(r, { undone: 0, total: 1, refusal: "Persuasion has been changed since; delete it yourself if you mean to" });
  assert.ok(t.f.files.has("Books/Persuasion.md"));
});

test("an edit in a table, of a saved row or of a note, is kept with what it was, and undone back to it", async () => {
  const fm = {
    app: "W",
    data: { books: { source: "notes", from: "Books" } },
    panels: [
      { view: "table", title: "Chores", source: "chores", columns: ["task", "done"], edit: ["done"] },
      { view: "table", title: "Books", source: "books", columns: ["name", "rating"], edit: ["rating"] },
    ],
  };
  const t = open(fm, {
    [DATA]: { fm: { chores: [{ task: "bins", done: false }, { task: "dishes", done: false }] } },
    "Books/Emma.md": { fm: { rating: 3 } },
  });
  await settle();
  const [chores, books] = panels(t.root);
  const box = chores.querySelectorAll("tbody tr")[1].querySelector("input") as HTMLInputElement;
  box.checked = true;
  change(box);
  await settle();
  const rating = books.querySelector("tbody tr input") as HTMLInputElement;
  rating.value = "5";
  change(rating);
  await settle();
  const [edited, choreEdit] = await t.entries();
  assert.deepEqual([choreEdit, edited].map((e) => [e.what, ...e.changes.map(describeChange)]), [
    ["Chores", "Changed done from false to true in chores in W data"],
    ["Books", "Set rating of Emma to 5 (was 3)"],
  ]);
  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.equal(t.f.files.get("Books/Emma.md")!.fm!.rating, 3);
  const r = await undoEntry(choreEdit, t.undoIO);
  assert.deepEqual(r, { undone: 1, total: 1 });
  assert.deepEqual(data(t.f, "chores"), [{ task: "bins", done: false }, { task: "dishes", done: false }]);
});

test("ticking a checklist item, clearing the list, and ticking a task are each undone", async () => {
  const fm = {
    app: "W",
    panels: [
      { view: "checklist", title: "Packing", items: ["passport", "charger"] },
      { view: "table", title: "Tasks", source: "tasks", from: "Tasks", columns: ["text", "done"], edit: ["done"] },
    ],
  };
  const t = open(fm, { "Tasks/Home.md": { fm: {}, body: "- [ ] Buy stamps\n" } });
  await settle();
  const [packing, tasks] = panels(t.root);
  const passport = packing.querySelector('input[type="checkbox"]') as HTMLInputElement;
  passport.checked = true;
  change(passport);
  await settle();
  assert.deepEqual((await t.entries())[0].changes.map(describeChange), ["Ticked “passport”"]);
  assert.equal((await t.entries())[0].what, "Packing", "named by its panel, not the list it ticks into");
  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.deepEqual(data(t.f, "checked"), []);

  const task = tasks.querySelector('tbody tr input[type="checkbox"]') as HTMLInputElement;
  task.checked = true;
  change(task);
  await settle();
  assert.equal(t.f.files.get("Tasks/Home.md")!.body, "- [x] Buy stamps\n");
  assert.deepEqual((await t.entries())[0].changes.map(describeChange), ["Ticked “Buy stamps” in Home"]);
  assert.deepEqual(await t.undoLatest(), { undone: 1, total: 1 });
  assert.equal(t.f.files.get("Tasks/Home.md")!.body, "- [ ] Buy stamps\n");
});

test("shortcuts and links are kept as theirs; what record samples isn't kept", async () => {
  const KP = "https://example.com/kp.json";
  const t = fakeBackground({
    "Apps/Meds.md": { fm: { app: "Meds", panels: [{ view: "button", label: "Took meds", save: "doses", shortcut: "took" }] } },
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: { source: KP, limit: 1, record: "1h" } }, panels: [{ view: "number", source: "kp", field: "v" }] } },
  }, { [KP]: [{ v: 3 }] });
  await t.bg.start();
  await t.bg.runCommand("Apps/Meds.md:took");
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "took" });
  assert.deepEqual(t.f.files.get("Apps/Kp data.md")?.fm?.kp_log, [{ at: savedAt("2026-11-18T12:00"), v: 3 }]);
  const all = await t.activity.list();
  assert.deepEqual(all.map((e) => [e.app, describeActor(e.actor), e.what]), [["Apps/Meds.md", "A link", "Took meds"], ["Apps/Meds.md", "A shortcut", "Took meds"]]);
});

/** A log kept in memory, with a clock that moves a minute per entry. */
function memoryLog(start?: string) {
  const kept = { text: start };
  let clock = Date.UTC(2026, 10, 18);
  const log = new ActivityLog({ read: async () => kept.text, write: async (text) => { kept.text = text; } }, () => (clock += 60_000));
  return { log, kept };
}
const row = (n: number) => ({ kind: "row-added" as const, path: "A data.md", list: "l", row: { n } });

test("the log keeps a few hundred runs per app, survives a restart, and follows a renamed note", async () => {
  const { log, kept } = memoryLog();
  assert.equal(await log.add({ app: "A.md", actor: "you", what: "x", changes: [] }), undefined, "a run that changed nothing isn't kept");
  for (let i = 0; i < MAX_PER_APP + 5; i++) await log.add({ app: "A.md", actor: "you", what: "x", changes: [row(i)] });
  await log.add({ app: "B.md", actor: "trigger:A", what: "y", changes: [{ kind: "property", path: "A data.md", field: "f", from: 1, to: 2, had: true }] });
  const a = await log.list("A.md");
  assert.equal(a.length, MAX_PER_APP);
  assert.deepEqual((a[0].changes[0] as { row: unknown }).row, { n: MAX_PER_APP + 4 }, "newest first");
  assert.equal(describeActor((await log.list("B.md"))[0].actor), "Triggered by A");

  await log.rename("A.md", "Apps/A.md");
  await log.rename("A data.md", "Apps/A data.md");
  const again = new ActivityLog({ read: async () => kept.text, write: async () => {} });
  const moved = await again.list("Apps/A.md");
  assert.equal(moved.length, MAX_PER_APP);
  assert.equal(moved[0].changes[0].path, "Apps/A data.md");
  assert.equal((await again.list("B.md"))[0].changes[0].path, "Apps/A data.md");
  assert.deepEqual(await new ActivityLog({ read: async () => "not json", write: async () => {} }).list(), [], "a log that can't be read starts empty");
});

test("each change reads as a sentence", () => {
  const sentences = ([
    { kind: "row-added", path: "Apps/Budget data.md", list: "spend", row: { amount: 12, what: "coffee", where: "cafe", tip: 1, at: "x" } },
    { kind: "row-edited", path: "Apps/W data.md", list: "chores", row: {}, field: "done", from: false, to: true },
    { kind: "checklist", path: "x", list: "checked", item: "passport", checked: false },
    { kind: "cleared", path: "x", list: "checked", items: ["a", "b"] },
    { kind: "property", path: "Books/Emma.md", field: "status", from: undefined, to: "read", had: false },
    { kind: "line-added", path: "Daily.md", line: "- walked", created: false },
    { kind: "note-created", path: "Books/Emma.md", hash: "" },
    { kind: "task", path: "Tasks/Home.md", line: 0, text: "Buy stamps", done: false },
  ] satisfies Entry["changes"]).map(describeChange);
  assert.deepEqual(sentences, [
    "Saved amount 12, what coffee, where cafe, … to spend in Budget data",
    "Changed done from false to true in chores in W data",
    "Unticked “passport”",
    "Cleared 2 ticked items",
    "Set status of Emma to read",
    "Added to Daily the line “- walked”",
    "Created the note Emma",
    "Unticked “Buy stamps” in Home",
  ]);
});

test("a saved row's numbers read as they were saved, not rounded", () => {
  const said = ([
    { kind: "row-added", path: "Kinds/Spend data.md", list: "spend", row: { amount: 11.99, note: "SPOTIFY USA" } },
    { kind: "row-added", path: "Kinds/Spend data.md", list: "spend", row: { amount: 132.47, note: "HARDWARE DEPOT" } },
    { kind: "row-added", path: "Kinds/Spend data.md", list: "spend", row: { amount: 1450, note: "OAKWOOD" } },
  ] satisfies Entry["changes"]).map(describeChange);
  assert.deepEqual(said, [
    "Saved amount 11.99, note SPOTIFY USA to spend in Spend data",
    "Saved amount 132.47, note HARDWARE DEPOT to spend in Spend data",
    "Saved amount 1450, note OAKWOOD to spend in Spend data",
  ]);
});

test("another device's entry kept as ledger events can be undone here, and shows undone wherever it was undone", async () => {
  const fm = { app: "W", panels: [{ view: "button", label: "Coffee", save: "cups" }] };
  const t = open(fm);
  await settle();
  click(t.root.querySelector("button")!);
  await settle();
  const [mine] = await t.entries();
  // The same entry as another device would list it: its own log, read here.
  const theirs: Entry = { ...mine, device: "iPhone" };
  assert.deepEqual(eventsOf(theirs), [{ path: DATA, event: (mine.changes[0] as { event: string }).event }]);
  const undoneNow = async () => {
    const undone = (await t.data.ledger!.state(DATA)).undone;
    return undoneIn(theirs, (p) => (p === DATA ? undone : new Set()));
  };
  assert.equal(await undoneNow(), 0);
  assert.deepEqual(await undoEntry(theirs, t.undoIO), { undone: 1, total: 1 });
  assert.equal(await undoneNow(), 1);
  assert.deepEqual(data(t.f, "cups"), []);
  // A change not kept as an event (a line added to a note) stays the other device's to undo.
  assert.equal(eventsOf({ ...theirs, changes: [{ kind: "line-added", path: "Daily.md", line: "x", created: false }] }), undefined);
});
