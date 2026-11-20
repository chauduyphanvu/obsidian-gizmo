import assert from "node:assert/strict";
import { test } from "node:test";
import { dryLines } from "../src/background.ts";
import { linkNotice } from "../src/links.ts";
import { readSpec } from "../src/spec.ts";
import { fakeBackground } from "./support/fakes.ts";

const PACKING = {
  app: "Pack for the trip",
  panels: [
    { view: "checklist", title: "Packing", items: ["Passport", "Phone charger", "Power bank", "Socks"], save: "packed", shortcut: "pack" },
  ],
};

function packing(more: Parameters<typeof fakeBackground>[0] = {}) {
  const t = fakeBackground({ "Apps/Trip.md": { fm: PACKING }, ...more });
  const packed = () => t.f.files.get("Apps/Trip data.md")?.fm?.packed as string[] | undefined;
  return { ...t, packed };
}

test("a checklist's link ticks the item it names, by its text or the only item starting with it, case aside", async () => {
  const t = packing();
  await t.bg.start();
  await t.bg.runUri({ app: "Trip", do: "pack", item: "passport" });
  await t.bg.runUri({ app: "Trip", do: "pack", item: "so" });
  assert.deepEqual(t.packed(), ["Passport", "Socks"]);
  assert.deepEqual(t.notices, ["Trip: ticked Passport", "Trip: ticked Socks"]);
});

test("ticking an item already ticked leaves it ticked and keeps nothing in the activity log", async () => {
  const t = packing({ "Apps/Trip data.md": { fm: { packed: ["Passport"] } } });
  await t.bg.start();
  await t.bg.runUri({ app: "Trip", do: "pack", item: "Passport" });
  assert.deepEqual(t.packed(), ["Passport"]);
  assert.deepEqual(t.notices, ["Trip: Passport was already ticked"]);
  assert.deepEqual(await t.activity.list("Apps/Trip.md"), []);
});

test("an item that isn't there, could be two, is missing, or comes with other values ticks nothing and says why", async () => {
  const t = packing();
  await t.bg.start();
  await t.bg.runUri({ app: "Trip", do: "pack", item: "p" });
  await t.bg.runUri({ app: "Trip", do: "pack", item: "towel" });
  await t.bg.runUri({ app: "Trip", do: "pack", item: " " });
  await t.bg.runUri({ app: "Trip", do: "pack", item: "Socks", colour: "red" });
  await t.bg.runUri({ app: "Trip", do: "pack", item: "Socks\nPassport" });
  assert.equal(t.packed(), undefined);
  assert.deepEqual(t.notices.slice(0, 4), [
    "Trip: “p” could be Passport or Phone charger or Power bank",
    "Trip: no item “towel”; the items are Passport, Phone charger, Power bank, Socks",
    "Trip: say which item to tick: item=…",
    "Trip: a checklist takes only item, not colour",
  ]);
  assert.equal(t.notices.length, 5);
});

test("a checklist's command opens the app to tick an item", async () => {
  const t = packing();
  await t.bg.start();
  await t.bg.runCommand("Apps/Trip.md:pack");
  assert.deepEqual(t.out.apps, ["Apps/Trip.md"]);
  assert.deepEqual(t.notices, ["Trip: tick an item"]);
});

test("another app's then ticks an item with fill, and a then without fill is told to give one", async () => {
  const t = packing({
    "Apps/Flights.md": { fm: { app: "f", panels: [
      { view: "form", fields: { item: "text" }, save: "flights", then: { app: "[[Trip]]", do: "pack", fill: { item: "{item}" } }, shortcut: "note" },
      { view: "button", label: "Bare", save: "bare", then: { app: "[[Trip]]", do: "pack" }, shortcut: "bare" },
    ] } },
  });
  await t.bg.start();
  await t.bg.runUri({ app: "Flights", do: "note", item: "power" });
  assert.deepEqual(t.packed(), ["Power bank"]);
  await t.bg.runCommand("Apps/Flights.md:bare");
  assert.ok(t.notices.includes("Trip: “pack” is a checklist; give Flights's then a fill with item"), t.notices.join("\n"));
});

test("a dry run of a checklist link says what it would tick and ticks nothing", async () => {
  const t = packing();
  await t.bg.start();
  const lines = dryLines(await t.bg.dryRun("Apps/Trip.md", "pack", { item: "phone" }));
  assert.equal(t.packed(), undefined);
  assert.ok(lines.some((l) => l.includes("Phone charger")), lines.join("\n"));
  assert.deepEqual(t.bg.formStart("Apps/Trip.md", "pack"), {
    fields: { item: ["Passport", "Phone charger", "Power bank", "Socks"] },
    row: { item: "Passport" },
  });
});

