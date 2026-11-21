import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import type { NoteReader } from "../src/expand.ts";
import { HostedApp, parseHosted } from "../src/hosted.ts";
import { LensIndex, LensStack } from "../src/lenses.ts";
import { pickPanels, readComponentPreview, readSpec } from "../src/spec.ts";
import { permissionsOf } from "../src/permissions.ts";
import { fakeBackground, fakeEnv, listsIn, raw, savedAt } from "./support/fakes.ts";
import { parseYaml, vaultNote } from "./support/yaml.ts";

// The notes under gallery/, proved: each reads without errors and asks for exactly the permissions
// listed here, and the main action of each is driven through an AppController on a fake vault.
// The fake clock reads Wednesday 18 November 2026, 12:00; every permission is granted.

const GALLERY = new URL("../gallery/", import.meta.url);
type Notes = Parameters<typeof fakeEnv>[0];

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const click = (el: Element) => event(el, "click");
const change = (el: Element) => event(el, "change");
const submit = (el: Element) => el.dispatchEvent(new window.Event("submit"));
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  change(select);
};
/** Types into an input and leaves it, as a person does. */
const type = (input: Element, value: string) => {
  (input as HTMLInputElement).value = value;
  change(input);
};
const panels = (root: Element) => [...root.querySelectorAll(".gz-panel")];
/** A panel that reads a pick nobody made: in the composed layout, empty and out of sight until there is one. */
const waitsForPick = (el: Element) => el.classList.contains("gz-collapsed") && el.childNodes.length === 0;

/** Everything a test started, stopped afterwards: an app that refreshes keeps its timer, and the process, alive. */
const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** A gallery note: its frontmatter and the text after it. */
function gallery(path: string): { fm: Record<string, unknown>; body: string } {
  const source = readFileSync(new URL(path, GALLERY), "utf8");
  const m = source.match(/^---\n([\s\S]*?)\n---\n?/);
  return { fm: (m ? parseYaml(m[1]) : {}) as Record<string, unknown>, body: m ? source.slice(m[0].length) : source };
}
const galleryFile = (path: string) => ({ raw: readFileSync(new URL(path, GALLERY), "utf8") });
const fm = (path: string) => gallery(path).fm;
const noteNames = (folder: string) => readdirSync(new URL(`${folder}/`, GALLERY)).filter((n) => n.endsWith(".md") && !n.endsWith(" data.md")).sort();

/** The apps and components of the gallery, as links find them. */
const reader: NoteReader = (() => {
  const all: Record<string, Record<string, unknown>> = {};
  for (const folder of ["Apps", "Components"]) for (const n of noteNames(folder)) all[`${folder}/${n}`] = fm(`${folder}/${n}`);
  return {
    resolve: (link) => Object.keys(all).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
    frontmatter: (path) => all[path],
  };
})();

// ---- Every note reads without errors and asks for exactly this -----------------------------------

/** What each app asks the person to allow; a change to a note that changes this has to say so here. */
const APPS: Record<string, string[]> = {
  "Apps/Aurora watch.md": ["net:services.swpc.noaa.gov"],
  "Apps/Book finder.md": ["create:Books", "edit:Books", "images", "net:openlibrary.org", "read:Books", "send:openlibrary.org|typed.q"],
  "Apps/Budget.md": ["answer:spent"],
  "Apps/Decision journal.md": ["create:Decisions", "edit:Decisions", "read:Decisions"],
  "Apps/Household chores.md": [],
  "Apps/Medication log.md": ["answer:doses-today"],
  "Apps/Project board.md": ["create:Projects", "edit:Projects", "read:Projects"],
  "Apps/Read later.md": ["create:Reading", "edit:Reading", "net:feeds.bbci.co.uk", "net:feeds.npr.org", "read:Reading"],
  "Apps/Task inbox.md": ["read:Tasks", "tasks:Tasks", "write:Tasks/Inbox.md"],
  "Apps/Sleep.md": [],
  "Apps/Trip planner.md": ["net:api.frankfurter.dev", "net:api.open-meteo.com", "net:archive-api.open-meteo.com", "read:Trips/Tokyo.ics",
    "send:api.open-meteo.com|this.lat", "send:api.open-meteo.com|this.lon", "send:archive-api.open-meteo.com|this.lat", "send:archive-api.open-meteo.com|this.lon"],
  "Apps/Watchlist.md": ["net:query1.finance.yahoo.com", "send:query1.finance.yahoo.com|picked.position.symbol"],
  "Apps/Weight.md": [],
};
const COMPONENTS: Record<string, string[]> = {
  "Components/Decision review.md": ["edit:Decisions"],
  "Components/Destination weather.md": ["net:api.open-meteo.com", "net:archive-api.open-meteo.com"],
  "Components/Reading progress.md": ["edit:Books"],
  "Components/Tracker kit.md": [],
};

test("every gallery app reads without errors, asks for what it says it asks for, and has a way to act", () => {
  assert.deepEqual(noteNames("Apps").map((n) => `Apps/${n}`), Object.keys(APPS).sort());
  for (const [path, wanted] of Object.entries(APPS)) {
    const { fm: app, body } = gallery(path);
    const r = readSpec(app, { path, notes: reader });
    assert.ok(r?.spec, `${path} is an app`);
    assert.deepEqual(r.errors, [], path);
    assert.deepEqual(permissionsOf(r.spec, path), wanted, path);
    assert.ok(typeof app.app === "string" && app.app.length > 0, `${path} says what it is for`);
    assert.ok(body.trim().length > 0, `${path} says how to use it`);
    // Something a person can do in it: log, add, tick, edit, move, pick, open.
    const acts = r.spec.panels.some(({ panel: p }) => p.save || p.append || p.open || p.edit?.length || p.select || p.view === "board" || p.view === "checklist");
    assert.ok(acts, `${path} has a way to act`);
  }
});

test("every gallery component reads without errors and asks for what it says it asks for", () => {
  assert.deepEqual(noteNames("Components").map((n) => `Components/${n}`), Object.keys(COMPONENTS).sort());
  for (const [path, wanted] of Object.entries(COMPONENTS)) {
    const { fm: component, body } = gallery(path);
    const r = readComponentPreview(component, { path, notes: reader });
    assert.ok(r.result.spec, `${path} is a component`);
    assert.deepEqual(r.result.errors, [], path);
    assert.deepEqual(permissionsOf(r.result.spec, path), wanted, path);
    assert.ok(body.trim().length > 0, `${path} says what it is for`);
  }
  assert.equal(readComponentPreview(fm("Components/Reading progress.md"), { path: "Components/Reading progress.md", notes: reader }).lens, "Books");
  assert.equal(readComponentPreview(fm("Components/Decision review.md"), { path: "Components/Decision review.md", notes: reader }).lens, "Decisions");
});

/** The `gizmo` blocks of a note's text. */
const blocksOf = (body: string) => [...body.matchAll(/```gizmo\n([\s\S]*?)```/g)].map((m) => m[1]);

