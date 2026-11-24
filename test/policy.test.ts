import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFlows, violationText, type FlowContext } from "../src/flows.ts";
import { formulaReads } from "../src/formula.ts";
import { permissionsOf } from "../src/permissions.ts";
import {
  clearance, hostLabel, isPolicyPath, noteLabels, policyHash, readPolicy, released, scopeLabels, type Policy,
} from "../src/policy.ts";
import { readSpec } from "../src/spec.ts";

const NOW = new Date(2026, 10, 19, 10, 0);

function policyOf(fm: Record<string, unknown>): Policy {
  const r = readPolicy(fm);
  assert.deepEqual(r.errors, []);
  return r.policy!;
}

const POLICY = policyOf({
  labels: {
    "Health/**": "private",
    "#finance": "private",
    "Apps/Budget data": { amount: "private" },
    "host:api.bank.example": "private",
  },
  sinks: { "api.open-meteo.com": "public", "openlibrary.org": "public", "api.notes.example": "personal" },
  release: [{ app: "Health/Meds", panel: "Doses today", to: ["pin"] }],
});

test("a policy reads its labels, places and exceptions; anything it can't read is an error, never left out", () => {
  assert.equal(POLICY.labels.length, 4);
  assert.deepEqual(POLICY.labels.map((r) => r.kind), ["glob", "tag", "note", "host"]);
  assert.equal(POLICY.typed, "public");
  const bad = readPolicy({
    labels: { "Health/": "secretive", "host:x.example": { a: "private" } },
    sinks: { lockscreen: "personal" },
    release: [{ app: "A", panel: "B" }, { app: "A", panel: "B", to: ["anywhere"] }],
    color: "blue",
  });
  assert.deepEqual(bad.errors, [
    'unknown key "color"; a policy has labels, sinks, release, typed',
    "labels: Health/ must be one of public, personal, private, secret",
    "labels: host:x.example takes one label, not fields",
    'sinks: "lockscreen" is neither a website nor one of notify, pin, answer, images, gizmod, share',
    "release 1 needs to: the places its value may go, e.g. [pin]",
    "release 2: to can name notify, pin, answer, images, gizmod, share, not anywhere",
  ]);
  assert.equal(bad.policy, undefined);
});

test("labels come from folders and globs, tags and their sub-tags, a note by name, and single fields; anything else is personal", () => {
  assert.equal(noteLabels(POLICY, "Health/Meds data.md").base, "private");
  assert.equal(noteLabels(POLICY, "Health/Visits/2026.md").base, "private");
  assert.equal(noteLabels(POLICY, "Projects/Tax return.md", ["#finance/tax"]).base, "private");
  assert.equal(noteLabels(POLICY, "Projects/Garden.md", ["#garden"]).base, "personal");
  const budget = noteLabels(POLICY, "Apps/Budget data.md");
  assert.deepEqual(budget, { base: "personal", fields: { amount: "private" } });
  const folder = policyOf({ labels: { "Journal/": "secret", "Daily": "private" } });
  assert.equal(noteLabels(folder, "Journal/2026/Nov.md").base, "secret");
  assert.equal(noteLabels(folder, "Notes/Daily.md").base, "private", "a note named without a folder matches it in any folder");
});

test("a scope's labels count every rule that could match a note there, tags anywhere", () => {
  assert.equal(scopeLabels(POLICY, "Health").base, "private");
  assert.equal(scopeLabels(POLICY, "Health/Visits").base, "private");
  assert.equal(scopeLabels(POLICY, "Projects").base, "private", "a note in Projects may carry #finance");
  const noTags = policyOf({ labels: { "Health/**": "private" } });
  assert.equal(scopeLabels(noTags, "Projects").base, "personal");
  assert.equal(scopeLabels(noTags, "").base, "private", "the whole vault holds Health");
});

