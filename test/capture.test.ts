import assert from "node:assert/strict";
import { test } from "node:test";
import { captureDate, captureLine, captureTargets, captureTime, completed, parseFields, parseLine, receipt, type CaptureApp } from "../src/capture.ts";
import { readSpec } from "../src/spec.ts";
import { fakeBackground, savedAt } from "./support/fakes.ts";

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
  const sp = bad("sp");
  assert.deepEqual(!sp.ok && sp.completions, ["spend"]);
  const typedOn = bad("sp 5");
  assert.deepEqual(!typedOn.ok && typedOn.completions, [], "past the name, names aren't offered for the last word");
  const cat = bad("spend 5 f");
  assert.deepEqual(!cat.ok && cat.completions, ["food", "fun"]);
});

// ---- The fields alone: the Do… command's strict read, and an add line's loose one --------------------

const SPEND: [string, string | string[]][] = [["amount", "number"], ["category", ["food", "home", "transport", "fun", "other"]], ["note", "text"]];
const COSTS: [string, string | string[]][] = [["item", "text"], ["local", "number"], ["on", "date"], ["at", "time"]];
const loose = (line: string, fields = SPEND) => parseFields(line, fields, NOW, { name: "spend", loose: true });

test("read strictly, the fields are read as the Do… command reads them", () => {
  assert.deepEqual(parseFields("14.5 food lunch with Sam", SPEND, NOW, { name: "spend" }), {
    params: { amount: "14.5", category: "food", note: "lunch with Sam" }, missing: [], errors: [], completions: [],
  });
  const lunch = parseFields("lunch 12", SPEND, NOW, { name: "spend" });
  assert.deepEqual(lunch.errors, ["amount must be a number, not “lunch”"]);
  assert.equal(lunch.next, "amount: a number");
  assert.deepEqual(parseFields("14.5", SPEND, NOW, { name: "spend" }).missing, ["category", "note"]);
});

test("read loosely, a number goes to the number field wherever it is on the line, and the words left over to the text field", () => {
  assert.deepEqual(loose("lunch with Sam 14.50").params, { amount: "14.5", note: "lunch with Sam" });
  assert.deepEqual(loose("lunch 14.50 with Sam").params, { amount: "14.5", note: "lunch with Sam" }, "words keep their order");
  assert.deepEqual(loose("lunch 14.50 with Sam").missing, ["category"]);
  assert.deepEqual(loose("2 coffees 6").params, { amount: "2", note: "coffees 6" }, "a second number has no field left, so it is text");
  assert.deepEqual(loose("").params, {});
  assert.deepEqual(loose("").missing, ["amount", "category", "note"]);
});

test("read loosely, a choice is found anywhere, in full or by 3 letters or more of only one of them", () => {
  assert.deepEqual(loose("bus pass 2.90 tra").params, { amount: "2.9", category: "transport", note: "bus pass" });
  assert.deepEqual(loose("FUN 20").params, { amount: "20", category: "fun" });
  assert.deepEqual(loose("foo 3").params, { amount: "3", category: "food" });
  assert.deepEqual(loose("fo 3").params, { amount: "3", note: "fo" }, "two letters are text when there is a text field");
  assert.deepEqual(loose("3 fo", [["amount", "number"], ["category", ["food", "home"]]]).params, { amount: "3", category: "food" }, "with no text field, a short start still picks the only choice");
  assert.deepEqual(loose("3 hom", [["amount", "number"], ["category", ["home", "homework"]], ["note", "text"]]).params, { amount: "3", note: "hom" }, "a start two choices share is text");
  assert.deepEqual(loose('"to read" 3', [["page", "number"], ["status", ["to read", "reading", "done"]]]).params, { page: "3", status: "to read" });
});

