import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import type { NoteReader } from "../src/expand.ts";
import { checkPanel, readSpec, resolvePanel, startingValues, type Panel } from "../src/spec.ts";
import { readInputs } from "../src/template.ts";
import { pie } from "../src/views/pie.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { fakeEnv } from "./support/fakes.ts";

const APP = "Apps/W.md";
const NOW = new Date(2026, 10, 18, 12);
const settle = async (ms = 10) => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, ms)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const key = (el: Element, name: string) => {
  const e = new window.Event("keydown", { bubbles: true }) as Event & { key: string };
  e.key = name;
  el.dispatchEvent(e);
};

const reader = (notes: Record<string, Record<string, unknown>>): NoteReader => ({
  resolve: (link) => Object.keys(notes).find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
  frontmatter: (path) => notes[path],
});

const QUAKES = "https://quakes.example.com/feed";
// On the grid, where a panel waiting for a pick says where to pick; compose.test.ts has the composed sheet.
const MASTER_DETAIL = {
  app: "Quakes",
  layout: "grid",
  data: { quakes: { source: QUAKES, pick: "features" } },
  panels: [
    { view: "list", title: "Strongest", source: "quakes", item: "{place}", select: "quake" },
    { view: "text", title: "Detail", text: "M$quake.mag at $quake.place" },
    { view: "number", source: "https://detail.example.com/q?id=$quake.id", pick: "current", field: "t" },
  ],
};
const FEATURES = { features: [{ id: "a1", place: "Lima", mag: 6.1 }, { id: "b2", place: "Oslo", mag: 4.2 }] };

function open(fm: Record<string, unknown>, notes: Record<string, { fm?: Record<string, unknown> }> = {}) {
  const t = fakeEnv({ [APP]: { fm }, ...notes }, { [QUAKES]: FEATURES });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const start = () => { const app = new AppController(root, APP, t.env); app.load(); return app; };
  return { ...t, root, start };
}