test("places: notices, the status bar and answers take personal unless the policy says; websites only as listed", () => {
  assert.equal(clearance(POLICY, "notify"), "personal");
  assert.equal(clearance(POLICY, "images"), "public");
  assert.equal(clearance(POLICY, "api.open-meteo.com"), "public");
  assert.equal(clearance(POLICY, "example.org"), undefined);
  assert.equal(hostLabel(POLICY, "API.bank.example"), "private");
  assert.equal(released(POLICY, "Health/Meds.md", "Doses today", "pin"), true);
  assert.equal(released(POLICY, "Health/Meds.md", "Doses today", "notify"), false);
  assert.equal(released(POLICY, "Other/Meds.md", "Doses today", "pin"), false, "an app of the same name elsewhere isn't released");
});

test("a policy's fingerprint doesn't depend on the order its keys are written in", () => {
  const a = policyOf({ labels: { "Health/**": "private", "#finance": "private" }, sinks: { "a.example": "public" } });
  const b = policyOf({ sinks: { "a.example": "public" }, labels: { "Health/**": "private", "#finance": "private" } });
  assert.equal(policyHash(a), policyHash(b));
  const swapped = policyOf({ labels: { "#finance": "private", "Health/**": "private" }, sinks: { "a.example": "public" } });
  assert.equal(policyHash(a), policyHash(swapped), "nor on the order of its label lines");
  assert.notEqual(policyHash(a), policyHash(policyOf({ labels: { "Health/**": "secret" } })));
  assert.ok(isPolicyPath("Gizmo policy.md") && isPolicyPath("gizmo POLICY.md") && !isPolicyPath("Notes/Gizmo policy.md"));
});

test("a formula's result is made of the fields and the $names it reads", () => {
  assert.deepEqual(formulaReads("amount * rate + fee"), { fields: ["amount", "rate", "fee"], vars: [] });
  assert.deepEqual(formulaReads("round(trip.cost, 2)")?.fields, ["trip"]);
  assert.equal(formulaReads("field(name)")?.fields, "*");
  assert.deepEqual(formulaReads("close * $holding.shares"), { fields: ["close"], vars: [{ name: "holding", path: "shares" }] });
  assert.deepEqual(formulaReads("1 + 2"), { fields: [], vars: [] });
  assert.equal(formulaReads("1 +"), undefined);
});

// ---- Flows ---------------------------------------------------------------------------------------

/** Apps a `then` may run in these tests, and where their data is kept when not beside them. */
const TARGETS: Record<string, Record<string, unknown>> = {
  Errands: { app: "e", view: "form", fields: { errand: "text" }, save: "errands", shortcut: "add" },
  "Med log": { app: "m", view: "form", fields: { med: "text" }, save: "doses", shortcut: "log", notify: "Logged {med}" },
};
const TARGET_DATA: Record<string, string> = { "Med log": "Health/Med log data" };

function flows(path: string, fm: Record<string, unknown>, more: Partial<FlowContext> = {}, policy = POLICY) {
  const r = readSpec(fm, { now: NOW, path });
  assert.deepEqual(r?.errors, []);
  const spec = r!.spec!;
  const wanted = permissionsOf(spec, path);
  const ctx: FlowContext = {
    policy, appPath: path, dataPath: path.replace(/\.md$/, " data.md"), hostPath: path, tags: () => [],
    thenTarget: (app) => {
      const name = app.replace(/^\[\[|\]\]$/g, "");
      const fm = TARGETS[name];
      const spec = fm && readSpec(fm, { now: NOW, path: `Apps/${name}.md` })?.spec;
      return spec && { path: `Apps/${name}.md`, dataPath: `${TARGET_DATA[name] ?? `Apps/${name} data`}.md`, spec };
    },
    ...more,
  };
  const v = checkFlows(spec, wanted, ctx);
  return { ...v, wanted, lines: v.violations.map(violationText) };
}

