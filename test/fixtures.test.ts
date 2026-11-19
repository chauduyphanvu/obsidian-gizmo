import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { permissionsOf, readSpec } from "../src/spec.ts";
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

function openApp(path: string, notes: Parameters<typeof fakeEnv>[0], responses: Record<string, unknown> = {}) {
  const t = fakeEnv({ [path]: { fm: vaultNote(path).fm }, ...notes }, responses);
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, path, t.env).load();
  return { ...t, root };
}

test("Library: search Open Library, read about a pick, add it to Books, set its status", async () => {
  const spec = readSpec(vaultNote("Apps/Library.md").fm, { path: "Apps/Library.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Library.md"), ["create:Books", "edit:Books", "net:openlibrary.org", "read:Books"]);

  const { root, f, notices } = openApp("Apps/Library.md", books(), { [SEARCH]: DOCS });
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [results, about, shelf] = [...root.querySelectorAll(".na-panel")];
  assert.equal(text(results.querySelector(".na-waiting")), "Type in “q”");
  assert.equal(text(about.querySelector(".na-waiting")), "Pick a row in “Search results”");
  assert.deepEqual([...shelf.querySelectorAll("tbody tr td:first-child")].map((td) => text(td)), ["Dune", "Middlemarch", "Piranesi", "The Overstory"]);

  const box = root.querySelector('.na-inputs input[type="search"]') as HTMLInputElement;
  box.value = "dune";
  key(box, "Enter");
  await settle();
  assert.deepEqual(f.requests, ["https://openlibrary.org/search.json?q=dune&limit=10"]);
  const items = [...results.querySelectorAll("li")];
  assert.deepEqual(items.map((li) => text(li)), ["Dune · Frank HerbertAdd", "Dune Messiah · Frank HerbertAdd"]);

  (items[1] as HTMLElement).click();
  await settle();
  assert.equal(text(about.querySelector(".na-text")), "Dune Messiah, by Frank Herbert. First published in 1969; 52 editions.");

  // Dune is already on the shelf; Dune Messiah isn't.
  (items[0].querySelector("button.na-row-action") as HTMLButtonElement).click();
  await settle();
  (items[1].querySelector("button.na-row-action") as HTMLButtonElement).click();
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
});

test("Chores: a form shaped by the block saves chores; ticking one off moves it to done", async () => {
  const spec = readSpec(vaultNote("Apps/Chores.md").fm, { path: "Apps/Chores.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Chores.md"), []);

  const { root, f } = openApp("Apps/Chores.md", {});
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const form = root.querySelector("form.na-form")!;
  assert.deepEqual([...form.querySelectorAll(".na-field span")].map((s) => text(s)), ["task", "room", "done"]);
  (form.querySelector("input") as HTMLInputElement).value = "Water the plants";
  choose(form.querySelector("select")!, "garden");
  form.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(f.files.get("Apps/Chores data.md")!.fm!.chores, [{ task: "Water the plants", room: "garden", done: false, at: "2026-11-18T12:00" }]);
  const todo = root.querySelector(".na-view-table")!;
  assert.equal(text(todo.querySelector("tbody tr")), "Water the plantsgarden");
  assert.equal(text(root.querySelector(".na-view-number .na-big")), "0");

  const tick = todo.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal((f.files.get("Apps/Chores data.md")!.fm!.chores as { done: boolean }[])[0].done, true);
  assert.equal(text(todo.querySelector(".na-empty")), "Nothing here yet.");
  assert.equal(text(root.querySelector(".na-view-number .na-big")), "1");
});

/** A file of the test vault that isn't a note: its text, as the vault would hand it over. */
const vaultFile = (path: string) => ({ raw: readFileSync(new URL(`./vault/${path}`, import.meta.url), "utf8") });

