import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import { aheadEnv } from "../src/ahead.ts";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import type { NoteReader } from "../src/expand.ts";
import { HostedApp, parseHosted } from "../src/hosted.ts";
import { LensIndex, LensStack } from "../src/lenses.ts";
import { pickPanels, readComponentPreview, readSpec } from "../src/spec.ts";
import { permissionsOf } from "../src/permissions.ts";
import { fakeBackground, fakeEnv, listsIn, raw, savedAt } from "./support/fakes.ts";
import { addLine, said, typeLine } from "./support/addline.ts";
import { parseYaml, vaultNote } from "./support/yaml.ts";
import { REFERENCE, dayOf, sampleFiles } from "../tools/samples.ts";

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
const fm = (path: string) => gallery(path).fm;
const noteNames = (folder: string) => readdirSync(new URL(`${folder}/`, GALLERY)).filter((n) => n.endsWith(".md") && !n.endsWith(" data.md")).sort();

/** The apps, components and kinds of the gallery, as links find them. */
const reader: NoteReader = (() => {
  const all: Record<string, Record<string, unknown>> = {};
  for (const folder of ["Apps", "Components", "Kinds"]) for (const n of noteNames(folder)) all[`${folder}/${n}`] = fm(`${folder}/${n}`);
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
  "Apps/Bills and renewals.md": ["kind-write:Kinds/Renewal.md", "kind-write:Kinds/Spend.md", "kind:Kinds/Renewal.md", "kind:Kinds/Spend.md"],
  "Apps/Budget.md": ["answer:lands", "answer:spent", "kind-write:Kinds/Spend.md", "kind:Kinds/Spend.md"],
  "Apps/Decision journal.md": ["create:Decisions", "edit:Decisions", "read:Decisions"],
  "Apps/Household chores.md": ["kind-write:Kinds/Chore.md", "kind-write:Kinds/Spend.md", "kind:Kinds/Chore.md", "kind:Kinds/Spend.md"],
  "Apps/Medication log.md": ["answer:doses-today", "kind-write:Kinds/Dose.md", "kind:Kinds/Dose.md"],
  "Apps/Project board.md": ["create:Projects", "edit:Projects", "read:Projects"],
  "Apps/Read later.md": ["create:Reading", "edit:Reading", "net:feeds.bbci.co.uk", "net:feeds.npr.org", "read:Reading"],
  "Apps/Practice.md": [],
  "Apps/Task inbox.md": ["read:Tasks", "tasks:Tasks", "write:Tasks/Inbox.md"],
  "Apps/Trip planner.md": ["kind-write:Kinds/Spend.md", "kind:Kinds/Spend.md", "net:api.frankfurter.dev", "net:api.open-meteo.com", "net:archive-api.open-meteo.com", "read:Trips/Tokyo.ics",
    "send:api.open-meteo.com|this.lat", "send:api.open-meteo.com|this.lon", "send:archive-api.open-meteo.com|this.lat", "send:archive-api.open-meteo.com|this.lon"],
  "Apps/Vitals.md": ["kind-write:Kinds/Measurement.md", "kind:Kinds/Measurement.md"],
  "Apps/Trades.md": ["kind-write:Kinds/Trade.md", "kind:Kinds/Trade.md", "net:query1.finance.yahoo.com", "send:query1.finance.yahoo.com|picked.position.symbol"],
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

test("Destination weather has words for every sky Open-Meteo's weather_code can send", () => {
  // The WMO codes Open-Meteo documents for weather_code.
  const WMO = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
  const panels = fm("Components/Destination weather.md").panels as { title?: string; values?: Record<string, Record<string, string>> }[];
  const words = panels.find((p) => p.title === "The week ahead")!.values!.weather_code;
  assert.deepEqual(WMO.filter((c) => !words[c]), [], "codes with no words show as a bare number");
});

/** What each kind asks the person to allow: only the folder an import reads by itself. */
const KINDS: Record<string, string[]> = {
  "Kinds/Chore.md": [],
  "Kinds/Dose.md": [],
  "Kinds/Measurement.md": ["read:Inbox/Health"],
  "Kinds/Renewal.md": [],
  "Kinds/Spend.md": ["read:Inbox/Bank"],
  "Kinds/Trade.md": ["read:Inbox/Broker"],
};

test("every gallery kind reads without errors, asks only for the folder it imports from, and says what its rows are for", () => {
  assert.deepEqual(noteNames("Kinds").map((n) => `Kinds/${n}`), Object.keys(KINDS));
  for (const [path, wanted] of Object.entries(KINDS)) {
    const { fm: kind, body } = gallery(path);
    const r = readSpec(kind, { path, notes: reader })!;
    assert.deepEqual(r.errors, [], path);
    assert.ok(r.spec?.kind, `${path} is a kind`);
    assert.deepEqual(permissionsOf(r.spec!, path), wanted, path);
    assert.ok(body.trim().length > 0, `${path} says what it is for`);
  }
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
  assert.deepEqual(permissionsOf(shown.spec, "Apps/Medication log.md"), ["answer:doses-today", "kind-write:Kinds/Dose.md", "kind:Kinds/Dose.md"]);

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

const DOSE = "Kinds/Dose.md";
const SPEND = "Kinds/Spend.md";
const RENEWAL = "Kinds/Renewal.md";
const HOUR = 3_600_000;
const BANK = "Inbox/Bank/Checking 2026-11.csv";

/**
 * The gallery's sample files as tools/samples.ts writes them for the day the fake clock reads, which
 * the gallery in the repo holds too until someone writes them for another day.
 */
const SAMPLES = sampleFiles(dayOf(REFERENCE));
const sample = (path: string) => ({ raw: SAMPLES.files[path] });
/** A gallery kind with the sample rows beside it: its data note, and the log of a device called "sample" with its other lines. */
function withSamples(name: string, files = SAMPLES.files): Notes {
  const data = files[`Kinds/${name} data.md`].match(/^---\n([\s\S]*?)\n---\n?/)![1];
  const out: Notes = { [`Kinds/${name}.md`]: { fm: fm(`Kinds/${name}.md`) }, [`Kinds/${name} data.md`]: { fm: parseYaml(data) as Record<string, unknown> } };
  for (const path of Object.keys(files).filter((p) => p.startsWith(`Kinds/${name} data/log/`))) out[path] = { raw: files[path] };
  return out;
}
/** A kind's rows, every line of them. */
const kindRows = (t: { env: { store?: (d: string, a: string) => { rows(list: string): Promise<Record<string, unknown>[]> } } }, kind: string) =>
  t.env.store!(`Kinds/${kind[0].toUpperCase()}${kind.slice(1)} data.md`, `Kinds/${kind[0].toUpperCase()}${kind.slice(1)}.md`).rows(kind);
const titled = (root: Element, title: string) => panels(root).find((p) => text(p.querySelector(".gz-title")).startsWith(title))!;
const big = (root: Element, title: string) => text(titled(root, title).querySelector(".gz-big, .gz-text"));
const openTab = async (root: Element, name: string) => {
  click([...root.querySelectorAll("button.gz-tab")].find((b) => text(b) === name)!);
  await settle();
};
/** A table's rows as the text of each cell, its ledger's group headings left out. */
const cells = (el: Element) => [...el.querySelectorAll("tbody tr:not(.gz-ledger-group)")].map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.querySelector("input, select") as HTMLInputElement | null)?.value ?? text(td)));
const asked = (t: { bg: { asks: { list(): { text: string }[] } } }) => t.bg.asks.list().map((a) => a.text);
const lineOfAsk = (a: { answer: unknown }) => (a.answer as { line?: string }).line;

test("Medication log: a dose from a button, a hotkey or a link; today's count in the status bar; the year and a picked day; by 10:00 the rhythm asks with the line that logs one", async () => {
  const path = "Apps/Medication log.md";
  const t = await background({ [path]: { fm: fm(path) }, [DOSE]: { fm: fm(DOSE) } });
  assert.deepEqual(t.out.commands.filter((c) => c.id.startsWith(path)).map((c) => c.name),
    ["Medication log: Doses today", "Medication log: Add refill", "Medication log: Took Medication B", "Medication log: Took Medication A"]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Doses today: 0", title: "Medication log" }]);

  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.equal(big(root, "Doses today"), "0");
  assert.equal(text(titled(root, "Next dose").querySelector(".gz-empty, .gz-text")), "No dose planned yet.");
  const button = (label: string) => [...root.querySelectorAll("button.gz-button")].find((b) => text(b) === label)!;
  click(button("Took Medication A"));
  await settle();
  assert.equal(big(root, "Doses today"), "1");
  assert.equal(said(root.querySelector(".gz-view-button")!), "Logged Medication A");
  assert.deepEqual(cells(titled(root, "Today's doses")).map((r) => r.slice(1)), [["Medication A", "taken"]]);
  // One row isn't grouped by day, so the table itself says how its time reads: never the stamp as saved.
  assert.match(cells(titled(root, "Today's doses"))[0][0], /^\d{1,2}:\d\d/);

  // With the app closed: a hotkey, then a link of the other button.
  await t.bg.runCommand(`${path}:took-meds`);
  await t.bg.runUri({ app: "Medication log", do: "took-b" });
  await settle();
  assert.deepEqual((await kindRows(t, "dose")).map((r) => [r.med, r.line ?? "logged"]), [["Medication A", "logged"], ["Medication A", "logged"], ["Medication B", "logged"]]);
  assert.equal(t.f.files.has("Apps/Medication log data.md"), false, "the doses are the kind's, not the app's");
  assert.equal(big(root, "Doses today"), "3");
  assert.deepEqual(t.notices, ["Logged Medication A", "Logged Medication B"]);
  assert.equal(t.out.status[0].text, "Doses today: 3");

  // The year: today has its three; pick it for what they were.
  const square = root.querySelector('rect[data-date="2026-11-18"]')!;
  assert.equal(square.getAttribute("aria-label"), "2026-11-18: 3");
  click(square);
  await settle();
  assert.deepEqual([...titled(root, "Doses on the day I pick").querySelectorAll("li:not(.gz-ledger-group)")].map(text).map((t) => t.replace(/\$.*/, "")).filter(Boolean), ["Medication A", "Medication A", "Medication B"]);

  // The next morning before 10:00, the rule asks; its line is the button's word, and running it answers.
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  const [rhythm] = t.bg.asks.list();
  assert.deepEqual([rhythm?.text, lineOfAsk(rhythm)], ["Took Medication A? by 10:00", "meds"]);
  assert.ok((await t.bg.capture("meds")).ok);
  await settle();
  assert.deepEqual(asked(t), []);
});

test("Medication log: a planned schedule; a dose taken settles its planned one; one not taken asks in Next, and marked missed it shows for the doctor", async () => {
  const path = "Apps/Medication log.md";
  const t = await background({ [path]: { fm: fm(path) }, [DOSE]: { fm: fm(DOSE) } });
  // At 08:00 on the 19th, a dose a day at that time, to the 25th: one row each day from the 20th.
  t.advance(20 * HOUR);
  const planned = await t.bg.capture('dose "Medication A" @every day until 2026-11-25');
  assert.ok(planned.ok, planned.error ?? "");
  const schedule = (await kindRows(t, "dose")).filter((r) => r.line === "planned");
  assert.deepEqual(schedule.map((r) => r.at), [20, 21, 22, 23, 24, 25].map((d) => savedAt(`2026-11-${d}T08:00`)));

  // The 20th at 08:10: the dose planned for 08:00 asks, once; the 10:00 rule leaves that dose to it.
  t.advance(24 * HOUR + 10 * 60_000);
  await t.bg.tick();
  await settle();
  assert.deepEqual(asked(t).filter((a) => !a.startsWith("no dose")), ["Medication A, planned Fri Nov 20, 08:00: did it happen?"]);
  const root = await t.open(path);
  assert.equal(big(root, "Next dose"), "Medication A, in 23 hours");
  assert.deepEqual(cells(titled(root, "Today's doses")).map((r) => r.slice(1)), [["Medication A", "not taken yet"]]);
  // One tap takes it: the planned dose is settled, and its ask goes.
  click([...root.querySelectorAll("button.gz-button")].find((b) => text(b) === "Took Medication A")!);
  await settle();
  const taken = (await kindRows(t, "dose")).find((r) => r.at === savedAt("2026-11-20T08:00"))!;
  assert.equal(typeof taken.matched, "string");
  assert.deepEqual(asked(t).filter((a) => !a.startsWith("no dose")), []);
  assert.deepEqual(cells(titled(root, "Today's doses")).map((r) => r.slice(1)), [["Medication A", "taken"]]);

  // The 21st at noon, nothing taken: Next asks about the 08:00 dose; x says it was missed.
  const told = t.notices.length;
  t.advance(28 * HOUR);
  await t.bg.tick();
  await settle();
  const ask = t.bg.asks.list().find((a) => a.text === "Medication A, planned Sat Nov 21, 08:00: did it happen?")!;
  assert.ok(ask, asked(t).join(" | "));
  assert.ok((await t.bg.settleAsk(ask, "dismiss")).ok);
  await settle();
  assert.equal((await kindRows(t, "dose")).find((r) => r.at === savedAt("2026-11-21T08:00"))!.line, "dismissed");
  assert.deepEqual(cells(titled(root, "Today's doses")).map((r) => r.slice(1)), [["Medication A", "missed"]]);
  // The rule's own miss of that morning doesn't ask again, nor is it told: x on the planned dose answered both.
  assert.deepEqual(asked(t).filter((a) => a.includes("Sat Nov 21")), []);
  assert.deepEqual(t.notices.slice(told), []);

  await openTab(root, "For the doctor");
  assert.equal(big(root, "Taken as planned"), "50%");
  assert.deepEqual(cells(titled(root, "Each medication")), [["Medication A", "1", "1", "50"]]);
  assert.deepEqual(cells(titled(root, "Missed doses")).map((r) => r.slice(1)), [["Medication A"]]);
});

test("Medication log, on its sample rows: Supply counts each medication down from its refills and tells when one has a week or less left; a refill moves it; For the doctor sums up the last 30 days", async () => {
  const path = "Apps/Medication log.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Dose") });
  // Medication B: 56 doses picked up, 47 taken, nearly two a day lately: five days left, so it tells.
  assert.deepEqual(t.notices, ["Medication log: What I have left: Medication B, Days left 5"]);
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  await openTab(root, "Supply");
  const left = () => cells(titled(root, "What I have left"));
  assert.deepEqual(left(), [["Medication A", "37", "0.9", "43"], ["Medication B", "9", "1.7", "5"]]);

  addLine(titled(root, "Picked up a refill"), '"Medication B" 60');
  await settle();
  assert.deepEqual((await kindRows(t, "dose")).at(-1), { med: "Medication B", refill: 60, at: savedAt("2026-11-18T12:00") });
  assert.deepEqual(left()[1], ["Medication B", "69", "1.7", "40"]);
  assert.ok((await t.bg.capture("medb")).ok);
  await settle();
  assert.deepEqual(left()[1], ["Medication B", "68", "1.8", "38"]);
  await openTab(root, "Today");
  assert.equal(big(root, "Doses today"), "1", "a refill is not a dose");
  // The doctor's 30 days end at the minute before now; the dose just taken counts from the next.

  await openTab(root, "For the doctor");
  assert.equal(big(root, "Taken as planned"), "93%");
  assert.deepEqual(cells(titled(root, "Each medication")), [["Medication A", "23", "2", "92"], ["Medication B", "47", "3", "94"]]);
  assert.equal(cells(titled(root, "Missed doses")).length, 5);
  assert.deepEqual(cells(titled(root, "What I noted")).map((r) => r.slice(1)), [["Medication A", "took it with food"], ["Medication B", "dizzy for an hour after"]]);
});