test("Today is a plain note; each of its gizmo blocks reads without errors and asks for nothing", () => {
  const today = gallery("Today.md");
  assert.equal(today.fm.app, undefined);
  const sources = blocksOf(today.body);
  assert.equal(sources.length, 2);
  const [meds, water] = sources.map((s) => parseHosted(parseYaml(s)));

  assert.equal("error" in meds, false);
  assert.ok("kind" in meds && meds.kind === "app");
  const app = readSpec(fm("Apps/Medication log.md"), { path: "Apps/Medication log.md", notes: reader })!;
  const shown = pickPanels(app.spec!, meds.panels ?? [], "Medication log");
  assert.deepEqual(shown.errors, []);
  assert.deepEqual(shown.spec.panels.map((ps) => ps.panel.view), ["button", "number"]);
  assert.deepEqual(permissionsOf(shown.spec, "Apps/Medication log.md"), ["answer:doses-today"]);

  assert.ok("kind" in water && water.kind === "embed");
  const own = readSpec(water.definition, { path: "Today.md", notes: reader, host: {} })!;
  assert.deepEqual(own.errors, []);
  assert.deepEqual(permissionsOf(own.spec!, "Today.md"), []);
});

test("Start here lists every gallery note with the sentence its first line holds", () => {
  const { body } = gallery("Start here.md");
  const paths = [...noteNames("Apps").map((n) => `Apps/${n}`), ...noteNames("Components").map((n) => `Components/${n}`)];
  for (const path of paths) {
    const { fm: f } = gallery(path);
    const name = path.replace(/^.*\//, "").replace(/\.md$/, "");
    const sentence = String(f.app ?? f.component);
    assert.ok(body.includes(`- [[${name}]]: ${sentence}`), `${name}: ${sentence}`);
  }
  assert.ok(body.includes("- [[Today]]: "));
  assert.ok(body.trimEnd().endsWith("Copy a note into your vault and open it; it will ask before it touches anything."));
});

// ---- Driving the apps -----------------------------------------------------------------------------

function openApp(path: string, notes: Notes = {}, responses: Record<string, unknown> = {}, definition = fm(path)) {
  const t = fakeEnv({ [path]: { fm: definition }, ...notes }, responses);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const controller = new AppController(root, path, t.env);
  started.push(controller);
  controller.load();
  return { ...t, root };
}

/** The background service on a fake vault, started; `open` draws an app as its tab would. */
async function background(notes: Notes, responses: Record<string, unknown> = {}) {
  const t = fakeBackground(notes, responses);
  t.env.opened = (path) => t.bg.opened(path);
  t.env.alerts = t.bg.alerts;
  await t.bg.start();
  const open = async (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const controller = new AppController(root, path, t.env);
    started.push(controller);
    controller.load();
    await settle();
    return root;
  };
  return { ...t, open };
}

test("Medication log: a dose from the button, a hotkey or a link; the count, streak, year and a picked day follow", async () => {
  const path = "Apps/Medication log.md";
  const doses = [{ at: "2026-11-16T08:00" }, { at: "2026-11-17T08:05" }];
  const t = await background({ [path]: { fm: fm(path) }, "Apps/Medication log data.md": { fm: { doses } } });
  assert.deepEqual(t.out.commands, [
    { id: `${path}:doses-today`, name: "Medication log: Doses today" },
    { id: `${path}:took-meds`, name: "Medication log: Took meds" },
  ]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Doses today: 0", title: "Medication log" }]);

  const root = await t.open(path);
  assert.equal(root.querySelector(".gz-error"), null);
  const [today, streak, onTime, , year, day] = panels(root);
  const square = (date: string) => root.querySelector(`rect[data-date="${date}"]`)!;
  assert.equal(text(today.querySelector(".gz-big")), "0");
  assert.equal(text(streak.querySelector(".gz-big")), "2days");
  assert.match(text(onTime.querySelector(".gz-big")), /^\d+days$/);
  assert.ok(waitsForPick(day));

  click(root.querySelector("button.gz-button")!);
  await settle();
  assert.equal(text(today.querySelector(".gz-big")), "1");
  assert.equal(text(streak.querySelector(".gz-big")), "3days");
  assert.equal(square("2026-11-18").getAttribute("aria-label"), "2026-11-18: 1");
  assert.equal(square("2026-11-17").getAttribute("aria-label"), "2026-11-17: 1");
  assert.equal(year.querySelectorAll("rect").length, 365);

  // Pick the 18th: its dose, as a time.
  click(square("2026-11-18"));
  await settle();
  assert.equal(day.querySelectorAll("li").length, 1);
  assert.match(text(day.querySelector("li")), /12:00/);
  click(square("2026-11-17"));
  await settle();
  assert.match(text(day.querySelector("li")), /8:05/);

  // With the app closed: a hotkey, then a link.
  await t.bg.runCommand(`${path}:took-meds`);
  await t.bg.runUri({ app: "Medication log", do: "took-meds" });
  await settle();
  const saved = t.f.files.get("Apps/Medication log data.md")!.fm!.doses as { at: string }[];
  assert.equal(saved.length, 5);
  assert.equal(text(today.querySelector(".gz-big")), "3");
  assert.deepEqual(t.notices, ["Dose logged", "Dose logged", "Dose logged"]);
  assert.equal(t.out.status[0].text, "Doses today: 3");
});

const TRACKER = "Components/Tracker kit.md";

test("Weight: the Tracker kit in three lines; log a weight, see the week against the last, the goal line, and fix an entry in the table", async () => {
  assert.deepEqual(Object.keys(fm("Apps/Weight.md")), ["app", "use", "with"]);
  const weight = [
    { value: 81.2, at: "2026-11-10T07:30" }, { value: 80.8, at: "2026-11-13T07:30" },
    { value: 80.6, at: "2026-11-16T07:30" }, { value: 80.2, at: "2026-11-17T07:30" },
  ];
  const { root, f } = openApp("Apps/Weight.md", { [TRACKER]: { fm: fm(TRACKER) }, "Apps/Weight data.md": { fm: { weight } } });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [week, latest, form, chart, entries] = panels(root);
  assert.deepEqual(panels(root).map((p) => text(p.querySelector(".gz-title"))), ["This week", "Latest", "Log my weight", "My weight against my goal", "Entries"]);
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["weight", "note"]);
  assert.equal(text(week.querySelector(".gz-big")), "80.4kg");
  assert.equal(text(week.querySelector(".gz-compare")), "▼ 0.6 kg (<1%) vs previous");
  assert.equal(text(latest.querySelector(".gz-big")), "80.2kg");
  assert.equal(text(chart.querySelector(".gz-goal-label")), "Goal 75 kg");
  assert.equal(chart.querySelector(".gz-legend"), null);
  assert.deepEqual([...entries.querySelectorAll("th")].map(text), ["at", "weight", "note"]);

  const [value, note] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  value.value = "79.4";
  note.value = "after the trip";
  submit(form.querySelector("form")!);
  await settle();
  const saved = f.files.get("Apps/Weight data.md")!.fm!.weight as Record<string, unknown>[];
  assert.deepEqual(saved.at(-1), { value: 79.4, note: "after the trip", at: savedAt("2026-11-18T12:00") });
  assert.equal(text(latest.querySelector(".gz-big")), "79.4kg");
  assert.equal(text(week.querySelector(".gz-big")), "80.1kg");
  assert.equal(text(week.querySelector(".gz-compare")), "▼ 0.9 kg (1%) vs previous");

  // The newest entry is the first row; its weight was a typo.
  const first = entries.querySelector("tbody tr")!;
  assert.equal(text(first.querySelectorAll("td")[0]), new Date(2026, 10, 18, 12).toLocaleDateString());
  type(first.querySelectorAll("input")[0], "79.9");
  await settle();
  assert.equal((f.files.get("Apps/Weight data.md")!.fm!.weight as { value: number }[]).at(-1)!.value, 79.9);
  assert.equal(text(latest.querySelector(".gz-big")), "79.9kg");
});

test("Sleep: the same kit for hours slept, against a goal of eight", async () => {
  assert.deepEqual(Object.keys(fm("Apps/Sleep.md")), ["app", "use", "with"]);
  const sleep = [{ value: 6, at: "2026-11-10T07:00" }, { value: 7, at: "2026-11-16T07:00" }, { value: 6, at: "2026-11-17T07:00" }];
  const { root, f } = openApp("Apps/Sleep.md", { [TRACKER]: { fm: fm(TRACKER) }, "Apps/Sleep data.md": { fm: { sleep } } });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [week, latest, form, chart, entries] = panels(root);
  assert.equal(text(root.querySelector(".gz-description")), "Log how long I sleep and see whether I'm getting my eight hours");
  assert.deepEqual(panels(root).map((p) => text(p.querySelector(".gz-title"))), ["This week", "Latest", "Log my sleep", "My sleep against my goal", "Entries"]);
  assert.equal(text(week.querySelector(".gz-big")), "6.5hours");
  assert.equal(text(week.querySelector(".gz-compare")), "▲ 0.5 hours (8%) vs previous");
  assert.equal(text(chart.querySelector(".gz-goal-label")), "Goal 8 hours");

  (form.querySelector("input") as HTMLInputElement).value = "8.5";
  submit(form.querySelector("form")!);
  await settle();
  assert.deepEqual((f.files.get("Apps/Sleep data.md")!.fm!.sleep as unknown[]).at(-1), { value: 8.5, note: "", at: savedAt("2026-11-18T12:00") });
  assert.equal(text(latest.querySelector(".gz-big")), "8.5hours");
  assert.equal(text(week.querySelector(".gz-big")), "7.2hours");
  assert.deepEqual([...entries.querySelectorAll("th")].map(text), ["at", "sleep", "note"]);
});

test("Tracker kit: one app may use it twice; each thing it tracks keeps its own list", async () => {
  const both = {
    app: "Weight and sleep together",
    panels: [
      { use: "[[Tracker kit]]", with: { what: "weight", unit: "kg", goal: 75 } },
      { use: "[[Tracker kit]]", with: { what: "sleep", unit: "hours", goal: 8 } },
    ],
  };
  const r = readSpec(both, { path: "Apps/Health.md", notes: reader })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Apps/Health.md"), []);
  const { root, f } = openApp("Apps/Health.md", { [TRACKER]: { fm: fm(TRACKER) } }, {}, both);
  await settle();
  const forms = panels(root).filter((p) => p.querySelector("form"));
  assert.equal(forms.length, 2);
  for (const [form, v] of [[forms[0], "80"], [forms[1], "7.5"]] as const) {
    (form.querySelector("input") as HTMLInputElement).value = v;
    submit(form.querySelector("form")!);
    await settle();
  }
  const data = f.files.get("Apps/Health data.md")!.fm!;
  assert.deepEqual([data.weight, data.sleep], [[{ value: 80, note: "", at: savedAt("2026-11-18T12:00") }], [{ value: 7.5, note: "", at: savedAt("2026-11-18T12:00") }]]);
});

test("Budget: log an expense, see the month against last, the stacked weeks and a notice at the limit", async () => {
  const path = "Apps/Budget.md";
  const spend = [
    { amount: 1800, category: "home", note: "rent", at: "2026-10-03T08:00" },
    { amount: 300, category: "food", note: "", at: "2026-11-02T08:00" },
    { amount: 400, category: "home", note: "", at: "2026-11-03T08:00" },
  ];
  // Last month and this one together pass 2000; this month alone doesn't, so nothing is told yet. The alert sits on
  // the limit bar, not on the number that compares: a compared panel is evaluated over both months.
  const t = await background({ [path]: { fm: fm(path) }, "Apps/Budget data.md": { fm: { spend } } });
  assert.deepEqual(t.notices, []);
  const root = await t.open(path);
  assert.equal(root.querySelector(".gz-error"), null);
  const [month, limit, form, chart, recent] = panels(root);
  // The amount field carries its label and money format to the form, the number and the table.
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["Spent", "category", "note"]);
  assert.deepEqual([...recent.querySelectorAll("th")].map(text), ["When", "Spent", "category", "note"]);
  assert.equal(text(month.querySelector(".gz-big")), "$700.00");
  assert.equal(text(limit.querySelector(".gz-big")), "$700/ $2,000");
  assert.equal(text(month.querySelector(".gz-compare")), "▼ $1,100.00 (61%) vs previous");
  assert.equal(text(chart.querySelector(".gz-goal-label")), "$500 goal");
  assert.deepEqual([...chart.querySelectorAll(".gz-legend-name")].map(text), ["Food", "Home", "Transport", "Fun", "Other"]);
  // A bar for each week with spending (1,800 and 700), both past the $500 goal; this week has none yet.
  assert.equal(chart.querySelectorAll("path.gz-bar").length, 2);
  assert.equal(chart.querySelectorAll("path.gz-bar.is-over").length, 2);
  assert.equal(text(chart.querySelector(".gz-stack-head")), "Week of Nov 16$0 of $500");
  assert.equal(chart.querySelectorAll(".gz-strip span").length, 0);

  const [amount, note] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  amount.value = "1350";
  note.value = "flights";
  choose(form.querySelector("select")!, "transport");
  submit(form.querySelector("form")!);
  await settle();
  const saved = t.f.files.get("Apps/Budget data.md")!.fm!.spend as Record<string, unknown>[];
  assert.deepEqual(saved.at(-1), { amount: 1350, category: "transport", note: "flights", at: savedAt("2026-11-18T12:00") });
  assert.equal(text(month.querySelector(".gz-big")), "$2,050.00");
  assert.equal(text(limit.querySelector(".gz-big")), "$2,050/ $2,000");
  assert.deepEqual(t.notices, ["Budget: Against my limit $2,050"]);
  assert.deepEqual(t.bg.alerts.list().map((a) => [a.app, a.title, a.text]), [["Budget", "Against my limit", "$2,050"]]);

  // The flights were fun, not transport.
  const row = [...recent.querySelectorAll("tbody tr")].find((tr) => (tr.querySelector("input.gz-edit") as HTMLInputElement | null)?.value === "1350")!;
  choose(row.querySelector("select")!, "fun");
  await settle();
  assert.equal((t.f.files.get("Apps/Budget data.md")!.fm!.spend as { category: string }[]).at(-1)!.category, "fun");
});

