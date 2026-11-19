import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController, type AppEnv } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { schemaOf, type NoteReader } from "../src/expand.ts";
import { panelIds, readSpec, resolvePanel, type Panel } from "../src/spec.ts";
import { askersOf, permissionsOf } from "../src/permissions.ts";
import { fakeHost } from "./support/fakes.ts";

const APP = "Apps/X.md";
const FILES = { appPath: APP, dataPath: "Apps/X data.md" };
const NOW = new Date(2026, 10, 18, 12);
const URL_Q = "https://earthquake.example.com/feed.json";
const QUAKES = ["A1", "B5", "C3", "D6", "E4.5", "F7"].map((s) => ({ place: s[0], mag: Number(s.slice(1)) }));

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

/** felt reads the list; strong reads felt; named reads strong. */
const CHAIN = {
  felt: { source: "quakes", where: { mag: "> 2" }, sort: "-mag" },
  strong: { source: "felt", where: { mag: "> 4" }, limit: 3 },
  named: { source: "strong", sort: "place" },
};

async function rows(p: Panel, data: Record<string, unknown> = { quakes: QUAKES }) {
  const f = fakeHost({ [FILES.dataPath]: { fm: data } });
  const out = await new DataLayer(f.host).panelData(p.source, p, FILES, { ttlMs: 0, now: NOW });
  return (out as { place: string }[]).map((r) => r.place).join("");
}

test("a chain runs each block's stage in order, root first, then the panel's own keys", async () => {
  const r = readSpec({
    app: "x",
    data: CHAIN,
    panels: [
      { view: "list", source: "named" },
      { view: "list", source: "named", sort: "-place" },
      { view: "list", source: "strong", limit: null },
      { view: "list", source: "strong", where: { mag: "< 6" } },
      { view: "list", source: "felt" },
    ],
  })!;
  assert.deepEqual(r.errors, []);
  const [named, reversed, unlimited, replaced, felt] = r.spec!.panels.map((ps) => ps.panel);
  assert.deepEqual(named, {
    view: "list", sort: "place", source: "quakes",
    upstream: [{ where: { mag: "> 2" }, sort: "-mag" }, { where: { mag: "> 4" }, limit: 3 }],
  });
  assert.equal(await rows(named), "BDF");
  assert.equal(await rows(reversed), "FDB");
  // The named block is a preset the panel can change; the blocks above it are fixed.
  assert.equal(await rows(unlimited), "FDBE");
  assert.equal(await rows(replaced), "BEC");
  assert.deepEqual(felt, { view: "list", where: { mag: "> 2" }, sort: "-mag", source: "quakes" });
  assert.equal(await rows(felt), "FDBEC");
});

test("chains that loop or run too deep are named and dropped", () => {
  const loop = readSpec({
    app: "x",
    data: { lead: { source: "a" }, a: { source: "b", limit: 1 }, b: { source: "a" }, fine: { source: "list" } },
    panels: [{ view: "list", source: "fine" }],
  })!;
  assert.deepEqual(loop.errors, ["data.a → data.b → data.a use each other"]);
  assert.deepEqual(Object.keys(loop.spec!.blocks), ["fine"]);

  const deep = readSpec({
    app: "x",
    data: { a: { source: "list" }, b: { source: "a" }, c: { source: "b" }, d: { source: "c" }, e: { source: "d" }, f: { source: "e" } },
    panels: [{ view: "list", source: "d" }],
  })!;
  assert.deepEqual(deep.errors, ["data.e → data.d → data.c → data.b → data.a is more than 4 blocks deep"]);
  assert.deepEqual(Object.keys(deep.spec!.blocks), ["a", "b", "c", "d"]);
  assert.equal(deep.spec!.panels[0].panel.source, "list");
});

test("only a chain's root says where data comes from; panels get the root's source keys", () => {
  const r = readSpec({
    app: "x",
    data: {
      quakes: { source: URL_Q, headers: { Accept: "application/json" }, pick: "features" },
      big: { source: "quakes", headers: { X: "1" }, from: "Health", record: "1h", where: { "properties.mag": "> 5" } },
    },
    panels: [{ view: "number", source: "big" }, { view: "number", source: "big", headers: null }],
  })!;
  assert.deepEqual(r.errors, [
    'data.big: "headers" belongs on data.quakes, where the source is',
    'data.big: "from" belongs on data.quakes, where the source is',
    'data.big: "record" belongs on data.quakes, where the source is',
  ]);
  const [own, cleared] = r.spec!.panels.map((ps) => ps.panel);
  assert.deepEqual(own, {
    view: "number", where: { "properties.mag": "> 5" }, headers: { Accept: "application/json" }, source: URL_Q,
    upstream: [{ pick: "features" }],
  });
  assert.equal(cleared.headers, undefined);
});