const TRACKER = "Components/Tracker kit.md";

test("Practice: the Tracker kit in three lines; log a session, see the week against the last, the goal line, and fix an entry in the table", async () => {
  assert.deepEqual(Object.keys(fm("Apps/Practice.md")), ["app", "use", "with"]);
  const practice = [
    { value: 20, at: "2026-11-10T19:30" }, { value: 25, at: "2026-11-13T19:30" },
    { value: 30, at: "2026-11-16T19:30" }, { value: 35, at: "2026-11-17T19:30" },
  ];
  const { root, f } = openApp("Apps/Practice.md", { [TRACKER]: { fm: fm(TRACKER) }, "Apps/Practice data.md": { fm: { practice } } });
  await settle();
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  // Latest leads the answer; the week against the last is the fact beside it.
  const [latest, week, form, chart, entries] = panels(root);
  assert.deepEqual(panels(root).map((p) => text(p.querySelector(".gz-title"))), ["Latest", "This week", "Log my practice", "My practice against my goal", "Entries"]);
  assert.ok(latest.classList.contains("gz-headline") && week.classList.contains("gz-fact"));
  typeLine(form, "40 scales and the Bach");
  assert.deepEqual([...form.querySelectorAll(".gz-pv-label")].map(text), ["practice", "note"]);
  assert.equal(text(week.querySelector(".gz-big")), "32.5minutes");
  // Against last week up to Wednesday noon, which holds only the 20 of the 10th; as a fact, in short.
  assert.equal(text(week.querySelector(".gz-compare")), "↑ 12.5 minutes vs last week");
  assert.equal(text(latest.querySelector(".gz-big")), "35minutes");
  assert.equal(text(chart.querySelector(".gz-goal-label")), "Goal 30 minutes");
  assert.equal(chart.querySelector(".gz-legend"), null);
  assert.deepEqual([...entries.querySelectorAll("thead th")].map(text), ["at", "practice", "note"]);

  addLine(form, "40 scales and the Bach");
  await settle();
  const saved = f.files.get("Apps/Practice data.md")!.fm!.practice as Record<string, unknown>[];
  assert.deepEqual(saved.at(-1), { value: 40, note: "scales and the Bach", at: savedAt("2026-11-18T12:00") });
  assert.equal(text(latest.querySelector(".gz-big")), "40minutes");
  assert.equal(text(week.querySelector(".gz-big")), "35.0minutes");
  assert.equal(text(week.querySelector(".gz-compare")), "↑ 15.0 minutes vs last week");

  // The newest entry is the first row; its minutes were a typo.
  const first = entries.querySelector("tbody tr:not(.gz-ledger-group)")!;
  assert.equal(text(first.querySelectorAll("td")[0]), new Date(2026, 10, 18, 12).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  type(first.querySelectorAll("input")[0], "45");
  await settle();
  assert.equal((f.files.get("Apps/Practice data.md")!.fm!.practice as { value: number }[]).at(-1)!.value, 45);
  assert.equal(text(latest.querySelector(".gz-big")), "45minutes");
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

const MEASUREMENT = "Kinds/Measurement.md";
const HEALTH = "Inbox/Health/Health export 2026-11.csv";
/** A table's rows by its first cell. */
const byFirst = (el: Element) => Object.fromEntries(cells(el).map((r) => [r[0], r.slice(1)]));

test("Vitals, on its sample rows: the health export comes in by itself, its step counts and failed readings left out; Accept all pairs what was typed and adds what wasn't; each measure says which way it moved against its target, and For the appointment sums up 30 and 90 days", async () => {
  const path = "Apps/Vitals.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Measurement"), [HEALTH]: sample(HEALTH) });
  assert.ok(t.notices.includes("Imported 31 rows from Health export 2026-11.csv into Measurement, skipped 12"), t.notices.join(" | "));
  // Sleep has slipped this week, under the 7 hours the note's sleep_target asks for: told once.
  assert.deepEqual(t.notices.filter((n) => n.startsWith("Vitals")), ["Vitals: Sleep 6.5 hours"]);
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["Now", "For the appointment"]);
  assert.deepEqual(["Weight", "Blood pressure", "Pulse", "Sleep"].map((title) => big(root, title)), ["79.8kg", "125/80", "69bpm", "6.5hours"]);
  assert.equal(text(titled(root, "Sleep").querySelector(".gz-compare")), "↓ 0.5 hours vs Nov 5–11");
  assert.equal(text(titled(root, "Sleep").querySelector(".gz-ans-status")), "The alert is on");
  assert.ok(!titled(root, "Weight").querySelector(".gz-ans-status"), "79.8 is under the weight target of 80");
  assert.deepEqual(byFirst(titled(root, "Each measure")), {
    weight: ["79.8", "80.2", "down 0.9, the right way", "80"],
    systolic: ["125", "130", "down 2.6, the right way", "130"],
    diastolic: ["80", "83", "down 1.6, the right way", "80"],
    pulse: ["69", "68.6", "down 1, the right way", "75"],
    sleep: ["6.6", "7", "down 0.2, the wrong way", "7"],
  });
  assert.equal(text(titled(root, "Weight, last 90 days").querySelector(".gz-goal-label")), "Goal 80 kg");

  // The export's readings wait: most were typed already and pair; a reading pairs within 0.1 on its day.
  const card = () => titled(root, "From my health export, not checked yet").querySelector(".gz-reconcile");
  assert.equal(text(card()!.querySelector(".gz-title")), "31 rows from a file to check");
  assert.equal(text(card()!.querySelector(".gz-reconcile-counts")), "24 pair with rows you logged7 only in the file1 only logged0 logged twice");
  assert.equal(text(card()!.querySelector("li .gz-reconcile-what")), "Nov 9 · sleep · 7.33 = Nov 9 · sleep · 7.30");
  assert.deepEqual(asked(t), ["31 rows from a file to check in Measurement"]);
  click([...card()!.querySelectorAll("button")].find((b) => text(b) === "Accept all")!);
  await settle();
  assert.ok(!card(), "nothing left to check");
  const [entry] = await t.activity.list(path);
  // 24 pair; the 7 that pair with nothing each become logged and keep their import's id.
  assert.deepEqual([entry.what, entry.changes.length], ["Accepted 31 rows from a file", 38]);
  // This morning's weigh-in came from the scale; Sunday evening's reading, taken again after a failed one, only from the cuff.
  assert.equal(big(root, "Weight"), "79.7kg");
  assert.deepEqual(cells(titled(root, "Blood pressure, each sitting")).slice(0, 2), [["2026-11-16 morning", "125", "80", "69"], ["2026-11-15 evening", "141", "91", "76"]]);
  const rows = await kindRows(t, "measurement");
  // A reading typed and exported counts once: the export's row is paired with it, not logged beside it.
  assert.deepEqual(rows.filter((r) => r.what === "weight" && String(r.at).startsWith("2026-11-09")).map((r) => [r.line ?? "logged", typeof r.matched]), [["logged", "undefined"], ["attested", "string"]]);
  assert.equal(rows.some((r) => r.value === 0), false, "the failed reading stayed out");

  await openTab(root, "For the appointment");
  assert.equal(big(root, "Weight, last 30 days"), "80.2kg");
  assert.equal(text(titled(root, "Weight, last 30 days").querySelector(".gz-compare")), "↓ 1% less than Sep 20 – Oct 19 · 81.2 kg");
  assert.equal(big(root, "Blood pressure, last 30 days"), "131/84");
  assert.deepEqual(byFirst(titled(root, "Each measure, last 30 days")), {
    weight: ["30", "80.2", "79.6 to 80.9", "19"],
    systolic: ["9", "131", "125 to 141", "4"],
    diastolic: ["9", "83.9", "80 to 91", "8"],
    pulse: ["9", "69.4", "67 to 76", "1"],
    sleep: ["27", "7", "5.8 to 7.9", "14"],
  });
  assert.deepEqual(byFirst(titled(root, "Each measure, last 90 days")).systolic, ["26", "133", "125 to 141", "16"]);
  assert.deepEqual(cells(titled(root, "Off target, last 90 days"))[0], ["Wed Nov 18", "sleep", "6.3", "7"]);
  assert.equal(cells(titled(root, "Blood pressure, each sitting, last 30 days")).length, 9);
  assert.deepEqual(cells(titled(root, "What I noted")).map((r) => r.slice(1)), [
    ["sleep", "7", "forgot to wear the watch"], ["weight", "80.5", "after a weekend away"], ["systolic", "130", "after coffee"], ["sleep", "6.4", "late flight home"],
  ]);
});

