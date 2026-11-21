import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { checkPanel } from "../src/spec.ts";
import { fakeEnv, fakeHost } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

function open(path: string, notes: Parameters<typeof fakeEnv>[0], lines: string[] = [], responses: Record<string, unknown> = {}) {
  const t = fakeEnv(notes, responses);
  t.source.lines = lines;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, path, t.env);
  app.load();
  return { ...t, root, app };
}

const NOTE = ["---", "app: Meds", "refresh: soon", "panels:", "  - view: text", "    text: ok", "  - view: gauge", "---"];
const MEDS = { "Apps/Meds.md": { fm: { app: "Meds", refresh: "soon", panels: [{ view: "text", text: "ok" }, { view: "gauge" }] } } };

const links = (root: Element) => [...root.querySelectorAll(".gz-error li")];

// ---- Errors that point at the line -------------------------------------------------------------------

test("the problems card links an error that names a panel, and leaves the others as text", async () => {
  const { root, source } = open("Apps/Meds.md", MEDS, NOTE);
  const items = links(root);
  assert.equal(items.length, 2);
  const placed = items.find((li) => li.querySelector(".gz-error-link"))!;
  const plain = items.find((li) => !li.querySelector(".gz-error-link"))!;
  const link = placed.querySelector("button.gz-error-link") as HTMLButtonElement;
  assert.match(text(link), /^panel 2: view must be one of /);
  assert.equal(text(placed), text(link));
  assert.equal(plain.querySelector(".gz-error-link"), null);
  assert.equal(text(plain), "refresh must look like 30s, 5m, 1h");

  link.click();
  await settle();
  assert.deepEqual(source.shownAt, [6]);
});

test("the line is looked up when the link is clicked, so it follows edits made since the card was drawn", async () => {
  const { root, source } = open("Apps/Meds.md", MEDS, NOTE);
  source.lines = ["---", "app: Meds", "# a note to self", "# another", ...NOTE.slice(2)];
  (root.querySelector("button.gz-error-link") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(source.shownAt, [8]);
});

test("when the note no longer has that panel, the link just opens the source", async () => {
  const t = open("Apps/Meds.md", MEDS, NOTE);
  let opened = 0;
  t.env.showSource = () => { opened++; };
  t.source.lines = ["---", "app: Meds", "---"];
  (t.root.querySelector("button.gz-error-link") as HTMLButtonElement).click();
  await settle();
  assert.equal(opened, 1);
  assert.deepEqual(t.source.shownAt, []);
});

test("an error from a component is a link to the app's panel that uses it", async () => {
  const lines = ["---", "app: Meds", "panels:", "  - view: text", "    text: ok", "  - use: \"[[Ticker]]\"", "---"];
  const { root, source } = open("Apps/Meds.md", {
    "Apps/Meds.md": { fm: { app: "Meds", panels: [{ view: "text", text: "ok" }, { use: "[[Ticker]]" }] } },
    "Components/Ticker.md": { fm: { component: "T", panels: [{ view: "gauge" }] } },
  }, lines);
  const link = root.querySelector("button.gz-error-link") as HTMLButtonElement;
  assert.match(text(link), /^panel 2 \(from \[\[Ticker\]\] panel 1\): view must be one of /);
  link.click();
  await settle();
  assert.deepEqual(source.shownAt, [5]);
});

test("a data block's error links to the block", async () => {
  const lines = ["---", "app: Meds", "data:", "  doses:", "    colour: red", "    source: doses", "panels:", "  - view: text", "    text: ok", "---"];
  const { root, source } = open("Apps/Meds.md", {
    "Apps/Meds.md": { fm: { app: "Meds", data: { doses: { colour: "red", source: "doses" } }, panels: [{ view: "text", text: "ok" }] } },
  }, lines);
  const link = root.querySelector("button.gz-error-link") as HTMLButtonElement;
  assert.equal(text(link), 'data.doses: unknown key "colour"');
  link.click();
  await settle();
  assert.deepEqual(source.shownAt, [3]);
});

test("a component note's own errors stay text, since they name the component, not a panel of this note", () => {
  const { root } = open("Components/T.md", { "Components/T.md": { fm: { component: "T", panels: [{ view: "gauge" }] } } }, ["---", "component: T", "panels:", "  - view: gauge", "---"]);
  assert.equal(links(root).length >= 1, true);
  assert.equal(root.querySelector(".gz-error-link"), null);
});

// ---- Data inspector ----------------------------------------------------------------------------------

const QUAKES = "https://earthquake.usgs.gov/feed";
const FEED = { features: [{ properties: { mag: 4.6, place: "A" } }, { properties: { mag: 3.1, place: "B" } }], metadata: { count: 2 } };
const NOW = { current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } };
const RESPONSES = { [QUAKES]: FEED, "https://api.open-meteo.com/forecast": NOW };