const DOCS = {
  numFound: 2,
  docs: [
    { key: "/works/OL893415W", title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, edition_count: 155, number_of_pages_median: 412, cover_i: 11481354 },
    { key: "/works/OL20893680W", title: "Piranesi", author_name: ["Susanna Clarke"], first_publish_year: 2020, edition_count: 23, number_of_pages_median: 272 },
  ],
};

test("Book finder: search, read about a pick, add it to Books, then set its status and finish date on its card", async () => {
  const { root, f, notices } = openApp(
    "Apps/Book finder.md",
    { "Books/Middlemarch.md": { fm: { author: "George Eliot", status: "done", finished: "2026-02-10", cover: 1 } } },
    { "https://openlibrary.org/search.json": DOCS },
  );
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [read, results, shelf] = panels(root);
  assert.equal(text(results.querySelector(".gz-waiting")), "Type in “q”");
  assert.equal(text(read.querySelector(".gz-big")), "1");
  assert.deepEqual([...shelf.querySelectorAll(".gz-rowcard-title")].map(text), ["Middlemarch"]);

  const box = root.querySelector('.gz-inputs input[type="search"]') as HTMLInputElement;
  box.value = "dune";
  const enter = new window.Event("keydown", { bubbles: true }) as Event & { key: string };
  enter.key = "Enter";
  box.dispatchEvent(enter);
  await settle();
  assert.deepEqual(f.requests, ["https://openlibrary.org/search.json?q=dune&limit=10&fields=key,title,author_name,first_publish_year,edition_count,number_of_pages_median,cover_i"]);
  const items = [...results.querySelectorAll("li")];
  assert.deepEqual(items.map(text), ["Dune · Frank Herbert (1965)Add", "Piranesi · Susanna Clarke (2020)Add"]);
  // Picking a result tells me about it under the results; it isn't a note yet, so there is nothing to open.
  click(items[0]);
  await settle();
  assert.equal(text(results.querySelector(".gz-detail-text")), "Dune, by Frank Herbert, first published in 1965. 155 editions.");
  assert.equal(results.querySelector(".gz-detail a"), null);

  for (const li of items) click(li.querySelector("button.gz-row-action")!);
  await settle();
  assert.deepEqual(notices, ["Added Dune to Books", "Added Piranesi to Books"]);
  assert.deepEqual(f.files.get("Books/Dune.md")!.fm,
    { title: "Dune", author: "Frank Herbert", year: 1965, pages: 412, cover: 11481354, status: "to read", at: savedAt("2026-11-18T12:00") });
  // Saving the same book twice is refused, not overwritten.
  click(items[0].querySelector("button.gz-row-action")!);
  await settle();
  assert.equal(notices.at(-1), "“Dune” already exists");

  const cards = () => [...shelf.querySelectorAll(".gz-rowcard")];
  assert.deepEqual(cards().map((c) => text(c.querySelector(".gz-rowcard-title"))), ["Dune", "Middlemarch", "Piranesi"]);
  assert.equal(cards()[0].querySelector("img")!.getAttribute("src"), "https://covers.openlibrary.org/b/id/11481354-M.jpg");
  assert.equal(cards()[2].querySelector("img"), null);

  // Started, then finished.
  choose(cards()[0].querySelector("select")!, "reading");
  await settle();
  assert.equal(f.files.get("Books/Dune.md")!.fm!.status, "reading");
  choose(cards()[0].querySelector("select")!, "done");
  type(cards()[0].querySelector('input[type="date"]')!, "2026-11-18");
  await settle();
  assert.deepEqual([f.files.get("Books/Dune.md")!.fm!.status, f.files.get("Books/Dune.md")!.fm!.finished], ["done", "2026-11-18"]);
  assert.equal(text(read.querySelector(".gz-big")), "2");
});