test("a count from a Health app may go to a notice only when released; its own alert stays inside", () => {
  const meds = {
    app: "m",
    panels: [
      { view: "button", label: "Took meds", save: "doses", notify: "Dose logged" },
      { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", pin: "status" },
      { view: "number", title: "Doses this week", source: "doses", where: { at: "this week" }, agg: "count", pin: "status", alert: "< 7" },
    ],
  };
  const r = flows("Health/Meds.md", meds);
  assert.deepEqual(r.lines, [
    "Doses this week: Meds data (private) → a notice (personal)",
    "Doses this week: Meds data (private) → the status bar (personal)",
  ]);
  const elsewhere = flows("Apps/Meds.md", meds);
  assert.deepEqual(elsewhere.lines, []);
});

test("a request may carry a note's property only to a website cleared for its label; an unlisted one is asked, up to personal", () => {
  const trip = (host: string) => ({
    app: "t", view: "number", title: "Rain", source: `https://${host}/v1/forecast?lat=$this.lat&lon=$this.lon`, pick: "rain",
  });
  const listedPublic = flows("Trips/Tokyo.md", trip("api.open-meteo.com"));
  assert.deepEqual(listedPublic.lines, [
    "Rain: Tokyo.lat (personal) → api.open-meteo.com (public)",
    "Rain: Tokyo.lon (personal) → api.open-meteo.com (public)",
  ]);
  const listedPersonal = flows("Trips/Tokyo.md", trip("api.notes.example"));
  assert.deepEqual(listedPersonal.lines, []);
  assert.deepEqual(listedPersonal.covered.sort(), ["net:api.notes.example", "send:api.notes.example|this.lat", "send:api.notes.example|this.lon"]);
  const unlisted = flows("Trips/Tokyo.md", trip("weather.example"));
  assert.deepEqual(unlisted.lines, []);
  assert.deepEqual(unlisted.covered, []);
  assert.deepEqual(unlisted.asked, unlisted.wanted);
  const health = flows("Health/Visit.md", trip("weather.example"));
  assert.deepEqual(health.lines, [
    "Rain: Visit.lat (private) → weather.example (personal)",
    "Rain: Visit.lon (private) → weather.example (personal)",
  ]);
});

test("what you type goes as public to a listed website and asks nothing; reading notes is covered, writing still asks", () => {
  const finder = {
    app: "b", inputs: { q: "text" },
    panels: [
      { view: "table", title: "Results", source: "https://openlibrary.org/search.json?q=$q", pick: "docs" },
      { view: "table", title: "Shelf", source: "notes", from: "Books", edit: ["status"] },
    ],
  };
  const r = flows("Apps/Book finder.md", finder);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.covered.sort(), ["net:openlibrary.org", "read:Books", "send:openlibrary.org|typed.q"]);
  assert.deepEqual(r.asked, ["edit:Books"]);
});

test("a formula's column takes the label of what it reads, and a field that chooses rows raises the rows' label", () => {
  const budget = {
    app: "b",
    panels: [
      { view: "number", title: "Entries", source: "spend", agg: "count", pin: "status" },
      { view: "number", title: "Big ones", source: "spend", where: { amount: "> 100" }, agg: "count", pin: "status" },
      { view: "table", title: "Doubled", source: "spend", compute: { twice: "amount * 2", label: "upper(note)" }, action: "Copy", notify: "Saved {label}", save: "copies" },
      { view: "table", title: "Doubled money", source: "spend", compute: { twice: "amount * 2" }, action: "Copy", notify: "Saved {twice}", save: "copies" },
    ],
  };
  const r = flows("Apps/Budget.md", budget);
  // A copy keeps amount where amount is private already; twice, made from it, lands in a field nothing labels.
  assert.deepEqual(r.lines, [
    "Big ones: Budget data (private) → the status bar (personal)",
    "Doubled: Budget data: twice (private) → Budget data (personal)",
    "Doubled money: Budget data: twice (private) → a notice (personal)",
    "Doubled money: Budget data: twice (private) → Budget data (personal)",
  ]);
});