test("Vitals: Next asks for the morning's weigh-in with the line that logs one; a blood pressure reading is its two numbers, side by side, and one over its targets tells; a target changed in the note's properties moves its alert", async () => {
  const path = "Apps/Vitals.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Measurement") });
  const root = await t.open(path);
  // Thursday, 08:00: nothing weighed yet today, and the weigh-in is due by 10:00.
  t.advance(20 * HOUR);
  await t.bg.tick();
  await settle();
  const [weigh] = t.bg.asks.list();
  assert.deepEqual([weigh?.text, lineOfAsk(weigh)], ["Weighed in? by 10:00", "weight"]);
  assert.ok((await t.bg.capture("weight 79.4")).ok);
  await settle();
  assert.deepEqual(asked(t), []);
  assert.equal(big(root, "Weight"), "79.4kg");

  // Blood pressure on the line for any reading: its systolic, then its diastolic, a minute apart.
  const reading = titled(root, "Took a reading");
  typeLine(reading, "sys 138");
  assert.deepEqual([...reading.querySelectorAll(".gz-pv-label")].map(text), ["what", "value", "note"]);
  assert.equal(text(reading.querySelector(".gz-chip.is-on")), "systolic", "three letters of a measure pick it");
  addLine(reading, "sys 138");
  await settle();
  t.advance(60_000);
  addLine(reading, "dia 88");
  await settle();
  assert.equal(big(root, "Blood pressure"), "138/88");
  assert.equal(text(titled(root, "Blood pressure").querySelector(".gz-ans-status")), "The alert is on for 1 row");
  assert.deepEqual(cells(titled(root, "Blood pressure, each sitting"))[0], ["2026-11-19 morning", "138", "88", "—"]);
  assert.ok(t.notices.includes("Vitals: Blood pressure: 138/80"), t.notices.join(" | "));

  // A stricter weight target, typed in the note's properties: 79.4 is now over it.
  t.f.files.get(path)!.fm!.weight_target = 79;
  t.changed(path);
  await settle();
  assert.equal(text(titled(root, "Weight").querySelector(".gz-ans-status")), "The alert is on");
  assert.deepEqual(byFirst(titled(root, "Each measure")).weight.at(-1), "79");
  assert.ok(t.notices.includes("Vitals: Weight 79.4 kg"), t.notices.join(" | "));
});

test("Budget: the month lands at what is spent plus the bills still to pay; a bill planned past the limit puts the alert on before the money is spent", async () => {
  const path = "Apps/Budget.md";
  const spend = [
    { amount: 1800, category: "home", note: "rent", at: "2026-10-03T08:00" },
    { amount: 300, category: "food", note: "", at: "2026-11-02T08:00" },
    { amount: 400, category: "home", note: "", at: "2026-11-03T08:00" },
  ];
  const t = await background({ [path]: { fm: fm(path) }, [SPEND]: { fm: fm(SPEND) }, "Kinds/Spend data.md": { fm: { spend } } });
  const store = t.env.store!("Kinds/Spend data.md", SPEND);
  // A bill whose day passed with nothing paying it, one still to come, and next month's, which isn't this month's.
  await store.add("spend", { amount: 50, category: "home", note: "METRO WATER", at: savedAt("2026-11-10T09:00"), line: "planned" });
  await store.add("spend", { amount: 1200, category: "home", note: "OAKWOOD APARTMENTS", at: savedAt("2026-11-25T09:00"), line: "planned" });
  await store.add("spend", { amount: 1200, category: "home", note: "OAKWOOD APARTMENTS", at: savedAt("2026-12-25T09:00"), line: "planned" });
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  const [lands, limit, spent, coming, form] = panels(root);
  assert.ok(lands.classList.contains("gz-headline") && limit.classList.contains("gz-meter"));
  assert.equal(text(lands.querySelector(".gz-big")), "$1,950.00");
  assert.equal(text(spent.querySelector(".gz-big")), "$700.00");
  assert.equal(text(coming.querySelector(".gz-big")), "$1,250.00");
  // The limit bar is the headline's meter: what is left of the limit once the bills are paid, and a day.
  assert.equal(text(limit.querySelector(".gz-meter-legend")), "78% of $2,500$550.00 left · $45.83 a day for 12 days");
  assert.equal(text(spent.querySelector(".gz-compare")), "↓ $1,100.00 vs last month");
  assert.deepEqual(cells(titled(root, "Bills still to pay this month")), [["METRO WATER", "$50.00"], ["OAKWOOD APARTMENTS", "$1,200.00"]]);
  assert.deepEqual([...titled(root, "Bills still to pay this month").querySelectorAll("thead th")].map(text), ["Bill", "Amount"]);
  assert.deepEqual(t.notices, []);

  // The amount field carries its label and money format to the add line; a day still to come plans the row.
  typeLine(form, "612 transport SHIELD @2026-11-28");
  assert.deepEqual([...form.querySelectorAll(".gz-pv-label")].map(text).slice(0, 3), ["Spent", "category", "note"]);
  assert.match([...form.querySelectorAll(".gz-pv")].map(text).at(-1)!, /^planned/);
  addLine(form, "612 transport SHIELD @2026-11-28");
  await settle();
  assert.deepEqual((await store.rows("spend")).at(-1), { amount: 612, category: "transport", note: "SHIELD", at: savedAt("2026-11-28T12:00"), line: "planned" });
  // Nothing more is spent, but the month now lands past the limit: told now, not on the 28th.
  assert.equal(text(spent.querySelector(".gz-big")), "$700.00");
  assert.equal(text(lands.querySelector(".gz-big")), "$2,562.00");
  assert.equal(text(limit.querySelector(".gz-meter-legend")), "102% of $2,500$62.00 over");
  assert.equal(text(lands.querySelector(".gz-ans-status")), "The alert is on");
  assert.deepEqual(t.notices, ["Budget: The month lands at $2,562.00"]);

  // Spent now: a purchase logged on the add line; its category fixed in Recent.
  addLine(form, "14.5 food lunch");
  await settle();
  assert.equal(text(spent.querySelector(".gz-big")), "$714.50");
  assert.deepEqual((await store.rows("spend")).at(-1), { amount: 14.5, category: "food", note: "lunch", at: savedAt("2026-11-18T12:00") });
  choose(titled(root, "Recent").querySelector("tbody tr:not(.gz-ledger-group) select")!, "fun");
  await settle();
  assert.equal((await store.rows("spend")).at(-1)!.category, "fun");
  assert.deepEqual([...titled(root, "Each week by category").querySelectorAll(".gz-legend-name")].map(text), ["Food", "Home", "Transport", "Fun", "Travel", "Other or none"]);
  assert.equal(t.f.files.has("Apps/Budget data.md"), false, "nothing is kept in the app's own data note");
});

test("Budget, on its sample rows: the bank export in Inbox/Bank comes in by itself, its pay cheques left out, and waits on Budget's own card; Accept all counts each charge once, and the water bill's charge, and the dearer STREAMFLIX one, settle their planned rows", async () => {
  const path = "Apps/Budget.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Spend"), [BANK]: sample(BANK) });
  assert.ok(t.notices.includes("Imported 14 rows from Checking 2026-11.csv into Spend, skipped 2"), t.notices.join(" | "));
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  // Until they are checked, the bank's rows count nowhere.
  assert.deepEqual([big(root, "The month lands at"), big(root, "Spent so far"), big(root, "Still to come")], ["$2,135.58", "$1,971.89", "$163.69"]);
  const card = () => titled(root, "Charges from the bank, not checked yet").querySelector(".gz-reconcile");
  assert.equal(text(card()!.querySelector(".gz-title")), "14 rows from a file to check");
  assert.equal(text(card()!.querySelector(".gz-reconcile-counts")), "10 pair with rows you logged4 only in the file2 only logged0 logged twice");
  assert.deepEqual([...card()!.querySelectorAll("li .gz-reconcile-row")].slice(0, 2).map(text), ["Nov 2 · 1,450 · OAKWOOD APARTMENTS", "Nov 3 · 86.42 · GREENLEAF MARKET"]);
  assert.deepEqual(asked(t), [
    "14 rows from a file to check in Spend",
    "15.49 fun STREAMFLIX, planned Thu Nov 12, 09:00: did it happen?",
    "38.2 home METRO WATER, planned Mon Nov 16, 09:00: did it happen?",
    "65 home FASTNET INTERNET, planned Wed Nov 18, 09:00: did it happen?",
  ]);

  // Accept all, there in Budget: one change, kept as Budget's.
  click([...card()!.querySelectorAll("button")].find((b) => text(b) === "Accept all")!);
  await settle();
  assert.equal(card(), null, "nothing left to check");
  const [entry] = await t.activity.list(path);
  // 10 pair; the 4 that pair with nothing each become logged and keep their import's id, and 2 of them settle a bill.
  assert.deepEqual([entry.what, entry.changes.length], ["Accepted 14 rows from a file", 20]);
  const rows = await kindRows(t, "spend");
  const of = (note: string) => rows.filter((r) => r.note === note && String(r.at).startsWith("2026-11")).map((r) => [r.line ?? "logged", r.amount, typeof r.matched]);
  assert.deepEqual(of("METRO WATER"), [["planned", 38.2, "string"], ["logged", 38.2, "undefined"]]);
  // The bank's 17.99 is what counts; the bill planned at 15.49 is settled, so it doesn't count again.
  assert.deepEqual(of("STREAMFLIX"), [["planned", 15.49, "string"], ["logged", 17.99, "undefined"]]);

  // Four charges nobody logged now count, the water bill and STREAMFLIX once each; their asks are gone.
  assert.deepEqual([big(root, "The month lands at"), big(root, "Spent so far"), big(root, "Still to come")], ["$2,162.83", "$2,052.83", "$110.00"]);
  assert.match(text(titled(root, "Charges from the bank, not checked yet").querySelector(".gz-empty")), /^No charge from the bank waits\. Drop its CSV export in Inbox\/Bank\./);
  assert.deepEqual(asked(t), ["65 home FASTNET INTERNET, planned Wed Nov 18, 09:00: did it happen?"]);

  // FASTNET did come out, in cash at the shop: yes makes the planned row the row logged at its day, counted once.
  const fastnet = t.bg.asks.list().find((a) => a.text.includes("FASTNET"))!;
  assert.ok((await t.bg.settleAsk(fastnet, "answer")).ok);
  await settle();
  assert.deepEqual([big(root, "The month lands at"), big(root, "Spent so far"), big(root, "Still to come")], ["$2,162.83", "$2,117.83", "$45.00"]);
});