test("Reading progress: a lens above every book tracks the page, from the book's own properties", async () => {
  const path = "Components/Reading progress.md";
  const books = {
    "Books/Dune.md": { fm: { pages: 300, page: 100, status: "reading" } },
    "Books/Piranesi.md": { fm: { pages: 272 } },
    "Books/Unread.md": { fm: {} },
  };
  const t = fakeEnv({ [path]: { fm: fm(path) }, "Apps/Book finder.md": { fm: fm("Apps/Book finder.md") }, ...books });
  const index = new LensIndex(t.data);
  assert.deepEqual(index.lensesFor("Books/Dune.md"), [path]);
  assert.deepEqual(index.lensesFor("Apps/Book finder.md"), []);

  const grants: Record<string, string[]> = {};
  t.env.isGranted = (key, wanted) => wanted.length === 0 || (grants[key] ?? []).join("\n") === wanted.join("\n");
  t.env.grant = async (key, wanted) => { grants[key] = wanted; };
  const lens = (host: string) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const stack = new LensStack(el, index, () => t.env, { folded: () => false, setFolded: () => {} });
    started.push(stack);
    stack.show(host);
    return { el, stack };
  };
  const { el, stack } = lens("Books/Dune.md");
  await settle();
  assert.deepEqual([...el.querySelectorAll(".gz-card li")].map(text), ["Change properties of notes in Books"]);
  click(el.querySelector(".gz-card button.mod-cta")!);
  await settle();
  assert.deepEqual(grants, { [path]: ["edit:Books"] });
  assert.equal(el.querySelector(".gz-error"), null);
  assert.equal(text(el.querySelector(".gz-view-progress .gz-big")), "100/ 300 pages");
  assert.equal(text(el.querySelector(".gz-view-text .gz-text")), "33% read, 200 pages to go");

  const form = el.querySelector("form.gz-form")!;
  const [page, pages] = [...form.querySelectorAll("input")] as HTMLInputElement[];
  assert.deepEqual([page.value, pages.value], ["100", "300"]);
  type(page, "150");
  await settle();
  choose(form.querySelector("select")!, "done");
  type(form.querySelector('input[type="date"]')!, "2026-11-18");
  await settle();
  assert.deepEqual(t.f.files.get("Books/Dune.md")!.fm, { pages: 300, page: 150, status: "done", finished: "2026-11-18" });
  assert.equal(text(el.querySelector(".gz-view-progress .gz-big")), "150/ 300 pages");
  assert.equal(text(el.querySelector(".gz-view-text .gz-text")), "50% read, 150 pages to go");
  stack.dispose();

  // A book with a page count and no page yet; a book with neither.
  const second = lens("Books/Piranesi.md");
  await settle();
  assert.equal(text(second.el.querySelector(".gz-view-text .gz-text")), "0% read, 272 pages to go");
  second.stack.dispose();
  const third = lens("Books/Unread.md");
  await settle();
  assert.equal(text(third.el.querySelector(".gz-view-text .gz-text")), "Type the page count below");
  third.stack.dispose();
});