const PLANET = {
  app: "Planet",
  doses: [{ name: "vitamin D" }],
  panels: [
    { view: "number", title: "Strongest", source: QUAKES, pick: "features", field: "properties.mag", agg: "max" },
    { view: "list", title: "Places", source: QUAKES, pick: "features", item: "{properties.place}" },
    { view: "text", title: "Now", source: "https://api.open-meteo.com/forecast?lat=1", pick: "current", text: "{t}" },
    { view: "list", title: "Doses", source: "doses", item: "{name}" },
  ],
};

/** An app opened on a fake vault, once its panels have loaded. */
async function openApp(fm: Record<string, unknown>, responses: Record<string, unknown> = RESPONSES) {
  const t = open("Apps/Planet.md", { "Apps/Planet.md": { fm } }, [], responses);
  await settle();
  return t;
}

const shell = (root: Element) => root.querySelector(".gizmo")!;

test("inspect lists each distinct source once, under the first panel that uses it, with its raw data", async () => {
  const { app } = await openApp(PLANET);
  const found = await app.inspect();
  assert.deepEqual(found.map((s) => [s.title, s.kind]), [
    ["Strongest", "earthquake.usgs.gov"], ["Now", "api.open-meteo.com"], ["Doses", "list: doses"],
  ]);
  // Before the pick of the panels that read it.
  assert.deepEqual(found[0].data, FEED);
  assert.deepEqual(found[1].data, NOW);
  assert.deepEqual(found[2].data, [{ name: "vitamin D" }]);
  assert.equal(found[0].source, QUAKES);
  assert.equal(found[2].source, undefined);
});

test("inspecting makes no request the panels didn't", async () => {
  const t = await openApp(PLANET);
  const before = t.f.requests.length;
  assert.equal(before, 2);
  await t.app.inspect();
  await t.app.toggleInspector();
  assert.equal(t.f.requests.length, before);
});

test("sources differ by their notes scope too, and a panel waiting for typing isn't a source", async () => {
  const t = await openApp({
    app: "Notes",
    inputs: { q: "text" },
    panels: [
      { view: "list", title: "Books", source: "notes", from: "Books", item: "{name}" },
      { view: "list", title: "Reading", source: "notes", from: "Reading", item: "{name}" },
      { view: "list", title: "Again", source: "notes", from: "Books", item: "{name}" },
      { view: "list", title: "Search", source: "https://example.com/s?q=$q", item: "{title}" },
    ],
  });
  const found = await t.app.inspect();
  assert.deepEqual(found.map((s) => [s.title, s.kind]), [["Books", "notes: Books"], ["Reading", "notes: Reading"]]);
});