test("Budget allowed and Spend not yet: Budget says what allowing Spend adds and allows it in place; until then it doesn't say to drop a CSV while one waits unread", async () => {
  const path = "Apps/Budget.md";
  const t = fakeBackground({ [path]: { fm: fm(path) }, [SPEND]: { fm: fm(SPEND) }, [BANK]: sample(BANK) }, {}, { seen: true });
  t.grants[path] = APPS[path];
  t.env.opened = (p) => t.bg.opened(p);
  await t.bg.start();
  await settle();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, t.env);
  started.push(c);
  c.load();
  await settle();
  // Nothing of Spend's own runs: the bank's file isn't read, and Next asks nothing.
  assert.deepEqual([(await kindRows(t, "spend")).length, asked(t)], [0, []]);
  const card = () => root.querySelector(".gz-kind-allow");
  assert.equal(text(card()!.querySelector(".gz-title")), "Spend isn't allowed yet");
  assert.deepEqual([...card()!.querySelectorAll("li")].map(text), [
    "Read each file in Inbox/Bank into its rows, now and as new ones come",
    "Ask in Next about a planned row whose time passed with nothing settling it, and about rows from a file to check",
  ]);
  assert.match(text(card()), /Budget reads the rows of Spend, but Spend runs nothing of its own until you allow it\. Allowing it lets Spend:/);
  assert.deepEqual([...card()!.querySelectorAll("button")].map(text), ["Allow Spend", "Open Spend"]);
  assert.equal(text(titled(root, "Charges from the bank, not checked yet").querySelector(".gz-empty")), "Checking 2026-11.csv waits in Inbox/Bank; allow Spend to read it.");
  // Allow, there in Budget: Spend gets what its own note would ask for, reads the file, and asks in Next.
  click([...card()!.querySelectorAll("button")].find((b) => text(b) === "Allow Spend")!);
  await settle();
  assert.deepEqual(t.grants[SPEND], ["read:Inbox/Bank"]);
  assert.ok(t.notices.includes("Imported 14 rows from Checking 2026-11.csv into Spend, skipped 2"), t.notices.join(" | "));
  assert.equal(card(), null);
  assert.equal(text(titled(root, "Charges from the bank, not checked yet").querySelector(".gz-reconcile .gz-title")), "14 rows from a file to check");
  await t.bg.tick();
  await settle();
  assert.ok(asked(t).includes("14 rows from a file to check in Spend"), asked(t).join(" | "));
});

test("the samples written for another day tell the same story from it: the same asks, the bank's rows paired alike, each monthly bill on its day of the month", async () => {
  const later = sampleFiles(dayOf("2027-02-03"));
  assert.deepEqual([later.departs, SAMPLES.departs], ["2027-05-30", "2027-03-14"], "the trip is as far ahead");
  const path = "Apps/Budget.md";
  const t = fakeBackground({ [path]: { fm: fm(path) }, ...withSamples("Spend", later.files), "Inbox/Bank/Checking 2027-02.csv": { raw: later.files["Inbox/Bank/Checking 2027-02.csv"] } });
  // Eleven weeks on: Wednesday 3 February 2027 at noon, as the reference day is a Wednesday.
  t.advance(77 * 24 * HOUR);
  t.env.opened = (p) => t.bg.opened(p);
  await t.bg.start();
  await settle();
  assert.ok(t.notices.includes("Imported 14 rows from Checking 2027-02.csv into Spend, skipped 2"), t.notices.join(" | "));
  assert.deepEqual(asked(t), [
    "14 rows from a file to check in Spend",
    "15.49 fun STREAMFLIX, planned Thu Jan 28, 09:00: did it happen?",
    "38.2 home METRO WATER, planned Mon Feb 1, 09:00: did it happen?",
    "65 home FASTNET INTERNET, planned Wed Feb 3, 09:00: did it happen?",
  ]);
  const plans = (await kindRows(t, "spend")).filter((r) => r.note === "STREAMFLIX" && r.line === "planned").map((r) => String(r.at).slice(0, 10));
  assert.deepEqual(plans.slice(0, 3), ["2027-01-28", "2027-02-28", "2027-03-28"]);
});

test("the samples written for another day tell Vitals', Trades's, Trip planner's and Household chores' stories from it: the same imports, asks and headlines", async () => {
  const later = sampleFiles(dayOf("2027-02-03"));
  assert.equal(later.returns, "2027-06-05");
  const apps = ["Apps/Vitals.md", "Apps/Trades.md", "Apps/Trip planner.md", "Apps/Household chores.md"];
  const notes: Notes = { "Components/Destination weather.md": { fm: fm("Components/Destination weather.md") }, "Trips/Tokyo.ics": { raw: later.files["Trips/Tokyo.ics"] } };
  for (const a of apps) notes[a] = { fm: fm(a) };
  notes["Apps/Trip planner.md"] = { fm: { ...fm("Apps/Trip planner.md"), departs: later.departs, returns: later.returns } };
  for (const k of ["Measurement", "Trade", "Chore", "Spend"]) Object.assign(notes, withSamples(k, later.files));
  for (const p of ["Inbox/Health/Health export 2027-02.csv", "Inbox/Broker/Brokerage 2027-02.csv"]) notes[p] = { raw: later.files[p] };
  const t = fakeBackground(notes, { "https://api.frankfurter.dev/": { rates: { JPY: 159.42 } } });
  t.advance(77 * 24 * HOUR);
  t.env.opened = (p) => t.bg.opened(p);
  t.env.alerts = t.bg.alerts;
  await t.bg.start();
  await settle();
  assert.deepEqual(t.notices, [
    "Vitals: Sleep 6.5 hours", "Imported 31 rows from Health export 2027-02.csv into Measurement, skipped 12",
    "Trades: Sells over what I hold: MSFT", "Imported 4 rows from Brokerage 2027-02.csv into Trade, skipped 2",
  ]);
  assert.deepEqual(asked(t).filter((a) => !/^\d+(\.\d+)? (fun|home)/.test(a)), [
    "4 rows from a file to check in Trade",
    "Test the smoke alarms Alex upkeep, planned Sun Jan 24, 10:00: did it happen?",
    "31 rows from a file to check in Measurement",
    "Take the bins out Sam outside, planned Thu Jan 28, 20:00: did it happen?",
    "VTI buy 5 310, planned Mon Feb 1, 09:30: did it happen?",
  ]);
  const open = async (path: string) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const c = new AppController(root, path, t.env);
    started.push(c);
    c.load();
    await settle();
    return root;
  };
  let root = await open("Apps/Vitals.md");
  assert.deepEqual(["Weight", "Blood pressure", "Pulse", "Sleep"].map((x) => big(root, x)), ["79.8kg", "125/80", "69bpm", "6.5hours"]);
  root = await open("Apps/Trades.md");
  // What I hold doesn't depend on the calendar; this month's buys and this year's gains do, and early in February there are none yet.
  assert.deepEqual(["Cost of what I hold", "Bought this month", "Realized this year"].map((x) => big(root, x)), ["$19,817.57", "$0.00", "$0.00"]);
  root = await open("Apps/Trip planner.md");
  assert.deepEqual([big(root, "Days to go"), big(root, "The trip comes to")], ["116 days", "$2,930.00"]);
  root = await open("Apps/Household chores.md");
  assert.deepEqual(["Done this week", "Still to do this week", "Overdue"].map((x) => big(root, x)), ["2", "4", "2"]);
});

test("Budget: What if… a big purchase this month says the day the month would land past the limit, and nothing real changes", async () => {
  const path = "Apps/Budget.md";
  const t = fakeEnv({ [path]: { fm: fm(path) }, ...withSamples("Spend") });
  const end = new Date(2026, 10, 30, 23, 59).getTime();
  const data = new DataLayer(t.f.host, { like: t.data, ahead: { name: "Budget", at: end } });
  data.ledger!.onWrite = (p) => {
    data.fileChanged(p);
    t.f.flush();
  };
  started.push({ dispose: t.data.follow(data) });
  const env = aheadEnv(t.env, data, end, { show: () => {}, back: () => {} });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, env);
  started.push(c);
  c.load();
  await settle();
  // At the month's end, the bills planned by then count as paid: spent, and no longer still to come.
  assert.deepEqual([big(root, "The month lands at"), big(root, "Spent so far"), big(root, "Still to come")], ["$2,135.58", "$2,135.58", "$0.00"]);
  assert.match(text(titled(root, "Bills still to pay this month").querySelector(".gz-empty")), /^No bill left to pay this month/);
  addLine(panels(root).find((p) => p.querySelector("input.gz-addline-input"))!, "400 fun concert @2026-11-28");
  await settle();
  assert.equal(big(root, "The month lands at"), "$2,535.58");
  // The month lands at what is planned too, so planning the concert puts the alert on that day, as Keep would.
  assert.match(text(root.querySelector(".gz-ahead")), /“The month lands at” \(> 2500\) would go on Wed Nov 18/);
  assert.equal((await kindRows(t, "spend")).some((r) => r.note === "concert"), false);
});

test("Budget: What if… on the 20th: a bill planned for the 25th is still to come and not yet spent, and the month lands at the two together; every panel reads a planned row's line at the time shown", async () => {
  const path = "Apps/Budget.md";
  const t = fakeEnv({ [path]: { fm: fm(path) }, ...withSamples("Spend") });
  const shown = async (at: number) => {
    const data = new DataLayer(t.f.host, { like: t.data, ahead: { name: "Budget", at } });
    started.push({ dispose: t.data.follow(data) });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const c = new AppController(root, path, aheadEnv(t.env, data, at, { show: () => {}, back: () => {} }));
    started.push(c);
    c.load();
    await settle();
    return root;
  };
  const { root: live } = openApp(path, withSamples("Spend"));
  await settle();
  const on20 = await shown(new Date(2026, 10, 20, 23, 59).getTime());
  // As it is now: the bills of the 12th, 16th and 18th nothing paid wait as still to come, as does the 25th's.
  assert.deepEqual([big(live, "The month lands at"), big(live, "Spent so far"), big(live, "Still to come")], ["$2,135.58", "$1,971.89", "$163.69"]);
  // Shown on the 20th, the three have happened: they are spent, and only the 25th's 45.00 is still to come; nothing counts twice.
  assert.deepEqual([big(on20, "The month lands at"), big(on20, "Spent so far"), big(on20, "Still to come")], ["$2,135.58", "$2,090.58", "$45.00"]);
  assert.deepEqual(cells(titled(on20, "Bills still to pay this month")), [["BRIGHT MOBILE", "$45.00"]]);
});