test("Project board: add a project, drag it along, pick it for its dates, and open its note", async () => {
  const samples = Object.fromEntries(["Garden beds", "Japan trip", "Learn Rust", "Tax return"].map((n) => [`Projects/${n}.md`, { fm: fm(`Projects/${n}.md`) }]));
  const { root, f, opened } = openApp("Apps/Project board.md", samples);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [form, board, schedule] = panels(root);
  const column = (name: string) => [...board.querySelectorAll(".gz-board-col")].find((c) => text(c.querySelector(".gz-board-name")) === name)!;
  const cards = (name: string) => [...column(name).querySelectorAll(".gz-board-text")].map(text);
  assert.deepEqual(cards("idea"), ["Learn Rust · learning", "Tax return · money"]);
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Japan trip · travel"]);
  assert.deepEqual(cards("done"), []);
  assert.equal(schedule.querySelectorAll(".gz-tl-bar").length, 4);
  assert.deepEqual([...schedule.querySelectorAll(".gz-tl-label")].map(text), ["Japan trip", "Garden beds", "Learn Rust", "Tax return"]);
  assert.equal(board.querySelector(".gz-detail"), null);

  // A new project starts as an idea.
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["name", "area", "start", "due"]);
  const [name, area, start, due] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  name.value = "Learn piano";
  area.value = "learning";
  start.value = "2026-12-01";
  due.value = "2027-06-30";
  submit(form.querySelector("form")!);
  await settle();
  assert.deepEqual(f.files.get("Projects/Learn piano.md")!.fm, { status: "idea", area: "learning", start: "2026-12-01", due: "2027-06-30", at: savedAt("2026-11-18T12:00") });
  assert.deepEqual(cards("idea"), ["Learn Rust · learning", "Tax return · money", "Learn piano · learning"]);

  // Move it along: its note's status is what changes.
  const card = (title: string) => [...board.querySelectorAll(".gz-board-card")].find((c) => text(c.querySelector(".gz-board-text")).startsWith(title))!;
  event(card("Learn piano"), "dragstart");
  event(column("doing"), "drop");
  await settle();
  assert.equal(f.files.get("Projects/Learn piano.md")!.fm!.status, "doing");
  assert.deepEqual(cards("doing"), ["Garden beds · home", "Japan trip · travel", "Learn piano · learning"]);

  // Pick it: its details under the board, with a link that opens its note.
  click(card("Learn piano"));
  await settle();
  assert.equal(text(board.querySelector(".gz-detail-text")), "Learn piano is doing, due 2027-06-30 (learning)");
  assert.equal(text(board.querySelector(".gz-detail a")), "Open");
  click(board.querySelector(".gz-detail a")!);
  await settle();
  assert.deepEqual(opened, ["Projects/Learn piano.md"]);
});

/** The sample decisions in gallery/Decisions, as notes with their properties and text. */
const decisions = (): Notes => Object.fromEntries(noteNames("Decisions").map((n) => [`Decisions/${n}`, gallery(`Decisions/${n}`)]));

