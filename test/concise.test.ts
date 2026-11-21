import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import type { NoteReader } from "../src/expand.ts";
import { LensIndex, LensStack } from "../src/lenses.ts";
import { readComponentPreview, readSpec } from "../src/spec.ts";
import { askersOf, permissionsOf } from "../src/permissions.ts";
import { fakeBackground, fakeEnv, savedAt } from "./support/fakes.ts";
import { parseYaml, vaultNote } from "./support/yaml.ts";

// The Decision journal written short (Apps/Decisions), the same app as a kit (Components/Decision
// kit) used three lines long for another folder (Apps/Bets), and its lens (Components/Decision
// review), proved on a fake vault whose clock reads Wednesday 18 November 2026, 12:00. The long
// version is kept below, so the short one can be shown to draw the same panels.

type Notes = Parameters<typeof fakeEnv>[0];

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const event = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const click = (el: Element) => event(el, "click");
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  event(select, "change");
};
const type = (input: Element, value: string) => {
  (input as HTMLInputElement).value = value;
  event(input, "change");
};

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** The notes in a folder of the test vault, with their frontmatter and body. */
function folder(name: string): Notes {
  const names = readdirSync(new URL(`./vault/${name}`, import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => {
    const { fm, body } = vaultNote(`${name}/${n}`);
    return [`${name}/${n}`, { fm, body }];
  }));
}

const NOTES = ["Apps/Decisions.md", "Apps/Bets.md", "Components/Decision kit.md", "Components/Decision review.md"];
const vault = (): Notes => ({
  ...Object.fromEntries(NOTES.map((p) => [p, { fm: vaultNote(p).fm }])),
  ...folder("Decisions"),
  ...folder("Bets"),
});

const reader: NoteReader = {
  resolve: (link) => NOTES.find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
  frontmatter: (path) => vaultNote(path).fm,
};

/** The Decision journal as first written, in full: about a hundred lines of keys. */
const LONG = parseYaml(`app: Write down a decision before I know how it turns out, score it later, and see how often I'm right
data:
  decisions:
    source: notes
    from: Decisions
    fields:
      outcome: [open, right, wrong]
      learned: text
      review: date
    compute:
      hit: if(outcome == "right", 1, 0)
      said: confidence / 100
panels:
  - view: form
    title: A decision I'm making
    fields:
      decision: text
      expect: text
      confidence: [60, 70, 80, 90, 95]
      review: date
    save: Decisions/
    name: "{decision}"
    row:
      expect: "{expect}"
      confidence: "{confidence}"
      review: "{review}"
      made: "{date}"
      outcome: open
    label: Write it down
    notify: Written down. Come back on {review} to score it.
    shortcut: decide
  - view: number
    title: Ready to score
    source: decisions
    where: {outcome: open, review: past}
    label: decisions whose day has come
    alert: "> 0"
    pin: status
  - view: number
    title: Right so far
    source: decisions
    where: {outcome: "!= open"}
    field: hit
    agg: avg
    format: "0%"
    label: of the decisions I've scored
  - view: table
    tab: Score
    span: 4
    title: How did these turn out?
    source: decisions
    where: {outcome: open, review: past}
    sort: review
    columns: [name, expect, confidence, review, outcome, learned]
    edit: [outcome, learned]
    format: {review: relative}
    labels: {name: Decision, expect: I expected, confidence: "% sure", review: Due, outcome: It went, learned: What I learned}
  - view: timeline
    tab: Waiting
    span: 4
    title: Still waiting to find out
    source: decisions
    where: {outcome: open}
    sort: review
    start: made
    end: review
    item: "{name}"
    select: pick
  - view: text
    tab: Waiting
    span: 3
    title: The one I picked
    text: "$pick.name. I expected: $pick.expect ($pick.confidence% sure). I'll know by $pick.review."
  - view: button
    tab: Waiting
    label: Open its note
    open: $pick.path
  - view: bar
    tab: Track record
    span: 2
    title: How sure I said I was, and how often I was right
    source: decisions
    where: {outcome: "!= open"}
    group: confidence
    y: [said, hit]
    agg: avg
    format: "0%"
    labels: {said: I said, hit: I was right, confidence: "% sure"}
  - view: table
    tab: Track record
    span: 2
    title: Scored
    source: decisions
    where: {outcome: "!= open"}
    sort: -review
    columns: [name, confidence, outcome, learned]
    edit: [learned]
    labels: {name: Decision, confidence: "% sure", outcome: It went, learned: What I learned}`) as Record<string, unknown>;

