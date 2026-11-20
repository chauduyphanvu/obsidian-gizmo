import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { EXPECT_MISSED } from "../src/background.ts";
import { matches, rowsOf, type Row } from "../src/data.ts";
import { expectRows, metIn, readBy, readExpect, refusal, windowAt, windowsDue, type Rhythm } from "../src/expect.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";
import { parseYaml } from "./support/yaml.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A local time, as the fakes' clock and the periods count it. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const rhythm = (raw: Record<string, unknown>): Rhythm => {
  const errors: string[] = [];
  const [r] = readExpect([{ source: "doses", ...raw }], errors);
  assert.deepEqual(errors, []);
  return r as Rhythm;
};

test("expect's rules are read and checked: one kind each, ids of their own, by read for its period", () => {
  const errors: string[] = [];
  const rules = readExpect([
    { id: "meds", every: "day", by: "10:00", source: "doses", where: { kind: "pill" }, say: "No dose by 10", then: { app: "[[Inbox]]", do: "add" } },
    { every: "week", by: "fri 18:00", source: "runs" },
    { source: "weight", check: { weight: "between 30 and 250" } },
    { source: "deadlines", none: { due: "past" } },
  ], errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.map((r) => `${r.kind}:${r.id}`), ["rhythm:meds", "rhythm:expect-2", "value:expect-3", "state:expect-4"]);
  assert.deepEqual(readBy("fri 18:00", "week"), { day: 4, minutes: 18 * 60 });
  assert.deepEqual(readBy("31 09:00", "month"), { day: 30, minutes: 540 });
  const bad: string[] = [];
  readExpect([
    { every: "day", source: "x" },
    { every: "fortnight", by: "10:00", source: "x" },
    { every: "week", by: "10:00", source: "x" },
    { check: { a: 1 }, none: { b: 2 }, source: "x" },
    { every: "day", by: "25:00", source: "x" },
    { id: "a", check: { a: 1 }, source: "x" },
    { id: "a", check: { a: 1 }, source: "x" },
    { check: { a: 1 }, source: "x", say: "hi" },
  ], bad);
  assert.deepEqual(bad, [
    "expect 1: a rhythm needs by: the time it's due, e.g. by: \"10:00\"",
    "expect 2: every must be day, week or month",
    "expect 3: by for every week needs a weekday and a time, e.g. by: \"fri 18:00\"",
    "expect 4: needs one of every (a rhythm), check (what each row must hold) or none (what no row may match)",
    "expect 5: by must end with a time, e.g. by: \"10:00\"",
    "expect 7: another rule is already called a",
    "expect 8: a value rule doesn't take say",
  ]);
  assert.match(readExpect({ every: "day" }, [])[0]?.kind ?? "none", /none/);
});

test("a rhythm's window runs from its period's start to the next; its deadline is in it, at month ends and over a clock change too", () => {
  const day = rhythm({ every: "day", by: "10:00" });
  assert.deepEqual(windowAt(at(2026, 11, 18, 23, 59), day), { start: at(2026, 11, 18), deadline: at(2026, 11, 18, 10), end: at(2026, 11, 19) });
  const week = rhythm({ every: "week", by: "fri 18:00" });
  // Wednesday 18 November: the week from Monday 16th, due Friday 20th.
  assert.deepEqual(windowAt(at(2026, 11, 18, 12), week), { start: at(2026, 11, 16), deadline: at(2026, 11, 20, 18), end: at(2026, 11, 23) });
  const month = rhythm({ every: "month", by: "31 09:00" });
  assert.equal(windowAt(at(2027, 2, 10), month).deadline, at(2027, 2, 28, 9), "the last day of a short month");
  // 1 November 2026: clocks go back in many places; the deadline is still 10:00 on the clock.
  assert.equal(new Date(windowAt(at(2026, 11, 1, 20), day).deadline).getHours(), 10);
  assert.deepEqual(windowsDue(day, at(2026, 11, 17, 12), at(2026, 11, 19, 11)).map((w) => w.start), [at(2026, 11, 18), at(2026, 11, 19)]);
  assert.deepEqual(windowsDue(day, at(2026, 11, 18, 10), at(2026, 11, 18, 23)), [], "a deadline already decided isn't again");
});