test("Bills and renewals, on its sample rows: the next 30 days, overdue bills, a year of bills bill by bill, and a price rise caught from the bank's charge", async () => {
  const path = "Apps/Bills and renewals.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Spend"), ...withSamples("Renewal"), [BANK]: sample(BANK) });
  // The enrolment two weeks from its deadline is told; the bank's dearer STREAMFLIX charge waits to be checked, so no bill is settled by it yet.
  assert.deepEqual(t.notices.filter((n) => n.startsWith("Bills")).sort(), ["Bills and renewals: Renewals by deadline: Benefits open enrolment, Days left 12"]);
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["Next 30 days", "A year of bills", "Price changes", "Done"]);
  assert.equal(big(root, "Bills in the next 30 days"), "$2,435.68");
  assert.equal(big(root, "Renewals to start"), "1");
  assert.deepEqual(cells(titled(root, "Overdue")), [["STREAMFLIX", "$15.49"], ["METRO WATER", "$38.20"], ["FASTNET INTERNET", "$65.00"]]);
  // A bill's amount is what it costs, not what was spent.
  assert.deepEqual(["Overdue", "Coming up"].map((title) => [...titled(root, title).querySelectorAll("thead th")].map(text)), [["Bill", "Amount"], ["Bill", "Amount"]]);
  // Coming up takes a new price typed over a bill, so its cells are inputs holding the plain amount.
  assert.deepEqual(cells(titled(root, "Coming up")).slice(0, 3), [["FASTNET INTERNET", "65"], ["BRIGHT MOBILE", "45"], ["OAKWOOD APARTMENTS", "1450"]]);
  assert.deepEqual(cells(titled(root, "Renewals by deadline")).map((r) => r.slice(0, 4)), [
    ["Benefits open enrolment", "2026-11-30", "12", "2026-11-16"],
    ["Renew home insurance", "2026-12-15", "27", "2026-11-20"],
    ["Renew car registration", "2026-12-31", "43", "2026-12-01"],
    ["Renew passport", "2027-03-14", "116", "2027-01-13"],
    ["Renew driving licence", "2027-06-02", "196", "2027-04-02"],
  ]);

  await openTab(root, "A year of bills");
  assert.equal(big(root, "The next 12 months"), "$22,569.45");
  assert.deepEqual(cells(titled(root, "What each bill costs in a year")).slice(0, 3), [["OAKWOOD APARTMENTS", "12", "$17,400.00"], ["SHIELD AUTO INSURANCE", "2", "$1,224.00"], ["CITY POWER & LIGHT", "12", "$1,140.00"]]);
  assert.ok(titled(root, "Each month's bills").querySelector(".gz-chart-svg"));
  assert.match(text(titled(root, "Each month's bills")), /^Each month's billsNov 2027Planned\$1,595/);

  await openTab(root, "Price changes");
  assert.match(text(titled(root, "Charged more than planned").querySelector(".gz-empty")), /^No bill in the last 60 days cost more than planned\./);
  // The bank's charge accepted on Spend settles the bill though it is dearer: no ask, no longer overdue, and the rise shows.
  assert.ok(asked(t).some((a) => a.startsWith("15.49 fun STREAMFLIX")));
  const kind = await t.open(SPEND);
  const li = [...kind.querySelectorAll(".gz-reconcile li")].find((x) => text(x).includes("STREAMFLIX"))!;
  click([...li.querySelectorAll("button")].find((b) => text(b) === "Accept")!);
  await settle();
  assert.equal(asked(t).some((a) => a.startsWith("15.49 fun STREAMFLIX")), false);
  assert.deepEqual(cells(titled(root, "Charged more than planned")), [["STREAMFLIX", "$15.49", "$17.99", "$2.50"]]);
  await openTab(root, "Next 30 days");
  assert.deepEqual(cells(titled(root, "Overdue")), [["METRO WATER", "$38.20"], ["FASTNET INTERNET", "$65.00"]]);
  // The new price, typed over the next STREAMFLIX bill in Coming up.
  const next = [...titled(root, "Coming up").querySelectorAll("tbody tr")].find((tr) => (tr.querySelector("input") as HTMLInputElement | null)?.value === "STREAMFLIX")!;
  type(next.querySelectorAll("input")[1], "17.99");
  await settle();
  assert.equal(big(root, "Bills in the next 30 days"), "$2,438.18");
  assert.deepEqual((await kindRows(t, "spend")).filter((r) => r.note === "STREAMFLIX" && String(r.at).startsWith("2026-12")).map((r) => [r.amount, r.line]), [[17.99, "planned"]]);
});

test("Bills and renewals: a bill settled by a dearer charge under the bank's longer name shows under Price changes; a year of bills leaves out a bill already paid", async () => {
  const path = "Apps/Bills and renewals.md";
  const t = await background({ [path]: { fm: fm(path) }, [SPEND]: { fm: fm(SPEND) }, [RENEWAL]: { fm: fm(RENEWAL) } });
  const store = t.env.store!("Kinds/Spend data.md", SPEND);
  await store.add("spend", { amount: 15.49, category: "fun", note: "STREAMFLIX", at: savedAt("2026-11-18T13:00"), line: "planned" });
  await store.add("spend", { amount: 45, category: "home", note: "BRIGHT MOBILE", at: savedAt("2026-11-19T09:00"), line: "planned" });
  await store.add("spend", { amount: 100, category: "home", note: "CITY POWER", at: savedAt("2026-12-20T09:00"), line: "planned" });
  const root = await t.open(path);
  await openTab(root, "A year of bills");
  assert.equal(big(root, "The next 12 months"), "$160.49");
  // The bank names the bill longer, and charges more: it still settles the bill, and Price changes shows by how much.
  assert.ok((await t.bg.capture('spend 17.99 fun "STREAMFLIX.COM 866"')).ok);
  assert.ok((await t.bg.capture('spend 45 home "BRIGHT MOBILE"')).ok);
  await settle();
  assert.deepEqual((await kindRows(t, "spend")).filter((r) => r.line === "planned").map((r) => [r.note, typeof r.matched]), [["STREAMFLIX", "string"], ["BRIGHT MOBILE", "string"], ["CITY POWER", "undefined"]]);
  assert.equal(big(root, "The next 12 months"), "$100.00", "the two bills paid today are no longer to come");
  await openTab(root, "Price changes");
  assert.deepEqual(cells(titled(root, "Charged more than planned")), [["STREAMFLIX", "$15.49", "$17.99", "$2.50"]]);
});

test("Bills and renewals: a renewal planned with its deadline and the day to start; Next asks on that day, not on the deadline; logged again, it is done", async () => {
  const path = "Apps/Bills and renewals.md";
  const t = await background({ [path]: { fm: fm(path) }, [SPEND]: { fm: fm(SPEND) }, [RENEWAL]: { fm: fm(RENEWAL) } });
  const root = await t.open(path);
  const form = titled(root, "A renewal");
  typeLine(form, '"Renew passport" 2027-03-14 "post office" @2026-11-25');
  assert.deepEqual([...form.querySelectorAll(".gz-pv-label")].map(text).slice(0, 3), ["what", "Due", "how"]);
  addLine(form, '"Renew passport" 2027-03-14 "post office" @2026-11-25');
  await settle();
  assert.deepEqual((await kindRows(t, "renewal")).at(-1), { what: "Renew passport", due: "2027-03-14", how: "post office", at: savedAt("2026-11-25T12:00"), line: "planned" });
  // A bill's amount is what it costs, not what was spent: the form's labels say so in its preview.
  typeLine(titled(root, "A bill"), "15.49 STREAMFLIX fun @2026-12-12");
  assert.deepEqual([...titled(root, "A bill").querySelectorAll(".gz-pv-label")].map(text), ["Amount", "Bill", "category", "planned"]);
  // A bill too, planned from Do… with the form's word.
  const r = await t.bg.capture("bill 15.49 STREAMFLIX fun @2026-12-12");
  assert.ok(r.ok, r.error ?? "");
  await settle();
  assert.deepEqual(cells(titled(root, "Coming up")), [["STREAMFLIX", "15.49"]]);
  assert.deepEqual(cells(titled(root, "Renewals by deadline")).map((r) => r.slice(0, 4)), [["Renew passport", "2027-03-14", "116", "2026-11-25"]]);
  await t.bg.tick();
  await settle();
  assert.deepEqual(asked(t), [], "not before its day to start");
  assert.equal(big(root, "Renewals to start"), "0");

  // The 25th: its day to start has come, months before the deadline.
  t.advance(7 * 24 * HOUR + HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(asked(t), ["Renew passport 2027-03-14 post office, planned Wed Nov 25, 12:00: did it happen?"]);
  // One due in a week is told as well.
  assert.ok((await t.bg.capture('renew "Renew car registration" 2026-12-02 @2026-11-26')).ok);
  await settle();
  assert.ok(t.notices.includes("Bills and renewals: Renewals by deadline: Renew car registration, Days left 7"), t.notices.join(" | "));

  // Done at the post office: logging it again, with no day, settles the planned one.
  assert.equal(big(root, "Renewals to start"), "1");
  assert.ok((await t.bg.capture('renew "Renew passport"')).ok);
  await t.bg.tick();
  await settle();
  assert.deepEqual(asked(t), []);
  assert.equal(big(root, "Renewals to start"), "0");
  const rows = await kindRows(t, "renewal");
  assert.equal(typeof rows.find((r) => r.what === "Renew passport" && r.line === "planned")!.matched, "string");
  await openTab(root, "Done");
  assert.deepEqual(cells(titled(root, "Renewed")).map((r) => r.slice(1)), [["Renew passport", ""]]);
  // A date left out is today, as in any form: the renewal logged by hand says it was due today.
  assert.equal(rows.find((r) => r.what === "Renew passport" && r.line === undefined)!.due, "2026-11-25");
});

const CHORE = "Kinds/Chore.md";

test("Household chores, on its sample rows: the week's rota and what was done, the overdue turns Next asks about; a chore done by anyone settles its turn; upkeep done settles its plan, and what it cost goes in Spend", async () => {
  const path = "Apps/Household chores.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Chore"), ...withSamples("Spend") });
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["This week", "Upkeep"]);
  assert.deepEqual([big(root, "Done this week"), big(root, "Still to do this week"), big(root, "Overdue")], ["2", "4", "2"]);
  assert.deepEqual(cells(titled(root, "This week")).map((r) => r.slice(1)), [
    ["Wash the dishes", "Sam", "done"], ["Wash the dishes", "Alex", "done"], ["Take the bins out", "Sam", "to do"],
    ["Clean the bathroom", "Alex", "to do"], ["Vacuum the house", "Sam", "to do"], ["Do the laundry", "Alex", "to do"],
  ]);
  assert.deepEqual(cells(titled(root, "Overdue turns")).map((r) => r.slice(1)), [["Test the smoke alarms", "Alex"], ["Take the bins out", "Sam"]]);
  const chores = (asks: string[]) => asks.filter((a) => !/^\d/.test(a));
  assert.deepEqual(chores(asked(t)), ["Test the smoke alarms Alex upkeep, planned Sun Nov 8, 10:00: did it happen?", "Take the bins out Sam outside, planned Thu Nov 12, 20:00: did it happen?"]);

  // Alex vacuums today: "vacuum" is in "Vacuum the house", so it settles the nearest turn, Saturday's, though it was Sam's.
  const did = titled(root, "Did a chore");
  typeLine(did, "vacuum Alex");
  assert.equal(text(did.querySelector(".gz-chip.is-on")), "Alex");
  const area = [...did.querySelectorAll(".gz-pv")][2];
  assert.equal(text(area.querySelector(".gz-chip.is-on, .gz-chip.is-guess, .gz-chip.is-default")), "rooms", `the area is guessed from an earlier vacuum: ${area.innerHTML}`);
  addLine(did, "vacuum Alex");
  await settle();
  const saturday = (await kindRows(t, "chore")).find((r) => r.task === "Vacuum the house" && r.line === "planned" && String(r.at).startsWith("2026-11-21"))!;
  assert.equal(typeof saturday.matched, "string");
  assert.deepEqual([big(root, "Done this week"), big(root, "Still to do this week")], ["3", "3"]);
  assert.deepEqual(cells(titled(root, "This week")).find((r) => r[1] === "vacuum")!.slice(1), ["vacuum", "Alex", "done"]);

  // The bins went out last Thursday after all: Enter in Next says it was done then, by whose turn it was.
  const bins = t.bg.asks.list().find((a) => a.text.startsWith("Take the bins out"))!;
  assert.ok((await t.bg.settleAsk(bins, "answer")).ok);
  await settle();
  assert.equal(big(root, "Overdue"), "1");
  // Last week's bins don't count this week: this week Alex did the vacuuming and a night's dishes, Sam a night's dishes.
  assert.deepEqual([...titled(root, "Who did what this week").querySelectorAll("tbody tr")].map(text), ["Alex2", "Sam1"]);

  // Upkeep: the smoke alarms tested and their batteries bought; that settles the plan of the 8th, and the cost goes to Spend as home.
  await openTab(root, "Upkeep");
  assert.deepEqual([big(root, "Upkeep in the next 30 days"), big(root, "Next upkeep"), big(root, "Upkeep paid this year")], ["1", "Replace the furnace filter, in 24 days", "$213.99"]);
  assert.deepEqual(cells(titled(root, "Upkeep in the next 12 months")).map((r) => r[1]), [
    "Replace the furnace filter", "Car service", "Flush the water heater", "Replace the furnace filter", "Clean the gutters", "Replace the furnace filter", "Car service", "Replace the furnace filter", "Test the smoke alarms",
  ]);
  assert.ok((await t.bg.capture("chore smoke Alex upkeep")).ok);
  addLine(titled(root, "Paid for upkeep"), '32.50 "smoke alarm batteries"');
  await settle();
  assert.deepEqual(chores(asked(t)), []);
  assert.equal(big(root, "Overdue"), "0");
  assert.deepEqual((await kindRows(t, "spend")).at(-1), { amount: 32.5, note: "Upkeep: smoke alarm batteries", category: "home", at: savedAt("2026-11-18T12:00") });
  assert.equal(big(root, "Upkeep paid this year"), "$246.49");
  assert.deepEqual(cells(titled(root, "Last done")).map((r) => [r[0], r[2]]), [["Car service", "Sam"], ["Clean the gutters", "Alex"], ["Replace the furnace filter", "Sam"], ["smoke", "Alex"]]);
  assert.deepEqual(cells(titled(root, "What upkeep cost"))[0].slice(-2), ["Upkeep: smoke alarm batteries", "$32.50"]);
});