/** Opens an app note of the fake vault as its tab would. */
function open(path: string, notes: Notes = vault()) {
  const t = fakeEnv(notes);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, path, t.env);
  started.push(app);
  app.load();
  const panel = (title: string) => [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-title")) === title)!;
  const tab = (name: string) => click([...root.querySelectorAll("button.gz-tab")].find((b) => text(b) === name)!);
  return { ...t, root, panel, tab };
}

// ---- Every note reads, and asks for exactly this ---------------------------------------------------

test("Decisions, Bets, the kit and the lens read without problems and ask for exactly their folder", () => {
  const decisions = readSpec(vaultNote("Apps/Decisions.md").fm, { path: "Apps/Decisions.md", notes: reader })!;
  assert.deepEqual(decisions.errors, []);
  assert.deepEqual(permissionsOf(decisions.spec!, "Apps/Decisions.md"), ["create:Decisions", "edit:Decisions", "read:Decisions"]);
  assert.deepEqual(decisions.spec!.panels.map((ps) => ps.panel.tab), [undefined, undefined, undefined, "Score", "Waiting", "Track record", "Track record"]);

  const bets = readSpec(vaultNote("Apps/Bets.md").fm, { path: "Apps/Bets.md", notes: reader })!;
  assert.deepEqual(bets.errors, []);
  assert.deepEqual(Object.keys(vaultNote("Apps/Bets.md").fm), ["app", "use", "with"]);
  assert.deepEqual(permissionsOf(bets.spec!, "Apps/Bets.md"), ["create:Bets", "edit:Bets", "read:Bets"]);
  for (const [perm, who] of askersOf(bets.spec!, "Apps/Bets.md")) assert.deepEqual([...who], ["Components/Decision kit.md"], perm);

  const kit = readComponentPreview(vaultNote("Components/Decision kit.md").fm, { path: "Components/Decision kit.md", notes: reader });
  assert.deepEqual([kit.result.errors, kit.missing], [[], []]);
  assert.deepEqual(permissionsOf(kit.result.spec!, "Components/Decision kit.md"), ["create:Decisions", "edit:Decisions", "read:Decisions"]);

  const lens = readComponentPreview(vaultNote("Components/Decision review.md").fm, { path: "Components/Decision review.md", notes: reader });
  assert.deepEqual([lens.result.errors, lens.lens], [[], "Decisions"]);
  assert.deepEqual(permissionsOf(lens.result.spec!, "Components/Decision review.md"), ["edit:Decisions"]);

  const long = readSpec(LONG, { path: "Apps/Decision journal.md" })!;
  assert.deepEqual(long.errors, []);
  assert.deepEqual(permissionsOf(long.spec!, "Apps/Decision journal.md"), permissionsOf(decisions.spec!, "Apps/Decisions.md"));
});

// ---- Decisions, driven -------------------------------------------------------------------------------