test("Bank: spending per month from the export; pick a transaction and flag it with a reason", async () => {
  const spec = readSpec(vaultNote("Apps/Bank.md").fm, { path: "Apps/Bank.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Bank.md"), ["read:Finance/bank.csv"]);

  const { root, f, changed } = openApp("Apps/Bank.md", { "Finance/bank.csv": vaultFile("Finance/bank.csv") });
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const [months, largest, flag, flagged] = [...root.querySelectorAll(".na-panel")];
  assert.equal(months.querySelectorAll(".na-bar").length, 4);
  const rows = [...largest.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.slice(4).map((tr) => text(tr.querySelectorAll("td")[1])),
    ["Online Furniture Co", "Apple Store", 'Bistro "Le Chat", Elm Ave', "Whole Foods Market"]);
  assert.equal(text(flag.querySelector(".na-waiting")), "Pick a row in “Largest transactions”");

  (rows[4] as HTMLElement).click();
  await settle();
  const form = root.querySelector("form.na-form")!;
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
  assert.equal(root.querySelector(".na-error"), null);
  const [hn, xkcd, saved] = [...root.querySelectorAll(".na-panel")];
  assert.deepEqual([...hn.querySelectorAll("li")].map((li) => text(li)), ["Unreal Tournament 2004 in the BrowserSave", "Show HN: A tiny & fast parserSave"]);
  assert.deepEqual([...xkcd.querySelectorAll("li")].map((li) => text(li)), ["Voyager CrashSave"]);
  assert.equal(text(saved.querySelector(".na-empty")), "Nothing here yet.");

  const save = (li: Element) => (li.querySelector("button.na-row-action") as HTMLButtonElement).click();
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
  assert.equal(root.querySelector(".na-error"), null);
  const [agenda, form, done] = [...root.querySelectorAll(".na-panel")];
  // Wed 18 Nov: the Thursday bins and Tuesday's swim practice (a weekly rule), not Thanksgiving on the 26th.
  assert.deepEqual([...agenda.querySelectorAll("li")].map((li) => text(li)), ["2026-11-19 · Bins outDone", "2026-11-24T17:30 · Swim practiceDone"]);
  assert.equal(text(done.querySelector(".na-empty")), "Nothing here yet.");

  (agenda.querySelectorAll("li")[1].querySelector("button.na-row-action") as HTMLButtonElement).click();
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
  assert.equal(root.querySelector(".na-error"), null);
  const [board, schedule, picked, due] = [...root.querySelectorAll(".na-panel")];
  const column = (name: string) => [...board.querySelectorAll(".na-board-col")].find((c) => text(c.querySelector(".na-board-name")) === name)!;
  const cards = (name: string) => [...column(name).querySelectorAll(".na-board-text")].map((c) => text(c));
  assert.deepEqual(cards("idea"), ["Japan trip · travel", "Learn Rust · learning"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Kitchen remodel · home"]);
  assert.deepEqual(cards("done"), ["Tax filing · money"]);

  // The schedule runs by start date and shows today; nothing is picked yet.
  assert.deepEqual([...schedule.querySelectorAll(".na-tl-label")].map((l) => text(l)), ["Tax filing", "Kitchen remodel", "Garden beds", "Japan trip", "Learn Rust"]);
  assert.equal(schedule.querySelectorAll(".na-tl-today").length, 1);
  assert.equal(text(picked.querySelector(".na-waiting")), "Pick a row in “Schedule”");

  const bars = [...schedule.querySelectorAll(".na-tl-bar")] as HTMLElement[];
  bars[2].click();
  await settle();
  assert.equal(text(picked.querySelector(".na-text")), "Garden beds is due 2026-11-30");

  // November is shown: the garden is due on the 30th. December has the kitchen.
  const day = (date: string) => due.querySelector(`[data-date="${date}"]`)!;
  assert.equal(text(day("2026-11-30").querySelector(".na-cal-val")), "1");
  assert.ok(day("2026-11-18").classList.contains("na-today"));
  (due.querySelector('button[aria-label="Next month"]') as HTMLButtonElement).click();
  assert.equal(text(day("2026-12-15").querySelector(".na-cal-val")), "1");

  // Drag Japan trip to doing: its note's status changes and the board follows.
  const trip = [...board.querySelectorAll(".na-board-card")].find((c) => text(c.querySelector(".na-board-text")).startsWith("Japan"))!;
  event(trip, "dragstart");
  event(column("doing"), "drop");
  await settle();
  assert.equal(f.files.get("Projects/Japan trip.md")!.fm!.status, "doing");
  assert.deepEqual(cards("idea"), ["Learn Rust · learning"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Japan trip · travel", "Kitchen remodel · home"]);
  // The picked project survived the reload, and the calendar stayed on December.
  assert.equal(text(picked.querySelector(".na-text")), "Garden beds is due 2026-11-30");
  assert.equal(text(due.querySelector(".na-cal-title")), "December 2026");
});

test("Habits: log a stretch, and the streak and today's square in the Year tab follow", async () => {
  const spec = readSpec(vaultNote("Apps/Habits.md").fm, { path: "Apps/Habits.md" })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, "Apps/Habits.md"), []);

  const { root, f } = openApp("Apps/Habits.md", { "Apps/Habits data.md": { fm: vaultNote("Apps/Habits data.md").fm } });
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  assert.deepEqual([...root.querySelectorAll("button.na-tab")].map(text), ["Weeks", "Moods", "Year"]);
  const streak = () => text(root.querySelector(".na-view-number .na-big"));
  const square = (date: string) => root.querySelector(`rect[data-date="${date}"]`)!;
  assert.equal(root.querySelectorAll("rect").length, 365);
  assert.equal(streak(), "0days");
  // A day with a stretch, the day after without; none yet today.
  assert.equal(square("2026-11-05").getAttribute("aria-label"), "2026-11-05: 1");
  assert.ok(/na-step/.test(square("2026-11-05").getAttribute("class")!));
  assert.equal(square("2026-11-06").getAttribute("aria-label"), "2026-11-06: 0");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 0");
  assert.ok(square("2026-11-18").classList.contains("na-today"));
  assert.ok(!/na-step/.test(square("2026-11-18").getAttribute("class")!));

  (root.querySelector("button.na-button") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual((f.files.get("Apps/Habits data.md")!.fm!.stretches as { at: string }[]).at(-1), { at: "2026-11-18T12:00" });
  assert.equal(streak(), "1days");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 1");
  assert.ok(/na-step/.test(square("2026-11-18").getAttribute("class")!));
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
  assert.equal(root.querySelector(".na-error"), null);
  const [open, soon, done] = [...root.querySelectorAll(".na-panel")];
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
  assert.equal(text(soon.querySelector(".na-big")), "4");
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
  assert.equal(text(soon.querySelector(".na-big")), "3");
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
  assert.equal(root.querySelector(".na-error"), null);
  const [shelf, byStatus] = [...root.querySelectorAll(".na-panel")];
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
  assert.equal(root.querySelector(".na-error"), null);
  const [form, week, chart, recent] = [...root.querySelectorAll(".na-panel")];

  // This week ($42.25) against last week ($125.50).
  assert.equal(text(week.querySelector(".na-big")), "$42.25");
  assert.equal(text(week.querySelector(".na-compare")), "▼ $83.25 (66%) vs previous");
  assert.equal(week.querySelector(".na-compare")!.getAttribute("aria-label"), "down $83.25, 66 percent, versus previous");

  // Weekly totals stacked by category, with the budget line.
  assert.equal(text(chart.querySelector(".na-goal-label")), "goal $400");
  assert.equal(text(chart.querySelector(".na-legend")), "FoodRentTransportFunOther");
  assert.ok(chart.querySelectorAll("path.na-bar.na-stacked").length >= 6);
  assert.match(text(chart.querySelector(".na-readout")), /Food \$30.*Transport \$12/);

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
  assert.equal(text(week.querySelector(".na-big")), "$62.25");
  assert.equal(text(week.querySelector(".na-compare")), "▼ $63.25 (50%) vs previous");
  assert.deepEqual([...recent.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelectorAll("td")[1])).slice(0, 2), ["$20.00", "$30.25"]);
  assert.equal(text(recent.querySelector("tbody tr td")), "just now");

  // The movie was food after all.
  choose(recent.querySelector("tbody tr select")!, "food");
  await settle();
  assert.equal((f.files.get("Apps/Spending data.md")!.fm!.spend as Record<string, unknown>[]).at(-1)!.category, "food");
  assert.equal(text(week.querySelector(".na-big")), "$62.25");
  assert.match(text(chart.querySelector(".na-readout")), /Food \$50/);
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
  const open = async (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    new AppController(root, path, t.env).load();
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
  assert.equal(root.querySelector(".na-error"), null);
  const [now, , record, sightings] = [...root.querySelectorAll(".na-panel")];
  assert.equal(text(now.querySelector(".na-big")), "5.33");
  assert.equal(text(record.querySelector(".na-title")), "My Kp record");
  assert.ok(record.querySelector(".na-chart-svg"));
  (root.querySelector("button.na-button") as HTMLButtonElement).click();
  await settle();
  assert.equal(text(sightings.querySelector(".na-list")), "2026-11-18T12:00");
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
  const items = [...root.querySelectorAll(".na-alerts li")];
  assert.deepEqual(items.map((li) => [...li.children].map((c) => text(c))), [["Space weather", "Kp now", "5.33"]]);
  const box = root.querySelector(".na-checklist input") as HTMLInputElement;
  box.dispatchEvent(new window.Event("change"));
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Attention data.md")!.fm!.done_today, ["Take meds"]);
  assert.match(text(root.querySelector(".na-view-checklist .na-title")), /1\/4/);
});
