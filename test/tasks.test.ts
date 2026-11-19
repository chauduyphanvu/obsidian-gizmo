import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { parseTasks, tickLine } from "../src/sources/tasks.ts";
import { checkPanel, readSpec, type Panel } from "../src/spec.ts";
import { describePermission, editPermissions, permissionsOf } from "../src/permissions.ts";
import { rowKey } from "../src/views/common.ts";
import { editErrors } from "../src/edit.ts";
import { fakeEnv, fakeHost } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12);
const FILES = { appPath: "Apps/T.md", dataPath: "Apps/T data.md" };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const lines = (...l: string[]) => l.join("\n");

test("a task is a list item with a checkbox: any indent, bullet or number, any status character", () => {
  const text = lines(
    "- [ ] plain",
    "* [x] star, done",
    "+ [X] plus, done in capitals",
    "1. [ ] numbered",
    "12) [/] numbered with a parenthesis, in progress",
    "    - [-] indented, cancelled",
    "\t- [>] tab-indented, forwarded   ",
    "-  [ ] two spaces after the bullet",
    "- [ ]",
    "- [] no status",
    "-[ ] no space after the bullet",
    "- [ ]no space after the box",
    "- [ab] two characters",
    "Some text - [ ] not at the start",
    "- [ ] ",
  );
  assert.deepEqual(parseTasks(text).map((t) => [t.line, t.status, t.done, t.text]), [
    [0, " ", false, "plain"],
    [1, "x", true, "star, done"],
    [2, "X", true, "plus, done in capitals"],
    [3, " ", false, "numbered"],
    [4, "/", false, "numbered with a parenthesis, in progress"],
    [5, "-", false, "indented, cancelled"],
    [6, ">", false, "tab-indented, forwarded"],
    [7, " ", false, "two spaces after the bullet"],
    [14, " ", false, ""],
  ]);
});

test("lines in the frontmatter or in a code block aren't tasks; line numbers count from the top of the file", () => {
  const text = lines(
    "---",
    "status: active",
    "- [ ] a list in the frontmatter",
    "---",
    "- [ ] first",
    "```md",
    "- [ ] in a code block",
    "```",
    "~~~~",
    "- [ ] in a tilde block",
    "~~~",
    "- [ ] still inside: a shorter fence doesn't close it",
    "~~~~",
    "Inline ```code``` doesn't open a block",
    "  ```",
    "  - [ ] in an indented block",
    "  ```",
    "- [x] last",
  );
  assert.deepEqual(parseTasks(text).map((t) => [t.line, t.text]), [[4, "first"], [17, "last"]]);
  // Without a closing line, the dashes are just a rule and the lines after it count.
  assert.deepEqual(parseTasks(lines("---", "- [ ] after a rule")).map((t) => t.line), [1]);
  assert.deepEqual(parseTasks(lines("- [ ] windows\r", "- [x] line ends\r")).map((t) => [t.text, t.done]), [["windows", false], ["line ends", true]]);
});

test("due comes from 📅 or due::, whichever comes first; tags are those on the line", () => {
  const text = lines(
    "- [ ] Order timber 📅 2026-11-20 #shopping",
    "- [ ] Hire a mixer [due:: 2026-11-24] #garden/shed #garden",
    "- [ ] Both due:: 2026-12-01 then 📅 2026-12-05",
    "- [ ] No date, issue #123 and C# aren't tags, #2026plan is",
    "- [ ] 📅2026-11-30 without a space",
  );
  assert.deepEqual(parseTasks(text).map((t) => [t.due, t.tags]), [
    ["2026-11-20", ["#shopping"]],
    ["2026-11-24", ["#garden/shed", "#garden"]],
    ["2026-12-01", []],
    [null, ["#2026plan"]],
    ["2026-11-30", []],
  ]);
  // The markers stay in the text, since people read them.
  assert.equal(parseTasks(text)[0].text, "Order timber 📅 2026-11-20 #shopping");
});

