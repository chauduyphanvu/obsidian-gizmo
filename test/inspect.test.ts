import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { renderInspector, sourceKind, type InspectedSource } from "../src/inspect.ts";

const text = (el: Element | null | undefined) => el?.textContent ?? "";

const QUAKES = {
  type: "FeatureCollection",
  count: 2,
  ok: true,
  next: null,
  features: [
    { id: "a1", properties: { mag: 4.6, place: "10 km N of Somewhere", felt: null }, geometry: { coordinates: [10, 20, 5] } },
    { id: "a2", properties: { mag: 2.5, place: "Elsewhere" }, geometry: { coordinates: [] } },
  ],
  metadata: { generated: 1700000000 },
  "Adj. Close": 12.5,
};

function render(sources: InspectedSource[]) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const copied: string[] = [];
  renderInspector(el, sources, (t) => copied.push(t));
  return { el, copied };
}

const source = (data: unknown, over: Partial<InspectedSource> = {}): InspectedSource =>
  ({ title: "Earthquakes", kind: "earthquake.usgs.gov", data, ...over });

/** Opens a node the way the browser does: the attribute, then the toggle event. */
function open(details: Element) {
  details.setAttribute("open", "");
  details.dispatchEvent(new window.Event("toggle"));
}

const nodes = (el: Element) => [...el.querySelectorAll(":scope > .na-children > .na-node")];
const keyOf = (node: Element) => text(node.querySelector("button.na-key"));
const child = (parent: Element, key: string) => nodes(parent).find((n) => keyOf(n) === key)!;
const press = (node: Element) => (node.querySelector("button.na-key") as HTMLButtonElement).click();

test("a source has a heading with its title and kind, and the top of its data open", () => {
  const { el } = render([source(QUAKES)]);
  assert.equal(text(el.querySelector(".na-inspect-head")), "Earthquakes · earthquake.usgs.gov");
  const root = el.querySelector(".na-tree > details.na-node")!;
  assert.equal(root.hasAttribute("open"), true);
  assert.equal(text(root.querySelector(":scope > summary")), "{…} 7 keys");
  assert.deepEqual(nodes(root).map(keyOf), ["type", "count", "ok", "next", "features", "metadata", "Adj. Close"]);
});

test("values are previewed by type: text in quotes, numbers, true, false, null, sizes", () => {
  const { el } = render([source(QUAKES)]);
  const root = el.querySelector(".na-tree > details.na-node")!;
  const preview = (key: string) => {
    const v = child(root, key).querySelector(".na-val")!;
    return [text(v), v.className.split(" ").filter((c) => c !== "na-val")[0]];
  };
  assert.deepEqual(preview("type"), ['"FeatureCollection"', "na-t-string"]);
  assert.deepEqual(preview("count"), ["2", "na-t-number"]);
  assert.deepEqual(preview("ok"), ["true", "na-t-bool"]);
  assert.deepEqual(preview("next"), ["null", "na-t-null"]);
  assert.deepEqual(preview("features"), ["[…] 2 items", "na-t-meta"]);
  assert.deepEqual(preview("metadata"), ["{…} 1 key", "na-t-meta"]);
});

test("long text is cut at 80 characters, one line, and sizes are singular for one", () => {
  const { el } = render([source({ long: "x".repeat(200), spaced: "a\n  b\tc", none: [], one: [1], empty: {} })]);
  const root = el.querySelector(".na-tree > details.na-node")!;
  const val = (key: string) => text(child(root, key).querySelector(".na-val"));
  assert.equal(val("long"), `"${"x".repeat(80)}…"`);
  assert.equal(val("spaced"), '"a b c"');
  assert.equal(val("none"), "[…] 0 items");
  assert.equal(val("one"), "[…] 1 item");
  assert.equal(val("empty"), "{…} 0 keys");
});

test("deeper nodes are closed and draw their children only when first opened", () => {
  const { el } = render([source(QUAKES)]);
  const root = el.querySelector(".na-tree > details.na-node")!;
  const features = child(root, "features");
  assert.equal(features.tagName.toLowerCase(), "details");
  assert.equal(features.hasAttribute("open"), false);
  assert.equal(features.querySelector(".na-children"), null);
  // Nothing below the closed nodes exists yet.
  assert.equal(el.querySelectorAll(".na-node").length, 1 + 7);

  open(features);
  assert.deepEqual(nodes(features).map(keyOf), ["0", "1"]);
  assert.equal(features.querySelectorAll(".na-node").length, 2);
  const first = child(features, "0");
  assert.equal(first.querySelector(".na-children"), null);

  // Opening again doesn't draw the children twice.
  open(features);
  features.dispatchEvent(new window.Event("toggle"));
  assert.equal(features.querySelectorAll(":scope > .na-children").length, 1);
  assert.equal(nodes(features).length, 2);
});

