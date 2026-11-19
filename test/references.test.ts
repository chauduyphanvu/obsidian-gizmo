import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteReader } from "../src/expand.ts";
import { readSpec, resolvePanel } from "../src/spec.ts";
import { InputRef, InputText, fillParams, parseInputs, resolveInputs } from "../src/template.ts";

const APP = "Apps/W.md";
const NOW = new Date(2026, 10, 18, 9);
const QUAKE = { id: "us7000", properties: { mag: 6.1, place: "Near Lima" }, tags: ["big", "felt"] };

const reader = (notes: Record<string, Record<string, unknown>>): NoteReader => ({
  resolve: (link) => Object.keys(notes).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
  frontmatter: (path) => notes[path],
});

test("$name.path reads inside a value, whole or inside text", () => {
  const names = new Set(["quake", "symbol"]);
  const values = { quake: QUAKE, symbol: "SPY" };
  const fill = (raw: unknown, key = "text") => resolveInputs(parseInputs(raw, names, key), values);
  assert.deepEqual(parseInputs("$quake.properties.mag", names), new InputRef("quake", "properties.mag"));
  assert.equal(fill("$quake.properties.mag", "where"), 6.1);
  assert.equal(fill("$quake.tags.1"), "felt");
  assert.deepEqual(fill("$quake.tags", "where"), ["big", "felt"]);
  assert.equal(fill("M$quake.properties.mag near $quake.properties.place"), "M6.1 near Near Lima");
  assert.equal(fill("$quake.nope"), undefined);
  assert.equal(fill("[$quake.nope]"), "[]");
  assert.equal(fill("https://api.example.com/q?near=$quake.properties.place", "source"), "https://api.example.com/q?near=Near%20Lima");
});