test("a window is met by a row in it by its deadline; a late row, or one of a later window, doesn't count", () => {
  const day = rhythm({ every: "day", by: "10:00", where: { kind: "pill" } });
  const w = windowAt(at(2026, 11, 18, 12), day);
  const now = new Date(at(2026, 11, 20));
  const row = (h: number, d = 18, kind = "pill") => ({ at: `2026-11-${d}T${String(h).padStart(2, "0")}:00`, kind });
  assert.equal(metIn([row(9)], day, w, now), true);
  assert.equal(metIn([row(10)], day, w, now), true, "at the deadline still counts");
  assert.equal(metIn([row(11)], day, w, now), false, "late");
  assert.equal(metIn([row(8, 19)], day, w, now), false, "the next day's row is the next window's");
  assert.equal(metIn([row(9, 18, "syrup")], day, w, now), false, "where picks which rows count");
});

test("a value rule says what's wrong with a row; between A and B works in where too", () => {
  const errors: string[] = [];
  const rules = readExpect([{ source: "weight", check: { weight: "between 30 and 250", unit: "kg" } }], errors);
  const now = new Date(at(2026, 11, 18));
  assert.equal(refusal(rules, "weight", { weight: 812, unit: "kg" }, now), "weight 812 isn't between 30 and 250");
  assert.equal(refusal(rules, "weight", { weight: 80, unit: "lb" }, now), "unit lb isn't kg");
  assert.equal(refusal(rules, "weight", { unit: "kg" }, now), "weight is empty, and must be between 30 and 250");
  assert.equal(refusal(rules, "weight", { weight: 80, unit: "kg" }, now), undefined);
  assert.equal(refusal(rules, "other", { weight: 812 }, now), undefined, "only its own list");
  assert.equal(matches("2026-11-20", "between 2026-11-01 and 2026-11-30", now), true);
  assert.equal(matches(31, "between 1 and 30", now), false);
  assert.equal(matches("2026-11-30T18:00", "between 2026-11-01 and 2026-11-30", now), true, "the last day is a whole day");
  assert.equal(matches("between friends and family", "between friends and family", now), true, "ends that aren't numbers or dates are text");
});

test("expect runs as hidden panels: their thens are asked for, a state rule's alert is checked, and an app's own expect field stays data", () => {
  const r = readSpec({
    app: "Meds", view: "table", source: "doses",
    expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", then: { app: "[[Inbox]]", do: "add" } }, { source: "doses", none: { kind: "unknown" } }, { source: "doses", check: { n: "> 0" } }],
  }, { path: "Apps/Meds.md" })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.spec!.expected), ["meds", "expect-2"]);
  assert.deepEqual([r.spec!.expected["expect-2"].panel.view, r.spec!.expected["expect-2"].panel.alert], ["number", { kind: "unknown" }]);
  assert.ok(permissionsOf(r.spec!, "Apps/Meds.md").includes("run:Inbox#add"));
  const journal = parseYaml(readFileSync(new URL("../gallery/Apps/Decision journal.md", import.meta.url), "utf8").split("---")[1]) as Record<string, unknown>;
  const read = readSpec(journal, { path: "Apps/Decision journal.md" })!;
  assert.deepEqual([read.errors, read.spec!.expect], [[], []]);
  assert.deepEqual(readSpec({ app: "x", view: "table", source: "s", expect: "high" }, { path: "x.md" })!.spec!.expect, [], "not a list: data");
  const older = readSpec({ app: "x", view: "table", source: "expect", expect: [{ task: "dentist" }] }, { path: "x.md" })!;
  assert.deepEqual([older.errors, older.spec!.expect], [[], []], "a list of rows called expect: data");
});

test("an older app's list called expect is still its data, and source: expect reads it; rules are never read as rows", async () => {
  const e = fakeEnv({ "Apps/Old.md": { fm: { app: "Old", view: "table", source: "expect", expect: [{ task: "dentist" }] } }, "Apps/Meds.md": { fm: MEDS } });
  const files = (name: string) => ({ appPath: `Apps/${name}.md`, dataPath: `Apps/${name} data.md` });
  const read = (name: string) => e.env.data.rawData("expect", { view: "table", source: "expect" }, files(name), { ttlMs: 0, now: new Date(at(2026, 11, 18, 12)) });
  assert.deepEqual(rowsOf(await read("Old")).map((r) => (r as Row).task), ["dentist"]);
  assert.deepEqual(await e.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows("expect"), []);
});

const MEDS = {
  app: "Meds",
  panels: [{ view: "button", label: "Took it", save: "doses", shortcut: "took" }],
  expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", say: "no dose by 10:00", then: { app: "[[Inbox]]", do: "add", fill: { task: "Missed meds {window}" } } }],
};
const INBOX = { app: "Inbox", panels: [{ view: "form", title: "Add", fields: { task: "text" }, save: "todo", shortcut: "add" }] };
const notes = () => ({ "Apps/Meds.md": { fm: MEDS }, "Apps/Inbox.md": { fm: INBOX } });