test("tickLine changes only the status character of the task on that line", () => {
  const text = lines("# Shed", "- [ ] Order timber", "  - [ ] Hire a mixer", "- [x] Measure");
  assert.equal(tickLine(text, 2, "Hire a mixer", true), lines("# Shed", "- [ ] Order timber", "  - [x] Hire a mixer", "- [x] Measure"));
  assert.equal(tickLine(text, 3, "Measure", false), lines("# Shed", "- [ ] Order timber", "  - [ ] Hire a mixer", "- [ ] Measure"));
  // Already as asked: nothing to change.
  assert.equal(tickLine(text, 3, "Measure", true), text);
  // Any other status becomes done or open.
  assert.equal(tickLine("1) [/] Draw plans\r\n", 0, "Draw plans", true), "1) [x] Draw plans\r\n");
  assert.equal(tickLine("- [-] Cancelled", 0, "Cancelled", false), "- [ ] Cancelled");
});

test("tickLine finds a task that moved, and refuses when unsure", () => {
  const moved = lines("New line above", "# Shed", "- [ ] Order timber", "- [ ] Hire a mixer");
  assert.equal(tickLine(moved, 2, "Hire a mixer", true), lines("New line above", "# Shed", "- [ ] Order timber", "- [x] Hire a mixer"));
  // Two others read the same: which one is meant can't be known.
  const twice = lines("- [ ] Water plants", "- [ ] Feed cat", "- [ ] Water plants");
  assert.equal(tickLine(twice, 1, "Water plants", true), undefined);
  // On its own line, a duplicate elsewhere doesn't matter.
  assert.equal(tickLine(twice, 2, "Water plants", true), lines("- [ ] Water plants", "- [ ] Feed cat", "- [x] Water plants"));
  // The task was reworded, or its line is no longer a task: nothing is written.
  assert.equal(tickLine(lines("- [ ] Order oak timber"), 0, "Order timber", true), undefined);
  assert.equal(tickLine(lines("Order timber"), 0, "Order timber", true), undefined);
  assert.equal(tickLine(lines("```", "- [ ] Order timber", "```"), 1, "Order timber", true), undefined);
  assert.equal(tickLine("", 5, "Order timber", true), undefined);
});

test("rows carry the note and line; a row is told apart by both", async () => {
  const f = fakeHost({
    "Projects/Shed.md": { fm: { status: "active" }, body: lines("# Shed", "- [ ] Order timber 📅 2026-11-20 #shopping", "- [x] Measure") },
    "Projects/Taxes.md": { tags: ["#admin"], body: "- [ ] File the return" },
    "Inbox/Idea.md": { body: "- [ ] Not in scope" },
  });
  const p = checkPanel({ view: "table", source: "tasks", from: "Projects" }, true).panel as Panel;
  const rows = await new DataLayer(f.host).panelData(p.source, p, FILES, { ttlMs: 0, now: NOW }) as Record<string, unknown>[];
  assert.deepEqual(rows, [
    { text: "Order timber 📅 2026-11-20 #shopping", done: false, status: " ", path: "Projects/Shed.md", name: "Shed", line: 1, due: "2026-11-20", tags: ["#shopping"] },
    { text: "Measure", done: true, status: "x", path: "Projects/Shed.md", name: "Shed", line: 2, due: null, tags: [] },
    { text: "File the return", done: false, status: " ", path: "Projects/Taxes.md", name: "Taxes", line: 0, due: null, tags: [] },
  ]);
  assert.deepEqual(rows.map(rowKey), ["Projects/Shed.md:1", "Projects/Shed.md:2", "Projects/Taxes.md:0"]);
  const byTag = checkPanel({ view: "list", source: "tasks", from: "#admin", where: { done: false } }, true).panel as Panel;
  assert.deepEqual((await new DataLayer(f.host).panelData(byTag.source, byTag, FILES, { ttlMs: 0, now: NOW }) as { text: string }[]).map((r) => r.text), ["File the return"]);
});