test("Decision journal: one decision is due; write one down, score the due one, and the share and the chart follow", async () => {
  const path = "Apps/Decision journal.md";
  const t = await background({ [path]: { fm: fm(path) }, ...decisions() });
  // With the app closed: the one whose day has come is counted in the status bar and told once.
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Ready to score: 1", title: "Decision journal" }]);
  assert.deepEqual(t.notices, ["Decision journal: Ready to score 1"]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:decide`, name: "Decision journal: Write it down" }]);

  const root = await t.open(path);
  assert.equal(root.querySelector(".gz-error"), null);
  const panel = (title: string) => panels(root).find((p) => text(p.querySelector(".gz-title")) === title)!;
  const tab = (name: string) => click([...root.querySelectorAll("button.gz-tab")].find((b) => text(b) === name)!);
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["Score", "Waiting", "Track record"]);
  assert.equal(text(panel("Ready to score").querySelector(".gz-big")), "1");
  assert.equal(text(panel("Right so far").querySelector(".gz-big")), "67%");

  // Written down: a note in Decisions, its confidence a number, outcome open and today's date from the fields' defaults.
  const form = panel("A decision I'm making");
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["Decision", "I expected", "% sure", "Due"]);
  const [name, expect] = form.querySelectorAll("input");
  type(name, "Walk to work through the winter");
  type(expect, "I keep it up until March");
  choose(form.querySelector("select")!, "80");
  type(form.querySelector('input[type="date"]')!, "2027-03-01");
  submit(form.querySelector("form")!);
  await settle();
  assert.deepEqual(t.f.files.get("Decisions/Walk to work through the winter.md")!.fm, {
    expect: "I keep it up until March", confidence: 80, review: "2027-03-01", outcome: "open", made: "2026-11-18", at: savedAt("2026-11-18T12:00"),
  });
  assert.ok(t.notices.includes("Written down. Come back on 2027-03-01 to score it."), t.notices.join("; "));

  // Waiting: picking one shows what I expected, with a link to its note.
  tab("Waiting");
  const timeline = panel("Still waiting to find out");
  assert.deepEqual([...timeline.querySelectorAll(".gz-tl-label")].map(text),
    ["Repaint the hallway myself", "Take the night train to Vienna", "Walk to work through the winter"]);
  click(timeline.querySelectorAll(".gz-tl-bar")[1]);
  assert.equal(text(timeline.querySelector(".gz-detail-text")),
    "Take the night train to Vienna. I expected: It costs less than flying once I count the hotel night (80% sure). I'll know by 2027-03-20.");

  // Score the due one in place: what I learned, then how it went; it leaves the table and the count.
  tab("Score");
  const score = panel("How did these turn out?");
  assert.deepEqual([...score.querySelectorAll("th")].map(text), ["Decision", "I expected", "% sure", "Due", "It went", "What I learned"]);
  const row = score.querySelector("tbody tr")!;
  assert.deepEqual([...row.querySelectorAll("td")].slice(0, 4).map(text),
    ["Repaint the hallway myself", "It takes one weekend and looks as good as a painter's job", "70", "3 days ago"]);
  type(row.querySelector("input")!, "Two weekends, and the ceiling shows it");
  await settle();
  choose(panel("How did these turn out?").querySelector("tbody tr select")!, "wrong");
  await settle();
  assert.deepEqual(t.f.files.get("Decisions/Repaint the hallway myself.md")!.fm, {
    expect: "It takes one weekend and looks as good as a painter's job", confidence: 70, made: "2026-10-25", review: "2026-11-15",
    outcome: "wrong", learned: "Two weekends, and the ceiling shows it",
  });
  assert.equal(text(panel("Ready to score").querySelector(".gz-big")), "0");
  assert.equal(text(panel("Right so far").querySelector(".gz-big")), "50%");
  assert.equal(t.out.status[0].text, "Ready to score: 0");

  // Track record: what I said against how often I was right, by how sure I was.
  tab("Track record");
  const chart = panel("How sure I said I was, and how often I was right");
  assert.deepEqual([...chart.querySelectorAll(".gz-legend-name")].map(text), ["I said", "I was right"]);
  // 60%, 70% (both of them wrong, so no bar for right) and 90% sure.
  assert.equal(chart.querySelectorAll("path.gz-bar").length, 5);
  assert.equal(text(chart.querySelector(".gz-legend")), "90I said90%I was right100%");
  assert.deepEqual([...panel("Scored").querySelectorAll("tbody tr")].map((tr) => text(tr.querySelector("td"))),
    ["Repaint the hallway myself", "Buy the winter tyres in October", "Fix the electricity price for a year", "Cook dinner from scratch three nights a week"]);
});

test("Decision review: a lens on each decision note reads it back and saves how it went", async () => {
  const path = "Components/Decision review.md";
  const t = fakeEnv({ [path]: { fm: fm(path) }, "Apps/Decision journal.md": { fm: fm("Apps/Decision journal.md") }, ...decisions() });
  const index = new LensIndex(t.data);
  assert.deepEqual(index.lensesFor("Decisions/Take the night train to Vienna.md"), [path]);
  assert.deepEqual(index.lensesFor("Apps/Decision journal.md"), []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const stack = new LensStack(el, index, () => t.env, { folded: () => false, setFolded: () => {} });
  started.push(stack);
  stack.show("Decisions/Take the night train to Vienna.md");
  await settle();
  assert.equal(el.querySelector(".gz-error"), null);
  assert.equal(text(el.querySelector(".gz-view-text .gz-text")), "I expect: It costs less than flying once I count the hotel night (80% sure). Due 2027-03-20.");
  const form = el.querySelector("form.gz-form")!;
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["It went", "What I learned", "Due"]);
  choose(form.querySelector("select")!, "right");
  type(form.querySelector("textarea")!, "The sleeper was full; book it early");
  await settle();
  const saved = t.f.files.get("Decisions/Take the night train to Vienna.md")!;
  assert.deepEqual([saved.fm!.outcome, saved.fm!.learned], ["right", "The sleeper was full; book it early"]);
  assert.equal(text(el.querySelector(".gz-view-text .gz-text")), "I expected: It costs less than flying once I count the hotel night (80% sure). It went right.");
});

test("Task inbox: add a task to the inbox, see what is open and due this week, tick one in its own note", async () => {
  const home = "# Home\n\n- [ ] Water plants 📅 2026-11-19\n- [ ] Buy stamps\n- [x] Call the bank 📅 2026-11-17\n";
  const { root, f, writes } = openApp("Apps/Task inbox.md", { "Tasks/Home.md": { fm: {}, body: home } });
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [soon, form, open, done] = panels(root);
  const openRows = () => [...open.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(0, 3).map(text));
  // The undated task, the one still to be sorted, comes first.
  assert.deepEqual(openRows(), [["Buy stamps", "Home", "—"], ["Water plants 📅 2026-11-19", "Home", "2026-11-19"]]);
  assert.equal(text(soon.querySelector(".gz-big")), "1");
  assert.deepEqual([...done.querySelectorAll("li")].map(text), ["Call the bank 📅 2026-11-17 · Home"]);

  (form.querySelector("input") as HTMLInputElement).value = "Book the dentist";
  submit(form.querySelector("form")!);
  await settle();
  assert.deepEqual(writes, ["Tasks/Inbox.md"]);
  assert.equal(f.files.get("Tasks/Inbox.md")!.body, "- [ ] Book the dentist\n");
  // The inbox is a note in Tasks, so the new task is open too, undated with the others.
  assert.deepEqual(openRows(), [["Buy stamps", "Home", "—"], ["Book the dentist", "Inbox", "—"], ["Water plants 📅 2026-11-19", "Home", "2026-11-19"]]);

  const water = [...open.querySelectorAll("tbody tr")].find((tr) => text(tr.querySelector("td")).startsWith("Water plants"))!;
  const box = water.querySelector('input[type="checkbox"]') as HTMLInputElement;
  box.checked = true;
  change(box);
  await settle();
  assert.equal(f.files.get("Tasks/Home.md")!.body, "# Home\n\n- [x] Water plants 📅 2026-11-19\n- [ ] Buy stamps\n- [x] Call the bank 📅 2026-11-17\n");
  assert.equal(openRows().length, 2);
  assert.equal(text(soon.querySelector(".gz-big")), "0");
  assert.deepEqual([...done.querySelectorAll("li")].map(text), ["Water plants 📅 2026-11-19 · Home", "Call the bank 📅 2026-11-17 · Home"]);
});

const WEATHER = {
  current: { time: "2026-11-18T12:00", temperature_2m: 17.5 },
  daily: {
    time: ["2026-11-18", "2026-11-19"], weather_code: [2, 80],
    temperature_2m_max: [18.7, 14.5], temperature_2m_min: [9.3, 6.9], precipitation_probability_max: [24, 60],
  },
};
const YEAR = { daily: { time: ["2025-01-01", "2025-01-02", "2025-02-01"], temperature_2m_max: [10, 12, 11], temperature_2m_min: [2, 3, 1] } };

test("Trip planner: days to go, packing, the itinerary from a calendar file, expenses in yen and the weather there", async () => {
  const path = "Apps/Trip planner.md";
  const responses = {
    "https://api.open-meteo.com/": WEATHER, "https://archive-api.open-meteo.com/": YEAR, "https://api.frankfurter.dev/": { rates: { JPY: 159.42 } },
  };
  const { root, f, changed } = openApp(path, {
    "Components/Destination weather.md": { fm: fm("Components/Destination weather.md") },
    "Trips/Tokyo.ics": galleryFile("Trips/Tokyo.ics"),
  }, responses);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [days, packing, itinerary, total, rate, form, expenses, now, week, year] = panels(root);
  assert.equal(text(days.querySelector(".gz-big")), "116 days");
  assert.equal(text(packing.querySelector(".gz-title")), "Packing · 0/6");
  assert.deepEqual([...itinerary.querySelectorAll("tbody tr")].map((tr) => text(tr.querySelectorAll("td")[1])),
    ["Flight to Tokyo", "Hotel in Shinjuku", "Breakfast at Tsukiji outer market", "Day trip to Kamakura", "teamLab Planets", "Flight home"]);
  assert.equal(text(rate.querySelector(".gz-big")), "159.42");

  // The weather there: the property lat and lon choose where, and the sky is in words.
  assert.ok(f.requests.includes("https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&current=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto"));
  assert.equal(text(now.querySelector(".gz-title")), "Tokyo now");
  assert.deepEqual([...week.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(1).map(text)),
    [["partly cloudy", "9 to 19 °C", "24 %"], ["showers", "7 to 15 °C", "60 %"]]);
  assert.ok(year.querySelector(".gz-chart-svg"));

  // Pack.
  const tick = packing.querySelector("input") as HTMLInputElement;
  tick.checked = true;
  change(tick);
  await settle();
  assert.deepEqual(f.files.get("Apps/Trip planner data.md")!.fm!.packed, ["Passport"]);
  assert.equal(text(packing.querySelector(".gz-title")), "Packing · 1/6");

  // 3,000 yen at the rate in the note's properties, 150 to the dollar.
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["item", "Yen"]);
  const [item, local] = form.querySelectorAll("input") as unknown as HTMLInputElement[];
  item.value = "Ramen";
  local.value = "3000";
  submit(form.querySelector("form")!);
  await settle();
  assert.deepEqual((f.files.get("Apps/Trip planner data.md")!.fm!.spend as unknown[]), [{ item: "Ramen", local: 3000, at: savedAt("2026-11-18T12:00") }]);
  assert.equal(text(total.querySelector(".gz-big")), "$20.00");
  assert.deepEqual([...expenses.querySelectorAll("th")].map(text), ["item", "Yen", "Dollars"]);
  assert.deepEqual([...expenses.querySelectorAll("tbody tr")[0].querySelectorAll("td")].map(text).slice(2), ["$20.00"]);

  // Edit the rate in the note and the dollars follow.
  f.files.get(path)!.fm!.rate = 100;
  changed(path);
  await settle();
  assert.equal(text(total.querySelector(".gz-big")), "$30.00");
});

const yahoo = (symbol: string, closes: number[]) => ({
  chart: {
    result: [{
      meta: { symbol, regularMarketPrice: closes.at(-1) },
      timestamp: closes.map((_, i) => 1794493800 + i * 86_400),
      indicators: { quote: [{ close: closes, open: closes, volume: closes.map(() => 1) }] },
    }],
  },
});
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";

test("Watchlist: pick a symbol, see its move, record a buy, and pick a position for what it is worth now", async () => {
  const responses = { [`${YAHOO}SPY`]: yahoo("SPY", [523, 523.88, 517.99, 506.24, 508.29]), [`${YAHOO}AAPL`]: yahoo("AAPL", [200, 205, 210]) };
  const { root, f } = openApp("Apps/Watchlist.md", {}, responses);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [price, move, , chart, positions, , worth] = panels(root);
  assert.equal(text(price.querySelector(".gz-big")), "508.29USD");
  assert.equal(text(move.querySelector(".gz-big")), "0.40%");
  assert.ok(chart.querySelector(".gz-chart-svg"));
  assert.equal(text(positions.querySelector(".gz-empty")), "Nothing here yet.");
  assert.ok(waitsForPick(worth));

  const record = async (symbol: string, date: string, shares: string, paid: string) => {
    choose(root.querySelector(".gz-inputs select")!, symbol);
    await settle();
    const fields = panels(root)[2].querySelectorAll("input") as unknown as HTMLInputElement[];
    assert.match(text(panels(root)[2].querySelector(".gz-title")), new RegExp(`of ${symbol}$`));
    [fields[0].value, fields[1].value, fields[2].value] = [date, shares, paid];
    submit(panels(root)[2].querySelector("form")!);
    await settle();
  };
  await record("SPY", "2026-11-10", "10", "500");
  await record("SPY", "2026-11-12", "5", "510");
  await record("AAPL", "2026-11-17", "5", "200");
  assert.deepEqual(f.files.get("Apps/Watchlist data.md")!.fm!.buys,
    [
      { symbol: "SPY", date: "2026-11-10", shares: 10, price: 500, at: savedAt("2026-11-18T12:00") },
      { symbol: "SPY", date: "2026-11-12", shares: 5, price: 510, at: savedAt("2026-11-18T12:00") },
      { symbol: "AAPL", date: "2026-11-17", shares: 5, price: 200, at: savedAt("2026-11-18T12:00") },
    ]);
  assert.equal(text(panels(root)[0].querySelector(".gz-big")), "210.00USD");

  // What was paid, per symbol.
  const rows = () => [...panels(root)[4].querySelectorAll("tbody tr")];
  assert.deepEqual(rows().map((tr) => [...tr.querySelectorAll("td")].map(text)), [["AAPL", "5", "$1,000.00"], ["SPY", "15", "$7,550.00"]]);

  // SPY: 15 shares at the last close of 508.29, against $7,550.
  click(rows()[1]);
  await settle();
  assert.equal(text(panels(root)[6].querySelector(".gz-big")), "$7,624.35");
  assert.equal(text(panels(root)[6].querySelector(".gz-title")), "SPY is worth");
  assert.equal(text(panels(root)[7].querySelector(".gz-big")), "$74.35");
  assert.ok(f.requests.includes(`${YAHOO}SPY?range=5d&interval=1d`));

  // Setting a buy's shares to 0 takes it out of the positions.
  const lots = [...panels(root)[5].querySelectorAll("tbody tr")];
  assert.equal(lots.length, 3);
  const aapl = lots.find((tr) => text(tr.querySelectorAll("td")[1]) === "AAPL")!;
  type(aapl.querySelector("input.gz-edit")!, "0");
  await settle();
  assert.deepEqual(rows().map((tr) => text(tr.querySelector("td"))), ["SPY"]);
});

const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const KP_FORECAST = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
const KP_READINGS = [
  { time_tag: "2026-11-18T10:58:00", kp_index: 4, estimated_kp: 4.33, kp: "4P" },
  { time_tag: "2026-11-18T10:59:00", kp_index: 5, estimated_kp: 5.33, kp: "5P" },
];
const FORECAST = [
  { time_tag: "2026-11-17T21:00:00", kp: 3, observed: "observed", noaa_scale: null },
  { time_tag: "2026-11-18T09:00:00", kp: 5.67, observed: "estimated", noaa_scale: "G1" },
  { time_tag: "2026-11-18T21:00:00", kp: 5.67, observed: "predicted", noaa_scale: "G1" },
  { time_tag: "2026-11-19T00:00:00", kp: 2.33, observed: "predicted", noaa_scale: null },
];

test("Aurora watch: told when Kp is high now or forecast, an hourly record, and my sightings with a note", async () => {
  const path = "Apps/Aurora watch.md";
  const t = await background({ [path]: { fm: fm(path) } }, { [KP]: KP_READINGS, [KP_FORECAST]: FORECAST });
  // With the app closed: the record, the status bar, and a notice for each alert, told once.
  const data = () => t.f.files.get("Apps/Aurora watch data.md")!.fm!;
  assert.deepEqual(data().kp_log, [{ at: savedAt("2026-11-18T12:00"), time_tag: "2026-11-18T10:59:00", kp_index: 5, estimated_kp: 5.33, kp: "5P" }]);
  assert.deepEqual(t.notices, ["Aurora watch: Kp now 5.33", "Aurora watch: Expected to reach Kp 5 (1 row)"]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Kp now: 5.33", title: "Aurora watch" }]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:saw-aurora`, name: "Aurora watch: Saw aurora" }]);

  const root = await t.open(path);
  assert.equal(root.querySelector(".gz-error"), null);
  const [now, , forecast, expected, record, sightings] = panels(root);
  assert.equal(text(now.querySelector(".gz-big")), "5.33");
  assert.equal(text(forecast.querySelector(".gz-goal-label")), "Goal 5");
  assert.deepEqual([...expected.querySelectorAll("li")].map(text), ["2026-11-18T21:00:00 · Kp 5.67"]);
  assert.ok(record.querySelector(".gz-chart-svg"));
  assert.equal(text(sightings.querySelector(".gz-empty")), "Nothing here yet.");

  // Saw one: the button, then a note on it in the table; and one more from a link with the app closed.
  click(root.querySelector("button.gz-button")!);
  await settle();
  assert.deepEqual((data().sightings as { at: string }[]).map((s) => s.at), [savedAt("2026-11-18T12:00")]);
  type(sightings.querySelector("tbody input.gz-edit")!, "green arc to the north");
  await settle();
  assert.deepEqual(data().sightings, [{ at: savedAt("2026-11-18T12:00"), note: "green arc to the north" }]);
  await t.bg.runUri({ app: "Aurora watch", do: "saw-aurora" });
  await settle();
  assert.equal((data().sightings as unknown[]).length, 2);
  assert.deepEqual(t.notices.slice(2), ["Sighting saved", "Sighting saved"]);
});

