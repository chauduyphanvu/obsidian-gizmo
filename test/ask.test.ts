import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addAnswer, addToApp, appsToAddTo, askEnvOf, askHelp, askLine, compileAsk, NO_KINDS, panelEmbed, panelYaml, parseAsk, type AskKind } from "../src/ask.ts";
import type { AppEnv } from "../src/app.ts";
import { runtimeOn } from "./support/runtime.ts";
import type { NoteReader } from "../src/expand.ts";
import { readFields } from "../src/keys.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { fakeBackground } from "./support/fakes.ts";
import { parseYaml } from "./support/yaml.ts";

// Thursday 19 November 2026, 10:00.
const NOW = new Date(2026, 10, 19, 10, 0);
const KIND_PATH = "Kinds/Spend.md";

/** The gallery's Spend kind, as the vault has it. */
const SPEND_FM = parseYaml(readFileSync(new URL("../gallery/Kinds/Spend.md", import.meta.url), "utf8").match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
const fields = readFields(SPEND_FM.fields as Record<string, unknown>).types;
const SPEND: AskKind = {
  path: KIND_PATH, name: "spend", shortcut: "spend", fields,
  seen: { category: ["food", "travel"], note: ["lunch", "lunch with friends", "Ramen"], trip: ["Tokyo"] },
};
const notes: NoteReader = {
  resolve: (link) => (link === "Spend" ? KIND_PATH : undefined),
  frontmatter: (path) => (path === KIND_PATH ? SPEND_FM : undefined),
};

const answer = (line: string, kinds: AskKind[] = [SPEND]) => {
  const r = parseAsk(line, kinds, NOW);
  assert.ok(r.ok, `${line}: ${"error" in r ? r.error : ""}`);
  return r.panel;
};
const refused = (line: string, kinds: AskKind[] = [SPEND]) => {
  const r = parseAsk(line, kinds, NOW);
  assert.ok(!r.ok, `${line} should be refused`);
  return r;
};

const EXAMPLES: [string, Record<string, unknown>][] = [
  ["spend food per week since sep", {
    view: "bar", title: "Spend: sum of amount per week, food, since Sep 1", source: "[[Spend]]",
    where: { category: "food", at: ">= 2026-09-01" }, group: "at", per: "week", y: "amount", agg: "sum",
  }],
  ["spend this month", { view: "number", title: "Spend: sum of amount, this month", source: "[[Spend]]", where: { at: "this month" }, field: "amount", agg: "sum" }],
  ["spend by category last 30 days", {
    view: "bar", title: "Spend: sum of amount by category, last 30 days", source: "[[Spend]]", where: { at: "last 30 days" }, group: "category", y: "amount", agg: "sum",
  }],
  ["spend avg per month", { view: "line", title: "Spend: avg of amount per month", source: "[[Spend]]", group: "at", per: "month", y: "amount", agg: "avg" }],
  ["spend list travel", {
    view: "table", title: "Spend: rows, travel", source: "[[Spend]]", where: { category: "travel" }, sort: "-at", columns: ["at", "amount", "category", "note", "local", "trip"],
  }],
  ["spend count food this year", { view: "number", title: "Spend: count, food, this year", source: "[[Spend]]", where: { category: "food", at: "this year" }, agg: "count" }],
];

test("each example asks the Spend kind for the panel a person would type", () => {
  for (const [line, panel] of EXAMPLES) assert.deepEqual(answer(line), panel, line);
});

test("every answer goes through the same checker as a typed panel, and needs only to read the kind: no write, no fetch, no other note", () => {
  for (const [line] of EXAMPLES) {
    const c = compileAsk(SPEND, answer(line), { notes, now: NOW });
    assert.deepEqual(c.errors, [], line);
    assert.ok(c.spec, line);
    assert.deepEqual(c.wanted, ["kind:Kinds/Spend.md"], line);
    assert.deepEqual(permissionsOf(c.spec!, c.path), ["kind:Kinds/Spend.md"], line);
    const p = c.spec!.panels[0].panel;
    assert.equal(p.target, undefined, `${line}: it saves nothing`);
    assert.equal(p.edit, undefined, `${line}: it edits nothing`);
    assert.deepEqual(p.kind, { path: KIND_PATH, name: "spend" }, line);
  }
});

test("an answer that would need anything besides reading the kind is refused, and not drawn", () => {
  const web = compileAsk(SPEND, { view: "number", source: "https://example.com/x.json", field: "n" }, { notes, now: NOW });
  assert.equal(web.spec, undefined);
  assert.deepEqual(web.errors, ["an ask only reads Spend, and this one would need net:example.com"]);
  const saves = compileAsk(SPEND, { view: "form", save: "[[Spend]]" }, { notes, now: NOW });
  assert.equal(saves.spec, undefined);
  assert.match(saves.errors.at(-1)!, /^an ask only reads Spend, and this one would need kind-write:Kinds\/Spend\.md/);
  const broken = compileAsk(SPEND, { view: "number", source: "[[Nowhere]]", agg: "count" }, { notes, now: NOW });
  assert.equal(broken.spec, undefined);
  assert.ok(broken.errors.length > 0);
});

test("the YAML an answer stands for reads back as the same panel, as an item of panels and as an embed", () => {
  const panel = answer("spend food per week since sep");
  const yaml = panelYaml(panel);
  assert.equal(yaml, [
    "- view: bar",
    '  title: "Spend: sum of amount per week, food, since Sep 1"',
    '  source: "[[Spend]]"',
    '  where: {category: food, at: ">= 2026-09-01"}',
    "  group: at",
    "  per: week",
    "  y: amount",
    "  agg: sum",
  ].join("\n"));
  for (const [line, p] of EXAMPLES) assert.deepEqual(parseYaml(`panels:\n${panelYaml(p).replace(/^/gm, "  ")}`), { panels: [p] }, line);
  const embed = panelEmbed(panel);
  assert.ok(embed.startsWith("```gizmo\nview: bar\n") && embed.endsWith("\nagg: sum\n```"));
  // As a block in a note, it is an app that asks to read the kind, as any embed of it would.
  const block = { app: "", ...(parseYaml(embed.split("\n").slice(1, -1).join("\n")) as Record<string, unknown>) };
  const r = readSpec(block, { now: NOW, notes, path: "Daily.md", host: {} })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Daily.md"), ["kind:Kinds/Spend.md"]);
});

test("Keep adds the answer to an app as Insert panel adds one, or says why it can't: a note with no panels list, or one whose panels come from a component", () => {
  const panel = answer("spend this month");
  const opts = { path: "Apps/Sleep.md", notes, parse: parseYaml, now: NOW };
  const sleep = "---\napp: Sleep\npanels:\n  - view: button\n    label: Slept\n    save: nights\n---\nBody\n";
  const added = addToApp(sleep, panel, opts);
  assert.ok("text" in added);
  assert.equal(added.text, [
    "---", "app: Sleep", "panels:", "  - view: button", "    label: Slept", "    save: nights",
    "  - view: number", '    title: "Spend: sum of amount, this month"', '    source: "[[Spend]]"', "    where: {at: this month}", "    field: amount", "    agg: sum",
    "---", "Body", "",
  ].join("\n"));
  const r = readSpec(parseYaml(added.text.split("---")[1]) as Record<string, unknown>, { now: NOW, notes, path: "Apps/Sleep.md" })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Apps/Sleep.md"), ["kind:Kinds/Spend.md"], "the app now asks to read the kind, as for any panel");
  const kit = "---\napp: Weight\nuse: \"[[Tracker kit]]\"\nwith: {what: weight}\n---\n";
  assert.deepEqual(addToApp(kit, panel, { ...opts, path: "Apps/Weight.md" }), { refusal: "put - use: … inside panels to mix a component with other panels" });
  assert.deepEqual(addToApp("---\napp: x\nview: countdown\nto: 2027-01-01\n---\n", panel, opts), { refusal: "This note has one panel typed at the top level; move it under panels: to add more" });
});

test("a word the ask doesn't know is named, with what was probably meant", () => {
  const typo = refused("spend fod per week");
  assert.equal(typo.error, "“fod” isn't a field of Spend, a value its rows hold, or a word an ask knows (did you mean food?)");
  assert.deepEqual(typo.completions, [], "Tab replaces the last word, so only the last word is offered a replacement");
  assert.deepEqual(refused("spend fod").completions, ["food"]);
  assert.deepEqual(refused("spend tok").completions, ["Tokyo"], "the words starting with it, as the rows write them");
  assert.deepEqual(refused("spend per we").completions, ["week"]);
  assert.deepEqual(refused("spend by cat").completions, ["category"]);
  assert.equal(refused("spend food per wek").error, "per takes day, week, month or year, not “wek”");
  assert.equal(refused("spend by categry").error, "by takes a field of Spend: amount, category, note, local and trip, not “categry” (did you mean category?)");
  assert.equal(refused("spend this").error, "say this week, this month or this year");
  assert.equal(refused("spend since someday").error, "since takes a month or a day: since sep, since 2026-09-01, since last mon, not “someday”");
  const kind = refused("spnd food");
  assert.equal(kind.error, "no kind called “spnd” (did you mean spend?); ask one of spend");
  assert.deepEqual(kind.completions, []);
  assert.deepEqual(refused("spnd").completions, ["spend"]);
  assert.deepEqual(refused("sp").completions, ["spend"], "a kind's name is offered while it is typed");
});

test("a word that could be two things says so, and how to write each", () => {
  const both: AskKind = { ...SPEND, seen: { ...SPEND.seen, note: ["trip", "lunch"] } };
  assert.equal(refused("spend trip", [both]).error, "“trip” is a field of Spend and a value of note: write by trip for the field, or note=trip for the value");
  assert.equal(refused("spend local", [{ ...SPEND, seen: { note: ["local"] } }]).error, "“local” is a field of Spend and a value of note: write sum local for the field, or note=local for the value");
  const twice: AskKind = { ...SPEND, seen: { ...SPEND.seen, note: ["Tokyo"] } };
  assert.equal(refused("spend Tokyo", [twice]).error, "“Tokyo” is a value of note and trip: write note=Tokyo or trip=Tokyo");
  assert.deepEqual(answer("spend trip=Tokyo", [twice]).where, { trip: "Tokyo" });
  assert.deepEqual(answer("spend note=tokyo", [twice]).where, { note: "Tokyo" }, "a value is found in any case, and kept as the rows write it");
  assert.equal(refused("spend category").error, "category is a field of Spend: write by category to group by it, or category=… to keep some rows");
});

test("values: a choice, a value the rows hold (quoted when it has spaces), field=value; one value a field", () => {
  assert.deepEqual(answer("spend list Tokyo").where, { trip: "Tokyo" });
  assert.deepEqual(answer('spend list "lunch with friends"').where, { note: "lunch with friends" });
  assert.deepEqual(answer("spend home").where, { category: "home" }, "a choice the rows don't hold yet");
  assert.deepEqual(answer("spend local=1500").where, { local: 1500 });
  assert.equal(refused("spend category=books").error, "category must be one of food, home, transport, fun, travel, other");
  assert.equal(refused("spend colour=red").error, "Spend has no field “colour”; its fields are amount, category, note, local and trip");
  assert.equal(refused("spend food travel").error, "category is given twice (food and travel); an ask keeps the rows with one value of each field");
});

test("what is added up: sum of the first number field unless said, another field by its name, count when there is no number", () => {
  assert.deepEqual(answer("spend max local"), { view: "number", title: "Spend: max of local", source: "[[Spend]]", field: "local", agg: "max" });
  assert.deepEqual(answer("spend local by trip"), { view: "bar", title: "Spend: sum of local by trip", source: "[[Spend]]", group: "trip", y: "local", agg: "sum" });
  assert.deepEqual(answer("spend last"), { view: "number", title: "Spend: last of amount", source: "[[Spend]]", sort: "at", field: "amount", agg: "last" });
  assert.equal(answer("spend last per week").view, "line");
  assert.deepEqual(answer("spend count per week"), { view: "bar", title: "Spend: count per week", source: "[[Spend]]", group: "at", per: "week" });
  const chores: AskKind = { path: "Kinds/Chore.md", name: "chore", fields: { task: "text", room: ["kitchen", "bath"] }, seen: {} };
  assert.deepEqual(answer("chore kitchen", [chores]), { view: "number", title: "Chore: count, kitchen", source: "[[Chore]]", where: { room: "kitchen" }, agg: "count" });
  assert.equal(refused("chore sum", [chores]).error, "Chore has no number field to sum; ask count instead");
  assert.equal(refused("spend count amount").error, "count counts the rows; leave out amount");
  assert.equal(refused("spend sum avg").error, "say one of sum, avg, count, min, max, last: sum or avg");
  assert.equal(refused("spend amount local").error, "say one number field: amount or local");
});

test("time: the windows a where knows, since a month or a day, one of them", () => {
  assert.deepEqual(answer("spend since dec").where, { at: ">= 2025-12-01" }, "a month still to come this year is last year's");
  assert.deepEqual(answer("spend since nov").where, { at: ">= 2026-11-01" });
  assert.deepEqual(answer("spend since september").where, { at: ">= 2026-09-01" });
  assert.deepEqual(answer("spend since 2026-10-05").where, { at: ">= 2026-10-05" });
  assert.deepEqual(answer("spend since last mon").where, { at: ">= 2026-11-09" });
  // A month and a day is that day, as on any other line: the last one, today included.
  assert.deepEqual(answer("spend since nov 5").where, { at: ">= 2026-11-05" });
  assert.deepEqual(answer("spend since dec 24 food").where, { at: ">= 2025-12-24", category: "food" });
  assert.equal(answer("spend since nov 5").title, "Spend: sum of amount, since Nov 5");
  assert.equal(answer("spend since dec").title, "Spend: sum of amount, since Dec 1, 2025");
  for (const w of ["today", "yesterday", "this week", "last 7 days", "last 3 months", "next 30 days", "upcoming"]) assert.deepEqual(answer(`spend ${w}`).where, { at: w }, w);
  assert.equal(refused("spend this month since sep").error, "say one time: “this month” or “since Sep 1”");
});

test("lines: logged rows unless the line says planned or all", () => {
  assert.equal(answer("spend this month").lines, undefined);
  // Planned without logged is what is planned and not yet settled: the row that settled one isn't asked for.
  assert.deepEqual(answer("spend planned upcoming"), {
    view: "number", title: "Spend: sum of amount, upcoming, planned rows", source: "[[Spend]]", lines: "planned", where: { at: "upcoming", matched: "" }, field: "amount", agg: "sum",
  });
  assert.equal(answer("spend all this month").lines, "all");
  assert.deepEqual(answer("spend logged planned").lines, ["logged", "planned"]);
});

test("planned on the ask line is planned and not yet settled; logged and planned counts a settled bill once, as Budget's month does, in the YAML it shows", async () => {
  const BUDGET_LANDS = { view: "number", title: "Lands", source: "[[Spend]]", lines: ["logged", "planned"], where: { at: "this month", matched: "" }, field: "amount", agg: "sum" };
  const both = answer("spend logged planned this month");
  const planned = answer("spend planned this month");
  assert.equal(panelYaml(planned).split("\n").find((l) => l.includes("where")), '  where: {at: this month, matched: ""}');
  assert.equal(panelYaml(both).split("\n").find((l) => l.includes("where")), "  where: {at: this month}");
  const t = fakeBackground({ [KIND_PATH]: { fm: SPEND_FM }, "Apps/Ask.md": { fm: { app: "a", panels: [both, planned, BUDGET_LANDS] } } });
  await t.data.ledger!.write("Kinds/Spend data.md", [
    { op: "add", l: "spend", row: "l1", v: { amount: 17.99, category: "fun", note: "STREAMFLIX.COM 866", at: "2026-11-12T10:00" } },
    { op: "add", l: "spend", row: "l2", v: { amount: 12, category: "food", note: "lunch", at: "2026-11-13T12:00" } },
    { op: "add", l: "spend", row: "p1", v: { amount: 15.49, category: "fun", note: "STREAMFLIX", at: "2026-11-12T09:00", line: "planned", matched: "l1" } },
    { op: "add", l: "spend", row: "p2", v: { amount: 45, category: "home", note: "BRIGHT MOBILE", at: "2026-11-25T09:00", line: "planned" } },
  ]);
  await t.bg.start();
  const spec = readSpec({ app: "a", panels: [both, planned, BUDGET_LANDS] }, { notes: t.env.notes, path: "Apps/Ask.md" })!.spec!;
  const values = await Promise.all(spec.panels.map(async (ps) => {
    const e = await t.bg.evaluate("Apps/Ask.md", ps);
    return "value" in e ? e.value : e;
  }));
  assert.deepEqual(values, [74.99, 45, 74.99]);
});

test("list is the rows themselves, and grouping is per a time or by a field", () => {
  assert.equal(refused("spend list sum").error, "list shows the rows themselves; leave out “sum”");
  assert.equal(refused("spend list per week").error, "list shows the rows themselves; leave out “per”");
  assert.equal(refused("spend per week by category").error, "an ask groups per a time or by a field, not both");
});

test("a bare ? shows the grammar and the kinds; with no kinds, it says how to make one", () => {
  const help = parseAsk("", [SPEND], NOW);
  assert.ok(!help.ok && help.help);
  assert.deepEqual(help.completions, ["spend"]);
  const lines = askHelp([SPEND]);
  assert.equal(lines.at(-1), "Kinds: spend (amount, category, note, local, trip)");
  assert.equal(askHelp([]).at(-1), NO_KINDS);
  assert.equal(refused("spend", []).error, NO_KINDS);
  assert.equal(askHelp([{ ...SPEND, shortcut: "sp" }]).at(-1), "Kinds: spend or sp (amount, category, note, local, trip)");
});

test("a kind is asked by its name or its shortcut; a name two kinds share reaches neither", () => {
  const short: AskKind = { ...SPEND, shortcut: "sp" };
  assert.equal(answer("sp this month", [short]).source, "[[Spend]]");
  assert.equal(answer("SPEND", [short]).view, "number");
  const other: AskKind = { ...SPEND, path: "Other/Spend.md" };
  assert.equal(refused("spend this month", [SPEND, other]).error, "“spend” names 2 kinds (Kinds/Spend.md and Other/Spend.md), so it reaches none of them; rename one");
  const clash: AskKind = { path: "Kinds/Sport.md", name: "sport", shortcut: "spend", fields: { minutes: "number" }, seen: {} };
  assert.match(refused("spend", [SPEND, clash]).error, /names 2 kinds/);
  assert.equal(answer("sport", [SPEND, clash]).source, "[[Sport]]", "its own name still reaches it");
});

test("a kind with no rows can still be asked: its choices are known, values of other fields aren't", () => {
  const empty: AskKind = { ...SPEND, seen: {} };
  assert.deepEqual(answer("spend food this month", [empty]).where, { category: "food", at: "this month" });
  assert.match(refused("spend Tokyo", [empty]).error, /^“Tokyo” isn't a field of Spend/);
});

test("the background hands an ask the vault's kinds: name, shortcut, fields, the values their rows hold, and how to link each", async () => {
  const t = fakeBackground({
    [KIND_PATH]: { fm: SPEND_FM },
    "Kinds/Chore.md": { fm: { kind: "chore", fields: { task: "text", room: ["kitchen", "bath"] } } },
    "Apps/Budget.md": { fm: { app: "b", panels: [{ view: "form", save: "[[Spend]]", alias: "paid" }] } },
  });
  await t.bg.start();
  await t.bg.capture("spend 14.5 food lunch with friends");
  await t.bg.capture("spend 1800 travel taxi 2000 Tokyo");
  const kinds = await t.bg.askKinds();
  assert.deepEqual(kinds.map((k) => [k.path, k.name, k.shortcut ?? null]).sort(), [["Kinds/Chore.md", "chore", null], [KIND_PATH, "spend", "spend"]]);
  const spend = kinds.find((k) => k.name === "spend")!;
  assert.deepEqual(spend.seen, { category: ["food", "travel"], note: ["lunch with friends", "taxi"], trip: ["Tokyo"] });
  assert.equal(spend.link, undefined, "[[Spend]] finds it");
  assert.deepEqual(answer("spend list Tokyo", kinds).where, { trip: "Tokyo" });
  assert.equal(t.f.files.get("Kinds/Spend (ask).md"), undefined, "an ask writes nothing");
});

test("the ask line is a Do… line that starts with ?; a kind's shortcut without it is still a capture line", () => {
  assert.equal(askLine("? spend food"), " spend food");
  assert.equal(askLine("  ?"), "");
  assert.equal(askLine("spend 14.5 food lunch"), undefined);
  assert.equal(askLine("what if spend 5"), undefined);
});

test("an answer is kept in an app the person picks, naming the kind as that app finds it", async () => {
  const t = await runtimeOn({
    [KIND_PATH]: { fm: SPEND_FM, body: "" },
    "Apps/Sleep.md": { fm: { app: "Sleep", panels: [{ view: "button", label: "Slept", save: "nights" }] }, body: "Body\n" },
    "Apps/Budget.md": { fm: { app: "Budget", panels: [{ view: "button", label: "Spent", save: "spend" }] }, body: "" },
    "Notes/Plain.md": { body: "not an app" },
  });
  assert.deepEqual(appsToAddTo(t.runtime), ["Apps/Budget.md", "Apps/Sleep.md"]);
  const panel = answer("spend this month");
  assert.deepEqual(await addAnswer(t.runtime, "Apps/Sleep.md", KIND_PATH, panel), { refusal: undefined });
  const panels = (t.f.files.get("Apps/Sleep.md")!.fm as { panels: { source?: string }[] }).panels;
  assert.equal(panels.at(-1)!.source, "[[Spend]]");
  assert.deepEqual(await addAnswer(t.runtime, "Apps/Gone.md", KIND_PATH, panel), { refusal: "it isn't there any more" });
});

test("the app an answer is drawn in reads the kind and nothing else, and writes nothing", async () => {
  const base = { isGranted: () => false, preview: false } as unknown as AppEnv;
  const env = askEnvOf(base, "kind:Kinds/Spend.md");
  assert.equal(env.isGranted("x", ["kind:Kinds/Spend.md"]), true);
  assert.equal(env.isGranted("x", ["kind:Kinds/Spend.md", "net:example.com"]), false);
  await assert.rejects(() => env.appendLine("Daily.md", "- x"), /an ask only reads/);
  await assert.rejects(() => env.createNote("A.md", {}, ""), /an ask only reads/);
  assert.equal(env.store, undefined);
  assert.equal(env.preview, true);
});