test("a picked row carries its panel's labels to the website it's sent to", () => {
  const visits = {
    app: "v",
    panels: [
      { view: "table", title: "Visits", source: "notes", from: "Health", select: "visit" },
      { view: "text", title: "Clinic", source: "https://api.notes.example/clinic?name=$visit.clinic", text: "{name}" },
    ],
  };
  const r = flows("Apps/Visits.md", visits);
  assert.deepEqual(r.lines, ["Clinic: the picked visit.clinic (private) → api.notes.example (personal)"]);
});

test("then may fill another app only with data no more private than that app's data note; copies into notes likewise", () => {
  const watch = {
    app: "w",
    panels: [
      { view: "number", title: "Due", source: "notes", from: "Health", alert: { due: "past" }, then: { app: "[[Errands]]", do: "add", fill: { errand: "Book {name}" } } },
      { view: "table", title: "Visits", source: "notes", from: "Health", action: "Copy", append: "Daily", line: "- {name}" },
      { view: "form", title: "Note", fields: { text: "text" }, append: "Health/Log", line: "- {text}" },
    ],
  };
  const r = flows("Apps/Watch.md", watch);
  assert.deepEqual(r.lines, [
    "Due: notes in Health (private) → a notice (personal)",
    "Due: notes in Health: name (private) → Errands (through then) (personal)",
    "Visits: notes in Health: name (private) → the note Daily (personal)",
  ]);
});

test("a website's answer to a request with a secret, or one the policy labels, is private", () => {
  const bank = {
    app: "b",
    panels: [
      { view: "number", title: "Balance", source: "https://api.bank.example/balance", pick: "amount", pin: "status" },
      { view: "number", title: "Rate", source: "https://api.rates.example/eur?key={secret:rates}", pick: "rate", pin: "status" },
      { view: "number", title: "Weather", source: "https://api.open-meteo.com/v1/x", pick: "t", pin: "status" },
    ],
  };
  const r = flows("Apps/Bank.md", bank);
  assert.deepEqual(r.lines, [
    "Balance: api.bank.example (private) → the status bar (personal)",
    "Rate: api.rates.example (private) → the status bar (personal)",
  ]);
  assert.ok(r.asked.includes("secret:rates") && r.asked.includes("net:api.bank.example"));
  assert.ok(r.covered.includes("net:api.open-meteo.com"));
});

test("a file's label is its own; a lens's $this is any note in its scope; a kit's panels are labelled as the app's", () => {
  const files = policyOf({ labels: { "Calendar/family.ics": "private", "Health/**": "private" } });
  const week = flows("Apps/Week.md", { app: "w", view: "number", title: "Next", source: "Calendar/family.ics", agg: "count", pin: "status" }, {}, files);
  assert.deepEqual(week.lines, ["Next: family.ics (private) → the status bar (personal)"]);
  const lens = readSpec({ app: "c", panels: [{ view: "text", title: "Clinic", source: "https://api.notes.example/c?n=$this.clinic", text: "{x}" }] }, { now: NOW, path: "Lens.md", host: { scope: "Health" } });
  assert.ok(lens?.spec);
  const v = checkFlows(lens.spec, permissionsOf(lens.spec, "Lens.md"), {
    policy: POLICY, appPath: "Lens.md", dataPath: "Lens data.md", hostPath: "Health/Dentist.md", lensScope: "Health", tags: () => [], thenTarget: () => undefined,
  });
  assert.deepEqual(v.violations.map(violationText), ["Clinic: notes in Health.clinic (private) → api.notes.example (personal)"]);
  const kit = { component: "Log", params: { what: "x" }, panels: [{ view: "number", title: "$what", source: "log", agg: "count", pin: "status" }] };
  const notes = { resolve: (l: string) => (l === "Kit" ? "Kit.md" : undefined), frontmatter: (p: string) => (p === "Kit.md" ? kit : undefined) };
  const r = readSpec({ app: "a", use: "[[Kit]]", with: { what: "Doses" } }, { now: NOW, notes, path: "Health/Doses.md" })!;
  assert.deepEqual(r.errors, []);
  const kv = checkFlows(r.spec!, permissionsOf(r.spec!, "Health/Doses.md"), {
    policy: POLICY, appPath: "Health/Doses.md", dataPath: "Health/Doses data.md", hostPath: "Health/Doses.md", tags: () => [], thenTarget: () => undefined,
  });
  assert.deepEqual(kv.violations.map(violationText), ["Doses: Doses data (private) → the status bar (personal)"]);
});