test("Household chores: a rota planned on the line asks in Next once a turn's time passes; Enter says it was done then; who did what this week", async () => {
  const path = "Apps/Household chores.md";
  const t = await background({ [path]: { fm: fm(path) }, [CHORE]: { fm: fm(CHORE) }, [SPEND]: { fm: fm(SPEND) } });
  const root = await t.open(path);
  assert.match(text(titled(root, "This week").querySelector(".gz-empty")), /^Nothing done or planned this week yet\./);
  const plan = titled(root, "Plan a chore");
  typeLine(plan, '"Take the bins out" Sam outside @every week from thu 20:00 until 2026-12-31');
  assert.match([...plan.querySelectorAll(".gz-pv")].map(text).at(-1)!, /^planned7 times, Thu Nov 19, 20:00 to Thu Dec 31, 20:00$/);
  addLine(plan, '"Take the bins out" Sam outside @every week from thu 20:00 until 2026-12-31');
  await settle();
  assert.equal((await kindRows(t, "chore")).filter((r) => r.line === "planned").length, 7);
  assert.equal(big(root, "Still to do this week"), "1");
  const [[when]] = cells(titled(root, "This week"));
  assert.doesNotMatch(when, /^\d{4}-\d\d-\d\dT/, "a lone turn reads as a day and a time, not the stamp as saved");
  assert.match(when, /\d{1,2}:\d\d/);
  assert.ok((await t.bg.capture('did "Wash the dishes" Alex kitchen')).ok);
  assert.ok((await t.bg.capture('did "Wash the dishes" Sam kitchen')).ok);
  assert.ok((await t.bg.capture('did Groceries Sam kitchen')).ok);
  await settle();
  assert.match(text(titled(root, "Who did what this week")), /Alex.*Sam|Sam.*Alex/);

  // Friday morning: Thursday's bins went unasked-for, so Next asks; Enter says Sam did it then.
  t.advance(44 * HOUR);
  await t.bg.tick();
  await settle();
  const [bins] = t.bg.asks.list();
  assert.equal(bins?.text, "Take the bins out Sam outside, planned Thu Nov 19, 20:00: did it happen?");
  assert.ok((await t.bg.settleAsk(bins, "answer")).ok);
  await settle();
  assert.deepEqual(asked(t), []);
  assert.deepEqual(cells(titled(root, "This week")).find((r) => r[1] === "Take the bins out")!.slice(1), ["Take the bins out", "Sam", "done"]);
  assert.equal(big(root, "Done this week"), "4");
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
  // On the add line: the quoted name fills the first text field, the word left over the next, the dates start then due.
  typeLine(form, '"Learn piano" learning 2026-12-01 2027-06-30');
  assert.deepEqual([...form.querySelectorAll(".gz-pv-label")].map(text), ["name", "area", "start", "due"]);
  addLine(form, '"Learn piano" learning 2026-12-01 2027-06-30');
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
  typeLine(form, '"Walk to work through the winter" "I keep it up until March" 80 2027-03-01');
  assert.deepEqual([...form.querySelectorAll(".gz-pv-label")].map(text), ["Decision", "I expected", "% sure", "Due"]);
  addLine(form, '"Walk to work through the winter" "I keep it up until March" 80 2027-03-01');
  await settle();
  assert.deepEqual(t.f.files.get("Decisions/Walk to work through the winter.md")!.fm, {
    expect: "I keep it up until March", confidence: 80, review: "2027-03-01", outcome: "open", made: "2026-11-18", at: savedAt("2026-11-18T12:00"),
  });
  assert.equal(said(form), "Written down. Come back on 2027-03-01 to score it.");

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
  assert.deepEqual([...score.querySelectorAll("thead th")].map(text), ["Decision", "I expected", "% sure", "Due", "It went", "What I learned"]);
  const row = score.querySelector("tbody tr:not(.gz-ledger-group)")!;
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
  assert.deepEqual([...panel("Scored").querySelectorAll("tbody tr:not(.gz-ledger-group)")].map((tr) => text(tr.querySelector("td"))),
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
  assert.deepEqual([...done.querySelectorAll("li:not(.gz-ledger-group)")].map(text), ["Water plants 📅 2026-11-19 · Home", "Call the bank 📅 2026-11-17 · Home"]);
});

const WEATHER = {
  current: { time: "2026-11-18T12:00", temperature_2m: 17.5 },
  daily: {
    time: ["2026-11-18", "2026-11-19"], weather_code: [2, 80],
    temperature_2m_max: [18.7, 14.5], temperature_2m_min: [9.3, 6.9], precipitation_probability_max: [24, 60],
  },
};
const YEAR = { daily: { time: ["2025-01-01", "2025-01-02", "2025-02-01"], temperature_2m_max: [10, 12, 11], temperature_2m_min: [2, 3, 1] } };

test("Trip planner: days to go, packing, the itinerary from a calendar file, expenses in yen saved in dollars to Spend, and the weather there", async () => {
  const path = "Apps/Trip planner.md";
  const responses = {
    "https://api.open-meteo.com/": WEATHER, "https://archive-api.open-meteo.com/": YEAR, "https://api.frankfurter.dev/": { rates: { JPY: 159.42 } },
  };
  const trip = gallery(path).fm;
  const { root, f, changed } = openApp(path, {
    "Components/Destination weather.md": { fm: fm("Components/Destination weather.md") },
    "Kinds/Spend.md": { fm: fm("Kinds/Spend.md") },
    // Lunch at home and a ticket on another trip: neither is this trip's.
    "Kinds/Spend data.md": { fm: { spend: [
      { amount: 14.5, category: "food", note: "lunch", at: "2026-11-17T12:00" },
      { amount: 40, category: "travel", note: "Metro", local: 36, trip: "Paris", at: "2026-11-16T09:00" },
    ] } },
    "Trips/Tokyo.ics": sample("Trips/Tokyo.ics"),
  }, responses, { ...trip, departs: SAMPLES.departs, returns: SAMPLES.returns });
  await settle();
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["Plan", "Itinerary", "Spending", "Weather"]);
  assert.equal(big(root, "Days to go"), "116 days");
  const packing = titled(root, "Packing");
  assert.equal(text(packing.querySelector(".gz-title")), "Packing · 0/6");
  await openTab(root, "Itinerary");
  assert.deepEqual(cells(titled(root, "Itinerary")).map((r) => r[1]),
    ["Flight to Tokyo", "Hotel in Shinjuku", "Breakfast at Tsukiji outer market", "Day trip to Kamakura", "teamLab Planets", "Flight home"]);

  // The weather there: the property lat and lon choose where, and the sky is in words.
  await openTab(root, "Weather");
  assert.ok(f.requests.includes("https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&current=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto"));
  assert.equal(text(titled(root, "Tokyo now").querySelector(".gz-title")), "Tokyo now");
  assert.deepEqual(cells(titled(root, "The week ahead")).map((r) => r.slice(1)), [["partly cloudy", "9 to 19 °C", "24 %"], ["showers", "7 to 15 °C", "60 %"]]);
  assert.ok(titled(root, "Average high and low").querySelector(".gz-chart-svg"));

  // Pack.
  await openTab(root, "Plan");
  const tick = titled(root, "Packing").querySelector("input") as HTMLInputElement;
  tick.checked = true;
  change(tick);
  await settle();
  assert.deepEqual(f.files.get("Apps/Trip planner data.md")!.fm!.packed, ["Passport"]);
  assert.equal(text(titled(root, "Packing").querySelector(".gz-title")), "Packing · 1/6");

  // 3,000 yen at the rate in the note's properties, 150 to the dollar, saved in dollars as a travel row of this trip.
  await openTab(root, "Spending");
  assert.equal(big(root, "Today's rate"), "159.42");
  assert.equal(big(root, "Spent so far"), "$0.00");
  const form = titled(root, "Spent abroad");
  typeLine(form, "Ramen 3000");
  assert.deepEqual([...form.querySelectorAll(".gz-pv-label")].map(text), ["item", "Yen"]);
  addLine(form, "Ramen 3000");
  await settle();
  const rows = () => listsIn(f.files.get("Kinds/Spend data.md")!.fm)!.spend as Record<string, unknown>[];
  assert.deepEqual(rows().at(-1), { note: "Ramen", local: 3000, amount: 20, category: "travel", trip: "Tokyo", at: savedAt("2026-11-18T12:00") });
  assert.equal(f.files.get("Apps/Trip planner data.md")!.fm!.spend, undefined, "nothing of it in the app's own data note");
  assert.equal(big(root, "Spent so far"), "$20.00");
  assert.deepEqual([...titled(root, "Expenses").querySelectorAll("th")].map(text), ["Item", "Yen", "Dollars"]);
  assert.deepEqual(cells(titled(root, "Expenses")), [["Ramen", "¥3,000", "$20.00"]]);

  // Each row keeps the dollars it was worked out at: a new rate changes the next row, not this one.
  f.files.get(path)!.fm!.rate = 100;
  changed(path);
  await settle();
  assert.equal(big(root, "Spent so far"), "$20.00");
  addLine(titled(root, "Spent abroad"), "Sushi 3000");
  await settle();
  assert.equal(rows().at(-1)!.amount, 30);
  assert.equal(big(root, "Spent so far"), "$50.00");
});

const tripNotes = (files = SAMPLES.files): Notes => ({
  "Components/Destination weather.md": { fm: fm("Components/Destination weather.md") },
  ...withSamples("Spend", files),
  "Trips/Tokyo.ics": { raw: files["Trips/Tokyo.ics"] },
});

