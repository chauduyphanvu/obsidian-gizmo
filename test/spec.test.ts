import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration, readSpec } from "../src/spec.ts";
import { describePermission, permissionsOf } from "../src/permissions.ts";

test("a note without app is not an app", () => {
  assert.equal(readSpec({ tags: ["x"] }), undefined);
  assert.equal(readSpec(undefined), undefined);
});

test("an app line alone has no panels yet", () => {
  assert.deepEqual(readSpec({ app: "Weather in London" }), { errors: [], empty: true });
});

test("top-level keys make one panel and ignore unrelated properties", () => {
  const r = readSpec({ app: "Days to renewal", view: "countdown", to: "2026-10-03", tags: ["benefits"], created: "x" });
  assert.deepEqual(r?.errors, []);
  assert.deepEqual(r?.spec?.panels.map((ps) => ps.panel), [{ view: "countdown", to: "2026-10-03" }]);
});

test("panels are checked strictly", () => {
  const r = readSpec({
    app: "x",
    panels: [
      { view: "line", source: "weights" },
      { view: "number", source: "weights", colour: "red" },
      { view: "gauge" },
    ],
  });
  assert.deepEqual(r?.errors, [
    "panel 1: line needs x and y",
    'panel 2: unknown key "colour"',
    "panel 3: view must be one of number, text, line, bar, pie, table, list, button, form, checklist, countdown, progress, timer, calendar, board, scatter, timeline, alerts",
  ]);
  // A stray key is reported but doesn't stop an otherwise valid panel from showing.
  assert.deepEqual(r?.spec?.panels.map((ps) => ps.panel), [{ view: "number", source: "weights" }]);
});

test("actions only apply to action views, and buttons need one", () => {
  const r = readSpec({ app: "x", panels: [{ view: "number", source: "a", append: "Daily.md" }, { view: "button" }] });
  assert.deepEqual(r?.errors, [
    'panel 1: "append" doesn\'t apply to number',
    "panel 2: button needs at least one of save, append, notify",
  ]);
});

test("refresh durations", () => {
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("soon"), undefined);
  assert.deepEqual(readSpec({ app: "x", view: "text", text: "hi", refresh: "fast" })?.errors, ["refresh must look like 30s, 5m, 1h"]);
});

test("permissions come from the keys", () => {
  const spec = readSpec({
    app: "x",
    panels: [
      { view: "line", source: "https://api.example.com/q?k={secret:demo}", x: "t", y: "v", headers: { Authorization: "Bearer {secret:other}" } },
      { view: "list", source: "notes", from: "#health" },
      { view: "button", append: "Daily", save: "log" },
      { view: "button", append: "Apps/Me.md" },
    ],
  })!.spec!;
  assert.deepEqual(permissionsOf(spec, "Apps/Me.md"), [
    "net:api.example.com",
    "read:#health",
    "secret:demo",
    "secret:other",
    "write:Daily.md",
  ]);
});

test("save can't write over the app's own keys", () => {
  const r = readSpec({ app: "x", panels: [{ view: "button", save: "panels" }, { view: "checklist", items: ["a"], save: "app" }] });
  assert.deepEqual(r?.errors, [
    'panel 1: save can\'t use "panels", which names part of the app',
    'panel 2: save can\'t use "app", which names part of the app',
  ]);
});

test("save can't be named after a kind of source, since source: would read the kind instead", () => {
  const r = readSpec({ app: "x", panels: [{ view: "button", save: "tasks" }, { view: "form", fields: { a: "text" }, save: "notes" }, { view: "button", save: "tasks/" }] });
  assert.deepEqual(r?.errors, [
    'panel 1: save can\'t use "tasks", which names a kind of source',
    'panel 2: save can\'t use "notes", which names a kind of source',
  ]);
  // `this` keeps its own meaning on a form.
  assert.deepEqual(readSpec({ app: "x", panels: [{ view: "form", fields: { a: "text" }, save: "this" }] }, { host: {} })?.errors, []);
});

test("spec 1 or none is read; anything else draws nothing", () => {
  const panel = { view: "countdown", to: "2027-01-01" };
  assert.equal(readSpec({ app: "x", ...panel })?.spec?.panels.length, 1);
  assert.equal(readSpec({ app: "x", spec: 1, ...panel })?.spec?.panels.length, 1);
  const newer = readSpec({ app: "x", spec: 2, ...panel });
  assert.equal(newer?.spec, undefined);
  assert.deepEqual(newer?.errors, ["spec: 2 needs a newer Gizmo (this one reads spec 1)"]);
  assert.deepEqual(readSpec({ app: "x", spec: "1", ...panel })?.errors, ["spec must be 1"]);
});