test("a long list shows its first 50 items, then how many more", () => {
  const { el } = render([source({ rows: Array.from({ length: 240 }, (_, i) => i * 2) })]);
  const rows = child(el.querySelector(".na-tree > details.na-node")!, "rows");
  assert.equal(text(rows.querySelector("summary .na-val")), "[…] 240 items");
  open(rows);
  assert.equal(nodes(rows).length, 50);
  assert.deepEqual(nodes(rows).slice(48).map(keyOf), ["48", "49"]);
  const more = rows.querySelector(".na-inspect-more")!;
  assert.equal(text(more), "… 190 more");
  assert.equal(more.parentElement, rows.querySelector(":scope > .na-children"));
  const exact = render([source({ rows: Array.from({ length: 50 }, (_, i) => i) })]);
  const full = child(exact.el.querySelector(".na-tree > details.na-node")!, "rows");
  open(full);
  assert.equal(nodes(full).length, 50);
  assert.equal(full.querySelector(".na-inspect-more"), null);
});

test("a huge response only draws what has been opened", () => {
  const big = { items: Array.from({ length: 100_000 }, (_, i) => ({ i, tags: ["a", "b"], deep: { x: { y: i } } })) };
  const { el } = render([source(big)]);
  assert.ok(el.querySelectorAll("*").length < 60, `${el.querySelectorAll("*").length} elements`);
  const items = child(el.querySelector(".na-tree > details.na-node")!, "items");
  open(items);
  assert.equal(nodes(items).length, 50);
  assert.ok(el.querySelectorAll("*").length < 500);
});

test("pressing a key copies the path as pick and field take it", () => {
  const { el, copied } = render([source(QUAKES)]);
  const root = el.querySelector(".na-tree > details.na-node")!;
  press(child(root, "type"));
  press(child(root, "features"));
  const features = child(root, "features");
  open(features);
  press(child(features, "0"));
  const first = child(features, "0");
  open(first);
  const props = child(first, "properties");
  open(props);
  press(child(props, "mag"));
  open(child(first, "geometry"));
  const coords = child(child(first, "geometry"), "coordinates");
  open(coords);
  press(child(coords, "2"));
  press(child(features, "1"));
  assert.deepEqual(copied, ["type", "features", "features.0", "features.0.properties.mag", "features.0.geometry.coordinates.2", "features.1"]);
});

test("a key that has a dot in it is copied as it is, and says how the dot is read", () => {
  const { el, copied } = render([source(QUAKES)]);
  const root = el.querySelector(".na-tree > details.na-node")!;
  const dotted = child(root, "Adj. Close");
  press(dotted);
  assert.deepEqual(copied, ["Adj. Close"]);
  const title = dotted.querySelector("button.na-key")!.getAttribute("title")!;
  assert.match(title, /dot/);
  assert.match(title, /one name/);
  assert.match(title, /whole path/);
  assert.doesNotMatch(child(root, "type").querySelector("button.na-key")!.getAttribute("title")!, /dot/);
  assert.equal(child(root, "type").querySelector("button.na-key")!.getAttribute("title"), "Copy type");
});

test("keys are buttons, so the keyboard reaches them; values are not", () => {
  const { el } = render([source(QUAKES)]);
  const keys = [...el.querySelectorAll(".na-tree .na-key")];
  assert.ok(keys.length >= 7);
  for (const k of keys) assert.equal(k.tagName.toLowerCase(), "button");
  assert.equal(el.querySelectorAll(".na-val button").length, 0);
});

test("pressing a key doesn't open or close its node", () => {
  const { el } = render([source(QUAKES)]);
  const features = child(el.querySelector(".na-tree > details.na-node")!, "features");
  let stopped = false;
  features.addEventListener("click", () => { stopped = true; });
  press(features);
  assert.equal(stopped, false);
});