test("Decisions: the due decision is counted, scored in place from the dropdown, and leaves the count", async () => {
  const app = open("Apps/Decisions.md");
  await settle();
  assert.equal(app.root.querySelectorAll(".gz-error").length, 0);
  assert.deepEqual([...app.root.querySelectorAll("button.gz-tab")].map(text), ["Score", "Waiting", "Track record"]);
  assert.equal(text(app.panel("Ready to score").querySelector(".gz-big")), "1");
  assert.equal(text(app.panel("Right so far").querySelector(".gz-big")), "57%");
  const score = app.panel("How did these turn out?");
  assert.deepEqual([...score.querySelectorAll("th")].map(text), ["Decision", "I expected", "% sure", "Due", "It went", "What I learned"]);
  const row = score.querySelector("tbody tr")!;
  assert.equal(text(row.querySelector("td")), "Switch to the cheaper phone plan");
  assert.equal(text(row.querySelectorAll("td")[3]), "3 days ago");
  // What I learned first: once it has an outcome it is no longer waiting, and leaves the table.
  type(row.querySelector("input")!, "The basement has signal after all");
  await settle();
  choose(app.panel("How did these turn out?").querySelector("tbody tr select")!, "right");
  await settle();
  assert.deepEqual(app.f.files.get("Decisions/Switch to the cheaper phone plan.md")!.fm, {
    expect: "Coverage is just as good at home and at work", confidence: 80, made: "2026-10-20", review: "2026-11-15",
    outcome: "right", learned: "The basement has signal after all",
  });
  assert.equal(text(app.panel("Ready to score").querySelector(".gz-big")), "0");
  assert.equal(text(app.panel("Right so far").querySelector(".gz-big")), "63%");
  assert.equal(text(app.panel("How did these turn out?").querySelector(".gz-empty")), "Nothing here yet.");
});

test("Decisions: the form writes a decision note with a number, outcome open and today's date", async () => {
  const app = open("Apps/Decisions.md");
  await settle();
  const form = app.panel("A decision I'm making");
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["Decision", "I expected", "% sure", "Due"]);
  const [name, expect] = form.querySelectorAll("input");
  (name as HTMLInputElement).value = "Walk to work in winter";
  (expect as HTMLInputElement).value = "I keep it up through January";
  for (const o of form.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "70");
  (form.querySelector('input[type="date"]') as HTMLInputElement).value = "2027-02-01";
  form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(app.f.files.get("Decisions/Walk to work in winter.md")!.fm, {
    expect: "I keep it up through January", confidence: 70, review: "2027-02-01", outcome: "open", made: "2026-11-18", at: savedAt("2026-11-18T12:00"),
  });
  assert.ok(app.notices.includes("Written down. Come back on 2027-02-01 to score it."), app.notices.join("; "));
  app.tab("Waiting");
  assert.ok([...app.panel("Still waiting to find out").querySelectorAll(".gz-tl-label")].map(text).includes("Walk to work in winter"));
});

test("Decisions: picking a decision on the timeline shows what I expected, with a link to its note", async () => {
  const app = open("Apps/Decisions.md");
  await settle();
  app.tab("Waiting");
  const timeline = app.panel("Still waiting to find out");
  assert.deepEqual([...timeline.querySelectorAll(".gz-tl-label")].map(text), [
    "Switch to the cheaper phone plan", "Skip the extended warranty on the laptop", "Start running three mornings a week",
  ]);
  click(timeline.querySelectorAll(".gz-tl-bar")[2]);
  const detail = timeline.querySelector(".gz-detail")!;
  assert.equal(text(detail.querySelector(".gz-detail-text")),
    "Start running three mornings a week. I expected: I'm still doing it in February (60% sure). I'll know by 2027-02-09.");
  click(detail.querySelector("a")!);
  assert.deepEqual(app.opened, ["Decisions/Start running three mornings a week.md"]);
});