const rss = (...items: [string, string, string][]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed</title>
${items.map(([title, link, date]) => `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate></item>`).join("\n")}
</channel></rss>`;

test("Read later: save an article from a feed as a note, then tick it off when read", async () => {
  const responses = {
    "https://feeds.bbci.co.uk/news/technology/rss.xml": raw(rss(
      ["Chips: a new design", "https://www.bbc.co.uk/news/1", "Wed, 18 Nov 2026 09:00:00 "],
      ["A robot learns to fold", "https://www.bbc.co.uk/news/2", "Wed, 18 Nov 2026 08:00:00 "],
    ), "text/xml; charset=utf-8"),
    "https://feeds.npr.org/1001/rss.xml": raw(rss(["Markets close higher", "https://www.npr.org/3", "Tue, 17 Nov 2026 22:00:00 "]), "text/xml;charset=UTF-8"),
  };
  const t = openApp("Apps/Read later.md", {}, responses);
  const { root, f, notices } = t;
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const [unread, toRead, read, bbc, npr] = panels(root);
  assert.deepEqual([...bbc.querySelectorAll("li")].map(text), ["Chips: a new designSave", "A robot learns to foldSave"]);
  assert.deepEqual([...npr.querySelectorAll("li")].map(text), ["Markets close higherSave"]);
  assert.deepEqual([...root.querySelectorAll(".gz-tab")].map(text), ["To read", "Read", "BBC technology", "NPR news"]);
  assert.equal(text(toRead.querySelector(".gz-empty")), "Nothing here yet.");

  click(bbc.querySelectorAll("li")[1].querySelector("button.gz-row-action")!);
  await settle();
  t.env.now = () => new Date(2026, 10, 18, 12, 5);
  click(npr.querySelector("li button.gz-row-action")!);
  await settle();
  // Saving the same article again is refused rather than overwriting its note.
  click(bbc.querySelectorAll("li")[1].querySelector("button.gz-row-action")!);
  await settle();
  assert.deepEqual(notices, ["Saved A robot learns to fold to Reading", "Saved Markets close higher to Reading", "“A robot learns to fold” already exists"]);
  assert.deepEqual(f.files.get("Reading/A robot learns to fold.md")!.fm,
    { link: "https://www.bbc.co.uk/news/2", date: "2026-11-18T08:00", via: "BBC technology", at: savedAt("2026-11-18T12:00") });
  assert.equal(f.files.get("Reading/Markets close higher.md")!.fm!.via, "NPR news");

  assert.equal(text(unread.querySelector(".gz-big")), "2");
  const rows = () => [...toRead.querySelectorAll("tbody tr")];
  assert.deepEqual(rows().map((tr) => text(tr.querySelector("td"))), ["Markets close higher", "A robot learns to fold"]);
  // The link opens outside Obsidian.
  assert.equal(rows()[0].querySelector("a.external-link")!.getAttribute("href"), "https://www.npr.org/3");

  const tickRead = rows()[1].querySelector('input[type="checkbox"]') as HTMLInputElement;
  tickRead.checked = true;
  change(tickRead);
  await settle();
  assert.equal(f.files.get("Reading/A robot learns to fold.md")!.fm!.read, true);
  assert.equal(text(unread.querySelector(".gz-big")), "1");
  assert.deepEqual(rows().map((tr) => text(tr.querySelector("td"))), ["Markets close higher"]);
  assert.deepEqual([...read.querySelectorAll("li")].map(text), ["A robot learns to fold · BBC technology"]);
});

test("Today: the medication button and a water counter work from inside a plain note", async () => {
  const today = gallery("Today.md");
  const sources = blocksOf(today.body);
  const t = fakeEnv({ "Today.md": { fm: today.fm }, "Apps/Medication log.md": { fm: fm("Apps/Medication log.md") } });
  const [meds, water] = sources.map((source) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const hosted = new HostedApp(el, parseYaml(source), source, "Today.md", t.env);
    started.push(hosted);
    hosted.load();
    return el;
  });
  await settle();
  assert.equal(meds.querySelector(".gz-error"), null);
  assert.equal(water.querySelector(".gz-error"), null);

  // The Medication log's own button and count, saving in the Medication log's data note.
  assert.deepEqual(panels(meds).map(text), ["Doses today0", "Took meds"]);
  click(meds.querySelector("button.gz-button")!);
  await settle();
  assert.equal((t.f.files.get("Apps/Medication log data.md")!.fm!.doses as unknown[]).length, 1);
  assert.equal(text(meds.querySelector(".gz-view-number .gz-big")), "1");
  assert.deepEqual(t.notices, ["Dose logged"]);

  // A counter of the note's own, saving in Today data.
  assert.equal(text(water.querySelector(".gz-view-progress .gz-big")), "0/ 8 glasses");
  click(water.querySelector("button.gz-button")!);
  await settle();
  assert.deepEqual(listsIn(t.f.files.get("Today data.md")!.fm), { water: [{ at: savedAt("2026-11-18T12:00") }] });
  assert.equal(text(water.querySelector(".gz-view-progress .gz-big")), "1/ 8 glasses");
});

test("Movers (test vault): pick one of the biggest moves, note why it happened, and read the note back", async () => {
  const path = "Apps/Movers.md";
  const spec = readSpec(vaultNote(path).fm, { path })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, path), ["net:query1.finance.yahoo.com"]);

  // Sessions 3 and 5 moved by more than 1%.
  const closes = [100, 100.5, 103, 102.5, 99, 99.4];
  const { root, f } = openApp(path, {}, { [YAHOO]: yahoo("SPY", closes) }, vaultNote(path).fm);
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  const all = panels(root);
  const [moves, why, form] = all.slice(-3);
  assert.equal(text(all[3].querySelector(".gz-big")), "2");
  assert.deepEqual([...moves.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map(text)),
    [["session 5", "99.00", "-3.41"], ["session 3", "103.00", "2.49"]]);
  assert.ok(waitsForPick(form));
  assert.equal(text(why.querySelector(".gz-empty")), "Nothing here yet.");

  click(moves.querySelector("tbody tr")!);
  await settle();
  (form.querySelector("input") as HTMLInputElement).value = "Rate decision";
  submit(form.querySelector("form")!);
  await settle();
  assert.deepEqual(f.files.get("Apps/Movers data.md")!.fm!.reasons,
    [{ symbol: "SPY", session: 5, close: 99, change: -3.41, reason: "Rate decision", at: savedAt("2026-11-18T12:00") }]);
  assert.equal(text(why.querySelector("li")), "SPY session 5, -3.41%: Rate decision");
});

test("the gallery's capture names each reach one shortcut, and a line for each runs it", async () => {
  const notes: Notes = {};
  for (const folder of ["Apps", "Components"]) for (const n of noteNames(folder)) notes[`${folder}/${n}`] = { fm: fm(`${folder}/${n}`) };
  const t = fakeBackground(notes);
  await t.bg.start();
  const index = t.bg.captureIndex();
  assert.deepEqual([...index.clashes.keys()], []);
  assert.deepEqual([...index.names.keys()].sort(), ["add", "decide", "did", "meds", "pack", "saw-aurora", "sleep", "spend", "task", "took-meds", "weight"]);
  assert.equal(index.names.get("weight")?.app, "Weight");
  assert.equal(index.names.get("sleep")?.app, "Sleep");
  for (const line of ["spend 14.5 food lunch", "weight 81.2", "meds", "task renew the passport", "pack charg"]) {
    const r = await t.bg.capture(line);
    assert.equal(r.ok, true, `${line}: ${r.error ?? ""}`);
  }
  assert.deepEqual(t.f.files.get("Apps/Weight data.md")?.fm?.weight, [{ value: 81.2, note: "", at: savedAt("2026-11-18T12:00") }]);
  assert.deepEqual(t.f.files.get("Apps/Trip planner data.md")?.fm?.packed, ["Chargers"]);
});