test("each note is read once; a change re-reads only that note", async () => {
  const notes = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`Projects/p${i}.md`, { body: `- [ ] task ${i}` }]));
  const f = fakeHost(notes);
  const read: string[] = [];
  const readFile = f.host.readFile;
  f.host.readFile = (path) => { read.push(path); return readFile(path); };
  const dl = new DataLayer(f.host);
  const p = checkPanel({ view: "number", source: "tasks", from: "Projects", where: { done: true } }, true).panel as Panel;
  const load = async () => (await dl.panelData(p.source, p, FILES, { ttlMs: 0, now: NOW }) as unknown[]).length;
  assert.equal(await load(), 0);
  assert.equal(read.length, 2000);
  await load();
  assert.equal(read.length, 2000);
  f.files.get("Projects/p7.md")!.body = "- [x] task 7";
  dl.fileChanged("Projects/p7.md");
  assert.equal(await load(), 1);
  assert.deepEqual(read.slice(2000), ["Projects/p7.md"]);
  // A deleted note's tasks go with it.
  f.files.delete("Projects/p7.md");
  dl.fileDeleted("Projects/p7.md");
  assert.equal(await load(), 0);
  assert.equal(read.length, 2001);
});

test("a change to a note's text alone reloads the panels reading its tasks", async () => {
  const fm = { app: "Tasks", panels: [{ view: "list", source: "tasks", from: "Projects", item: "{text}" }] };
  const t = fakeEnv({ "Apps/T.md": { fm }, "Projects/Shed.md": { fm: { status: "active" }, body: "- [ ] Order timber" } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/T.md", t.env).load();
  await settle();
  assert.deepEqual([...root.querySelectorAll("li")].map((li) => li.textContent), ["Order timber"]);
  // The frontmatter stays the same; only the body gains a line.
  t.f.files.get("Projects/Shed.md")!.body = lines("- [ ] Order timber", "- [ ] Hire a mixer");
  t.changed("Projects/Shed.md");
  await settle();
  assert.deepEqual([...root.querySelectorAll("li")].map((li) => li.textContent), ["Order timber", "Hire a mixer"]);
});

test("tasks need from, read their scope, and tick lines with their own permission", () => {
  assert.deepEqual(checkPanel({ view: "list", source: "tasks" }, true).errors, ['source "tasks" needs "from" (a #tag or folder)']);
  const r = readSpec({
    app: "x",
    data: { work: { source: "tasks", from: "Projects" } },
    panels: [
      { view: "table", source: "work", where: { done: false }, columns: ["text", "done"], edit: ["done"] },
      { view: "number", source: "tasks", from: "#errand" },
    ],
  }, { path: "Apps/X.md" })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Apps/X.md"), ["read:#errand", "read:Projects", "tasks:Projects"]);
  assert.equal(describePermission("tasks:Projects"), "Tick tasks in notes in Projects");
  assert.equal(describePermission("read:Projects"), "Read notes in Projects");
});

test("only done can be edited on tasks, and a block can't be named tasks", () => {
  const p = { view: "table", source: "tasks", from: "Projects" } as Panel;
  assert.deepEqual(editErrors(p, ["done"]), []);
  assert.deepEqual(editErrors(p, ["done", "text"]), ['edit: only "done" can be changed on tasks']);
  assert.deepEqual(editErrors({ ...p, compute: { done: "true" } }, ["done"]), ['edit: "done" is computed']);
  assert.deepEqual(editPermissions(p, "edit"), [["tasks:Projects", "edit"]]);
  const r = readSpec({ app: "x", data: { tasks: { source: "chores" } }, panels: [{ view: "list", source: "chores" }] })!;
  assert.deepEqual(r.errors, ['data: "tasks" can\'t be a name; source: tasks already means tasks in notes']);
  assert.deepEqual(readSpec({ app: "x", panels: [{ view: "table", source: "tasks", from: "P", columns: ["text", "due"], edit: ["due"] }] })!.errors,
    ['panel 1: edit: only "done" can be changed on tasks']);
});

function openTasks(body: string) {
  const fm = { app: "Tasks", panels: [{ view: "table", source: "tasks", from: "Projects", columns: ["text", "done"], edit: ["done"] }] };
  const t = fakeEnv({ "Apps/T.md": { fm }, "Projects/Shed.md": { body } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/T.md", t.env).load();
  return { ...t, root };
}

test("ticking a task writes its status character; the table updates in place", async () => {
  const { root, f, writes, notices } = openTasks(lines("# Shed", "- [ ] Order timber", "\t- [ ] Hire a mixer #garden", "- [x] Measure"));
  await settle();
  const tbody = root.querySelector("tbody")!;
  const boxes = [...tbody.querySelectorAll("input")] as HTMLInputElement[];
  assert.deepEqual(boxes.map((b) => [b.type, b.checked]), [["checkbox", false], ["checkbox", false], ["checkbox", true]]);
  boxes[1].checked = true;
  change(boxes[1]);
  await settle();
  assert.deepEqual(writes, ["Projects/Shed.md"]);
  assert.equal(f.files.get("Projects/Shed.md")!.body, lines("# Shed", "- [ ] Order timber", "\t- [x] Hire a mixer #garden", "- [x] Measure"));
  assert.equal(root.querySelector("tbody"), tbody, "patched in place, not redrawn");
  assert.equal(boxes[1].checked, true);
  boxes[2].checked = false;
  change(boxes[2]);
  await settle();
  assert.equal(f.files.get("Projects/Shed.md")!.body, lines("# Shed", "- [ ] Order timber", "\t- [x] Hire a mixer #garden", "- [ ] Measure"));
  assert.deepEqual(notices, []);
});

test("a task that moved is still ticked; one that changed isn't, and the panel shows the note as it is", async () => {
  const { root, f, writes, notices } = openTasks(lines("- [ ] Order timber", "- [ ] Hire a mixer"));
  await settle();
  // Someone adds a line above without the app hearing of it yet.
  f.files.get("Projects/Shed.md")!.body = lines("- [ ] Call the council", "- [ ] Order timber", "- [ ] Hire a mixer");
  const mixer = root.querySelectorAll("tbody input")[1] as HTMLInputElement;
  mixer.checked = true;
  change(mixer);
  await settle();
  assert.equal(f.files.get("Projects/Shed.md")!.body, lines("- [ ] Call the council", "- [ ] Order timber", "- [x] Hire a mixer"));
  assert.deepEqual(notices, []);
  assert.deepEqual([...root.querySelectorAll("tbody tr")].map((tr) => tr.textContent), ["Call the council", "Order timber", "Hire a mixer"]);

  // Now the timber task is reworded behind the app's back: nothing is written.
  f.files.get("Projects/Shed.md")!.body = lines("- [ ] Call the council", "- [ ] Order oak timber", "- [x] Hire a mixer");
  const before = writes.length;
  const shown = [...root.querySelectorAll("tbody input")] as HTMLInputElement[];
  shown[1].checked = true;
  change(shown[1]);
  await settle();
  assert.equal(writes.length, before);
  assert.deepEqual(notices, ["That task has changed; reload"]);
  assert.equal(f.files.get("Projects/Shed.md")!.body, lines("- [ ] Call the council", "- [ ] Order oak timber", "- [x] Hire a mixer"));
  // The fake vault didn't announce the edit, so the note's parse is still the old one; the panel
  // reloads what the data layer knows, and the box is put back.
  assert.equal((root.querySelectorAll("tbody input")[1] as HTMLInputElement).checked, false);
});

test("a task outside the panel's scope is never written", async () => {
  const { root, f, data, writes } = openTasks("- [ ] Order timber");
  await settle();
  const box = root.querySelector("tbody input") as HTMLInputElement;
  // The note moves out of the scope; the app hasn't heard of it yet (no flush).
  f.files.set("Inbox/Shed.md", f.files.get("Projects/Shed.md")!);
  f.files.delete("Projects/Shed.md");
  data.fileRenamed("Inbox/Shed.md", "Projects/Shed.md");
  box.checked = true;
  change(box);
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(f.files.get("Inbox/Shed.md")!.body, "- [ ] Order timber");
});