test("a rhythm missed is decided once at its deadline: kept, told and its then run; a day met is quiet", async () => {
  // The fakes' clock starts Wednesday 18 November, 12:00.
  const t = fakeBackground(notes());
  await t.bg.start();
  await settle();
  assert.deepEqual(t.notices, [], "seen first now: what passed before isn't decided");
  t.advance(23 * HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual((t.notices as string[]).filter((n) => n.startsWith("Meds")), ["Meds: no dose by 10:00"]);
  const missed = await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED);
  assert.deepEqual(missed.map((r) => [r.rule, r.window]), [["meds", "2026-11-19"]]);
  assert.deepEqual((await t.env.store!("Apps/Inbox data.md", "Apps/Inbox.md").rows("todo")).map((r) => r.task), ["Missed meds 2026-11-19"]);
  // Thursday 20th: a dose at 09:00 meets it.
  await t.bg.tick();
  t.advance(21 * HOUR);
  await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").add("doses", { at: "2026-11-20T09:00" });
  t.advance(2 * HOUR);
  await t.bg.tick();
  await settle();
  assert.equal((t.notices as string[]).filter((n) => n.startsWith("Meds")).length, 1);
});

test("editing the app before a deadline is decided doesn't skip it; two ticks at once tell a miss once", async () => {
  const t = fakeBackground(notes());
  await t.bg.start();
  await settle();
  // Thursday 10:00:20: the deadline passed, not yet decided, and the app is edited.
  t.advance(22 * HOUR + 20_000);
  t.f.files.get("Apps/Meds.md")!.fm = { ...MEDS, expect: [{ ...MEDS.expect[0], say: "no dose by ten" }] };
  t.changed("Apps/Meds.md");
  await settle();
  await Promise.all([t.bg.tick(), t.bg.tick()]);
  await settle();
  assert.deepEqual((t.notices as string[]).filter((n) => n.startsWith("Meds")), ["Meds: no dose by ten"]);
});

test("after days with nothing running, each missed window is told once, judged on its own rows; a late row in one doesn't meet the next", async () => {
  const t = fakeBackground(notes());
  await t.bg.start();
  await settle();
  // Away until Monday 23rd, noon. On Friday a dose came late, at 11:00.
  await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").add("doses", { at: "2026-11-20T11:00" });
  t.advance(5 * DAY);
  await t.bg.tick();
  await settle();
  const missed = await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED);
  // The latest three windows are told: Saturday to Monday.
  assert.deepEqual(missed.map((r) => r.window), ["2026-11-21", "2026-11-22", "2026-11-23"]);
  assert.equal((t.notices as string[]).filter((n) => n.startsWith("Meds")).length, 3);
});

test("two runners deciding one miss keep it once, and only the first tells it", async () => {
  const a = fakeBackground(notes());
  await a.bg.start();
  a.advance(23 * HOUR);
  await a.bg.tick();
  await settle();
  // The other device on the same files, having noted the rule before too.
  const logs = Object.fromEntries([...a.f.others].map(([path, raw]) => [path, { raw }]));
  const b = fakeBackground({ ...notes(), ...logs, "Apps/Meds data.md": a.f.files.get("Apps/Meds data.md")!, "Apps/Inbox data.md": a.f.files.get("Apps/Inbox data.md")! }, {}, { triggers: { text: JSON.stringify({ v: 2, fired: { "Apps/Meds.md\nexpect:meds": { decided: new Date(2026, 10, 18, 12).getTime() } } }) } });
  b.f.host.device = () => "phone000";
  b.advance(23 * HOUR);
  await b.bg.start();
  await settle();
  assert.equal((await b.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED)).length, 1);
  assert.deepEqual((b.notices as string[]).filter((n) => n.startsWith("Meds")), []);
  assert.equal((await b.env.store!("Apps/Inbox data.md", "Apps/Inbox.md").rows("todo")).length, 1);
});

test("a state rule tells when a row comes to match, as an alert does, and runs its then", async () => {
  const t = fakeBackground({
    "Apps/Renewals.md": { fm: { app: "Renewals", view: "table", source: "deadlines", expect: [{ id: "lapsed", source: "deadlines", none: { due: "past" }, say: "Lapsed" }] } },
    "Apps/Renewals data.md": { fm: { deadlines: [{ what: "passport", due: "2027-01-01" }] } },
  });
  await t.bg.start();
  await settle();
  assert.deepEqual(t.notices, []);
  await t.env.store!("Apps/Renewals data.md", "Apps/Renewals.md").add("deadlines", { what: "lease", due: "2026-11-01" });
  await settle();
  assert.deepEqual(t.notices, ["Renewals: Lapsed (1 row)"]);
});