test("Decisions: the track record charts what I said against how often I was right, and scored ones stay editable", async () => {
  const app = open("Apps/Decisions.md");
  await settle();
  app.tab("Track record");
  const chart = app.panel("How sure I said I was, and how often I was right");
  assert.deepEqual([...chart.querySelectorAll(".gz-legend-name")].map(text), ["I said", "I was right"]);
  assert.equal(chart.querySelectorAll("path.gz-bar").length, 8, "four levels of sure, each with what I said and how often I was right");
  const scored = app.panel("Scored");
  assert.deepEqual([...scored.querySelectorAll("thead th")].map(text), ["Decision", "% sure", "It went", "What I learned"]);
  assert.equal(scored.querySelectorAll("tbody tr:not(.gz-ledger-group)").length, 7);
  const book = [...scored.querySelectorAll("tbody tr:not(.gz-ledger-group)")].find((tr) => text(tr.querySelector("td")) === "Book the flights four months ahead")!;
  assert.equal(book.querySelectorAll("select").length, 2, "edit: true edits confidence and outcome");
  type(book.querySelector("input")!, "Book earlier still");
  await settle();
  assert.equal(app.f.files.get("Decisions/Book the flights four months ahead.md")!.fm!.learned, "Book earlier still");
});

test("Decisions: the decide shortcut writes a note from a link, with the defaults the form doesn't show", async () => {
  const bg = fakeBackground(vault());
  await bg.bg.start();
  await bg.bg.runUri({ app: "Decisions", do: "decide", name: "Fix the bike myself", expect: "It rides by Saturday", confidence: "90", review: "2026-11-21" });
  await settle();
  assert.deepEqual(bg.f.files.get("Decisions/Fix the bike myself.md")!.fm, {
    expect: "It rides by Saturday", confidence: 90, review: "2026-11-21", outcome: "open", made: "2026-11-18", at: savedAt("2026-11-18T12:00"),
  });
  assert.ok(bg.notices.includes("Written down. Come back on 2026-11-21 to score it."), bg.notices.join("; "));
  bg.bg.stop();
});

// ---- Bets: the kit in another folder --------------------------------------------------------------

test("Bets: the kit runs on Bets, counts and writes there, and leaves Decisions alone", async () => {
  const app = open("Apps/Bets.md");
  await settle();
  assert.equal(app.root.querySelectorAll(".gz-error").length, 0);
  assert.equal(text(app.root.querySelector(".gz-description")), "Bets I've made with friends, scored when we find out who was right");
  assert.equal(text(app.panel("Bets to score").querySelector(".gz-big")), "0");
  assert.equal(text(app.panel("Right so far").querySelector(".gz-big")), "100%");
  const form = app.panel("Before I know");
  const [name, expect] = form.querySelectorAll("input");
  (name as HTMLInputElement).value = "Alex is late to the party";
  (expect as HTMLInputElement).value = "Alex turns up after nine";
  for (const o of form.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "60");
  form.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.deepEqual(app.f.files.get("Bets/Alex is late to the party.md")!.fm, {
    expect: "Alex turns up after nine", confidence: 60, review: "2026-11-18", outcome: "open", made: "2026-11-18", at: savedAt("2026-11-18T12:00"),
  });
  assert.ok(![...app.f.files.keys()].some((p) => p.startsWith("Decisions/Alex")));
  // Due today, it is ready to score.
  assert.equal(text(app.panel("Bets to score").querySelector(".gz-big")), "1");
});

// ---- The lens --------------------------------------------------------------------------------------

test("the Decision review lens shows on a decision note, reads it back, and saves how it went", async () => {
  const t = fakeEnv(vault());
  const index = new LensIndex(t.data);
  assert.deepEqual(index.lensesFor("Decisions/Switch to the cheaper phone plan.md"), ["Components/Decision review.md"]);
  assert.deepEqual(index.lensesFor("Bets/The corner bakery is still open in 2030.md"), []);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const stack = new LensStack(el, index, () => t.env, { folded: () => false, setFolded: () => {} });
  started.push(stack);
  stack.show("Decisions/Switch to the cheaper phone plan.md");
  await settle();
  assert.equal(text(el.querySelector(".gz-view-text .gz-text")), "I expect: Coverage is just as good at home and at work (80% sure). Due 2026-11-15.");
  const form = el.querySelector("form.gz-form")!;
  assert.deepEqual([...form.querySelectorAll(".gz-field > span")].map(text), ["It went", "What I learned", "Due"]);
  choose(form.querySelector("select")!, "wrong");
  await settle();
  const fm = t.f.files.get("Decisions/Switch to the cheaper phone plan.md")!.fm!;
  assert.equal(fm.outcome, "wrong");
  assert.equal(text(el.querySelector(".gz-view-text .gz-text")), "I expected: Coverage is just as good at home and at work (80% sure). It went wrong.");
});