test("a search box is a third kind of input; it starts with no value", () => {
  const errors: string[] = [];
  const defs = readInputs({ q: "text", n: [1, 2] }, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(defs.map((d) => [d.name, d.kind]), [["q", "text"], ["n", "choice"]]);
  assert.deepEqual(startingValues(defs, NOW), { n: 1 });
});

test("select declares a name other panels read as $name.field, refused where inputs are", () => {
  const r = readSpec(MASTER_DETAIL, { now: NOW })!;
  assert.deepEqual(r.errors, []);
  const [list, detail, number] = r.spec!.panels;
  assert.equal(list.panel.select, "quake");
  assert.deepEqual(r.spec!.selections, ["quake"]);
  assert.deepEqual([list.inputs, detail.inputs, number.inputs], [[], ["quake"], ["quake"]]);
  assert.deepEqual(resolvePanel(detail, {}), { errors: [], waiting: "quake" });
  assert.equal(resolvePanel(detail, { quake: FEATURES.features[0] }).panel!.text, "M6.1 at Lima");
  assert.equal(resolvePanel(number, { quake: { id: "a 1/2" } }).panel!.source, "https://detail.example.com/q?id=a%201%2F2");

  const bad = readSpec({
    app: "x",
    inputs: { symbol: ["SPY"], q: "text" },
    panels: [
      { view: "list", source: "s", select: "symbol", item: "$symbol" },
      { view: "list", source: "s", select: "my book" },
      { view: "list", source: "a", select: "pick" },
      { view: "table", source: "b", select: "pick" },
      { view: "text", text: "Picked $pick" },
      { view: "list", source: "notes", from: "$pick.folder" },
      { view: "list", source: "$pick.list" },
      { view: "list", source: "https://$pick.host/x" },
      { view: "table", source: "c", select: "spare" },
      { view: "list", source: "https://api.example.com/s?q=$q", where: { id: "$pick.id" } },
    ],
  }, { now: NOW })!;
  assert.deepEqual(bad.errors, [
    'panel 1: select: "symbol" is already an input',
    'panel 2: select: "my book" can only use letters, digits and _',
    'panel 4: two panels select "pick"',
    "panel 5: say which field: $pick.id",
    'panel 6: $pick can\'t be used in "from"',
    "panel 7: $pick can't choose the source; use it in a URL's path or query, or in where",
    "panel 8: $pick can't be part of a URL's host",
    'panel 9: selection "spare" isn\'t used by any panel',
  ]);
});

test("panels reading late values are checked with stand-ins, so only real problems show", () => {
  const r = readSpec({
    app: "x",
    inputs: { q: "text" },
    panels: [
      { view: "list", source: "events", select: "ev", item: "{title}" },
      { view: "countdown", to: "$ev.date", label: "$ev.title" },
      { view: "list", source: "https://api.example.com/s?q=$q", limit: "$ev.n", sort: "$q" },
      { view: "line", source: "events", x: "$ev.x" },
      { view: "list", source: "https://api.example.com/s?q=$q", headers: { "X-Q": "$q" } },
    ],
  }, { now: NOW })!;
  assert.deepEqual(r.errors, ["panel 4: line needs x and y"]);
  assert.equal(r.spec!.panels.length, 4);
  const countdown = r.spec!.panels[1];
  assert.equal(resolvePanel(countdown, { ev: { date: "2027-01-01", title: "Party" } }).panel!.label, "Party");
  assert.deepEqual(resolvePanel(countdown, { ev: { date: "soon" } }).errors, ['"to" is not a date']);
});

test("a component's own selection belongs to that use of it", () => {
  const notes = {
    "Picker.md": {
      component: "pick a city's quake",
      params: ["feed"],
      panels: [
        { view: "list", title: "Pick", source: "$feed", select: "row", item: "{place}" },
        { view: "text", text: "Picked $row.place", title: "Picked" },
        { view: "list", source: "$feed", select: "feed" },
      ],
    },
  };
  const r = readSpec({ app: "x", panels: [{ use: "[[Picker]]", with: { feed: "a" } }, { use: "[[Picker]]", with: { feed: "b" } }] },
    { notes: reader(notes), path: APP, now: NOW })!;
  assert.deepEqual(r.errors, [
    'panel 1 (from [[Picker]] panel 3): select: "feed" is already a param',
    'panel 2 (from [[Picker]] panel 3): select: "feed" is already a param',
  ]);
  const [pick1, text1, , pick2, text2] = r.spec!.panels;
  assert.deepEqual(r.spec!.selections, ["row@1", "row@2"]);
  assert.deepEqual([pick1.panel.select, pick2.panel.select], ["row@1", "row@2"]);
  assert.deepEqual([text1.inputs, text2.inputs], [["row@1"], ["row@2"]]);
  assert.equal(resolvePanel(text2, { "row@1": { place: "Lima" }, "row@2": { place: "Oslo" } }).panel!.text, "Picked Oslo");
});

test("an app's selection passed to a component is read there with a path", () => {
  const notes = { "Detail.md": { component: "d", params: ["q"], panels: [{ view: "text", text: "$q.place: M$q.mag" }, { view: "text", text: "$q" }] } };
  const r = readSpec({ app: "x", panels: [{ view: "list", source: "s", select: "quake" }, { use: "[[Detail]]", with: { q: "$quake" } }] },
    { notes: reader(notes), path: APP, now: NOW })!;
  assert.deepEqual(r.errors, ["panel 2 (from [[Detail]] panel 2): say which field: $quake.id"]);
  assert.equal(resolvePanel(r.spec!.panels[1], { quake: { place: "Lima", mag: 6 } }).panel!.text, "Lima: M6");
});

test("master and detail: picking a row loads the panels that read it; picking it again clears", async () => {
  const { root, start, f } = open(MASTER_DETAIL);
  start();
  await settle();
  const [list, detail, number] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(text(detail.querySelector(".gz-waiting")), "Pick a row in “Strongest”");
  assert.equal(text(number.querySelector(".gz-waiting")), "Pick a row in “Strongest”");
  assert.equal(text(detail.querySelector(".gz-title")), "Detail");
  assert.deepEqual(f.requests, [QUAKES]);

  const ul = list.querySelector("ul")!;
  const [lima, oslo] = [...list.querySelectorAll("li")];
  assert.deepEqual([lima.getAttribute("role"), lima.getAttribute("tabindex"), lima.getAttribute("aria-pressed")], ["button", "0", "false"]);
  (lima as HTMLElement).click();
  await settle();
  assert.equal(text(detail.querySelector(".gz-text")), "M6.1 at Lima");
  assert.equal(text(number.querySelector(".gz-big")), "7");
  assert.equal(f.requests.at(-1), "https://detail.example.com/q?id=a1");
  // The list highlights in place: same elements, nothing redrawn.
  assert.equal(list.querySelector("ul"), ul);
  assert.ok(lima.classList.contains("gz-selected"));
  assert.equal(lima.getAttribute("aria-pressed"), "true");

  key(oslo, "Enter");
  await settle();
  assert.equal(text(detail.querySelector(".gz-text")), "M4.2 at Oslo");
  assert.deepEqual([lima.classList.contains("gz-selected"), oslo.classList.contains("gz-selected")], [false, true]);

  key(oslo, " ");
  await settle();
  assert.equal(text(detail.querySelector(".gz-waiting")), "Pick a row in “Strongest”");
  assert.equal(list.querySelectorAll(".gz-selected").length, 0);
});

test("a selection survives its panel reloading and is gone when the note is reopened", async () => {
  const fm = {
    app: "Books",
    panels: [
      { view: "table", title: "Shelf", source: "books", columns: ["title"], select: "book" },
      { view: "text", text: "Reading $book.title" },
    ],
  };
  const { root, start, env, data, f } = open(fm, { "Apps/W data.md": { fm: { books: [{ title: "Dune" }, { title: "Emma" }] } } });
  const first = start();
  await settle();
  (root.querySelectorAll("tbody tr")[1] as HTMLElement).click();
  await settle();
  assert.equal(text(root.querySelector(".gz-text")), "Reading Emma");
  f.files.get("Apps/W data.md")!.fm = { books: [{ title: "Dune" }, { title: "Emma" }, { title: "Ulysses" }] };
  data.fileChanged("Apps/W data.md");
  f.flush();
  await settle();
  assert.equal(root.querySelectorAll("tbody tr").length, 3);
  assert.ok(root.querySelectorAll("tbody tr")[1].classList.contains("gz-selected"));
  assert.equal(text(root.querySelector(".gz-text")), "Reading Emma");
  first.dispose();
  new AppController(root, APP, env).load();
  await settle();
  // The text waits for a pick again, out of sight until there is one.
  assert.ok(root.querySelector(".gz-view-text.gz-collapsed"));
  assert.equal(root.querySelectorAll(".gz-selected").length, 0);
});

test("a search box waits for typing, applies after a pause or on Enter, and keeps focus and text", async () => {
  const fm = {
    app: "Search",
    inputs: { q: "text" },
    panels: [
      { view: "number", title: "Results", source: "https://search.example.com/s?q=$q", pick: "current", field: "t" },
      { view: "countdown", to: "2027-01-01" },
    ],
  };
  const { root, start, f } = open(fm);
  start();
  await settle();
  const box = root.querySelector('.gz-inputs input[type="search"]') as HTMLInputElement;
  const number = root.querySelector(".gz-view-number")!;
  assert.equal(box.getAttribute("aria-label"), "q");
  assert.equal(text(number.querySelector(".gz-waiting")), "Type in “q”");
  assert.equal(text(number.querySelector(".gz-title")), "Results");

  box.focus();
  box.value = "war & p";
  box.dispatchEvent(new window.Event("input"));
  await settle(20);
  assert.deepEqual(f.requests, [], "nothing is applied while typing");
  box.value = "war & peace";
  box.dispatchEvent(new window.Event("input"));
  await new Promise((r) => setTimeout(r, 350));
  await settle();
  assert.deepEqual(f.requests, ["https://search.example.com/s?q=war%20%26%20peace"]);
  assert.equal(text(number.querySelector(".gz-big")), "7");
  assert.equal(root.querySelector('.gz-inputs input[type="search"]'), box);
  assert.equal(box.value, "war & peace");
  assert.equal(document.activeElement, box);

  box.value = "dune";
  key(box, "Enter");
  await settle();
  assert.equal(f.requests.at(-1), "https://search.example.com/s?q=dune");

  box.value = "{secret:demo}";
  key(box, "Enter");
  await settle();
  assert.match(text(number), /\$q can't hold a secret or a line break/);
  assert.equal(f.requests.length, 2);

  box.value = "";
  key(box, "Enter");
  await settle();
  assert.equal(text(number.querySelector(".gz-waiting")), "Type in “q”");
});

test("a grouped bar picks the group's row; marks are buttons and the picked one is marked", async () => {
  const fm = {
    app: "Moods",
    panels: [
      { view: "bar", title: "By mood", source: "log", group: "mood", select: "mood" },
      { view: "text", text: "$mood.mood: $mood.count" },
    ],
  };
  const { root, start } = open(fm, { "Apps/W data.md": { fm: { log: [{ mood: "ok" }, { mood: "good" }, { mood: "good" }] } } });
  start();
  await settle();
  const bars = [...root.querySelectorAll(".gz-bar")];
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map((b) => [b.getAttribute("role"), b.getAttribute("tabindex"), b.getAttribute("aria-label")]),
    [["button", "0", "good"], ["button", "0", "ok"]]);
  bars[0].dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle();
  assert.equal(text(root.querySelector(".gz-text")), "good: 2");
  assert.deepEqual(bars.map((b) => b.classList.contains("gz-selected")), [true, false]);
});

test("an ungrouped bar picks the data row behind it", async () => {
  const fm = {
    app: "Budget",
    panels: [
      { view: "bar", source: "budget", x: "category", y: ["planned", "spent"], select: "line" },
      { view: "text", text: "$line.category $line.note" },
    ],
  };
  const budget = [{ category: "food", planned: 5, spent: 4, note: "groceries" }, { category: "rent", planned: 9, spent: 9, note: "monthly" }];
  const { root, start } = open(fm, { "Apps/W data.md": { fm: { budget } } });
  start();
  await settle();
  // Drawn series by series: planned food, planned rent, spent food, spent rent.
  const bars = [...root.querySelectorAll(".gz-bar")];
  assert.equal(bars.length, 4);
  bars[3].dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle();
  assert.equal(text(root.querySelector(".gz-text")), "rent monthly");
  assert.deepEqual(bars.map((b) => b.classList.contains("gz-selected")), [false, true, false, true]);
});

test("a pie's slices and legend rows pick the same row; Other picks nothing", () => {
  const picked: (Record<string, unknown> | undefined)[] = [];
  let current: Record<string, unknown> | undefined;
  const ctx = {
    now: NOW, width: () => 600,
    select: (_: string, row: Record<string, unknown> | undefined) => { picked.push(row); current = row; },
    selected: () => current,
  } as unknown as PanelCtx;
  const p = checkPanel({ view: "pie", source: "s", group: "g", select: "g" }, true).panel as Panel;
  const el = document.createElement("div");
  const rows = ["a", "b", "c", "d", "e", "f", "g"].map((g, i) => ({ g, count: 10 - i }));
  pie.mount(el, p, ctx, "k").update(rows);
  const items = [...el.querySelectorAll(".gz-legend-item")];
  assert.equal(el.querySelectorAll(".gz-slice.gz-selectable").length, 5);
  assert.equal(items.length, 6);
  assert.ok(!items[5].classList.contains("gz-selectable"), "Other");
  items[1].dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(picked, [{ g: "b", count: 9 }]);
  assert.deepEqual([...el.querySelectorAll(".gz-selected")].map((e) => e.tagName.toLowerCase()), ["path", "span"]);
});

test("two uses of one component keep their selections apart", async () => {
  const notes = {
    "Components/Picker.md": { fm: {
      component: "c",
      params: ["list"],
      panels: [
        { view: "list", title: "Pick from $list", source: "$list", select: "row", item: "{name}" },
        { view: "text", text: "Picked $row.name" },
      ],
    } },
    "Apps/W data.md": { fm: { a: [{ name: "a1" }, { name: "a2" }], b: [{ name: "b1" }] } },
  };
  // On the grid, where each waiting text names the list of its own use to pick from.
  const { root, start } = open({ app: "x", layout: "grid", panels: [{ use: "[[Picker]]", with: { list: "a" } }, { use: "[[Picker]]", with: { list: "b" } }] }, notes);
  start();
  await settle();
  const [, textA, listB, textB] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(text(textB.querySelector(".gz-waiting")), "Pick a row in “Pick from b”");
  (listB.querySelector("li") as HTMLElement).click();
  await settle();
  assert.equal(text(textB.querySelector(".gz-text")), "Picked b1");
  assert.ok(textA.querySelector(".gz-waiting"));
});

test("typing that is applied after the app was closed does nothing", async () => {
  const fm = { app: "Search", inputs: { q: "text" }, view: "number", source: "https://search.example.com/s?q=$q", pick: "current", field: "t" };
  const { root, start, f, data, env } = open(fm);
  const app = start();
  await settle();
  const box = root.querySelector('.gz-inputs input[type="search"]') as HTMLInputElement;
  box.value = "late";
  box.dispatchEvent(new window.Event("input"));
  app.dispose();
  await new Promise((r) => setTimeout(r, 350));
  await settle();
  assert.deepEqual(f.requests, []);
  // Nothing of the closed app is still listening: a change to its note isn't read.
  let reads = 0;
  const frontmatter = env.frontmatter;
  env.frontmatter = (path) => { reads++; return frontmatter(path); };
  f.files.get(APP)!.fm = { ...fm, app: "Search again" };
  data.fileChanged(APP);
  f.flush();
  assert.equal(reads, 0);
});