test("blocks keep fields, record and into, checked", () => {
  const r = readSpec({
    app: "x",
    data: {
      kp: { source: URL_Q, record: "1h", into: "kp_samples", fields: { kp: "number", level: ["calm", "storm"] } },
      a: { source: URL_Q, record: "often", into: "panels", fields: { w: "kilos" } },
      b: { source: URL_Q, into: "b_log" },
      c: { source: URL_Q, record: 5, into: "https://elsewhere.example.com" },
    },
    panels: [{ view: "number", source: "kp" }],
  })!;
  assert.deepEqual(r.errors, [
    "data.a: record must look like 10m, 1h, 1d",
    'data.a: into can\'t use "panels", which names part of the app',
    'data.a: field "w" type must be one of text, number, date, time, checkbox, textarea or a list of choices',
    'data.b: "into" needs "record"',
    "data.c: into must name a list, e.g. into: kp_log",
  ]);
  assert.deepEqual(r.spec!.blocks.kp, { source: URL_Q, record: "1h", into: "kp_samples", fields: { kp: "number", level: ["calm", "storm"] } });
  assert.deepEqual(r.spec!.blocks.a, { source: URL_Q });
  assert.deepEqual(r.spec!.blocks.c, { source: URL_Q, record: 5 });
});

test("into can't name a kind of source", () => {
  const r = readSpec({
    app: "x",
    data: { a: { source: URL_Q, record: "1h", into: "tasks" }, b: { source: URL_Q, record: "1h", into: "notes" } },
    panels: [{ view: "number", source: "a" }],
  })!;
  assert.deepEqual(r.errors, [
    'data.a: into can\'t use "tasks", which names a kind of source',
    'data.b: into can\'t use "notes", which names a kind of source',
  ]);
});

test("a panel gets the nearest fields up its chain as its schema, never as fields", () => {
  const r = readSpec({
    app: "x",
    data: {
      books: { source: "notes", from: "Books", fields: { status: ["to read", "done"], rating: "number" } },
      unread: { source: "books", where: { status: "to read" } },
      rated: { source: "books", fields: { rating: "number" } },
    },
    panels: [
      { view: "table", source: "unread" },
      { view: "table", source: "rated" },
      { view: "table", source: "books" },
      { view: "list", source: "notes", from: "Books" },
    ],
  })!;
  assert.deepEqual(r.errors, []);
  const [unread, rated, books, plain] = r.spec!.panels.map((ps) => ps.panel);
  assert.deepEqual(unread.schema, { status: ["to read", "done"], rating: "number" });
  assert.deepEqual(rated.schema, { rating: "number" });
  assert.deepEqual(books.schema, unread.schema);
  assert.equal(plain.schema, undefined);
  assert.ok(!("fields" in unread) && !("fields" in books));
  assert.deepEqual(unread.upstream, undefined, "a root with only source keys adds no stage");
  assert.equal(unread.from, "Books");
  assert.deepEqual(schemaOf("unread", r.spec!.blocks), unread.schema);
  assert.equal(schemaOf("nothing", r.spec!.blocks), undefined);
});

test("a chained panel asks for its root's host and secrets, named by the note that typed them", () => {
  const notes: Record<string, Record<string, unknown>> = {
    "C.md": {
      component: "c",
      params: ["min"],
      data: { quakes: { source: `${URL_Q}?k={secret:demo}`, pick: "features" }, big: { source: "quakes", where: { mag: "> $min" } } },
      panels: [{ view: "number", source: "big" }],
    },
  };
  const reader: NoteReader = { resolve: (l) => (`${l}.md` in notes ? `${l}.md` : undefined), frontmatter: (p) => notes[p] };
  const r = readSpec({
    app: "x",
    data: { mine: { source: "https://other.example.com/q", pick: "items" }, near: { source: "mine", limit: 1 } },
    panels: [
      { use: "[[C]]", with: { min: 5 } },
      { use: "[[C]]", with: { min: 6 }, source: "near" },
      { use: "[[C]]", with: { min: 7 }, source: "https://third.example.com/q", upstream: [] },
    ],
  }, { notes: reader, path: APP })!;
  assert.deepEqual(r.errors, ['panel 3: unknown key "upstream"']);
  const [inner, near, plain] = r.spec!.panels;
  assert.deepEqual(inner.panel, {
    view: "number", where: { mag: "> 5" }, source: `${URL_Q}?k={secret:demo}`, upstream: [{ pick: "features" }], secrets: ["demo"],
  });
  assert.equal(inner.writtenIn.source, "C.md");
  // A source beside use brings its own chain in place of the component's; its preset keys stay.
  assert.deepEqual(near.panel, { view: "number", where: { mag: "> 6" }, source: "https://other.example.com/q", limit: 1, upstream: [{ pick: "items" }] });
  assert.deepEqual([near.writtenIn.source, near.writtenIn.upstream], [APP, APP]);
  assert.deepEqual(plain.panel, { view: "number", where: { mag: "> 7" }, source: "https://third.example.com/q" });
  assert.deepEqual(permissionsOf(r.spec!, APP), ["net:earthquake.example.com", "net:other.example.com", "net:third.example.com", "secret:demo"]);
  const askers = askersOf(r.spec!, APP);
  assert.deepEqual([...askers.get("net:earthquake.example.com")!], ["C.md"]);
  assert.deepEqual([...askers.get("secret:demo")!], ["C.md"]);
  assert.deepEqual([...askers.get("net:other.example.com")!], [APP]);
});