test("Trip planner, on its sample rows: the trip comes to what is spent plus what is planned for it; a cost planned past the budget puts the alert on before it is spent; paid abroad in yen, a cost settles the one planned under its name", async () => {
  const path = "Apps/Trip planner.md";
  const trip = { ...fm(path), departs: SAMPLES.departs, returns: SAMPLES.returns };
  const t = await background({ [path]: { fm: trip }, ...tripNotes() }, { "https://api.frankfurter.dev/": { rates: { JPY: 159.42 } } });
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  // The flights are paid; the rail pass, the hotel, six days of food and getting around and teamLab are planned.
  assert.equal(big(root, "The trip comes to"), "$2,930.00");
  assert.equal(text(root.querySelector(".gz-meter .gz-meter-legend")), "92% of $3,200$270.00 left");
  assert.deepEqual(cells(titled(root, "The trip's money")).slice(0, 3), [["Tue Oct 20", "Flights to Haneda and back", "1240", "spent"], ["Mon Mar 1, 2027", "JR Pass, 7 days", "330", "planned"], ["Sun Mar 14, 2027", "Hotel in Shinjuku", "780", "planned"]]);
  assert.deepEqual(t.notices.filter((n) => n.startsWith("Trip")), []);
  // The trip's plans are Spend's, so Budget's March counts them; Bills keeps them out of a year of bills.
  assert.equal((await kindRows(t, "spend")).filter((r) => r.trip === "Tokyo" && r.line === "planned").length, 9);

  // A night in a ryokan, planned with its day: the trip now lands past its budget, told now, not in March.
  const plan = titled(root, "Plan a cost");
  typeLine(plan, "420 Ryokan in Hakone @2027-03-17");
  assert.deepEqual([...plan.querySelectorAll(".gz-pv-label")].map(text), ["Dollars", "item", "planned"]);
  addLine(plan, "420 Ryokan in Hakone @2027-03-17");
  await settle();
  assert.equal(big(root, "The trip comes to"), "$3,350.00");
  assert.equal(text(titled(root, "The trip comes to").querySelector(".gz-ans-status")), "The alert is on");
  assert.ok(t.notices.includes("Trip planner: The trip comes to $3,350.00"), t.notices.join(" | "));

  // In March, at the hotel: 117,000 yen at 150 is the $780 planned, under its name, so it settles that plan.
  t.advance((116 * 24 + 4) * HOUR);
  await openTab(root, "Spending");
  addLine(titled(root, "Spent abroad"), '"Hotel in Shinjuku" 117000');
  await settle();
  const hotel = (await kindRows(t, "spend")).filter((r) => r.note === "Hotel in Shinjuku");
  assert.deepEqual(hotel.map((r) => [r.line ?? "logged", r.amount, typeof r.matched]), [["planned", 780, "string"], ["logged", 780, "undefined"]]);
  // The rail pass's day passed with nothing paying it: still to come until Next is answered.
  assert.deepEqual([big(root, "Spent so far"), big(root, "Still to come")], ["$2,020.00", "$1,330.00"]);
});

test("Trip planner: What if… an excursion says the day the trip would pass its budget, and nothing real changes", async () => {
  const path = "Apps/Trip planner.md";
  const trip = { ...fm(path), departs: SAMPLES.departs, returns: SAMPLES.returns };
  const t = fakeEnv({ [path]: { fm: trip }, ...tripNotes() });
  const at = new Date(2027, 2, 31, 23, 59).getTime();
  const data = new DataLayer(t.f.host, { like: t.data, ahead: { name: "Trip planner", at } });
  data.ledger!.onWrite = (p) => {
    data.fileChanged(p);
    t.f.flush();
  };
  started.push({ dispose: t.data.follow(data) });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, aheadEnv(t.env, data, at, { show: () => {}, back: () => {} }));
  started.push(c);
  c.load();
  await settle();
  // At the end of March the trip has happened as planned: all of it spent, nothing still to come.
  assert.equal(big(root, "The trip comes to"), "$2,930.00");
  addLine(titled(root, "Plan a cost"), "320 Mt Fuji day tour @2027-03-16");
  await settle();
  assert.equal(big(root, "The trip comes to"), "$3,250.00");
  assert.match(text(root.querySelector(".gz-ahead")), /“The trip comes to” \(> 3200\) would go on/);
  await openTab(root, "Spending");
  assert.deepEqual([big(root, "Spent so far"), big(root, "Still to come")], ["$3,250.00", "$0.00"]);
  assert.equal((await kindRows(t, "spend")).some((r) => r.note === "Mt Fuji day tour"), false);
});

test("Trip planner, during the trip: a charge from the bank dated in the trip's days waits outside it, and its category set to travel brings it in", async () => {
  const path = "Apps/Trip planner.md";
  const trip = { ...fm(path), departs: SAMPLES.departs, returns: SAMPLES.returns };
  const t = await background({ [path]: { fm: trip }, ...tripNotes() }, { "https://api.frankfurter.dev/": { rates: { JPY: 159.42 } } });
  // The 17th of March: two charges from the bank, the card abroad and the water bill at home. In a ledger's day, a date with no time shows no time column.
  t.advance((119 * 24 + 6) * HOUR);
  const store = t.env.store!("Kinds/Spend data.md", SPEND);
  await store.add("spend", { amount: 61.2, note: "SUSHI ZANMAI TOKYO", at: "2027-03-16" });
  await store.add("spend", { amount: 38.2, note: "METRO WATER", at: "2027-03-16" });
  const root = await t.open(path);
  const before = big(root, "The trip comes to");
  await openTab(root, "Spending");
  const charges = () => titled(root, "The bank's charges in the trip's days");
  assert.deepEqual(cells(charges()).map((r) => r.slice(0, 2)), [["SUSHI ZANMAI TOKYO", "$61.20"], ["METRO WATER", "$38.20"]]);
  const sushi = [...charges().querySelectorAll("tbody tr:not(.gz-ledger-group)")].find((tr) => text(tr).includes("SUSHI"))!;
  choose(sushi.querySelector("select")!, "travel");
  await settle();
  // One row left is no ledger, so its date shows first.
  assert.deepEqual(cells(charges()).map((r) => r.slice(0, 2)), [["3/16/2027", "METRO WATER"]]);
  await openTab(root, "Plan");
  assert.deepEqual([before, big(root, "The trip comes to")], ["$2,930.00", "$2,991.20"]);
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

const TRADE = "Kinds/Trade.md";
const BROKER = "Inbox/Broker/Brokerage 2026-11.csv";

test("Trades: pick a symbol for its price, move and chart; log trades on the line; what I hold at average cost, picked for what it is worth now; a trade's shares set to 0 take it out", async () => {
  const path = "Apps/Trades.md";
  const responses = { [`${YAHOO}SPY`]: yahoo("SPY", [523, 523.88, 517.99, 506.24, 508.29]), [`${YAHOO}AAPL`]: yahoo("AAPL", [200, 205, 210]) };
  const t = await background({ [path]: { fm: fm(path) }, [TRADE]: { fm: fm(TRADE) } }, responses);
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([...root.querySelectorAll("button.gz-tab")].map(text), ["Holdings", "Plan", "Watch", "Trades"]);
  assert.equal(big(root, "Cost of what I hold"), "$0.00");
  assert.match(text(titled(root, "What I hold").querySelector(".gz-empty")), /^No shares held\./);
  // What a position is worth waits for one to be picked.
  const sheet = [...root.querySelectorAll(".gz-role-sheet")];
  assert.ok(sheet.length === 2 && sheet.every(waitsForPick));

  await openTab(root, "Watch");
  assert.equal(big(root, "SPY"), "508.29USD");
  assert.equal(big(root, "Last session"), "0.40%");
  assert.ok(titled(root, "SPY, last 3mo").querySelector(".gz-chart-svg"));
  choose(root.querySelector(".gz-inputs select")!, "AAPL");
  await settle();
  assert.equal(big(root, "AAPL"), "210.00USD");

  // On the line: a side, shares, a symbol and a price, in any order the words allow; @ for the day it filled.
  await openTab(root, "Holdings");
  const form = titled(root, "A trade");
  typeLine(form, "buy 10 SPY 500 @2026-11-10");
  assert.deepEqual([...form.querySelectorAll(".gz-pv")].map(text).slice(0, 4), ["symbolSPY", "sidebuysell", "shares10", "Price$500.00"]);
  assert.equal(text(form.querySelector(".gz-chip.is-on")), "buy");
  for (const line of ["buy 10 SPY 500 @2026-11-10", "buy 5 SPY 510 @2026-11-12", "buy 5 AAPL 200 @2026-11-17", "sell 3 SPY 512 @2026-11-17 10:00"]) {
    addLine(form, line);
    await settle();
  }
  assert.deepEqual((await kindRows(t, "trade")).map((r) => [r.symbol, r.side, r.shares, r.price]), [["SPY", "buy", 10, 500], ["SPY", "buy", 5, 510], ["AAPL", "buy", 5, 200], ["SPY", "sell", 3, 512]]);
  assert.equal(t.f.files.has("Apps/Trades data.md"), false, "the trades are the kind's, not the app's");
  // SPY: 15 bought for $7,550, an average of $503.33; 3 sold at $512 realize $26 at that average, and 12 stay at it.
  assert.deepEqual(cells(titled(root, "What I hold")), [["SPY", "12", "$503.33", "$6,040.00"], ["AAPL", "5", "$200.00", "$1,000.00"]]);
  assert.deepEqual([big(root, "Cost of what I hold"), big(root, "Realized this year"), big(root, "Bought this month")], ["$7,040.00", "$26.00", "$8,550.00"]);

  // SPY: 12 shares at the last close of 508.29, against the $6,040 they cost.
  click([...titled(root, "What I hold").querySelectorAll("tbody tr")][0]);
  await settle();
  assert.equal(big(root, "SPY is worth"), "$6,099.48");
  assert.equal(big(root, "Against what I paid"), "$59.48");
  assert.ok(t.f.requests.includes(`${YAHOO}SPY?range=5d&interval=1d`));

  // A trade's shares set to 0 in Every trade take it out of what I hold.
  await openTab(root, "Trades");
  const aapl = [...titled(root, "Every trade").querySelectorAll("tbody tr:not(.gz-ledger-group)")].find((tr) => text(tr.querySelectorAll("td")[1]) === "AAPL")!;
  type(aapl.querySelector("input.gz-edit")!, "0");
  await settle();
  await openTab(root, "Holdings");
  assert.deepEqual(cells(titled(root, "What I hold")).map((r) => r[0]), ["SPY"]);
});

test("Trades, on its sample rows: the broker's export comes in by itself, its dividend and interest left out; what I hold at average cost; a sell of shares bought before any was logged is flagged, never taken as a short; Accept all fills the plan's tranche and its ask goes", async () => {
  const path = "Apps/Trades.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Trade"), [BROKER]: sample(BROKER) }, { [`${YAHOO}VTI`]: yahoo("VTI", [318, 321.5]) });
  assert.ok(t.notices.includes("Imported 4 rows from Brokerage 2026-11.csv into Trade, skipped 2"), t.notices.join(" | "));
  // The MSFT sold on the 12th was never bought here: told while it waits, before anyone accepts it.
  assert.ok(t.notices.includes("Trades: Sells over what I hold: MSFT"), t.notices.join(" | "));
  const root = await t.open(path);
  assert.ok(!root.querySelector(".gz-error"), text(root.querySelector(".gz-error")));
  assert.deepEqual([big(root, "Cost of what I hold"), big(root, "Bought this month"), big(root, "Realized this year")], ["$19,817.57", "$3,790.00", "$369.67"]);
  assert.deepEqual(cells(titled(root, "What I hold")), [
    ["VTI", "40", "$272.58", "$10,903.17"], ["SPY", "4", "$618.90", "$2,475.60"], ["QQQ", "10", "$531.38", "$5,313.80"], ["AAPL", "5", "$225.00", "$1,125.00"],
  ]);
  assert.deepEqual(cells(titled(root, "Sells over what I hold")).map((r) => r.slice(1)), [["MSFT", "4", "0", "the broker's, not checked yet"]]);
  const card = () => titled(root, "From my broker, not checked yet").querySelector(".gz-reconcile");
  assert.equal(text(card()!.querySelector(".gz-reconcile-counts")), "2 pair with rows you logged2 only in the file0 only logged0 logged twice");
  assert.deepEqual(asked(t), ["4 rows from a file to check in Trade", "VTI buy 5 310, planned Mon Nov 16, 09:30: did it happen?"]);

  // Accept all: the broker's VTI of the 16th, at $312.40, fills the tranche planned at $310.
  click([...card()!.querySelectorAll("button")].find((b) => text(b) === "Accept all")!);
  await settle();
  assert.deepEqual(asked(t), []);
  const tranche = (await kindRows(t, "trade")).find((r) => r.line === "planned" && String(r.at).startsWith("2026-11-16"))!;
  assert.deepEqual([tranche.price, typeof tranche.matched], [310, "string"]);
  assert.deepEqual(cells(titled(root, "What I hold"))[0], ["VTI", "45", "$277.00", "$12,465.17"]);
  assert.equal(big(root, "Bought this month"), "$5,352.00");
  // Accepted, the MSFT sell is logged, and still flagged: What I hold never shows a symbol below zero.
  assert.deepEqual(cells(titled(root, "Sells over what I hold")).map((r) => r.slice(1)), [["MSFT", "4", "0", "logged"]]);
  assert.equal(cells(titled(root, "What I hold")).some((r) => r[0] === "MSFT"), false);
  // Picked, VTI is worth its 45 shares at the last close.
  click([...titled(root, "What I hold").querySelectorAll("tbody tr")][0]);
  await settle();
  assert.deepEqual([big(root, "VTI is worth"), big(root, "Against what I paid")], ["$14,467.50", "$2,002.33"]);

  await openTab(root, "Plan");
  assert.equal(big(root, "Still to buy"), "$6,200.00");
  assert.equal(big(root, "Next tranche"), "5 VTI, in 13 days");
  assert.deepEqual(cells(titled(root, "Planned buys")).map((r) => r.slice(0, 3)), [["Tue Dec 1", "VTI", "5"], ["Mon Jan 4, 2027", "VTI", "5"], ["Mon Feb 1, 2027", "VTI", "5"], ["Mon Mar 1, 2027", "VTI", "5"]]);
  await openTab(root, "Holdings");
  assert.match(text(titled(root, "Realized gain each year, at average cost")), /\$370/);
});