test("“Copied” shows beside the key for a second, and a second press doesn't stack another", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { el } = render([source(QUAKES)]);
    const root = el.querySelector(".na-tree > details.na-node")!;
    const row = child(root, "count");
    press(row);
    assert.equal(text(row.querySelector(".na-copied")), "Copied");
    assert.equal(row.querySelector("button.na-key")!.nextElementSibling, row.querySelector(".na-copied"));
    mock.timers.tick(600);
    press(row);
    assert.equal(row.querySelectorAll(".na-copied").length, 1);
    mock.timers.tick(600);
    assert.equal(row.querySelectorAll(".na-copied").length, 1);
    mock.timers.tick(500);
    assert.equal(row.querySelector(".na-copied"), null);
    press(row);
    assert.equal(row.querySelectorAll(".na-copied").length, 1);
    // Beside a node that opens, it sits in the summary.
    press(child(root, "features"));
    assert.equal(text(child(root, "features").querySelector("summary .na-copied")), "Copied");
  } finally {
    mock.timers.reset();
  }
});

test("a list at the top, and a lone value", () => {
  const list = render([source([{ a: 1 }, { a: 2 }])]);
  const root = list.el.querySelector(".na-tree > details.na-node")!;
  assert.equal(text(root.querySelector(":scope > summary")), "[…] 2 items");
  assert.equal(root.querySelector(":scope > summary button"), null);
  press(child(root, "0"));
  open(child(root, "0"));
  press(child(child(root, "0"), "a"));
  assert.deepEqual(list.copied, ["0", "0.a"]);

  const lone = render([source("just text"), source(7, { title: "Count" }), source(undefined, { title: "Nothing" })]);
  assert.deepEqual([...lone.el.querySelectorAll(".na-tree .na-val")].map(text), ['"just text"', "7", "undefined"]);
  assert.equal(lone.el.querySelectorAll(".na-tree button").length, 0);
});

test("a source that couldn't be read shows its problem instead of a tree", () => {
  const { el } = render([source({ error: "earthquake.usgs.gov answered 503" }, { title: "Quakes" })]);
  assert.equal(text(el.querySelector(".na-inspect-error")), "earthquake.usgs.gov answered 503");
  assert.equal(el.querySelector(".na-tree"), null);
  assert.equal(text(el.querySelector(".na-inspect-head")), "Quakes · earthquake.usgs.gov");
  // A response that merely has an error key among others is data.
  const data = render([source({ error: "x", code: 3 })]);
  assert.equal(data.el.querySelector(".na-inspect-error"), null);
  assert.equal(data.el.querySelectorAll(".na-key").length, 2);
});

test("each source has its own heading and tree, and drawing again replaces them", () => {
  const sources = [source({ a: 1 }, { title: "First", kind: "notes: Books" }), source([1], { title: "Second", kind: "list: doses" })];
  const { el, copied } = render(sources);
  assert.deepEqual([...el.querySelectorAll(".na-inspect-head")].map(text), ["First · notes: Books", "Second · list: doses"]);
  renderInspector(el, sources, (t) => copied.push(t));
  assert.equal(el.querySelectorAll(".na-inspect-source").length, 2);
  renderInspector(el, [], () => {});
  assert.equal(el.querySelectorAll(".na-inspect-source").length, 0);
  assert.match(text(el), /No data to inspect/);
});

test("a web address is shown as typed, with its secret placeholders, and no secret anywhere", () => {
  const url = "https://api.example.com/v1/x?key={secret:demo}&q=a%20b";
  const { el } = render([source({ ok: true }, { kind: "api.example.com", source: url })]);
  assert.equal(text(el.querySelector(".na-inspect-url")), url);
  assert.ok(text(el).includes("{secret:demo}"));
  assert.ok(!el.innerHTML.includes("s3cret"));
});

test("sourceKind says what a source is in a few words", () => {
  assert.equal(sourceKind("https://earthquake.usgs.gov/feed.geojson?x=1", undefined), "earthquake.usgs.gov");
  assert.equal(sourceKind("https://api.example.com/x?key={secret:demo}", undefined), "api.example.com");
  assert.equal(sourceKind("https://api.example.com:8443/x", undefined), "api.example.com:8443");
  assert.equal(sourceKind("notes", "Books"), "notes: Books");
  assert.equal(sourceKind("notes", "#book, Reading"), "notes: #book, Reading");
  assert.equal(sourceKind("doses", undefined), "list: doses");
});