test("the action opens the pane above the panels, and closes it again", async () => {
  const { app, root } = await openApp(PLANET);
  assert.equal(root.querySelector(".gz-inspector"), null);
  await app.toggleInspector();
  const pane = root.querySelector(".gz-inspector")!;
  assert.ok(pane);
  const order = [...shell(root).children];
  assert.ok(order.indexOf(pane) < order.indexOf(root.querySelector(".gz-body")!));
  assert.deepEqual([...pane.querySelectorAll(".gz-inspect-head")].map(text), [
    "Strongest · earthquake.usgs.gov", "Now · api.open-meteo.com", "Doses · list: doses",
  ]);
  assert.equal(pane.querySelectorAll(".gz-inspect-source").length, 3);
  await app.toggleInspector();
  assert.equal(root.querySelector(".gz-inspector"), null);
  await app.toggleInspector();
  assert.equal(root.querySelectorAll(".gz-inspector").length, 1);
});

test("the pane sits above the input bar too, and a key in it copies its path", async () => {
  const t = await openApp({ ...PLANET, inputs: { period: ["a", "b"] } });
  await t.app.toggleInspector();
  const order = [...shell(t.root).children].map((c) => c.className.split(" ")[0]);
  assert.ok(order.indexOf("gz-inspector") < order.indexOf("gz-inputs"), order.join());
  const pane = t.root.querySelector(".gz-inspector")!;
  const tree = pane.querySelector(".gz-inspect-source .gz-tree > details")!;
  const features = [...tree.querySelectorAll(":scope > .gz-children > .gz-node")].find((n) => text(n.querySelector("button.gz-key")) === "features")!;
  features.setAttribute("open", "");
  features.dispatchEvent(new window.Event("toggle"));
  const zero = features.querySelector(".gz-children > .gz-node")!;
  zero.setAttribute("open", "");
  zero.dispatchEvent(new window.Event("toggle"));
  const props = [...zero.querySelectorAll(":scope > .gz-children > .gz-node")].find((n) => text(n.querySelector("button.gz-key")) === "properties")!;
  props.setAttribute("open", "");
  props.dispatchEvent(new window.Event("toggle"));
  const mag = [...props.querySelectorAll(".gz-leaf")].find((n) => text(n.querySelector("button.gz-key")) === "mag")!;
  (mag.querySelector("button.gz-key") as HTMLButtonElement).click();
  assert.deepEqual(t.copied, ["features.0.properties.mag"]);
});

test("a source that fails shows its problem in the pane", async () => {
  const t = await openApp({ app: "Down", panels: [{ view: "text", title: "Down", source: "https://x.example.com/fail", text: "{a}" }] }, {});
  await t.app.toggleInspector();
  assert.equal(text(t.root.querySelector(".gz-inspector .gz-inspect-error")), "x.example.com answered 503");
});

test("secrets never appear: the address keeps its placeholder, headers aren't shown", async () => {
  const t = await openApp({
    app: "Keyed",
    panels: [{
      view: "text", title: "Keyed", source: "https://api.example.com/x?key={secret:demo}", headers: { authorization: "Bearer {secret:demo}" },
      pick: "current", text: "{t}",
    }],
  }, { "https://api.example.com/x": { current: { t: 7 }, key: "echoed" } });
  // The request really carried the secret, so the check below isn't vacuous.
  assert.ok(t.f.requests.some((u) => u.includes("key=s3cret")));
  await t.app.toggleInspector();
  const pane = t.root.querySelector(".gz-inspector")!;
  assert.equal(text(pane.querySelector(".gz-inspect-url")), "https://api.example.com/x?key={secret:demo}");
  assert.equal(text(pane.querySelector(".gz-inspect-head")), "Keyed · api.example.com");
  assert.ok(!t.root.innerHTML.includes("s3cret"));
  assert.ok(!text(pane).includes("Bearer"));
  assert.ok(!text(pane).includes("authorization"));
});