test("the chain is part of a panel's identity", () => {
  const ids = (data: Record<string, unknown>) => panelIds(readSpec({ app: "x", data, panels: [{ view: "list", source: "named" }] })!.spec!.panels.map((ps) => ps.template));
  const before = ids(CHAIN);
  assert.deepEqual(ids(structuredClone(CHAIN)), before);
  assert.notDeepEqual(ids({ ...CHAIN, felt: { ...CHAIN.felt, where: { mag: "> 3" } } }), before);
});

test("an input used in a block above the named one is filled, checked and reloads the panel", async () => {
  const fm = {
    app: "Quakes",
    inputs: { min: [4, 6] },
    data: { felt: { source: "quakes", where: { mag: "> $min" } }, top: { source: "felt", sort: "-mag" } },
    panels: [{ view: "list", source: "top", item: "{place}" }, { view: "countdown", to: "2027-01-01" }],
  };
  const spec = readSpec(fm, { now: NOW })!.spec!;
  assert.deepEqual(spec.panels[0].inputs, ["min"]);
  assert.deepEqual(resolvePanel(spec.panels[0], { min: 6 }).panel!.upstream, [{ where: { mag: "> 6" } }]);

  const f = fakeHost({ "Apps/Q.md": { fm }, "Apps/Q data.md": { fm: { quakes: QUAKES } } });
  const env = {
    data: new DataLayer(f.host),
    frontmatter: (path: string) => f.files.get(path)?.fm,
    notes: { resolve: () => undefined, frontmatter: () => undefined },
    isGranted: () => true, granted: () => [], grant: async () => {},
    storePath: (s: string) => s, writeFrontmatter: async () => {}, updateFrontmatter: async () => false, appendLine: async () => {},
    createNote: async () => false, readBody: async () => "", setTaskDone: async () => false,
    notify: () => {}, openNote: () => {}, showSource: () => {}, showSourceAt: () => {}, sourceLines: async () => [], copy: () => {}, now: () => NOW,
  } satisfies AppEnv;
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Q.md", env).load();
  await settle();
  const list = root.querySelector(".gz-view-list")!;
  assert.equal(text(list.querySelector(".gz-list")), "FDBE");
  const select = root.querySelector('select[aria-label="min"]')!;
  for (const o of select.querySelectorAll("option")) {
    if (o.textContent === "6") o.setAttribute("selected", "");
    else o.removeAttribute("selected");
  }
  select.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(root.querySelector(".gz-view-list"), list);
  assert.equal(text(list.querySelector(".gz-list")), "F");
});

test("a stage is checked again for each choice an input can take", () => {
  const r = readSpec({
    app: "x",
    inputs: { p: ["day", "fortnight"] },
    data: { log: { source: "sessions", group: "at", per: "$p" }, recent: { source: "log", limit: 5 } },
    panels: [{ view: "table", source: "recent" }],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, ["panel 1: data.log: per must be one of day, week, month, year (when $p is fortnight)"]);
});

test("two panels on different blocks of one chain share one request", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const spec = readSpec({
    app: "x",
    data: { forecast: { source: "https://api.example.com/forecast?lat=1" }, now: { source: "forecast", pick: "current" } },
    panels: [{ view: "number", source: "now", field: "t" }, { view: "line", source: "forecast", pick: "hourly", x: "time", y: "t" }],
  })!.spec!;
  const data = await Promise.all(spec.panels.map(({ panel: p }) => dl.panelData(p.source, p, FILES, { ttlMs: 60_000, now: NOW })));
  assert.equal(f.requests.length, 1);
  assert.deepEqual(data[0], { t: 7 });
});

test("a component's blocks follow the same chain rules", () => {
  const notes: Record<string, Record<string, unknown>> = {
    "C.md": {
      component: "c",
      data: { a: { source: "b" }, b: { source: "a" }, root: { source: "log", sort: "-at" }, last: { source: "root", limit: 1, headers: { X: "1" } } },
      panels: [{ view: "list", source: "last" }],
    },
  };
  const reader: NoteReader = { resolve: (l) => (`${l}.md` in notes ? `${l}.md` : undefined), frontmatter: (p) => notes[p] };
  const r = readSpec({ app: "x", panels: [{ use: "[[C]]" }] }, { notes: reader, path: APP })!;
  assert.deepEqual(r.errors, [
    "panel 1: [[C]] data.a → data.b → data.a use each other",
    'panel 1: [[C]] data.last: "headers" belongs on data.root, where the source is',
  ]);
  assert.deepEqual(r.spec!.panels[0].panel, { view: "list", limit: 1, source: "log", upstream: [{ sort: "-at" }] });
  assert.deepEqual(r.spec!.blocks, {}, "only the app's own blocks are listed");
});