test("a full stop or comma after a name ends it; a path after a scalar is text as before", () => {
  const names = new Set(["symbol", "range", "period"]);
  const values = { symbol: "SPY", range: "6mo", period: "week" };
  const fill = (raw: string, key = "title") => resolveInputs(parseInputs(raw, names, key), values);
  // Titles and sources from the fixtures in test/vault.
  assert.equal(fill("$symbol, last $range"), "SPY, last 6mo");
  assert.equal(fill("Earthquakes, past $period"), "Earthquakes, past week");
  assert.equal(fill("Price of $symbol."), "Price of SPY.");
  assert.equal(fill("Is it $symbol...?"), "Is it SPY...?");
  assert.equal(fill("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_$period.geojson", "source"),
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson");
  const r = readSpec({
    app: "x",
    inputs: { period: ["week", "day"] },
    data: { quakes: { source: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_$period.geojson", pick: "features" } },
    panels: [{ view: "number", title: "Earthquakes, past $period.", source: "quakes" }],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, []);
  const day = resolvePanel(r.spec!.panels[0], { period: "day" }).panel!;
  assert.equal(day.source, "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson");
  assert.equal(day.title, "Earthquakes, past day.");
});

test("a param holding a set of keys is read with a path, in the component and passed on", () => {
  const notes = {
    "Outer.md": { component: "o", params: ["at"], panels: [{ use: "[[Inner]]", with: { where: "$at", lat: "$at.lat" } }] },
    "Inner.md": {
      component: "i",
      params: ["where", "lat"],
      panels: [
        { view: "number", title: "$where.name now", source: "https://api.example.com/w?lat=$where.lat&lon=$where.lon&n=$where.name" },
        { view: "number", source: "https://api.example.com/x", limit: "$lat" },
        { view: "text", text: "Weather in $where" },
      ],
    },
  };
  const r = readSpec({ app: "x", panels: [{ use: "[[Outer]]", with: { at: { name: "New York", lat: 40, lon: -74 } } }] },
    { notes: reader(notes), path: APP, now: NOW })!;
  assert.deepEqual(r.errors, ["panel 1 (from [[Outer]] panel 1 → [[Inner]] panel 3): $where holds a list or a set of keys, so it can only be a whole value"]);
  const [first, second] = r.spec!.panels.map((ps) => ps.panel);
  assert.equal(first.title, "New York now");
  assert.equal(first.source, "https://api.example.com/w?lat=40&lon=-74&n=New%20York");
  assert.equal(second.limit, 40);
});

test("an input passed through with keeps its path until it is filled", () => {
  const params = new Map<string, unknown>([["q", new InputRef("quake")], ["t", new InputText(["about ", new InputRef("quake", "id")], false)]]);
  const errors: string[] = [];
  assert.deepEqual(fillParams("$q.properties.mag", params, errors), new InputRef("quake", "properties.mag"));
  const text = fillParams("https://api.example.com/e/$q.id?m=$q.properties.mag", params, errors, "source") as InputText;
  assert.deepEqual(text, new InputText(["https://api.example.com/e/", new InputRef("quake", "id"), "?m=", new InputRef("quake", "properties.mag")], true));
  assert.equal(resolveInputs(text, { quake: QUAKE }), "https://api.example.com/e/us7000?m=6.1");
  assert.equal(resolveInputs(fillParams("$t.", params, errors), { quake: QUAKE }), "about us7000.");
  assert.deepEqual(errors, []);
});

test("a value with a secret or a line break, or a row where text goes, is a problem, not a value", () => {
  const names = new Set(["q", "quake"]);
  const cases: [unknown, string, Record<string, unknown>, string[]][] = [
    ["https://api.example.com/s?q=$q", "source", { q: "a{secret:demo}" }, ["$q can't hold a secret or a line break"]],
    [{ Authorization: "Bearer $q" }, "headers", { q: "x\r\nHost: evil.example.com" }, ["$q can't hold a secret or a line break"]],
    [{ query: "find $q" }, "body", { q: "two\nlines" }, ["$q can't hold a secret or a line break"]],
    ["About $quake", "title", { quake: QUAKE }, ["say which field: $quake.id"]],
    ["About $quake.properties", "title", { quake: QUAKE }, ["say which field: $quake.properties.id"]],
    ["$quake.properties.place", "title", { quake: { properties: { place: "{secret:demo}" } } }, ["$quake.properties.place can't hold a secret or a line break"]],
    ["https://api.example.com/s?q=$q&id=$quake.id", "source", { q: "a b/c?d", quake: QUAKE }, []],
  ];
  for (const [raw, key, values, want] of cases) {
    const problems: string[] = [];
    resolveInputs(parseInputs(raw, names, key), values, problems);
    assert.deepEqual(problems, want, JSON.stringify(raw));
  }
  // Inside a URL the value is encoded, so it can't start a new query parameter or path.
  assert.equal(resolveInputs(parseInputs("https://api.example.com/s?q=$q&id=$quake.id", names, "source"), { q: "a b/c?d&e=1", quake: QUAKE }),
    "https://api.example.com/s?q=a%20b%2Fc%3Fd%26e%3D1&id=us7000");
});

test("a panel whose filled value has a problem resolves to that error", () => {
  const r = readSpec({
    app: "x",
    inputs: { q: ["dune"] },
    panels: [{ view: "list", title: "Books", source: "https://openlibrary.example.org/search.json?q=$q", headers: { "X-Q": "$q" } }],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, []);
  const ps = r.spec!.panels[0];
  assert.deepEqual(resolvePanel(ps, { q: "a{secret:demo}" }), { errors: ["$q can't hold a secret or a line break"] });
  assert.deepEqual(resolvePanel(ps, { q: "two\nlines" }), { errors: ["$q can't hold a secret or a line break"] });
  assert.equal(resolvePanel(ps, { q: "war & peace" }).panel!.source, "https://openlibrary.example.org/search.json?q=war%20%26%20peace");
});

test("a path that goes on past a field's value is text after it, in a source, in text and from $this", () => {
  const names = new Set(["q", "period"]);
  const values = { q: { id: 42, slug: "a/b", items: ["x"], nested: { n: 1 } }, period: 2.5 };
  const fill = (raw: string, key = "text") => resolveInputs(parseInputs(raw, names, key), values);
  assert.equal(fill("https://api.example.com/item/$q.id.json", "source"), "https://api.example.com/item/42.json");
  // Only the value is encoded; the text after it is as typed.
  assert.equal(fill("https://api.example.com/item/$q.slug.json", "source"), "https://api.example.com/item/a%2Fb.json");
  assert.equal(fill("Item $q.id.json"), "Item 42.json");
  assert.equal(fill("$q.items.0.txt"), "x.txt");
  assert.equal(fill("$q.nested.n.of.total"), "1.of.total");
  assert.equal(fill("$q.nested.n", "where"), 1);
  // A key missing on the way leaves the whole reference empty.
  assert.equal(fill("[$q.nope.json]"), "[]");
  assert.equal(fill("$q.nested.nope.json", "where"), undefined);
  // A scalar input, as before.
  assert.equal(fill("https://api.example.com/2.5_$period.geojson", "source"), "https://api.example.com/2.5_2.5.geojson");

  const r = readSpec({
    app: "Q",
    panels: [
      { view: "list", title: "Pick", source: "items", select: "q" },
      { view: "text", title: "Detail", source: "https://api.example.com/item/$q.id.json", text: "{x}" },
      { view: "text", title: "City", source: "https://api.example.com/city/$this.city.json", text: "{x} in $this.city.name" },
    ],
  }, { path: APP })!;
  assert.deepEqual(r.errors, []);
  const [, detail, city] = r.spec!.panels;
  assert.equal(resolvePanel(detail, { q: { id: 42 } }).panel!.source, "https://api.example.com/item/42.json");
  const here = resolvePanel(city, { this: { city: "Paris" } }).panel!;
  assert.equal(here.source, "https://api.example.com/city/Paris.json");
  assert.equal(here.text, "{x} in Paris.name");
});
