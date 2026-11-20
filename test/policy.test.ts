import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFlows, violationText, type FlowContext } from "../src/flows.ts";
import { fieldsRead } from "../src/formula.ts";
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
    'sinks: "lockscreen" is neither a website nor one of notify, pin, answer, images, gizmod',
    "release 1 needs to: the places its value may go, e.g. [pin]",
    "release 2: to can name notify, pin, answer, images, gizmod, not anywhere",
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
  assert.notEqual(policyHash(a), policyHash(policyOf({ labels: { "Health/**": "secret" } })));
  assert.ok(isPolicyPath("Gizmo policy.md") && isPolicyPath("gizmo POLICY.md") && !isPolicyPath("Notes/Gizmo policy.md"));
});

test("a formula's result is made of the fields it reads", () => {
  assert.deepEqual(fieldsRead("amount * rate + fee"), ["amount", "rate", "fee"]);
  assert.deepEqual(fieldsRead("round(trip.cost, 2)"), ["trip"]);
  assert.equal(fieldsRead("field(name)"), "*");
  assert.deepEqual(fieldsRead("1 + 2"), []);
  assert.equal(fieldsRead("1 +"), undefined);
});

// ---- Flows ---------------------------------------------------------------------------------------

function flows(path: string, fm: Record<string, unknown>, more: Partial<FlowContext> = {}, policy = POLICY) {
  const r = readSpec(fm, { now: NOW, path });
  assert.deepEqual(r?.errors, []);
  const spec = r!.spec!;
  const wanted = permissionsOf(spec, path);
  const ctx: FlowContext = {
    policy, appPath: path, dataPath: path.replace(/\.md$/, " data.md"), hostPath: path, tags: () => [],
    thenData: (app) => `Apps/${app.replace(/^\[\[|\]\]$/g, "")} data.md`, ...more,
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
    "panel 3: Meds data (private) → a notice (personal)",
    "panel 3: Meds data (private) → the status bar (personal)",
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
    "panel 2: Budget data (private) → the status bar (personal)",
    "panel 3: Budget data: twice (private) → Budget data (personal)",
    "panel 4: Budget data: twice (private) → a notice (personal)",
    "panel 4: Budget data: twice (private) → Budget data (personal)",
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
  assert.deepEqual(r.lines, ["panel 2: the picked visit.clinic (private) → api.notes.example (personal)"]);
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
    "panel 1: notes in Health (private) → a notice (personal)",
    "panel 1: notes in Health: name (private) → Errands data (through then) (personal)",
    "panel 2: notes in Health: name (private) → the note Daily (personal)",
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
    "panel 1: api.bank.example (private) → the status bar (personal)",
    "panel 2: api.rates.example (private) → the status bar (personal)",
  ]);
  assert.ok(r.asked.includes("secret:rates") && r.asked.includes("net:api.bank.example"));
  assert.ok(r.covered.includes("net:api.open-meteo.com"));
});
