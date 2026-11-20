import assert from "node:assert/strict";
import { test } from "node:test";
import { captureDate, captureTargets, captureTime, parseLine, type CaptureApp } from "../src/capture.ts";
import { readSpec } from "../src/spec.ts";
import { fakeBackground } from "./support/fakes.ts";

// Thursday 19 November 2026, 10:00.
const NOW = new Date(2026, 10, 19, 10, 0);

function app(path: string, fm: Record<string, unknown>): CaptureApp {
  const spec = readSpec(fm, { now: NOW, path })!.spec!;
  const shortcuts = new Map(spec.panels.filter((ps) => ps.panel.shortcut).map((ps) => [ps.panel.shortcut!, ps]));
  return { path, name: path.replace(/^.*\//, "").replace(/\.md$/, ""), shortcuts };
}

const BUDGET = app("Apps/Budget.md", {
  app: "b",
  panels: [{ view: "form", title: "Spent something", alias: "spend", save: "spend", fields: { amount: "number", category: ["food", "home", "transport", "fun", "other"], note: "text" } }],
});
const TRIP = app("Apps/Trip planner.md", {
  app: "t",
  panels: [{ view: "form", alias: "trip", save: "costs", fields: { item: "text", local: "number", on: "date", at: "time", paid: "checkbox" } }],
});
const MEDS = app("Apps/Medication log.md", { app: "m", panels: [{ view: "button", label: "Took meds", save: "doses", shortcut: "took-meds", alias: "meds" }] });
const PACK = app("Apps/Packing.md", { app: "p", panels: [{ view: "checklist", items: ["Passport", "Phone charger", "Power bank"], save: "packed", shortcut: "pack" }] });
const INDEX = captureTargets([BUDGET, TRIP, MEDS, PACK]);

const ok = (line: string) => {
  const r = parseLine(line, INDEX, NOW);
  assert.ok(r.ok, `${line}: ${"error" in r ? r.error : ""}`);
  return r;
};
const bad = (line: string) => {
  const r = parseLine(line, INDEX, NOW);
  assert.ok(!r.ok, `${line} should not parse`);
  return r;
};

test("values fill a form's fields in the order they're declared; the last text field takes the rest of the line", () => {
  assert.deepEqual(ok("spend 14.5 food lunch with Sam").params, { amount: "14.5", category: "food", note: "lunch with Sam" });
  assert.deepEqual(ok("SPEND 14.50 Fo").params, { amount: "14.5", category: "food" });
  assert.equal(ok("spend 14.5").next, "category: food, home, transport, fun, other");
});

test("a text field before others takes one word, or a quoted value; name=value fills any field", () => {
  assert.deepEqual(ok("trip coffee 4.5").params, { item: "coffee", local: "4.5" });
  assert.deepEqual(ok('trip "flat white" 4.5 yday 8am yes').params, { item: "flat white", local: "4.5", on: "2026-11-18", at: "08:00", paid: "true" });
  assert.deepEqual(ok('trip local=3 item="tram ticket"').params, { item: "tram ticket", local: "3" });
  assert.deepEqual(ok("spend note=parking 6 transport").params, { amount: "6", category: "transport", note: "parking" });
});

test("dates: words, offsets, weekdays and calendar dates, all from today", () => {
  const d = (w: string, next?: string) => captureDate(w, next, NOW)?.value;
  assert.equal(d("today"), "2026-11-19");
  assert.equal(d("yesterday"), "2026-11-18");
  assert.equal(d("yday"), "2026-11-18");
  assert.equal(d("tomorrow"), "2026-11-20");
  assert.equal(d("+14d"), "2026-12-03");
  assert.equal(d("-19d"), "2026-10-31");
  assert.equal(d("fri"), "2026-11-20");
  assert.equal(d("thursday"), "2026-11-26", "today's weekday is the next one, a week on");
  assert.equal(d("last", "thu"), "2026-11-12");
  assert.equal(d("last", "mon"), "2026-11-16");
  assert.equal(d("12-31"), "2026-12-31");
  assert.equal(d("2-29"), undefined, "2026 has no 29 February");
  assert.equal(d("2028-02-29"), "2028-02-29");
  assert.equal(d("2026-02-30"), undefined);
  assert.equal(d("someday"), undefined);
  assert.equal(captureDate("last", "thu", NOW)?.used, 2);
  // Across a month's end.
  assert.equal(captureDate("+1d", undefined, new Date(2026, 0, 31))?.value, "2026-02-01");
  assert.equal(captureDate("sun", undefined, new Date(2026, 11, 31))?.value, "2027-01-03");
});

test("times: 24-hour and am/pm", () => {
  assert.equal(captureTime("8:15"), "08:15");
  assert.equal(captureTime("08:15"), "08:15");
  assert.equal(captureTime("8am"), "08:00");
  assert.equal(captureTime("8:15pm"), "20:15");
  assert.equal(captureTime("12am"), "00:00");
  assert.equal(captureTime("12pm"), "12:00");
  assert.equal(captureTime("24:00"), undefined);
  assert.equal(captureTime("13pm"), undefined);
  assert.equal(captureTime("8"), undefined, "a bare number isn't a time");
});

test("a button takes nothing, a checklist the item to tick", () => {
  const meds = ok("meds");
  assert.equal(meds.params, undefined);
  assert.equal(meds.target.shortcut, "took-meds");
  assert.deepEqual(ok("pack phone").params, { item: "Phone charger" });
  assert.deepEqual(ok("pack item=passport").params, { item: "Passport" });
  assert.deepEqual(bad("meds now"), { ok: false, error: "meds takes no values", target: INDEX.names.get("meds"), completions: [] });
  const two = bad("pack p");
  assert.equal(!two.ok && two.error, "item “p” could be Passport or Phone charger or Power bank");
  assert.deepEqual(!two.ok && two.completions, ["Passport", "Phone charger", "Power bank"]);
});

test("nothing is guessed: each wrong value says what was expected, with what could be typed", () => {
  const cases: [string, string][] = [
    ["spend lots", "amount must be a number, not “lots”"],
    ["spend 5 groceries", "category must be one of food, home, transport, fun, other"],
    ["trip tea 2 someday", "on must be a date (today, yday, fri, last mon, 11-03, 2026-11-03), not “someday”"],
    ["trip tea 2 today 25:00", "at must be a time (8:15, 8am, 8:15pm), not “25:00”"],
    ["trip tea 2 today 8am maybe", "paid must be yes or no, not “maybe”"],
    ["trip tea 2 today 8am yes extra", "too many values: extra"],
    ["spend colour=red", "spend has no field “colour”; its fields are amount, category, note"],
    ["spend amount=1 amount=2", "amount is given twice"],
    ['spend 5 food "lunch', "a quote isn't closed"],
    ["spend", "type what spend saves, starting with amount"],
    ["sp 5", "no shortcut called “sp”"],
    ["", "type the name of a shortcut"],
  ];
  for (const [line, error] of cases) {
    const r = bad(line);
    assert.equal(!r.ok && r.error, error, line);
  }
  const sp = bad("sp 5");
  assert.deepEqual(!sp.ok && sp.completions, ["spend"]);
  const cat = bad("spend 5 f");
  assert.deepEqual(!cat.ok && cat.completions, ["food", "fun"]);
});

test("a shortcut's own name works while it's the only one in the vault; two apps sharing a name are both refused until one has an alias", () => {
  const inbox = app("Apps/Task inbox.md", { app: "i", panels: [{ view: "form", fields: { task: "text" }, save: "todo", shortcut: "add" }] });
  const errands = app("Apps/Errands.md", { app: "e", panels: [{ view: "form", fields: { item: "text" }, save: "items", shortcut: "add" }] });
  const alone = captureTargets([inbox]);
  assert.deepEqual(parseLine("add renew passport", alone, NOW), { ok: true, target: alone.names.get("add"), params: { task: "renew passport" }, next: undefined });
  const both = captureTargets([inbox, errands]);
  const r = parseLine("add milk", both, NOW);
  assert.equal(!r.ok && r.error, "“add” is a shortcut in Task inbox and Errands; give one of them an alias:");
  const aliased = app("Apps/Task inbox.md", { app: "i", panels: [{ view: "form", fields: { task: "text" }, save: "todo", shortcut: "add", alias: "task" }] });
  const fixed = captureTargets([aliased, errands]);
  assert.equal(fixed.names.get("add")?.app, "Errands");
  assert.equal(fixed.names.get("task")?.app, "Task inbox");
});

test("number and progress panels that answer aren't capture names", () => {
  const doses = app("Apps/Doses.md", { app: "d", panels: [{ view: "number", source: "doses", agg: "count", shortcut: "doses" }] });
  assert.equal(captureTargets([doses]).names.size, 0);
});

test("the background previews a line with a dry run, then runs it as the shortcut's command with those values", async () => {
  const t = fakeBackground({
    "Apps/Budget.md": { fm: { app: "b", panels: [{ view: "form", title: "Spent something", alias: "spend", save: "spend", fields: { amount: "number", category: ["food", "home"], note: "text" } }] } },
  });
  await t.bg.start();
  const preview = await t.bg.previewLine("spend 14.5 food lunch");
  assert.ok(preview.parsed.ok);
  assert.ok(preview.effects?.some((l) => l.includes("14.5") && l.includes("lunch")), preview.effects?.join("\n") ?? "");
  assert.equal(t.f.files.get("Apps/Budget data.md"), undefined, "a preview writes nothing");
  const ran = await t.bg.capture("spend 14.5 food lunch");
  assert.equal(ran.ok, true);
  assert.deepEqual(t.f.files.get("Apps/Budget data.md")?.fm?.spend, [{ amount: 14.5, category: "food", note: "lunch", at: "2026-11-18T12:00" }]);
  const [entry] = await t.activity.list("Apps/Budget.md");
  assert.equal(ran.entryId, entry.id);
  const wrong = await t.bg.capture("spend lots");
  assert.deepEqual([wrong.ok, wrong.error], [false, "amount must be a number, not “lots”"]);
});