test("lists can't be named after the app's own keys, and secrets stay out of hosts", () => {
  const r = readSpec({
    app: "x",
    panels: [
      { view: "number", source: "data" },
      { view: "number", source: "https://{secret:k}.example.com/v1" },
      { view: "number", source: "https://api.example.com/v1?key={secret:k}" },
    ],
  });
  assert.deepEqual(r?.errors, [
    'panel 1: source can\'t use "data", which names part of the app',
    "panel 2: a secret can't be part of the host; put it in the path, the query or headers",
  ]);
  assert.equal(r?.spec?.panels.length, 1);
});

test("a single top-level panel's identity ignores the note's other properties", () => {
  const a = readSpec({ app: "x", tags: ["a"], view: "countdown", to: "2027-01-01" })!.spec!.panels[0];
  const b = readSpec({ app: "y", tags: ["b"], view: "countdown", to: "2027-01-01" })!.spec!.panels[0];
  assert.deepEqual(a.template, b.template);
  assert.deepEqual(a.template, { view: "countdown", to: "2027-01-01" });
});

test("span takes 1 to 4 columns", () => {
  const r = readSpec({ app: "x", panels: [{ view: "countdown", to: "2027-01-01", span: 5 }, { view: "countdown", to: "2027-01-01", span: 2, tab: "A" }] });
  assert.deepEqual(r?.errors, ["panel 1: span must be 1, 2, 3 or 4"]);
});

test("a key a permission is made from can't hold a line break, which would make one line of the prompt read as several", () => {
  const read = (fm: Record<string, unknown>) => readSpec({ app: "x", ...fm }, { path: "Apps/X.md" })!;
  const r = read({ panels: [{ view: "form", fields: { title: "text" }, save: "Inbox\nedit:*\nread:*/" }, { view: "countdown", to: "2026-12-01" }] });
  assert.deepEqual(r.errors, ['panel 1: "save" can\'t hold a line break or other control character']);
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel.view), ["countdown"]);
  assert.deepEqual(permissionsOf(r.spec!, "Apps/X.md"), []);
  for (const [key, panel] of [
    ["from", { view: "table", source: "notes", from: "Journal\r\nedit:*" }],
    ["append", { view: "button", label: "Go", append: "Log\tx" }],
    ["then", { view: "button", label: "Go", then: { app: "Errands\nread:*", do: "add" } }],
    ["source", { view: "table", source: "Finance/bank\n.csv" }],
  ] as const) {
    assert.deepEqual(read({ panels: [panel] }).errors, [`panel 1: "${key}" can't hold a line break or other control character`], key);
  }
  const stored = read({ view: "button", label: "Go", save: "log", store: "[[Log\nedit:*]]" });
  assert.deepEqual(stored.errors, ['store can\'t hold a line break or other control character']);
  assert.equal(stored.spec!.store, undefined);
});

test("a request that carries a note's property, a picked row or what someone types says what it sends, and to whom", () => {
  const perms = (fm: Record<string, unknown>) => {
    const r = readSpec({ app: "x", ...fm }, { path: "Apps/X.md" })!;
    assert.deepEqual(r.errors, []);
    return permissionsOf(r.spec!, "Apps/X.md");
  };
  assert.deepEqual(perms({
    inputs: { q: "text", sort: ["new", "old"], day: "date" },
    held: [{ symbol: "AAPL" }],
    panels: [
      { view: "list", title: "Books", source: "https://openlibrary.org/search.json?q=$q&sort=$sort&d=$day", item: "{title}" },
      { view: "table", source: "held", select: "holding" },
      { view: "number", source: "https://quotes.example/v8/$holding.symbol", headers: { "X-Note": "$this.rating" }, field: "price" },
      { view: "number", source: "https://api.example.com/plain?d=$day", field: "n" },
    ],
  }), [
    "net:api.example.com",
    "net:openlibrary.org",
    "net:quotes.example",
    "send:openlibrary.org|typed.q",
    "send:quotes.example|picked.holding.symbol",
    "send:quotes.example|this.rating",
  ]);
  assert.equal(describePermission("send:openlibrary.org|typed.q"), "Send what you type in q to openlibrary.org");
  assert.equal(describePermission("send:quotes.example|picked.holding.symbol"), "Send the picked holding's symbol to quotes.example");
  assert.equal(describePermission("send:quotes.example|this.rating"), "Send the note's rating to quotes.example");
  // A POST body's values are sent too.
  assert.deepEqual(perms({ inputs: { note: "text" }, panels: [{ view: "text", source: "https://hooks.example/in", body: { text: "$note" }, text: "{ok}" }] }),
    ["net:hooks.example", "post:hooks.example", "send:hooks.example|typed.note"]);
});