test("a checklist's copied link says it takes item", async () => {
  const t = packing();
  await t.bg.start();
  const [link] = t.bg.shortcutLinks();
  assert.deepEqual(link.fields, ["item"]);
  assert.match(linkNotice(link), /Add &item=… to say which item to tick\./);
});

test("an alias makes the shortcut when there is none, from its words; a bad alias is told once", () => {
  const spec = readSpec({ app: "a", panels: [{ view: "button", label: "Took meds", save: "doses", alias: "meds" }] }, { now: new Date(2026, 10, 18) })!.spec!;
  assert.equal(spec.panels[0].panel.shortcut, "meds");
  assert.equal(spec.panels[0].panel.alias, "meds");
  const both = readSpec({ app: "a", panels: [{ view: "button", label: "x", save: "d", alias: "m", shortcut: "took-meds" }] }, { now: new Date(2026, 10, 18) })!.spec!;
  assert.equal(both.panels[0].panel.shortcut, "took-meds");
  const words = readSpec({ app: "a", panels: [{ view: "form", fields: { bpm: "number" }, save: "hr", alias: "Resting heart rate" }] }, { now: new Date(2026, 10, 18) })!.spec!;
  assert.equal(words.panels[0].panel.shortcut, "resting-heart-rate");
  const bad = readSpec({ app: "a", panels: [{ view: "button", label: "x", save: "d", alias: "meds!" }] }, { now: new Date(2026, 10, 18) })!;
  assert.deepEqual(bad.errors, ["panel 1: alias must be words of letters and digits (with - and '), up to 40 characters"]);
  const none = readSpec({ app: "a", panels: [{ view: "button", label: "x", save: "d", alias: "体重" }] }, { now: new Date(2026, 10, 18) })!;
  assert.deepEqual(none.errors, ["panel 1: alias “体重” makes no shortcut (it has no letters a-z or digits); add shortcut: too"]);
});

test("a kit's param of several words makes a working alias, and in an embed the alias is left out without a word", () => {
  const kit = {
    component: "Log a number",
    params: { what: "weight" },
    panels: [{ view: "form", fields: { value: "number" }, save: "log", alias: "$what" }],
  };
  const notes = { resolve: (link: string) => (link === "Kit" ? "Kit.md" : undefined), frontmatter: (p: string) => (p === "Kit.md" ? kit : undefined) };
  const r = readSpec({ app: "a", use: "[[Kit]]", with: { what: "resting heart rate" } }, { now: new Date(2026, 10, 18), notes, path: "HR.md" })!;
  assert.deepEqual(r.errors, []);
  assert.equal(r.spec!.panels[0].panel.shortcut, "resting-heart-rate");
  const embedded = readSpec({ app: "a", use: "[[Kit]]", with: { what: "Weight" } }, { now: new Date(2026, 10, 18), notes, path: "Day.md", host: {} })!;
  assert.deepEqual(embedded.errors, []);
  assert.equal(embedded.spec!.panels[0].panel.alias, undefined);
  assert.equal(embedded.spec!.panels[0].panel.shortcut, undefined);
});

test("a kit's literal param may name the alias; an input may not", () => {
  const kit = {
    component: "Log a number",
    params: { what: "weight" },
    panels: [{ view: "form", fields: { value: "number" }, save: "$what", alias: "$what" }],
  };
  const notes = { resolve: (link: string) => (link === "Kit" ? "Kit.md" : undefined), frontmatter: (p: string) => (p === "Kit.md" ? kit : undefined) };
  const r = readSpec({ app: "a", use: "[[Kit]]", with: { what: "sleep" } }, { now: new Date(2026, 10, 18), notes, path: "Sleep.md" })!;
  assert.deepEqual(r.errors, []);
  assert.equal(r.spec!.panels[0].panel.alias, "sleep");
  assert.equal(r.spec!.panels[0].panel.shortcut, "sleep");
  const typed = readSpec({
    app: "a", inputs: { who: ["a", "b"] },
    panels: [{ view: "button", label: "x", save: "d", alias: "$who" }],
  }, { now: new Date(2026, 10, 18) })!;
  assert.ok(typed.errors.some((e) => e.includes('can\'t be used in "alias"')), typed.errors.join("\n"));
});