test("the pane stays through unchanged redraws, and is filled anew when the app's keys change", async () => {
  const t = await openApp(PLANET);
  await t.app.toggleInspector();
  const pane = t.root.querySelector(".gz-inspector")!;
  const tree = pane.querySelector(".gz-tree > details")!;
  t.changed("Apps/Planet.md");
  await settle();
  assert.equal(t.root.querySelector(".gz-inspector"), pane);
  assert.equal(pane.querySelector(".gz-tree > details"), tree);

  const fm = t.f.files.get("Apps/Planet.md")!.fm!;
  (fm.panels as unknown[]).push({ view: "text", title: "More", source: "https://more.example.com/x", text: "{a}" });
  t.changed("Apps/Planet.md");
  await settle();
  assert.equal(t.root.querySelector(".gz-inspector"), pane);
  assert.deepEqual([...pane.querySelectorAll(".gz-inspect-head")].map(text).at(-1), "More · more.example.com");
  assert.equal(pane.querySelectorAll(".gz-inspect-source").length, 4);
});

test("an app with nothing to read says so, and the pane goes with the app", async () => {
  const t = await openApp({ app: "Plain", panels: [{ view: "text", title: "Hi", text: "hello" }] });
  await t.app.toggleInspector();
  assert.match(text(t.root.querySelector(".gz-inspector")), /No data to inspect/);
  t.app.dispose();
  assert.equal(t.root.querySelector(".gz-inspector"), null);
});

// ---- Component usage ----------------------------------------------------------------------------------

test("a component's usage hint has a Copy button that copies the snippet", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fm = { component: "Price and chart", params: { symbol: null, range: "6mo" }, panels: [{ view: "text", text: "x" }] };
    const { root, copied } = open("Components/Ticker.md", { "Components/Ticker.md": { fm } });
    const snippet = text(root.querySelector("pre.gz-example"));
    assert.equal(snippet, 'panels:\n  - use: "[[Ticker]]"\n    with: {symbol: …, range: 6mo}');
    const button = [...root.querySelectorAll("button")].find((b) => text(b) === "Copy") as HTMLButtonElement;
    assert.ok(button);
    assert.equal(button.closest(".gz-card")?.querySelector("pre.gz-example")?.textContent, snippet);
    button.click();
    assert.deepEqual(copied, [snippet]);
    assert.equal(text(button), "Copied");
    mock.timers.tick(1000);
    assert.equal(text(button), "Copy");
  } finally {
    mock.timers.reset();
  }
});

test("rawData is what a source returns before the pipeline, and shares the cache panelData reads", async () => {
  const f = fakeHost({ "Apps/A.md": { fm: { app: "A", doses: [{ n: 1 }, { n: 2 }] } } });
  const layer = new DataLayer(f.host);
  const files = { appPath: "Apps/A.md", dataPath: "Apps/A data.md" };
  const opts = { ttlMs: 60_000, now: new Date(2026, 10, 18) };
  const p = checkPanel({ view: "list", source: "https://api.example.com/x", pick: "current", item: "{t}" }, true).panel!;
  const whole = { current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } };
  assert.deepEqual(await layer.rawData(p.source, p, files, opts), whole);
  assert.deepEqual(await layer.panelData(p.source, p, files, opts), { t: 7 });
  assert.equal(f.requests.length, 1);
  assert.equal(await layer.rawData(undefined, p, files, opts), undefined);
  const doses = checkPanel({ view: "list", source: "doses", sort: "-n", item: "{n}" }, true).panel!;
  assert.deepEqual(await layer.rawData("doses", doses, files, opts), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(await layer.panelData("doses", doses, files, opts), [{ n: 2 }, { n: 1 }]);
});

test("an app still asking for permissions has no panels loaded, so there is nothing to inspect yet", async () => {
  const t = open("Apps/Planet.md", { "Apps/Planet.md": { fm: PLANET } }, [], RESPONSES);
  t.env.isGranted = () => false;
  t.app.load();
  await t.app.toggleInspector();
  assert.match(text(t.root.querySelector(".gz-inspector")), /No data to inspect/);
});
