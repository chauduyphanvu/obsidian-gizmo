import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { readSpec } from "../src/spec.ts";
import { permissionsOf } from "../src/permissions.ts";
import { fakeBackground, fakeEnv, raw } from "./support/fakes.ts";
import { vaultNote } from "./support/yaml.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const key = (el: Element, name: string) => {
  const e = new window.Event("keydown", { bubbles: true }) as Event & { key: string };
  e.key = name;
  el.dispatchEvent(e);
};
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

const SEARCH = "https://openlibrary.org/search.json";
const DOCS = {
  numFound: 2,
  docs: [
    { key: "/works/OL893415W", title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, edition_count: 81 },
    { key: "/works/OL893527W", title: "Dune Messiah", author_name: ["Frank Herbert"], first_publish_year: 1969, edition_count: 52 },
  ],
};

/** The Books folder of the test vault, as notes. */
function books() {
  const names = readdirSync(new URL("./vault/Books", import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => [`Books/${n}`, { fm: vaultNote(`Books/${n}`).fm }]));
}

test("no two notes in the test vault share a name, so every [[link]] means one note", () => {
  const names = (readdirSync(new URL("./vault", import.meta.url), { recursive: true }) as string[]).filter((n) => n.endsWith(".md")).map((n) => n.replace(/^.*\//, ""));
  assert.ok(names.length > 20);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});

/** Everything a test started, stopped afterwards: an app that refreshes keeps its timer, and the process, alive. */
const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** Draws an app as its tab would, stopped after the test. */
function mount(root: HTMLElement, path: string, env: ReturnType<typeof fakeEnv>["env"]) {
  const controller = new AppController(root, path, env);
  started.push(controller);
  controller.load();
}

function openApp(path: string, notes: Parameters<typeof fakeEnv>[0], responses: Record<string, unknown> = {}) {
  const t = fakeEnv({ [path]: { fm: vaultNote(path).fm }, ...notes }, responses);
  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  return { ...t, root };
}

test("Library: search Open Library, read about a pick, add it to Books, set its status, finish it toward the year's goal", async () => {
  const spec = readSpec(vaultNote("Apps/Library.md").fm, { path: "Apps/Library.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Library.md"), ["create:Books", "edit:Books", "net:openlibrary.org", "read:Books", "send:openlibrary.org|typed.q"]);

  const { root, f, notices } = openApp("Apps/Library.md", books(), { [SEARCH]: DOCS });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [results, about, goal, shelf] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(text(results.querySelector(".gz-waiting")), "Type in “q”");
  // Dune, Piranesi and The Overstory were finished this year; Middlemarch last December.
  assert.equal(text(goal.querySelector(".gz-big")), "3/ 24 books");
  assert.deepEqual([...shelf.querySelectorAll("th")].map((th) => text(th)), ["Book", "Author", "Status", "Finished"]);
  assert.equal(text(about.querySelector(".gz-waiting")), "Pick a row in “Search results”");
  assert.deepEqual([...shelf.querySelectorAll("tbody tr td:first-child")].map((td) => text(td)), ["Dune", "Middlemarch", "Piranesi", "The Overstory"]);

  const box = root.querySelector('.gz-inputs input[type="search"]') as HTMLInputElement;
  box.value = "dune";
  key(box, "Enter");
  await settle();
  assert.deepEqual(f.requests, ["https://openlibrary.org/search.json?q=dune&limit=10"]);
  const items = [...results.querySelectorAll("li")];
  assert.deepEqual(items.map((li) => text(li)), ["Dune · Frank HerbertAdd", "Dune Messiah · Frank HerbertAdd"]);

  (items[1] as HTMLElement).click();
  await settle();
  assert.equal(text(about.querySelector(".gz-text")), "Dune Messiah, by Frank Herbert. First published in 1969; 52 editions.");

  // Dune is already on the shelf; Dune Messiah isn't.
  (items[0].querySelector("button.gz-row-action") as HTMLButtonElement).click();
  await settle();
  (items[1].querySelector("button.gz-row-action") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(notices, ["“Dune” already exists", "Added Dune Messiah to Books"]);
  assert.deepEqual(f.files.get("Books/Dune Messiah.md")!.fm,
    { title: "Dune Messiah", author: "Frank Herbert", year: 1969, status: "to read", at: "2026-11-18T12:00" });
  const rows = [...shelf.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => text(tr.querySelector("td"))), ["Dune", "Dune Messiah", "Middlemarch", "Piranesi", "The Overstory"]);
  assert.equal(text(rows[1].querySelectorAll("td")[1]), "Frank Herbert");

  choose(rows[1].querySelector("select")!, "reading");
  await settle();
  assert.equal(f.files.get("Books/Dune Messiah.md")!.fm!.status, "reading");

  // Finished it: the date goes on the book's note and the goal moves.
  const finished = shelf.querySelectorAll("tbody tr")[1].querySelector('input[type="date"]') as HTMLInputElement;
  finished.value = "2026-11-17";
  finished.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(f.files.get("Books/Dune Messiah.md")!.fm!.finished, "2026-11-17");
  assert.equal(text(goal.querySelector(".gz-big")), "4/ 24 books");
});

test("Chores: a form shaped by the block saves chores; ticking one off moves it to done", async () => {
  const spec = readSpec(vaultNote("Apps/Chores.md").fm, { path: "Apps/Chores.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Chores.md"), []);

  const { root, f } = openApp("Apps/Chores.md", {});
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const form = root.querySelector("form.gz-form")!;
  assert.deepEqual([...form.querySelectorAll(".gz-field span")].map((s) => text(s)), ["task", "room", "done"]);
  (form.querySelector("input") as HTMLInputElement).value = "Water the plants";
  choose(form.querySelector("select")!, "garden");
  form.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(f.files.get("Apps/Chores data.md")!.fm!.chores, [{ task: "Water the plants", room: "garden", done: false, at: "2026-11-18T12:00" }]);
  const todo = root.querySelector(".gz-view-table")!;
  assert.equal(text(todo.querySelector("tbody tr")), "Water the plantsgarden");
  assert.equal(text(root.querySelector(".gz-view-number .gz-big")), "0");

  const tick = todo.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((f.files.get("Apps/Chores data.md")!.fm!.chores as { done: boolean }[])[0].done, true);
  assert.equal(text(todo.querySelector(".gz-empty")), "Nothing here yet.");
  assert.equal(text(root.querySelector(".gz-view-number .gz-big")), "1");
});

/** A file of the test vault that isn't a note: its text, as the vault would hand it over. */
const vaultFile = (path: string) => ({ raw: readFileSync(new URL(`./vault/${path}`, import.meta.url), "utf8") });

test("Bank: spending per month from the export; pick a transaction and flag it with a reason", async () => {
  const spec = readSpec(vaultNote("Apps/Bank.md").fm, { path: "Apps/Bank.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Bank.md"), ["read:Finance/bank.csv"]);

  const { root, f, changed } = openApp("Apps/Bank.md", { "Finance/bank.csv": vaultFile("Finance/bank.csv") });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [months, largest, flag, flagged] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(months.querySelectorAll(".gz-bar").length, 4);
  const rows = [...largest.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.slice(4).map((tr) => text(tr.querySelectorAll("td")[1])),
    ["Online Furniture Co", "Apple Store", 'Bistro "Le Chat", Elm Ave', "Whole Foods Market"]);
  assert.equal(text(flag.querySelector(".gz-waiting")), "Pick a row in “Largest transactions”");

  (rows[4] as HTMLElement).click();
  await settle();
  const form = root.querySelector("form.gz-form")!;
  (form.querySelector("input") as HTMLInputElement).value = "Too much for a shelf";
  form.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(f.files.get("Apps/Bank data.md")!.fm!.flagged,
    [{ description: "Online Furniture Co", amount: -489.99, date: "2026-10-24", reason: "Too much for a shelf", at: "2026-11-18T12:00" }]);
  assert.equal(text(flagged.querySelector("li")), "2026-10-24 · Online Furniture Co · -489.99 — Too much for a shelf");

  // A new export lands in the same file: the table follows it.
  f.files.set("Finance/bank.csv", { raw: `${vaultFile("Finance/bank.csv").raw}2026-11-18,Dentist,-900.00,Health\n` });
  changed("Finance/bank.csv");
  await settle();
  assert.equal(text(largest.querySelectorAll("tbody tr")[4].querySelectorAll("td")[1]), "Dentist");
});

const HN = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Hacker News: Front Page</title>
<item><title>Unreal Tournament 2004 in the Browser</title><link>https://ut2004.dev/</link><pubDate>Wed, 18 Nov 2026 20:29:00</pubDate><dc:creator>TheAceOfHearts</dc:creator><guid>https://news.ycombinator.com/item?id=2</guid></item>
<item><title>Show HN: A tiny &amp; fast parser</title><link>https://example.com/parser</link><pubDate>Wed, 18 Nov 2026 18:05:00</pubDate><dc:creator>jane</dc:creator><guid>https://news.ycombinator.com/item?id=1</guid></item>
</channel></rss>`;
const XKCD = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>xkcd.com</title><link href="https://xkcd.com/" rel="alternate"/>
<entry><title>Voyager Crash</title><link href="https://xkcd.com/3326/" rel="alternate"/><updated>2026-11-17T19:00:00</updated><id>https://xkcd.com/3326/</id></entry>
</feed>`;

test("Reading list: save an article from a feed as a note, then tick it off when read", async () => {
  const spec = readSpec(vaultNote("Apps/Reading list.md").fm, { path: "Apps/Reading list.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Reading list.md"),
    ["create:Reading", "edit:Reading", "net:hnrss.org", "net:xkcd.com", "read:Reading"]);

  const responses = { "https://hnrss.org/frontpage": raw(HN, "application/xml; charset=utf-8"), "https://xkcd.com/atom.xml": raw(XKCD, "text/xml; charset=UTF-8") };
  const { root, f, notices } = openApp("Apps/Reading list.md", {}, responses);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [hn, xkcd, saved] = [...root.querySelectorAll(".gz-panel")];
  assert.deepEqual([...hn.querySelectorAll("li")].map((li) => text(li)), ["Unreal Tournament 2004 in the BrowserSave", "Show HN: A tiny & fast parserSave"]);
  assert.deepEqual([...xkcd.querySelectorAll("li")].map((li) => text(li)), ["Voyager CrashSave"]);
  assert.equal(text(saved.querySelector(".gz-empty")), "Nothing here yet.");

  const save = (li: Element) => (li.querySelector("button.gz-row-action") as HTMLButtonElement).click();
  save(hn.querySelectorAll("li")[1]);
  await settle();
  save(xkcd.querySelector("li")!);
  await settle();
  // Saving the same article again is refused rather than overwriting the note.
  save(hn.querySelectorAll("li")[1]);
  await settle();
  assert.deepEqual(notices, ["Saved Show HN: A tiny & fast parser to Reading", "Saved Voyager Crash to Reading", "“Show HN A tiny & fast parser” already exists"]);
  assert.deepEqual(f.files.get("Reading/Show HN A tiny & fast parser.md")!.fm,
    { link: "https://example.com/parser", date: "2026-11-18T18:05", at: "2026-11-18T12:00" });
  assert.deepEqual(f.files.get("Reading/Voyager Crash.md")!.fm, { link: "https://xkcd.com/3326/", date: "2026-11-17T19:00", at: "2026-11-18T12:00" });

  const rows = [...saved.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => text(tr.querySelector("td"))), ["Show HN A tiny & fast parser", "Voyager Crash"]);
  const tick = rows[1].querySelector('input[type="checkbox"]') as HTMLInputElement;
  assert.equal(tick.checked, false);
  tick.checked = true;
  tick.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(f.files.get("Reading/Voyager Crash.md")!.fm!.read, true);
});

test("Week: the next seven days from a calendar file; log an item as done, or something that wasn't planned", async () => {
  const spec = readSpec(vaultNote("Apps/Week.md").fm, { path: "Apps/Week.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Week.md"), ["read:Calendar/family.ics"]);

  const { root, f, notices, changed } = openApp("Apps/Week.md", { "Calendar/family.ics": vaultFile("Calendar/family.ics") });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [agenda, form, done] = [...root.querySelectorAll(".gz-panel")];
  // Wed 18 Nov: the Thursday bins and Tuesday's swim practice (a weekly rule), not Thanksgiving on the 26th.
  assert.deepEqual([...agenda.querySelectorAll("li")].map((li) => text(li)), ["2026-11-19 · Bins outDone", "2026-11-24T17:30 · Swim practiceDone"]);
  assert.equal(text(done.querySelector(".gz-empty")), "Nothing here yet.");

  (agenda.querySelectorAll("li")[1].querySelector("button.gz-row-action") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(notices, ["Logged Swim practice"]);
  assert.deepEqual(f.files.get("Apps/Week data.md")!.fm!.done, [{ what: "Swim practice", planned: "2026-11-24T17:30", at: "2026-11-18T12:00" }]);

  (form.querySelector("input") as HTMLInputElement).value = "Called the plumber";
  form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual([...done.querySelectorAll("li")].map((li) => text(li)), ["2026-11-18T12:00 · Swim practice", "2026-11-18T12:00 · Called the plumber"]);

  // An event added to the calendar file today appears first.
  const ics = vaultFile("Calendar/family.ics").raw.replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:dentist\nDTSTART;VALUE=DATE:20261118\nSUMMARY:Dentist\nEND:VEVENT\nEND:VCALENDAR");
  f.files.set("Calendar/family.ics", { raw: ics });
  changed("Calendar/family.ics");
  await settle();
  assert.deepEqual([...agenda.querySelectorAll("li")].map((li) => text(li)),
    ["2026-11-18 · DentistDone", "2026-11-19 · Bins outDone", "2026-11-24T17:30 · Swim practiceDone"]);
});

const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

/** The Projects folder of the test vault, as notes. */
function projects() {
  const names = readdirSync(new URL("./vault/Projects", import.meta.url)).filter((n) => n.endsWith(".md")).sort();
  return Object.fromEntries(names.map((n) => [`Projects/${n}`, { fm: vaultNote(`Projects/${n}`).fm }]));
}

test("Projects: drag projects along a board, see the schedule, pick one, see what is due", async () => {
  const spec = readSpec(vaultNote("Apps/Projects.md").fm, { path: "Apps/Projects.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Projects.md"), ["edit:Projects", "read:Projects"]);

  const { root, f } = openApp("Apps/Projects.md", projects());
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [board, schedule, due] = [...root.querySelectorAll(".gz-panel")];
  const column = (name: string) => [...board.querySelectorAll(".gz-board-col")].find((c) => text(c.querySelector(".gz-board-name")) === name)!;
  const cards = (name: string) => [...column(name).querySelectorAll(".gz-board-text")].map((c) => text(c));
  assert.deepEqual(cards("idea"), ["Japan trip · travel", "Learn Rust · learning"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Kitchen remodel · home"]);
  assert.deepEqual(cards("done"), ["Tax filing · money"]);

  // The schedule runs by start date and shows today; nothing is picked yet.
  assert.deepEqual([...schedule.querySelectorAll(".gz-tl-label")].map((l) => text(l)), ["Tax filing", "Kitchen remodel", "Garden beds", "Japan trip", "Learn Rust"]);
  assert.equal(schedule.querySelectorAll(".gz-tl-today").length, 1);
  assert.equal(schedule.querySelector(".gz-detail"), null);

  // Picked, a project says when it is due under the schedule, with a link to its note.
  const bars = [...schedule.querySelectorAll(".gz-tl-bar")] as HTMLElement[];
  bars[2].click();
  await settle();
  assert.equal(text(schedule.querySelector(".gz-detail-text")), "Garden beds is due 2026-11-30");
  assert.equal(text(schedule.querySelector(".gz-detail a")), "Open");

  // November is shown: the garden is due on the 30th. December has the kitchen.
  const day = (date: string) => due.querySelector(`[data-date="${date}"]`)!;
  assert.equal(text(day("2026-11-30").querySelector(".gz-cal-val")), "1");
  assert.ok(day("2026-11-18").classList.contains("gz-today"));
  (due.querySelector('button[aria-label="Next month"]') as HTMLButtonElement).click();
  assert.equal(text(day("2026-12-15").querySelector(".gz-cal-val")), "1");

  // Drag Japan trip to doing: its note's status changes and the board follows.
  const trip = [...board.querySelectorAll(".gz-board-card")].find((c) => text(c.querySelector(".gz-board-text")).startsWith("Japan"))!;
  event(trip, "dragstart");
  event(column("doing"), "drop");
  await settle();
  assert.equal(f.files.get("Projects/Japan trip.md")!.fm!.status, "doing");
  assert.deepEqual(cards("idea"), ["Learn Rust · learning"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Japan trip · travel", "Kitchen remodel · home"]);
  // The picked project survived the reload, and the calendar stayed on December.
  assert.equal(text(schedule.querySelector(".gz-detail-text")), "Garden beds is due 2026-11-30");
  assert.equal(text(due.querySelector(".gz-cal-title")), "December 2026");
});

test("Habits: log a stretch, and the streak and today's square in the Year tab follow", async () => {
  const spec = readSpec(vaultNote("Apps/Habits.md").fm, { path: "Apps/Habits.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Habits.md"), []);

  const { root, f } = openApp("Apps/Habits.md", { "Apps/Habits data.md": { fm: vaultNote("Apps/Habits data.md").fm } });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["Weeks", "Moods", "Year"]);
  const streak = () => text(root.querySelector(".gz-view-number .gz-big"));
  const square = (date: string) => root.querySelector(`rect[data-date="${date}"]`)!;
  assert.equal(root.querySelectorAll("rect").length, 365);
  assert.equal(streak(), "0days");
  // A day with a stretch, the day after without; none yet today.
  assert.equal(square("2026-11-05").getAttribute("aria-label"), "2026-11-05: 1");
  assert.ok(/gz-step/.test(square("2026-11-05").getAttribute("class")!));
  assert.equal(square("2026-11-06").getAttribute("aria-label"), "2026-11-06: 0");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 0");
  assert.ok(square("2026-11-18").classList.contains("gz-today"));
  assert.ok(!/gz-step/.test(square("2026-11-18").getAttribute("class")!));

  (root.querySelector("button.gz-button") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual((f.files.get("Apps/Habits data.md")!.fm!.stretches as { at: string }[]).at(-1), { at: "2026-11-18T12:00" });
  assert.equal(streak(), "1days");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 1");
  assert.ok(/gz-step/.test(square("2026-11-18").getAttribute("class")!));
});

/** The notes of a test vault folder, each with its whole text as its body, so task lines count as in the file. */
function withText(folder: string) {
  const names = readdirSync(new URL(`./vault/${folder}`, import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => [`${folder}/${n}`, {
    fm: vaultNote(`${folder}/${n}`).fm,
    body: readFileSync(new URL(`./vault/${folder}/${n}`, import.meta.url), "utf8"),
  }]));
}

test("Tasks: what's open across project notes, ticked off in the note itself", async () => {
  const spec = readSpec(vaultNote("Apps/Tasks.md").fm, { path: "Apps/Tasks.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Tasks.md"), ["read:Tasks", "tasks:Tasks"]);

  const { root, f, notices } = openApp("Apps/Tasks.md", withText("Tasks"));
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [open, soon, done] = [...root.querySelectorAll(".gz-panel")];
  const openRows = () => [...open.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(0, 3).map((td) => text(td)));
  // Undated tasks sort first; a code block's checkboxes aren't tasks.
  assert.deepEqual(openRows(), [
    ["Pour the base", "Garden shed", "—"],
    ["Draw the plans", "Garden shed", "—"],
    ["Write the about page", "Website", "—"],
    ["Download bank statements 📅 2026-11-19", "Tax return", "2026-11-19"],
    ["Order timber 📅 2026-11-20 #shopping", "Garden shed", "2026-11-20"],
    ["Hire a mixer [due:: 2026-11-24]", "Garden shed", "2026-11-24"],
    ["Renew the domain 📅 2026-11-25 #admin", "Website", "2026-11-25"],
    ["File the return 📅 2027-01-31", "Tax return", "2027-01-31"],
  ]);
  assert.equal(text(soon.querySelector(".gz-big")), "4");
  assert.deepEqual([...done.querySelectorAll("li")].map((li) => text(li)),
    ["Measure the space 📅 2026-11-02 · Garden shed", "Find last year's return · Tax return", "Pick a theme · Website"]);

  const box = open.querySelectorAll("tbody tr")[3].querySelector('input[type="checkbox"]') as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.deepEqual(notices, []);
  assert.equal(f.files.get("Tasks/Tax return.md")!.body,
    "Everything for this year's return, in order.\n\n1. [x] Find last year's return\n2. [x] Download bank statements 📅 2026-11-19\n3. [ ] File the return 📅 2027-01-31\n");
  assert.equal(openRows().length, 7);
  assert.equal(text(soon.querySelector(".gz-big")), "3");
  assert.equal(text(done.querySelectorAll("li")[2]), "Download bank statements 📅 2026-11-19 · Tax return");
});

test("Shelf: the books Books.base picks, by status, set in place", async () => {
  const spec = readSpec(vaultNote("Apps/Shelf.md").fm, { path: "Apps/Shelf.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Shelf.md"), ["edit:*", "read:*"]);

  // A note outside Books, which the base leaves out.
  const t = fakeEnv({ "Apps/Shelf.md": { fm: vaultNote("Apps/Shelf.md").fm }, ...books(), "Inbox/Dune notes.md": { fm: { status: "reading" } } });
  t.f.others.set("Books.base", readFileSync(new URL("./vault/Books.base", import.meta.url), "utf8"));
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Shelf.md", t.env).load();
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [shelf, byStatus] = [...root.querySelectorAll(".gz-panel")];
  const rows = [...shelf.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => text(tr.querySelector("td"))), ["Dune", "Middlemarch", "Piranesi", "The Overstory"]);
  assert.deepEqual([...byStatus.querySelectorAll("li")].map((li) => text(li)), ["done · 4"]);

  choose(rows[0].querySelector("select")!, "reading");
  await settle();
  assert.deepEqual(t.f.files.get("Books/Dune.md")!.fm, { finished: "2026-02-10", status: "reading", page: 412, pages: 412 });
  assert.deepEqual([...byStatus.querySelectorAll("li")].map((li) => text(li)), ["done · 3", "reading · 1"]);
});

test("Spending: log a purchase, see the week against last, the stack against the budget, and fix a category", async () => {
  const spec = readSpec(vaultNote("Apps/Spending.md").fm, { path: "Apps/Spending.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Spending.md"), []);

  const spend = [
    { amount: 40, category: "food", note: "groceries", at: "2026-11-02T09:00" },
    { amount: 300, category: "rent", note: "", at: "2026-11-03T08:00" },
    { amount: 80.5, category: "food", note: "market", at: "2026-11-10T12:30" },
    { amount: 45, category: "fun", note: "cinema", at: "2026-11-12T19:00" },
    { amount: 12, category: "transport", note: "bus pass", at: "2026-11-16T08:15" },
    { amount: 30.25, category: "food", note: "lunch", at: "2026-11-17T13:00" },
  ];
  const { root, f } = openApp("Apps/Spending.md", { "Apps/Spending data.md": { fm: { spend } } });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [form, week, chart, recent] = [...root.querySelectorAll(".gz-panel")];

  // This week ($42.25) against last week ($125.50).
  assert.equal(text(week.querySelector(".gz-big")), "$42.25");
  assert.equal(text(week.querySelector(".gz-compare")), "▼ $83.25 (66%) vs previous");
  assert.equal(week.querySelector(".gz-compare")!.getAttribute("aria-label"), "down $83.25, 66 percent, versus previous");

  // Weekly totals stacked by category, with the budget line.
  assert.equal(text(chart.querySelector(".gz-goal-label")), "goal $400");
  assert.equal(text(chart.querySelector(".gz-legend")), "FoodRentTransportFunOther");
  assert.ok(chart.querySelectorAll("path.gz-bar.gz-stacked").length >= 6);
  assert.match(text(chart.querySelector(".gz-readout")), /Food \$30.*Transport \$12/);

  // Recent purchases, newest first, in the panel's formats; category is a dropdown.
  assert.deepEqual([...recent.querySelectorAll("th")].map((th) => text(th)), ["When", "Spent", "category", "note"]);
  const rows = [...recent.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => [text(tr.querySelectorAll("td")[0]), text(tr.querySelectorAll("td")[1])]).slice(0, 2), [["23 hours ago", "$30.25"], ["2 days ago", "$12.00"]]);
  assert.deepEqual([...rows[0].querySelectorAll("select option")].map((o) => text(o)), ["food", "rent", "transport", "fun", "other"]);

  // Log a purchase.
  const [amount, note] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  amount.value = "20";
  note.value = "movie";
  choose(form.querySelector("select")!, "fun");
  form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  const saved = f.files.get("Apps/Spending data.md")!.fm!.spend as Record<string, unknown>[];
  assert.deepEqual(saved.at(-1), { amount: 20, category: "fun", note: "movie", at: "2026-11-18T12:00" });
  assert.equal(text(week.querySelector(".gz-big")), "$62.25");
  assert.equal(text(week.querySelector(".gz-compare")), "▼ $63.25 (50%) vs previous");
  assert.deepEqual([...recent.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelectorAll("td")[1])).slice(0, 2), ["$20.00", "$30.25"]);
  assert.equal(text(recent.querySelector("tbody tr td")), "just now");

  // The movie was food after all.
  choose(recent.querySelector("tbody tr select")!, "food");
  await settle();
  assert.equal((f.files.get("Apps/Spending data.md")!.fm!.spend as Record<string, unknown>[]).at(-1)!.category, "food");
  assert.equal(text(week.querySelector(".gz-big")), "$62.25");
  assert.match(text(chart.querySelector(".gz-readout")), /Food \$50/);
});

const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const KP_READINGS = [
  { time_tag: "2026-11-18T10:58:00", kp_index: 4, estimated_kp: 4.33, kp: "4P" },
  { time_tag: "2026-11-18T10:59:00", kp_index: 5, estimated_kp: 5.33, kp: "5P" },
];

/** The background service on these vault notes, started; `open` draws an app as its tab would. */
async function background(paths: string[]) {
  const t = fakeBackground(Object.fromEntries(paths.map((p) => [p, { fm: vaultNote(p).fm }])), { [KP]: KP_READINGS });
  t.env.opened = (path) => t.bg.opened(path);
  t.env.alerts = t.bg.alerts;
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  const open = async (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    mount(root, path, t.env);
    await settle();
    return root;
  };
  return { ...t, open };
}

test("Space weather: Kp now, told when a storm is likely, an hourly record of my own, and my sightings", async () => {
  const path = "Apps/Space weather.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:services.swpc.noaa.gov"]);

  // With the app closed: a sample recorded, the storm told once, the value in the status bar.
  const t = await background([path]);
  const data = () => t.f.files.get("Apps/Space weather data.md")!.fm!;
  assert.deepEqual(data().kp_log, [{ at: "2026-11-18T12:00", time_tag: "2026-11-18T10:59:00", kp_index: 5, estimated_kp: 5.33, kp: "5P" }]);
  assert.deepEqual(t.notices, ["Space weather: Kp now 5.33"]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Kp now: 5.33", title: "Space weather" }]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:saw-aurora`, name: "Space weather: Saw aurora" }]);

  const root = await t.open(path);
  assert.equal(root.querySelector(".gz-error"), null);
  const [now, , record, sightings] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(text(now.querySelector(".gz-big")), "5.33");
  assert.equal(text(record.querySelector(".gz-title")), "My Kp record");
  assert.ok(record.querySelector(".gz-chart-svg"));
  (root.querySelector("button.gz-button") as HTMLButtonElement).click();
  await settle();
  assert.equal(text(sightings.querySelector(".gz-list")), "2026-11-18T12:00");
  // From a hotkey or a link, without opening the app.
  t.advance(90 * 60_000);
  await t.bg.runUri({ app: "Space weather", do: "saw-aurora" });
  await t.bg.tick();
  await settle();
  assert.deepEqual((data().sightings as { at: string }[]).map((s) => s.at), ["2026-11-18T12:00", "2026-11-18T13:30"]);
  assert.equal((data().kp_log as unknown[]).length, 2);
  assert.deepEqual(t.notices.slice(1), ["Sighting saved", "Sighting saved"]);
});

test("Meds: took meds from a hotkey or a link, and today's doses in the status bar", async () => {
  const path = "Apps/Meds.md";
  assert.deepEqual(readSpec(vaultNote(path).fm, { path })!.errors, []);
  const t = await background([path]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:took-meds`, name: "Meds: Took meds" }]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Doses today: 0", title: "Meds" }]);
  await t.bg.runCommand(`${path}:took-meds`);
  await t.bg.runUri({ app: "Meds", do: "took-meds" });
  await settle();
  assert.equal((t.f.files.get("Apps/Meds data.md")!.fm!.doses as unknown[]).length, 2);
  assert.equal(t.writes.filter((w) => w === "Daily.md").length, 2);
  assert.deepEqual(t.notices, ["Logged", "Logged"]);
  assert.equal(t.out.status[0].text, "Doses today: 2");
});

test("Attention: what needs my attention across my apps, and the day's to-dos", async () => {
  const path = "Apps/Attention.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), []);
  const t = await background([path, "Apps/Space weather.md"]);
  const root = await t.open(path);
  const items = [...root.querySelectorAll(".gz-alerts li")];
  assert.deepEqual(items.map((li) => [...li.children].map((c) => text(c))), [["Space weather", "Kp now", "5.33"]]);
  const box = root.querySelector(".gz-checklist input") as HTMLInputElement;
  box.dispatchEvent(new window.Event("change"));
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Attention data.md")!.fm!.done_today, ["Take meds"]);
  assert.match(text(root.querySelector(".gz-view-checklist .gz-title")), /1\/4/);
});

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";
/** Yahoo's chart answer for a symbol with these daily closes, the last one being the price now. */
const yahoo = (symbol: string, closes: number[]) => ({
  chart: {
    result: [{
      meta: { symbol, regularMarketPrice: closes.at(-1) },
      timestamp: closes.map((_, i) => 1794493800 + i * 86_400),
      indicators: { quote: [{ close: closes }] },
    }],
  },
});
const TICKER = { "Components/Ticker.md": { fm: vaultNote("Components/Ticker.md").fm } };
const panelsOf = (root: Element) => [...root.querySelectorAll(".gz-panel")];
const cells = (tr: Element) => [...tr.querySelectorAll("td")].map((td) => text(td));

test("Portfolio: the Ticker for the stock I pick, a buy recorded for each, what I hold of one and what it is worth", async () => {
  const path = "Apps/Portfolio.md";
  const spec = readSpec(vaultNote(path).fm, { path, notes: fakeEnv(TICKER).env.notes })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:query1.finance.yahoo.com", "send:query1.finance.yahoo.com|picked.holding.symbol"]);

  const responses = { [`${YAHOO}SPY`]: yahoo("SPY", [523, 523.88, 517.99, 506.24, 508.29]), [`${YAHOO}AAPL`]: yahoo("AAPL", [200, 205, 210]) };
  const { root, f } = openApp(path, TICKER, responses);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const panels = () => panelsOf(root);
  const [price, session, chart, form, held, worth, , buys, everything, paid] = panels();
  assert.equal(panels().length, 10);
  assert.equal(text(price.querySelector(".gz-title")), "SPY");
  assert.equal(text(price.querySelector(".gz-big")), "$508.29");
  assert.equal(text(session.querySelector(".gz-big")), "0.40%");
  assert.equal(text(chart.querySelector(".gz-title")), "SPY, last 6mo");
  assert.ok(chart.querySelector(".gz-chart-svg"));
  assert.equal(text(form.querySelector(".gz-title")), "Record a buy of SPY");
  for (const empty of [held, buys, everything]) assert.equal(text(empty.querySelector(".gz-empty")), "Nothing here yet.");
  assert.equal(text(worth.querySelector(".gz-waiting")), "Pick a row in “What I hold”");
  assert.equal(text(paid.querySelector(".gz-big")), "—");

  const record = async (symbol: string, date: string, shares: string, price: string) => {
    choose(root.querySelector('.gz-inputs select[aria-label="symbol"]')!, symbol);
    await settle();
    const buy = panels()[3];
    assert.equal(text(buy.querySelector(".gz-title")), `Record a buy of ${symbol}`);
    const fields = buy.querySelectorAll("input") as unknown as HTMLInputElement[];
    [fields[0].value, fields[1].value, fields[2].value] = [date, shares, price];
    buy.querySelector("form")!.dispatchEvent(new window.Event("submit"));
    await settle();
  };
  await record("SPY", "2026-11-10", "10", "500");
  await record("SPY", "2026-11-12", "5", "510");
  await record("AAPL", "2026-11-17", "5", "200");
  assert.deepEqual(f.files.get("Apps/Portfolio data.md")!.fm!.buys, [
    { symbol: "SPY", date: "2026-11-10", shares: 10, price: 500, at: "2026-11-18T12:00" },
    { symbol: "SPY", date: "2026-11-12", shares: 5, price: 510, at: "2026-11-18T12:00" },
    { symbol: "AAPL", date: "2026-11-17", shares: 5, price: 200, at: "2026-11-18T12:00" },
  ]);
  // The Ticker follows the pick; the totals cover every stock.
  assert.equal(text(panels()[0].querySelector(".gz-big")), "$210.00");
  assert.deepEqual([...panels()[4].querySelectorAll("tbody tr")].map(cells), [["AAPL", "5", "$1,000.00"]]);
  assert.deepEqual([...panels()[7].querySelectorAll("tbody tr")].map((tr) => text(tr.querySelector("td"))), [""]);
  assert.deepEqual([...panels()[8].querySelectorAll("tbody tr")].map(cells), [["AAPL", "5", "$1,000.00"], ["SPY", "15", "$7,550.00"]]);
  assert.equal(text(panels()[9].querySelector(".gz-big")), "$8,550.00");

  // 5 AAPL at the last close of 210, against the $1,000 paid.
  (panels()[4].querySelector("tbody tr") as HTMLElement).click();
  await settle();
  assert.equal(text(panels()[5].querySelector(".gz-title")), "Worth now");
  assert.equal(text(panels()[5].querySelector(".gz-label")), "5 shares of AAPL at the last close");
  assert.equal(text(panels()[5].querySelector(".gz-big")), "$1,050.00");
  assert.equal(text(panels()[6].querySelector(".gz-big")), "$50.00");
  assert.ok(f.requests.includes(`${YAHOO}AAPL?range=5d&interval=1d`));

  // Sold out of AAPL: setting its buy's shares to 0 takes it out of what I hold.
  const shares = panels()[7].querySelectorAll("tbody tr input")[1] as HTMLInputElement;
  shares.value = "0";
  shares.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((f.files.get("Apps/Portfolio data.md")!.fm!.buys as { shares: number }[])[2].shares, 0);
  assert.equal(text(panels()[4].querySelector(".gz-empty")), "Nothing here yet.");
  assert.deepEqual([...panels()[8].querySelectorAll("tbody tr")].map(cells), [["SPY", "15", "$7,550.00"]]);
});

test("AAPL: the whole note is the Ticker; its price is in the status bar, a 3% fall tells me, and a buy shows what it is worth", async () => {
  const path = "Apps/AAPL.md";
  const spec = readSpec(vaultNote(path).fm, { path, notes: fakeEnv(TICKER).env.notes })!;
  assert.deepEqual(spec.errors, []);
  assert.equal(spec.spec!.description, "Follow one stock, record what I buy of it, and see what my shares are worth");
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:query1.finance.yahoo.com", "send:query1.finance.yahoo.com|picked.holding.symbol"]);

  // Closed: down from 205 to 198 in the last session.
  const t = fakeBackground({ [path]: { fm: vaultNote(path).fm }, ...TICKER }, { [YAHOO]: yahoo("AAPL", [200, 205, 198]) });
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  await settle();
  assert.deepEqual(t.out.status, [{ appPath: path, text: "AAPL: $198.00", title: "AAPL" }]);
  assert.deepEqual(t.notices, ["AAPL: Last session -3.41 %"]);

  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.equal(text(root.querySelector(".gz-description")), "Follow one stock, record what I buy of it, and see what my shares are worth");
  const panels = () => panelsOf(root);
  assert.equal(text(panels()[3].querySelector(".gz-title")), "Record a buy of AAPL");
  const fields = panels()[3].querySelectorAll("input") as unknown as HTMLInputElement[];
  [fields[0].value, fields[1].value, fields[2].value] = ["2026-11-02", "10", "190"];
  panels()[3].querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(t.f.files.get("Apps/AAPL data.md")!.fm!.buys, [{ symbol: "AAPL", date: "2026-11-02", shares: 10, price: 190, at: "2026-11-18T12:00" }]);
  (panels()[4].querySelector("tbody tr") as HTMLElement).click();
  await settle();
  assert.equal(text(panels()[5].querySelector(".gz-big")), "$1,980.00");
  assert.equal(text(panels()[6].querySelector(".gz-big")), "$80.00");
});

/** The Health folder of the test vault, as notes. */
function health() {
  const names = readdirSync(new URL("./vault/Health", import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => [`Health/${n}`, { fm: vaultNote(`Health/${n}`).fm }]));
}

test("Appointments: what's coming up, a day's appointments, book one, and tick it off or move it", async () => {
  const path = "Apps/Appointments.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["create:Health", "edit:Health", "read:Health"]);

  const t = fakeBackground({ [path]: { fm: vaultNote(path).fm }, ...health() });
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Next appointment: 16 days", title: "Appointments" }]);
  assert.deepEqual(t.notices, []);
  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [coming, next, form, day, all] = panelsOf(root);
  const items = (panel: Element) => [...panel.querySelectorAll("li")].map((li) => text(li));
  // The physical in September is past, so it is only in the table.
  assert.deepEqual(items(coming), ["in 16 days · Dentist with Dr. Lee", "in 58 days · Eye exam with Dr. Patel"]);
  assert.equal(text(next.querySelector(".gz-big")), "16 days");
  assert.equal(text(day.querySelector(".gz-title")), "On 2026-11-18");
  assert.equal(text(day.querySelector(".gz-empty")), "Nothing here yet.");
  assert.deepEqual([...all.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelector("td"))), ["Eye exam", "Dentist", "Physical"]);

  // Half-way through booking, look at another day: the form keeps what was typed.
  const [what, date, who] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  what.value = "Blood test";
  const bar = root.querySelector('.gz-inputs input[type="date"]') as HTMLInputElement;
  bar.value = "2027-01-15";
  bar.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(text(panelsOf(root)[3].querySelector(".gz-title")), "On 2027-01-15");
  assert.deepEqual(items(panelsOf(root)[3]), ["Eye exam with Dr. Patel"]);
  assert.equal((panelsOf(root)[2].querySelector("input") as HTMLInputElement).value, "Blood test");

  // Booked for tomorrow: a note in Health, first in line, in the status bar, and told.
  [date.value, who.value] = ["2026-11-19", "Dr. Kim"];
  form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(t.f.files.get("Health/Blood test 2026-11-19.md")!.fm, { what: "Blood test", date: "2026-11-19", who: "Dr. Kim", at: "2026-11-18T12:00" });
  assert.deepEqual(items(panelsOf(root)[0])[0], "tomorrow · Blood test with Dr. Kim");
  assert.equal(text(panelsOf(root)[1].querySelector(".gz-big")), "1 day");
  assert.deepEqual(t.notices, ["Booked Blood test on 2026-11-19", "Appointments: Next appointment (1 row)"]);
  assert.equal(t.out.status[0].text, "Next appointment: 1 day");

  // Done: it leaves what's coming up. The dentist moves to the 20th.
  const row = (name: string) => [...panelsOf(root)[4].querySelectorAll("tbody tr")].find((tr) => text(tr.querySelector("td")) === name)!;
  const tick = row("Blood test 2026-11-19").querySelector('input[type="checkbox"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(t.f.files.get("Health/Blood test 2026-11-19.md")!.fm!.done, true);
  const moved = row("Dentist").querySelector('input[type="date"]') as HTMLInputElement;
  moved.value = "2026-12-20";
  moved.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(t.f.files.get("Health/Dentist.md")!.fm!.date, "2026-12-20");
  assert.deepEqual(items(panelsOf(root)[0]), ["in 32 days · Dentist with Dr. Lee", "in 58 days · Eye exam with Dr. Patel"]);
  assert.equal(t.out.status[0].text, "Next appointment: 32 days");
});

test("Renewals: add a deadline, see the days left soonest first, get told two weeks out, tick it done or move it", async () => {
  const path = "Apps/Renewals.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), []);

  const t = fakeBackground({ [path]: { fm: vaultNote(path).fm } });
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [form, next, coming, done] = panelsOf(root);
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map((s) => text(s)), ["What", "Due"]);
  assert.equal(text(next.querySelector(".gz-big")), "—");
  assert.equal(text(coming.querySelector(".gz-empty")), "Nothing here yet.");
  assert.equal(text(done.querySelector(".gz-empty")), "Nothing here yet.");

  const add = async (what: string, due: string) => {
    const [a, b] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
    [a.value, b.value] = [what, due];
    form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
    await settle();
  };
  await add("Passport", "2027-03-01");
  assert.deepEqual(t.notices, []);
  await add("Car insurance", "2026-11-25");
  assert.deepEqual(t.f.files.get("Apps/Renewals data.md")!.fm!.deadlines, [
    { what: "Passport", due: "2027-03-01", at: "2026-11-18T12:00" },
    { what: "Car insurance", due: "2026-11-25", at: "2026-11-18T12:00" },
  ]);
  const rows = () => [...coming.querySelectorAll("tbody tr")];
  assert.deepEqual([...coming.querySelectorAll("th")].map((th) => text(th)), ["What", "Due", "Days left", "Done"]);
  assert.deepEqual(rows().map((tr) => [text(tr.querySelector("td")), (tr.querySelector('input[type="date"]') as HTMLInputElement).value, text(tr.querySelectorAll("td")[2])]),
    [["Car insurance", "2026-11-25", "7"], ["Passport", "2027-03-01", "103"]]);
  assert.equal(text(next.querySelector(".gz-big")), "7 days");
  // A week away: told once.
  assert.deepEqual(t.notices, ["Renewals: Coming up (1 row)"]);

  const tick = rows()[0].querySelector('input[type="checkbox"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((t.f.files.get("Apps/Renewals data.md")!.fm!.deadlines as { done?: boolean }[])[1].done, true);
  assert.deepEqual(rows().map((tr) => text(tr.querySelector("td"))), ["Passport"]);
  assert.equal(text(next.querySelector(".gz-big")), "103 days");
  assert.equal(text(done.querySelector("li")), "Car insurance, due 2026-11-25");

  // The passport office wants it sooner: within two weeks again, so told again.
  const due = rows()[0].querySelector('input[type="date"]') as HTMLInputElement;
  due.value = "2026-12-01";
  due.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((t.f.files.get("Apps/Renewals data.md")!.fm!.deadlines as { due: string }[])[0].due, "2026-12-01");
  assert.equal(text(next.querySelector(".gz-big")), "13 days");
  assert.deepEqual(t.notices, ["Renewals: Coming up (1 row)", "Renewals: Coming up (1 row)"]);
});

const FRANKFURTER = "https://api.frankfurter.dev/v2/rates";
/** Frankfurter's rows for one pair: today's alone, or week by week. */
const rates = (base: string, quote: string, values: [string, number][]) => values.map(([date, rate]) => ({ date, base, quote, rate }));

test("Currency: today's rate told when it reaches mine, an amount converted, a transfer logged with its rate, the rate over time", async () => {
  const path = "Apps/Currency.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:api.frankfurter.dev"]);

  const responses = {
    [`${FRANKFURTER}?base=USD&quotes=EUR&from=2025-01-01`]: rates("USD", "EUR", [["2026-10-28", 0.93], ["2026-11-04", 0.94], ["2026-11-11", 0.955]]),
    [`${FRANKFURTER}?base=USD&quotes=EUR`]: rates("USD", "EUR", [["2026-11-18", 0.96]]),
    [`${FRANKFURTER}?base=GBP&quotes=EUR&from=2025-01-01`]: rates("GBP", "EUR", [["2026-11-11", 1.13]]),
    [`${FRANKFURTER}?base=GBP&quotes=EUR`]: rates("GBP", "EUR", [["2026-11-18", 1.14]]),
  };
  const t = fakeBackground({ [path]: { fm: vaultNote(path).fm } }, responses);
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  // Closed, the first pair is watched: a dollar buys 0.96 euro, past the 0.95 asked for.
  assert.deepEqual(t.notices, ["Currency: 1 USD in EUR 0.9600"]);

  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [rate, converted, chart, sent] = panelsOf(root);
  assert.equal(text(rate.querySelector(".gz-title")), "1 USD in EUR");
  assert.equal(text(rate.querySelector(".gz-big")), "0.9600");
  assert.equal(text(converted.querySelector(".gz-waiting")), "Type in “amount”");
  assert.equal(text(chart.querySelector(".gz-title")), "USD in EUR, week by week since 2025");
  assert.equal(chart.querySelectorAll("path.gz-line").length, 1);
  assert.equal(text(sent.querySelector(".gz-empty")), "Nothing here yet.");

  const amount = root.querySelector('.gz-inputs input[type="search"]') as HTMLInputElement;
  amount.value = "250";
  key(amount, "Enter");
  await settle();
  const item = converted.querySelector("li")!;
  assert.equal(text(item), "250.00 USD is 240.00 EUR at 0.9600I sent it");
  (item.querySelector("button.gz-row-action") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Currency data.md")!.fm!.transfers,
    [{ date: "2026-11-18", sent: 250, from: "USD", got: 240, to: "EUR", rate: 0.96, at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices.slice(1), ["Logged 250 USD → 240 EUR"]);
  const row = sent.querySelector("tbody tr")!;
  assert.deepEqual([...row.querySelectorAll("td")].slice(0, 6).map((td) => text(td)), ["2026-11-18", "250.00", "USD", "240.00", "EUR", "0.9600"]);
  const note = row.querySelector("input") as HTMLInputElement;
  note.value = "December rent";
  note.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((t.f.files.get("Apps/Currency data.md")!.fm!.transfers as { note: string }[])[0].note, "December rent");

  // Pounds instead: both requests follow the pick, and the amount carries over.
  choose(root.querySelector('.gz-inputs select[aria-label="have"]')!, "GBP");
  await settle();
  assert.equal(text(panelsOf(root)[0].querySelector(".gz-big")), "1.1400");
  assert.equal(text(panelsOf(root)[1].querySelector("li")), "250.00 GBP is 285.00 EUR at 1.1400I sent it");
  assert.ok(t.f.requests.includes(`${FRANKFURTER}?base=GBP&quotes=EUR&from=2025-01-01&group=week`));
});

const METEO = "https://api.open-meteo.com/v1/forecast";
/** Open-Meteo's answer for London: overcast now, four hours ahead (two of them likely wet), three days. */
const LONDON = {
  current: { time: "2026-11-18T12:00", interval: 900, temperature_2m: 8.4, apparent_temperature: 6.2, weather_code: 3, wind_speed_10m: 12.25 },
  hourly: {
    time: ["2026-11-18T12:00", "2026-11-18T13:00", "2026-11-18T14:00", "2026-11-18T15:00"],
    temperature_2m: [8.4, 8.9, 9.1, 8.6], apparent_temperature: [6.2, 6.8, 7, 6.5], precipitation_probability: [10, 35, 60, 85],
  },
  daily: {
    time: ["2026-11-18", "2026-11-19", "2026-11-20"], weather_code: [3, 63, 0],
    temperature_2m_max: [9.4, 10.6, 7.9], temperature_2m_min: [6.2, 5.5, 2.1], precipitation_probability_max: [85, 100, 0],
  },
};

test("Weather: now, the next hours and the week in words, told when rain is likely, and a walk logged with its weather", async () => {
  const path = "Apps/Weather.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:api.open-meteo.com", "write:Daily.md"]);

  const t = fakeBackground({ [path]: { fm: vaultNote(path).fm }, "Daily.md": { body: "# Daily\n" } }, { [METEO]: LONDON });
  const lines: string[] = [];
  t.env.appendLine = async (note, line) => { lines.push(`${note}: ${line}`); };
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  assert.deepEqual(t.notices, ["Weather: Rainy hours ahead 2 hours"]);

  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [now, rainy, hours, chance, week, walks] = panelsOf(root);
  // One request feeds every panel that reads the forecast.
  assert.equal(t.f.requests.filter((u) => u.startsWith(METEO)).length, 1);
  assert.equal(text(now.querySelector("li")), "8.4°C, feels like 6.2°C, overcast, wind 12.3 km/hI went for a walk");
  assert.equal(text(rainy.querySelector(".gz-big")), "2hours");
  assert.equal(text(hours.querySelector(".gz-legend")), "TemperatureFeels like");
  assert.equal(hours.querySelectorAll("path.gz-line").length, 2);
  assert.equal(text(chance.querySelector(".gz-goal-label")), "goal 50 %");
  assert.deepEqual([...week.querySelectorAll("th")].map((th) => text(th)), ["Day", "Sky", "Temperature", "Rain chance"]);
  assert.deepEqual([...week.querySelectorAll("tbody tr")].map(cells),
    [["Wednesday", "overcast", "6 to 9 °C", "85 %"], ["Thursday", "rain", "6 to 11 °C", "100 %"], ["Friday", "clear", "2 to 8 °C", "0 %"]]);
  assert.equal(text(walks.querySelector(".gz-empty")), "Nothing here yet.");

  (now.querySelector("button.gz-row-action") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Weather data.md")!.fm!.walks, [{ sky: "overcast", temp: 8.4, feels: 6.2, wind: 12.25, at: "2026-11-18T12:00" }]);
  assert.deepEqual(lines, ["Daily.md: - Walked in London: overcast, 8.4°C, feels like 6.2°C, wind 12.25 km/h"]);
  assert.deepEqual(t.notices.slice(1), ["Walk logged"]);
  const row = walks.querySelector("tbody tr")!;
  assert.deepEqual(cells(row).slice(0, 4), ["just now", "overcast", "8.4", "6.2"]);
  const note = row.querySelector("input") as HTMLInputElement;
  note.value = "Round the park, dry the whole way";
  note.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((t.f.files.get("Apps/Weather data.md")!.fm!.walks as { note: string }[])[0].note, "Round the park, dry the whole way");
});

const USGS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
/** A USGS feed: a strong quake yesterday that people felt, two smaller ones. */
const QUAKES = {
  type: "FeatureCollection",
  features: [
    { id: "ak01", properties: { mag: 3.2, place: "10 km N of Anchorage, Alaska", time: at(18, 6), felt: null, url: "https://earthquake.usgs.gov/earthquakes/eventpage/ak01", title: "M 3.2 - 10 km N of Anchorage, Alaska" }, geometry: { coordinates: [-149.9, 61.3, 40.1] } },
    { id: "us7001", properties: { mag: 7.1, place: "120 km S of Hachijo-jima, Japan", time: at(17, 9), felt: 450, url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7001", title: "M 7.1 - 120 km S of Hachijo-jima, Japan" }, geometry: { coordinates: [139.8, 32, 35.2] } },
    { id: "ci02", properties: { mag: 4.5, place: "8 km W of Ridgecrest, CA", time: at(16, 22), felt: 12, url: "https://earthquake.usgs.gov/earthquakes/eventpage/ci02", title: "M 4.5 - 8 km W of Ridgecrest, CA" }, geometry: { coordinates: [-117.8, 35.6, 8] } },
  ],
};
const SPACE = {
  "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json": [
    { time_tag: "2026-11-18T10:58:00", active: true, proton_speed: 412.5, proton_density: 4.1 },
    { time_tag: "2026-11-18T10:59:00", active: true, proton_speed: 418.2, proton_density: 4.3 },
  ],
  [KP]: KP_READINGS,
};
/** Open-Meteo for a city: now, and thirteen weeks of days ending today. */
const CITY = {
  current: { temperature_2m: 48.2, apparent_temperature: 44.1, relative_humidity_2m: 71, wind_speed_10m: 9.4 },
  daily: (() => {
    const time = Array.from({ length: 92 }, (_, i) => {
      const d = new Date(2026, 10, 18 - 91 + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    return { time, temperature_2m_max: time.map(() => 60), temperature_2m_min: time.map(() => 45), precipitation_sum: time.map(() => 0.1) };
  })(),
};

test("Planet Earth: told of a strong quake, pick one to see where and how deep with its USGS page, follow it and say why", async () => {
  const path = "Apps/Planet Earth.md";
  const notes = { [path]: { fm: vaultNote(path).fm }, "Components/City.md": { fm: vaultNote("Components/City.md").fm } };
  const spec = readSpec(vaultNote(path).fm, { path, notes: fakeEnv(notes).env.notes })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:api.open-meteo.com", "net:earthquake.usgs.gov", "net:services.swpc.noaa.gov"]);

  const t = fakeBackground(notes, { [USGS]: QUAKES, "https://api.open-meteo.com/v1/forecast": CITY, ...SPACE });
  await t.bg.start();
  started.push({ dispose: () => t.bg.stop() });
  assert.deepEqual(t.notices, ["Planet Earth: Strongest 7.1"]);

  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root, path, t.env);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map((b) => text(b)), ["Earthquakes", "Sun", "Philadelphia", "Saigon"]);
  const panel = (title: string) => panelsOf(root).find((p) => text(p.querySelector(".gz-title")) === title)!;
  assert.equal(text(panel("Earthquakes, past week").querySelector(".gz-big")), "3");
  assert.equal(text(panel("Strongest").querySelector(".gz-big")), "7.1");
  assert.equal(text(panel("Solar wind").querySelector(".gz-big")), "418km/s");

  const strongest = panel("The ten strongest");
  assert.deepEqual([...strongest.querySelectorAll("th")].map((th) => text(th)).slice(0, 3), ["Magnitude", "Where", "When"]);
  const rows = [...strongest.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((tr) => cells(tr).slice(0, 3)), [
    ["7.1", "120 km S of Hachijo-jima, Japan", "yesterday"],
    ["4.5", "8 km W of Ridgecrest, CA", "2 days ago"],
    ["3.2", "10 km N of Anchorage, Alaska", "6 hours ago"],
  ]);
  assert.equal(text(panel("The one I picked").querySelector(".gz-waiting")), "Pick a row in “The ten strongest”");
  assert.deepEqual([...panel("Felt by the most people").querySelectorAll("li")].map((li) => text(li)),
    ["450 reports · M7.1 · 120 km S of Hachijo-jima, Japan", "12 reports · M4.5 · 8 km W of Ridgecrest, CA"]);

  // Picked: the quake as a card, with how deep it was and a link to its page.
  (rows[0] as HTMLElement).click();
  await settle();
  const card = panel("The one I picked").querySelector(".gz-rowcard")!;
  assert.equal(text(card.querySelector(".gz-rowcard-title")), "120 km S of Hachijo-jima, Japan");
  const lines = Object.fromEntries([...card.querySelectorAll(".gz-rowcard-line")].map((l) => [text(l.querySelector(".gz-rowcard-label")), l.querySelector(".gz-rowcard-value")!]));
  assert.deepEqual(Object.keys(lines), ["Magnitude", "When", "Depth", "Felt reports", "USGS page"]);
  assert.deepEqual([text(lines.Magnitude), text(lines.Depth), text(lines["Felt reports"])], ["7.1", "35 km", "450"]);
  assert.equal(lines["USGS page"].querySelector("a")!.getAttribute("href"), "https://earthquake.usgs.gov/earthquakes/eventpage/us7001");

  // Follow it, and say why.
  (rows[0].querySelector("button.gz-row-action") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Planet Earth data.md")!.fm!.following, [{
    quake: "M 7.1 - 120 km S of Hachijo-jima, Japan", when: at(17, 9), page: "https://earthquake.usgs.gov/earthquakes/eventpage/us7001", at: "2026-11-18T12:00",
  }]);
  assert.deepEqual(t.notices.slice(1), ["Following 120 km S of Hachijo-jima, Japan"]);
  const followed = panel("Quakes I'm following").querySelector("tbody tr")!;
  assert.equal(text(followed.querySelector("td")), "M 7.1 - 120 km S of Hachijo-jima, Japan");
  assert.equal(followed.querySelector("a")!.getAttribute("href"), "https://earthquake.usgs.gov/earthquakes/eventpage/us7001");
  const why = followed.querySelector("input") as HTMLInputElement;
  why.value = "My cousin lives on Hachijo-jima";
  why.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((t.f.files.get("Apps/Planet Earth data.md")!.fm!.following as { note: string }[])[0].note, "My cousin lives on Hachijo-jima");

  // A city, through the component: now, and its last thirteen weeks from one request.
  assert.equal(text(panel("Saigon now").querySelector(".gz-big")), "48°F");
  assert.equal(text(panel("Average high and low by week, last three months").querySelector(".gz-legend")), "HighLow");
  assert.equal(t.f.requests.filter((u) => u.includes("latitude=10.82")).length, 1);
});