test("read loosely, dates and times take their words, name= fills a field, and quoted values fill the text fields in order", () => {
  assert.deepEqual(loose("coffee yday 4.5 8am", COSTS).params, { item: "coffee", local: "4.5", on: "2026-11-18", at: "08:00" });
  assert.deepEqual(loose("last mon tram 3", COSTS).params, { item: "tram", local: "3", on: "2026-11-16" });
  assert.deepEqual(loose("note=parking 6 transport").params, { amount: "6", category: "transport", note: "parking" });
  assert.deepEqual(loose('"flat white" 4.5', COSTS).params, { item: "flat white", local: "4.5" });
  const two: [string, string | string[]][] = [["name", "text"], ["expect", "text"], ["sure", ["60", "70", "80"]], ["due", "date"]];
  assert.deepEqual(loose('"Take the job" "It works out" 80 fri', two).params, { name: "Take the job", expect: "It works out", sure: "80", due: "2026-11-20" });
  assert.deepEqual(loose("Take the job 80", two).params, { name: "Take the job", sure: "80" });
});

test("read loosely, what can't be read says why, and nothing it can't place is dropped", () => {
  assert.deepEqual(loose("lots", [["weight", "number"]]).errors, ["weight must be a number, not “lots”"]);
  assert.deepEqual(loose("80 81", [["weight", "number"]]).errors, ["too many values: 81"]);
  assert.deepEqual(loose("colour=red 5").errors, ["spend has no field “colour”; its fields are amount, category, note"]);
  assert.deepEqual(loose("colour=red 5").params, { amount: "5" }, "the rest of the line is still read");
  assert.deepEqual(loose("amount=lots").errors, ["amount must be a number, not “lots”"]);
  assert.deepEqual(loose('5 "lunch').errors, ["a quote isn't closed"]);
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

test("an alias of several words is matched as the longest name the line starts with, in any case", () => {
  const hr = app("Apps/Heart.md", { app: "h", panels: [{ view: "form", alias: "Resting heart rate", save: "hr", fields: { bpm: "number" } }] });
  const rest = app("Apps/Rest.md", { app: "r", panels: [{ view: "form", alias: "resting", save: "naps", fields: { minutes: "number" } }] });
  const index = captureTargets([hr, rest]);
  const a = parseLine("Resting Heart Rate 55", index, NOW);
  assert.ok(a.ok && a.target.app === "Heart" && a.params?.bpm === "55", JSON.stringify(a));
  const b = parseLine("resting 20", index, NOW);
  assert.ok(b.ok && b.target.app === "Rest" && b.params?.minutes === "20", JSON.stringify(b));
  const c = parseLine("resting heart", index, NOW);
  assert.equal(!c.ok && c.error, "minutes must be a number, not “heart”");
});

test("name= finds a field in any case and keeps the form's spelling; a line with a line break is refused", () => {
  const caps = app("Apps/Caps.md", { app: "c", panels: [{ view: "form", alias: "spend", save: "s", fields: { Amount: "number", Note: "text" } }] });
  const index = captureTargets([caps]);
  const r = parseLine("spend amount=5 NOTE=lunch", index, NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.params, { Amount: "5", Note: "lunch" });
  const broken = parseLine("spend 5 buy milk\nignore this", index, NOW);
  assert.equal(!broken.ok && broken.error, "a capture line is one line");
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
  assert.deepEqual(t.f.files.get("Apps/Budget data.md")?.fm?.spend, [{ amount: 14.5, category: "food", note: "lunch", at: savedAt("2026-11-18T12:00") }]);
  const [entry] = await t.activity.list("Apps/Budget.md");
  assert.equal(ran.entryId, entry.id);
  const wrong = await t.bg.capture("spend lots");
  assert.deepEqual([wrong.ok, wrong.error], [false, "amount must be a number, not “lots”"]);
});

test("taking a completion replaces the last word and leaves a space for the next; one with spaces is quoted", () => {
  assert.equal(completed("spend 5 f", "food"), "spend 5 food ");
  assert.equal(completed("sp", "spend"), "spend ");
  assert.equal(completed("pack ", "Phone charger"), 'pack "Phone charger" ');
  assert.equal(completed("resting he", "resting heart rate"), "resting heart rate ");
});

test("a ;; line is a capture line, and once it runs its receipt isn't one", () => {
  assert.equal(captureLine(";; spend 5 food"), " spend 5 food");
  assert.equal(captureLine("  ;;meds"), "meds");
  assert.equal(captureLine("> ;; spend"), undefined);
  assert.equal(captureLine("spend 5"), undefined);
  const r = receipt("spend 5 food", "Budget", new Date(2026, 10, 19, 8, 14), "abc-1");
  assert.equal(r, "✓ spend 5 food · Budget · 08:14 · [details](obsidian://gizmo?activity=abc-1)");
  assert.equal(captureLine(r), undefined);
  assert.equal(receipt("meds", "Medication log", new Date(2026, 10, 19, 8, 14), undefined), "✓ meds · Medication log · 08:14");
});

test("a capture link with a key made for its name runs unattended; without one, or for another name, it asks first", async () => {
  const t = fakeBackground({
    "Apps/Budget.md": { fm: { app: "b", panels: [{ view: "form", alias: "spend", save: "spend", fields: { amount: "number", note: "text" } }] } },
    "Apps/Meds.md": { fm: { app: "m", panels: [{ view: "button", label: "Took meds", save: "doses", alias: "meds" }] } },
  });
  t.captureKeys.set("ck1", { spend: "Apps/Budget.md#spend" });
  await t.bg.start();
  await t.bg.runCaptureLink({ key: "ck1", line: "spend 6 parking", "x-success": "shortcuts://x-callback-url/done" });
  assert.equal(t.out.asked.length, 0);
  assert.deepEqual(t.f.files.get("Apps/Budget data.md")?.fm?.spend, [{ amount: 6, note: "parking", at: savedAt("2026-11-18T12:00") }]);
  // Word goes back to an app it hasn't sent to yet only once allowed, as for a shortcut's keyed link.
  assert.equal(t.out.chose.length, 1);
  t.ask.answer = false;
  await t.bg.runCaptureLink({ key: "ck1", line: "meds" });
  await t.bg.runCaptureLink({ line: "spend 7" });
  await t.bg.runCaptureLink({ key: "forged", line: "spend 8" });
  assert.equal(t.out.asked.length, 3);
  assert.match(t.out.asked[1].title, /A link asks to run “spend” in Budget/);
  assert.ok(t.out.asked[1].effects?.some((l) => l.includes("7")), JSON.stringify(t.out.asked[1]));
  assert.equal(t.f.files.get("Apps/Meds data.md"), undefined);
  assert.equal((t.f.files.get("Apps/Budget data.md")?.fm?.spend as unknown[]).length, 1);
});

test("a capture key runs a name only while it reaches the shortcut it was made for, and a forged key asks", async () => {
  const t = fakeBackground({
    "Apps/Other.md": { fm: { app: "o", panels: [{ view: "form", alias: "spend", save: "elsewhere", fields: { amount: "number" } }] } },
  });
  t.captureKeys.set("ck1", { spend: "Apps/Budget.md#spend" });
  t.ask.answer = false;
  await t.bg.start();
  await t.bg.runCaptureLink({ key: "ck1", line: "spend 500" });
  await t.bg.runCaptureLink({ key: "constructor", line: "spend 500" });
  await t.bg.runCaptureLink({ key: "__proto__", line: "spend 500" });
  assert.equal(t.out.asked.length, 3);
  assert.equal(t.f.files.get("Apps/Other data.md"), undefined);
});

test("a capture link that can't be read is told only in Obsidian, and runs nothing", async () => {
  const t = fakeBackground({ "Apps/Budget.md": { fm: { app: "b", panels: [{ view: "form", alias: "spend", save: "spend", fields: { amount: "number" } }] } } });
  t.captureKeys.set("ck1", { spend: "Apps/Budget.md#spend" });
  await t.bg.start();
  await t.bg.runCaptureLink({ key: "ck1", line: "spend lots", "x-error": "shortcuts://x-callback-url/err" });
  assert.deepEqual(t.notices, ["A capture link couldn't run “spend lots”: amount must be a number, not “lots”"]);
  assert.deepEqual(t.out.opened, []);
});