test("a value rule refuses a row from every way in: a form keeps what was typed, a link, a capture line's preview and a then are told", async () => {
  const WEIGHT = { app: "Weight", panels: [{ view: "form", title: "Log", fields: { weight: "number" }, save: "weight", shortcut: "log", alias: "weigh" }, { view: "table", title: "All", source: "weight", columns: ["weight"], edit: ["weight"] }], expect: [{ source: "weight", check: { weight: "between 30 and 250" } }] };
  const e = fakeEnv({ "Apps/Weight.md": { fm: WEIGHT } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, "Apps/Weight.md", e.env);
  c.load();
  await settle();
  const input = root.querySelector("form input") as HTMLInputElement;
  input.value = "812";
  root.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.equal(root.querySelector(".gz-form-error")?.textContent, "Not saved: weight 812 isn't between 30 and 250");
  assert.equal((root.querySelector("form input") as HTMLInputElement).value, "812", "what was typed stays");
  input.value = "81";
  root.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.equal(root.querySelector(".gz-form-error"), null);
  // An edit to a row is held to it too.
  const cell = root.querySelector("tbody input") as HTMLInputElement;
  cell.value = "0";
  cell.dispatchEvent(new window.Event("change"));
  await settle();
  assert.ok(e.notices.includes("Not saved: weight 0 isn't between 30 and 250"));
  assert.deepEqual((await e.env.store!("Apps/Weight data.md", "Apps/Weight.md").rows("weight")).map((r) => r.weight), [81]);
  c.dispose();

  const t = fakeBackground({ "Apps/Weight.md": { fm: WEIGHT } });
  await t.bg.start();
  const ran = await t.bg.capture("weigh 900");
  assert.deepEqual([ran.ok, t.notices.at(-1)], [false, "Not saved: weight 900 isn't between 30 and 250"]);
  // The one who ran it (gizmod's caller, a capture line) hears why, not only that it didn't run.
  assert.equal(ran.error, "“Log” didn't run: weight 900 isn't between 30 and 250");
  const preview = await t.bg.previewLine("weigh 900");
  assert.ok(preview.effects?.some((l) => l.includes("weight 900 isn't between 30 and 250")), JSON.stringify(preview.effects));
  assert.deepEqual(await t.env.store!("Apps/Weight data.md", "Apps/Weight.md").rows("weight"), []);
});

test("a refused row writes nothing at all: the line a form appends isn't added either", async () => {
  const LOG = { app: "Weight", panels: [{ view: "form", title: "Log", fields: { weight: "number" }, save: "weight", append: "[[Journal]]", line: "weighed {weight}", shortcut: "log" }], expect: [{ source: "weight", check: { weight: "between 30 and 250" } }] };
  const t = fakeBackground({ "Apps/Weight.md": { fm: LOG }, "Journal.md": { fm: {}, body: "" } });
  await t.bg.start();
  const ran = await t.bg.capture("log 500");
  assert.equal(ran.ok, false);
  await settle();
  assert.equal(t.f.files.get("Journal.md")!.body ?? "", "");
  assert.deepEqual(await t.env.store!("Apps/Weight data.md", "Apps/Weight.md").rows("weight"), []);
});

test("source: expect gives each rhythm's windows met or not, for a streak of days met", async () => {
  const t = fakeBackground({
    "Apps/Meds.md": { fm: { ...MEDS, panels: [...MEDS.panels, { view: "number", title: "Days on time", source: "expect", where: { rule: "meds", met: true }, agg: "streak", group: "at", per: "day" }] } },
    "Apps/Meds data.md": { fm: { doses: [{ at: "2026-11-15T08:00" }, { at: "2026-11-16T09:30" }, { at: "2026-11-17T09:00" }, { at: "2026-11-18T08:15" }] } },
  });
  await t.bg.start();
  const spec = t.bg.spec("Apps/Meds.md")!;
  const r = await t.bg.evaluate("Apps/Meds.md", spec.panels[1]);
  assert.equal("value" in r && r.value, 4);
  const rows = expectRows(spec.expect, () => [{ at: "2026-11-16T11:00" }], new Date(2026, 10, 16).getTime(), new Date(2026, 10, 17, 12));
  assert.deepEqual(rows.map((x) => [x.window, x.met]), [["2026-11-16", false], ["2026-11-17", false]]);
});