test("a then can't pass private data on through another app: what that app saves, tells or adds is checked as if sent from here", () => {
  const watch = {
    app: "w",
    panels: [{ view: "number", title: "Due", source: "notes", from: "Health", alert: { due: "past" }, then: { app: "[[Med log]]", do: "log", fill: { med: "{med}" } } }],
  };
  const r = flows("Apps/Watch.md", watch, {}, policyOf({ labels: { "Health/**": "private" }, release: [{ app: "Apps/Watch", panel: "Due", to: ["notify"] }] }));
  // Med log keeps its data in Health, so saving there is fine; its notice isn't.
  assert.deepEqual(r.lines, ["Due: notes in Health: med (private) → a notice from Med log (through then) (personal)"]);
});

test("a note's property or a picked row read in a notice, a line, a row or a formula carries its label", () => {
  const lens = flows("Apps/Lens.md", {
    app: "l",
    panels: [
      { view: "button", title: "Took", label: "Took", notify: "Took $this.med", save: "doses" },
      { view: "button", title: "Logged", label: "Log", append: "Daily", line: "- $this.med" },
    ],
  }, { hostPath: "Health/Meds.md" });
  assert.deepEqual(lens.lines, [
    "Took: Meds.med (private) → a notice (personal)",
    "Logged: Meds.med (private) → the note Daily (personal)",
  ]);
  const holdings = flows("Apps/Holdings.md", {
    app: "h",
    panels: [
      { view: "table", title: "Positions", source: "notes", from: "Health", select: "position" },
      { view: "table", title: "Value", source: "https://api.open-meteo.com/q", compute: { value: "close * $position.shares" }, action: "Tell", notify: "Worth {value}" },
    ],
  });
  assert.deepEqual(holdings.lines, ["Value: api.open-meteo.com: value (private) → a notice (personal)"]);
});

test("what the apps ask is the vault's: a policy holds its rows to what the most private note may go to", () => {
  const today = { app: "t", panels: [{ view: "number", title: "To do", source: "asks", agg: "count", pin: "status" }, { view: "table", title: "Asks", source: "asks", action: "Copy", append: "Daily", line: "- {text}" }] };
  const r = flows("Today.md", today);
  assert.deepEqual(r.wanted, ["write:Daily.md"], "reading it asks for nothing, as view: alerts doesn't");
  assert.deepEqual(r.lines, [
    "To do: what the apps ask (private) → the status bar (personal)",
    "Asks: what the apps ask: text (private) → the note Daily (personal)",
  ]);
});

test("a file source carries the label of the file it names, as a link too; one that isn't the file's path from the vault's root is an error", () => {
  const app = (source: string) => ({ app: "x", panels: [{ view: "number", title: "Total", source, field: "n", agg: "sum", shortcut: "total" }] });
  for (const source of ["Health/export.csv", "[[Health/export.csv]]", "[[Health/export.csv|Mine]]"]) {
    const v = flows("Apps/X.md", app(source));
    assert.deepEqual(v.lines, ["Total: export.csv.n (private) → a link's answer (personal)"], source);
    assert.ok(v.wanted.includes("read:Health/export.csv"), source);
  }
  // Another spelling of the path would be read as that file and labelled as some other.
  for (const source of ["./Health/export.csv", "Apps/../Health/export.csv", "/Health/export.csv", "Health//export.csv"]) {
    const errors = readSpec(app(source), { now: NOW, path: "Apps/X.md" })?.errors ?? [];
    assert.ok(errors.some((e) => e.includes("source must be the file's path from the vault's root")), `${source}: ${errors.join("; ")}`);
  }
});