test("Trades: a tranche planned on the line asks in Next once its day passes; the buy that fills it settles it whatever its price; ? trade asks the kind", async () => {
  const path = "Apps/Trades.md";
  const t = await background({ [path]: { fm: fm(path) }, ...withSamples("Trade") });
  const root = await t.open(path);
  await openTab(root, "Plan");
  const plan = titled(root, "Plan a buy");
  typeLine(plan, "QQQ 4 560 @2026-11-20");
  assert.match([...plan.querySelectorAll(".gz-pv")].map(text).at(-1)!, /^planned/);
  addLine(plan, "QQQ 4 560 @2026-11-20");
  await settle();
  assert.deepEqual((await kindRows(t, "trade")).at(-1), { symbol: "QQQ", side: "buy", shares: 4, price: 560, at: savedAt("2026-11-20T12:00"), line: "planned" });
  assert.equal(big(root, "Still to buy"), "$9,990.00");

  // The 20th at 14:00: it hasn't filled, so Next asks, beside the VTI tranche of the 16th.
  t.advance(50 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(asked(t), ["VTI buy 5 310, planned Mon Nov 16, 09:30: did it happen?", "QQQ buy 4 560, planned Fri Nov 20, 12:00: did it happen?"]);
  // It filled on the 21st at $557.80: logged with its price, it settles the tranche, and its ask goes.
  t.advance(24 * HOUR);
  assert.ok((await t.bg.capture("trade QQQ buy 4 557.80")).ok);
  await t.bg.tick();
  await settle();
  assert.deepEqual(asked(t), ["VTI buy 5 310, planned Mon Nov 16, 09:30: did it happen?"]);
  const qqq = (await kindRows(t, "trade")).filter((r) => r.symbol === "QQQ" && String(r.at).startsWith("2026-11-2"));
  assert.deepEqual(qqq.map((r) => [r.line ?? "logged", r.price, typeof r.matched]), [["planned", 560, "string"], ["logged", 557.8, "undefined"]]);
  // x on the VTI one sets that tranche aside.
  const vti = t.bg.asks.list()[0];
  assert.ok((await t.bg.settleAsk(vti, "dismiss")).ok);
  await settle();
  assert.deepEqual(asked(t), []);
});

test("Trades: What if… a buy this month says when the month's buys would pass invest_monthly and what I would hold then, and nothing real changes", async () => {
  const path = "Apps/Trades.md";
  const t = fakeEnv({ [path]: { fm: fm(path) }, ...withSamples("Trade") });
  const end = new Date(2026, 10, 30, 23, 59).getTime();
  const data = new DataLayer(t.f.host, { like: t.data, ahead: { name: "Trades", at: end } });
  data.ledger!.onWrite = (p) => {
    data.fileChanged(p);
    t.f.flush();
  };
  started.push({ dispose: t.data.follow(data) });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, aheadEnv(t.env, data, end, { show: () => {}, back: () => {} }));
  started.push(c);
  c.load();
  await settle();
  // At the month's end the tranche of the 16th has happened, as planned: bought, and in what I hold.
  assert.deepEqual([big(root, "Bought this month"), big(root, "Cost of what I hold")], ["$5,340.00", "$21,367.57"]);
  addLine(titled(root, "A trade"), "buy 10 QQQ 560 @2026-11-25");
  await settle();
  assert.equal(big(root, "Bought this month"), "$10,940.00");
  assert.deepEqual(cells(titled(root, "What I hold")).find((r) => r[0] === "QQQ"), ["QQQ", "20", "$545.69", "$10,913.80"]);
  assert.match(text(root.querySelector(".gz-ahead")), /“Bought this month” \(> 6000\) would go on/);
  assert.equal((await kindRows(t, "trade")).some((r) => r.symbol === "QQQ" && r.shares === 10), false);
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
  assert.deepEqual(t.notices, ["Aurora watch: Kp now 5.33", "Aurora watch: Expected to reach Kp 5: 2026-11-18T21:00:00 · Kp 5.67"]);
  assert.deepEqual(t.out.status, [{ appPath: path, text: "Kp now: 5.33", title: "Aurora watch" }]);
  assert.deepEqual(t.out.commands, [{ id: `${path}:saw-aurora`, name: "Aurora watch: Saw aurora" }]);

  const root = await t.open(path);
  assert.equal(root.querySelector(".gz-error"), null);
  const [now, , forecast, expected, record, sightings] = panels(root);
  assert.equal(text(now.querySelector(".gz-big")), "5.33");
  assert.equal(text(forecast.querySelector(".gz-goal-label")), "Goal 5");
  assert.deepEqual([...expected.querySelectorAll("li")].map(text), ["2026-11-18T21:00:00 · Kp 5.67"]);
  assert.ok(record.querySelector(".gz-chart-svg"));
  assert.equal(text(sightings.querySelector(".gz-empty")), "Nothing logged yet.");

  // Saw one: the button, then a note on it in the table; and one more from a link with the app closed.
  click(root.querySelector("button.gz-button")!);
  await settle();
  assert.deepEqual((data().sightings as { at: string }[]).map((s) => s.at), [savedAt("2026-11-18T12:00")]);
  // A lone sighting reads as a day and a time, not its saved stamp.
  const when = cells(sightings)[0][0];
  assert.doesNotMatch(when, /\d{4}-\d\d-\d\dT/);
  assert.match(when, /12:00/);
  type(sightings.querySelector("tbody input.gz-edit")!, "green arc to the north");
  await settle();
  assert.deepEqual(data().sightings, [{ at: savedAt("2026-11-18T12:00"), note: "green arc to the north" }]);
  await t.bg.runUri({ app: "Aurora watch", do: "saw-aurora" });
  await settle();
  assert.equal((data().sightings as unknown[]).length, 2);
  assert.equal(said(root.querySelector(".gz-view-button")!), "Sighting saved");
  assert.deepEqual(t.notices.slice(2), ["Sighting saved"]);
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
  const rows = () => [...toRead.querySelectorAll("tbody tr:not(.gz-ledger-group)")];
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
  const t = fakeEnv({ "Today.md": { fm: today.fm }, "Apps/Medication log.md": { fm: fm("Apps/Medication log.md") }, [DOSE]: { fm: fm(DOSE) } });
  const [meds, water] = sources.map((source) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const hosted = new HostedApp(el, parseYaml(source), source, "Today.md", t.env);
    started.push(hosted);
    hosted.load();
    return el;
  });
  await settle();
  assert.ok(!meds.querySelector(".gz-error"), text(meds.querySelector(".gz-error")));
  assert.ok(!water.querySelector(".gz-error"), text(water.querySelector(".gz-error")));

  // The Medication log's own button and count, saving a dose of Medication A to the kind Dose.
  assert.deepEqual(panels(meds).map(text), ["Doses today0", "Took Medication A"]);
  click(meds.querySelector("button.gz-button")!);
  await settle();
  assert.deepEqual((await kindRows(t, "dose")).map((r) => r.med), ["Medication A"]);
  assert.equal(text(meds.querySelector(".gz-view-number .gz-big")), "1");
  assert.equal(said(meds), "Logged Medication A");
  assert.deepEqual(t.notices, []);

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
  assert.equal(text(why.querySelector(".gz-empty")), "Nothing logged yet.");

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
  for (const folder of ["Apps", "Components", "Kinds"]) for (const n of noteNames(folder)) notes[`${folder}/${n}`] = { fm: fm(`${folder}/${n}`) };
  const t = fakeBackground(notes);
  await t.bg.start();
  const index = t.bg.captureIndex();
  assert.deepEqual([...index.clashes.keys()], []);
  assert.deepEqual([...index.names.keys()].sort(), ["add", "bill", "chore", "decide", "did", "dose", "measure", "medb", "meds", "pack", "practice", "reading", "refill", "renew", "renewal", "rota", "saw-aurora", "spend", "task", "took-b", "took-meds", "trade", "tranche", "tripcost", "upkeep", "upkeep-paid", "weight"]);
  assert.equal(index.names.get("weight")?.app, "Vitals");
  assert.equal(index.names.get("measure")?.app, "Measurement");
  assert.equal(index.names.get("practice")?.app, "Practice");
  assert.equal(index.names.get("did")?.app, "Household chores");
  assert.equal(index.names.get("tranche")?.app, "Trades");
  assert.equal(index.names.get("spend")?.app, "Spend", "the kind owns the word; Budget and Trip planner save into it");
  for (const line of ["spend 14.5 food lunch", "weight 81.2", "practice 25", "meds", "task renew the passport", "pack charg", "did vacuum Sam rooms"]) {
    const r = await t.bg.capture(line);
    assert.equal(r.ok, true, `${line}: ${r.error ?? ""}`);
  }
  assert.deepEqual((listsIn(t.f.files.get("Kinds/Measurement data.md")?.fm)?.measurement as Record<string, unknown>[]).map((r) => [r.what, r.value]), [["weight", 81.2]]);
  assert.deepEqual(t.f.files.get("Apps/Practice data.md")?.fm?.practice, [{ value: 25, note: "", at: savedAt("2026-11-18T12:00") }]);
  assert.deepEqual(t.f.files.get("Apps/Trip planner data.md")?.fm?.packed, ["Chargers"]);
  assert.deepEqual((listsIn(t.f.files.get("Kinds/Chore data.md")?.fm)?.chore as Record<string, unknown>[]).map((r) => [r.task, r.who, r.area]), [["vacuum", "Sam", "rooms"]]);
  assert.deepEqual((listsIn(t.f.files.get("Kinds/Spend data.md")?.fm)?.spend as Record<string, unknown>[]).map((r) => [r.amount, r.category, r.note]), [[14.5, "food", "lunch"]]);
});