// ---- The short version is the long one -----------------------------------------------------------

/** What a panel shows: its text, with each field as the value it holds and each dropdown as its choice. */
function shown(el: Element): string {
  const values = [...el.querySelectorAll("input, textarea")].map((i) => (i as HTMLInputElement).value ?? "");
  const clone = el.cloneNode(true) as Element;
  for (const select of clone.querySelectorAll("select")) {
    const picked = [...select.querySelectorAll("option")].find((o) => o.hasAttribute("selected")) ?? select.querySelector("option");
    select.replaceWith(clone.ownerDocument.createTextNode(text(picked)));
  }
  [...clone.querySelectorAll("input, textarea")].forEach((input, i) => input.replaceWith(clone.ownerDocument.createTextNode(values[i])));
  return text(clone).replace(/\s+/g, " ").trim();
}

/** The cells of a table panel, row by row, with fields as values. */
const cells = (el: Element) => [...el.querySelectorAll("tr:not(.gz-ledger-group)")].map((tr) => [...tr.querySelectorAll("th, td")].map(shown));

test("the short Decisions draws what the long Decision journal draws, over the same notes", async () => {
  const notes = vault();
  const long = open("Apps/Decision journal.md", { ...notes, "Apps/Decision journal.md": { fm: LONG } });
  const short = open("Apps/Decisions.md", structuredClone(notes));
  await settle();
  assert.deepEqual([long, short].map((a) => [...a.root.querySelectorAll("button.gz-tab")].map(text)), [["Score", "Waiting", "Track record"], ["Score", "Waiting", "Track record"]]);
  for (const title of ["Ready to score", "Right so far"]) assert.equal(shown(short.panel(title)), shown(long.panel(title)), title);
  // Scoring shows each decision exactly as the long one does, column for column.
  const [longScore, shortScore] = [long, short].map((a) => cells(a.panel("How did these turn out?")));
  assert.deepEqual(shortScore, longScore);
  assert.deepEqual(shortScore[0], ["Decision", "I expected", "% sure", "Due", "It went", "What I learned"]);
  assert.equal(shortScore.length, 2);
  for (const a of [long, short]) a.tab("Waiting");
  const [longLine, shortLine] = [long, short].map((a) => a.panel("Still waiting to find out"));
  assert.deepEqual([...shortLine.querySelectorAll(".gz-tl-label")].map(text), [...longLine.querySelectorAll(".gz-tl-label")].map(text));
  click(longLine.querySelectorAll(".gz-tl-bar")[2]);
  click(shortLine.querySelectorAll(".gz-tl-bar")[2]);
  await settle();
  const picked = text(long.panel("The one I picked").querySelector(".gz-text"));
  assert.match(picked, /^Start running three mornings a week\. I expected: /);
  assert.equal(text(short.panel("Still waiting to find out").querySelector(".gz-detail-text")), picked);
  click([...long.root.querySelectorAll("button")].find((b) => text(b) === "Open its note")!);
  click(short.panel("Still waiting to find out").querySelector(".gz-detail a")!);
  assert.deepEqual([short.opened, long.opened], [["Decisions/Start running three mornings a week.md"], ["Decisions/Start running three mornings a week.md"]]);
  for (const a of [long, short]) a.tab("Track record");
  const chart = "How sure I said I was, and how often I was right";
  assert.equal(shown(short.panel(chart)), shown(long.panel(chart)));
  assert.deepEqual(cells(short.panel("Scored")), cells(long.panel("Scored")));
});
