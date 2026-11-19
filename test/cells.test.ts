import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { askersOf, checkPanel, describePermission, permissionsOf, readSpec, type Panel } from "../src/spec.ts";
import { CELL_KINDS, drawCell } from "../src/views/cells.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { table } from "../src/views/rows.ts";
import { fakeEnv } from "./support/fakes.ts";

const NOW = new Date(2026, 10, 18, 12, 0);
const text_ = (el: Element | null | undefined) => el?.textContent ?? "";
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10)); };
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const key = (el: Element, name: string) => {
  const e = new window.Event("keydown", { bubbles: true }) as Event & { key: string };
  e.key = name;
  el.dispatchEvent(e);
};

interface Calls {
  opened: string[];
  ran: unknown[];
  edits: unknown[][];
  picked: unknown[];
}

function fakeCtx(): { ctx: PanelCtx; calls: Calls } {
  const calls: Calls = { opened: [], ran: [], edits: [], picked: [] };
  let selected: unknown;
  const ctx = {
    now: NOW,
    width: () => 600,
    openNote: (path: string) => calls.opened.push(path),
    runActions: async (_p: Panel, row: unknown) => { calls.ran.push(row); },
    editRow: async (...args: unknown[]) => { calls.edits.push(args); },
    select: (_: string, row: unknown) => { selected = row; calls.picked.push(row); },
    selected: () => selected,
  } as unknown as PanelCtx;
  return { ctx, calls };
}

const panel = (keys: Record<string, unknown> = {}) => {
  const r = checkPanel({ view: "table", source: "s", ...keys }, true);
  assert.deepEqual(r.errors, []);
  return r.panel as Panel;
};

/** One cell of the given kind, drawn on its own. */
function cell(kind: string, value: unknown, row: Record<string, unknown> = {}, keys: Record<string, unknown> = {}, field = "c") {
  const { ctx, calls } = fakeCtx();
  const td = document.createElement("td");
  drawCell(td, kind, value, row, panel(keys), ctx, field);
  return { td, calls };
}

test("the cell kinds", () => {
  assert.deepEqual(CELL_KINDS, ["progress", "sparkline", "link", "image", "check"]);
});

test("progress: a bar for 0–1, or 0–max, with the formatted value as its label", () => {
  const half = cell("progress", 0.5).td.querySelector(".na-cell-bar")!;
  assert.equal(half.getAttribute("role"), "progressbar");
  assert.equal(half.getAttribute("aria-label"), "0.50");
  assert.equal((half.querySelector(".na-cell-fill") as HTMLElement).style.width, "50%");
  const rated = cell("progress", 4, {}, { max: 5, format: { c: "0.0 / 5" } }).td.querySelector(".na-cell-bar")!;
  assert.equal(rated.getAttribute("aria-label"), "4.0 / 5");
  assert.equal(rated.getAttribute("aria-valuemax"), "5");
  assert.equal((rated.querySelector(".na-cell-fill") as HTMLElement).style.width, "80%");
  assert.equal((cell("progress", 9, {}, { max: 5 }).td.querySelector(".na-cell-fill") as HTMLElement).style.width, "100%");
  assert.equal((cell("progress", -2, {}, { max: 5 }).td.querySelector(".na-cell-fill") as HTMLElement).style.width, "0%");
  assert.equal((cell("progress", "3", {}, { max: 6 }).td.querySelector(".na-cell-fill") as HTMLElement).style.width, "50%");
  // Not a number: the plain value.
  assert.equal(text_(cell("progress", "soon").td), "soon");
  assert.equal(cell("progress", "soon").td.querySelector(".na-cell-bar"), null);
  assert.equal(text_(cell("progress", undefined).td), "—");
});

test("sparkline: a small line through a list of numbers, named in words; fewer than two numbers is the plain value", () => {
  const { td } = cell("sparkline", [3, 5, 4, 9]);
  const svg = td.querySelector("svg.na-spark")!;
  assert.equal(svg.getAttribute("width"), "80");
  assert.equal(svg.getAttribute("height"), "20");
  assert.equal(svg.getAttribute("role"), "img");
  assert.equal(svg.getAttribute("aria-label"), "4 values, from 3 to 9");
  const line = svg.querySelector("polyline")!;
  assert.ok(line.classList.contains("na-s1"));
  const ys = line.getAttribute("points")!.split(" ").map((p) => Number(p.split(",")[1]));
  assert.equal(ys.length, 4);
  assert.ok(ys[3] < ys[0] && ys[1] < ys[0] && ys[1] > ys[3], "higher values are drawn higher up");
  assert.equal(svg.querySelectorAll("circle").length, 1);
  assert.deepEqual(cell("sparkline", [2, 2, 2]).td.querySelector("polyline")!.getAttribute("points")!.split(" ").map((p) => p.split(",")[1]), ["10.0", "10.0", "10.0"]);
  assert.equal(cell("sparkline", ["3", "x", 5]).td.querySelector("svg")!.getAttribute("aria-label"), "2 values, from 3 to 5");
  for (const plain of [[7], [], "abc", 5, undefined]) {
    assert.equal(cell("sparkline", plain).td.querySelector("svg"), null);
  }
  assert.equal(text_(cell("sparkline", [7]).td), "7");
  assert.equal(text_(cell("sparkline", "abc").td), "abc");
});

test("link: an https address opens outside; a note path or [[link]] opens the note; anything else is text", () => {
  const web = cell("link", "https://example.com/a?b=1").td.querySelector("a")!;
  assert.equal(web.getAttribute("href"), "https://example.com/a?b=1");
  assert.equal(web.getAttribute("target"), "_blank");
  assert.equal(web.getAttribute("rel"), "noopener");
  assert.equal(text_(web), "example.com/a?b=1");

  const wiki = cell("link", "[[Dune]]");
  (wiki.td.querySelector("a") as HTMLElement).click();
  assert.deepEqual(wiki.calls.opened, ["Dune"]);
  assert.equal(text_(wiki.td), "Dune");
  const alias = cell("link", "[[Books/Dune#Plot|the book]]");
  assert.equal(text_(alias.td), "the book");
  (alias.td.querySelector("a") as HTMLElement).click();
  assert.deepEqual(alias.calls.opened, ["Books/Dune#Plot"]);
  const path = cell("link", "Books/Dune.md");
  assert.equal(text_(path.td), "Dune");
  (path.td.querySelector("a") as HTMLElement).click();
  assert.deepEqual(path.calls.opened, ["Books/Dune.md"]);

  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "http://example.com", "data:text/html,<b>x</b>", "file:///etc/passwd", "ftp://example.com/a.md", "mailto:a@b.co", "//example.com", "hello", "Dune"]) {
    const { td } = cell("link", bad);
    assert.equal(td.querySelector("a"), null, bad);
    assert.equal(text_(td), bad);
  }
  assert.equal(text_(cell("link", undefined).td), "—");
  assert.equal(text_(cell("link", 42).td), "42");
});

test("image: an https picture, lazy, named by the row; anything else draws nothing", () => {
  const img = cell("image", "https://example.com/dune.jpg", { name: "Dune", title: "ignored" }).td.querySelector("img")!;
  assert.equal(img.getAttribute("src"), "https://example.com/dune.jpg");
  assert.equal(img.getAttribute("loading"), "lazy");
  assert.equal(img.getAttribute("alt"), "Dune");
  assert.ok(img.classList.contains("na-cell-img"));
  assert.equal(cell("image", "https://example.com/a.png", { title: "A title" }).td.querySelector("img")!.getAttribute("alt"), "A title");
  assert.equal(cell("image", "https://example.com/a.png").td.querySelector("img")!.getAttribute("alt"), "");
  for (const bad of ["http://example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "/local/a.png", "a.png", "", undefined, 5]) {
    const { td } = cell("image", bad, { name: "X" });
    assert.equal(td.querySelector("img"), null, String(bad));
    assert.equal(text_(td), "", String(bad));
  }
});

test("check: a tick or an empty box that reads out as yes or no", () => {
  const on = cell("check", true).td.querySelector(".na-check")!;
  assert.equal(text_(on), "✓");
  assert.equal(on.getAttribute("aria-label"), "yes");
  assert.ok(on.classList.contains("is-on"));
  assert.equal(cell("check", "true").td.querySelector(".na-check")!.getAttribute("aria-label"), "yes");
  for (const off of [false, undefined, null, "no", 0]) {
    const mark = cell("check", off).td.querySelector(".na-check")!;
    assert.equal(mark.getAttribute("aria-label"), "no", String(off));
    assert.equal(text_(mark), "");
    assert.ok(!mark.classList.contains("is-on"));
  }
});

// ---- In a table ---------------------------------------------------------------------------------

function drawTable(keys: Record<string, unknown>, rows: unknown[], ctx = fakeCtx()) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  table.mount(el, panel(keys), ctx.ctx, "k").update(rows);
  return { el, ...ctx };
}

const BOOKS = [
  { name: "Dune", path: "Books/Dune.md", pct: 0.4, trend: [1, 2, 4], url: "https://example.com/dune", cover: "https://example.com/dune.jpg", done: true, status: "reading" },
  { name: "Emma", path: "Books/Emma.md", pct: 1, trend: [3], url: "javascript:alert(1)", cover: "http://example.com/emma.jpg", done: false, status: "done" },
];

test("a table draws each column as its cells kind and leaves the others as text", () => {
  const { el } = drawTable({
    columns: ["name", "pct", "trend", "url", "cover", "done"], format: { pct: "0%" },
    cells: { pct: "progress", trend: "sparkline", url: "link", cover: "image", done: "check" },
  }, BOOKS);
  const [dune, emma] = [...el.querySelectorAll("tbody tr")];
  assert.equal(text_(dune.querySelector("td")), "Dune");
  assert.equal(dune.querySelectorAll("td")[1].querySelector(".na-cell-bar")!.getAttribute("aria-label"), "40%");
  assert.ok(dune.querySelectorAll("td")[2].querySelector("svg.na-spark"));
  assert.equal(dune.querySelectorAll("td")[3].querySelector("a")!.getAttribute("href"), "https://example.com/dune");
  assert.equal(dune.querySelectorAll("td")[4].querySelector("img")!.getAttribute("alt"), "Dune");
  assert.equal(dune.querySelectorAll("td")[5].querySelector(".na-check")!.getAttribute("aria-label"), "yes");
  // Emma: a single trend number, a script address, an http picture.
  const [, , trend, url, cover] = [...emma.querySelectorAll("td")];
  assert.equal(text_(trend), "3");
  assert.equal(url.querySelector("a"), null);
  assert.equal(text_(url), "javascript:alert(1)");
  assert.equal(cover.querySelector("img"), null);
});

test("a check column that is in edit is the editable checkbox", () => {
  const { el, calls } = drawTable({ columns: ["name", "done"], cells: { done: "check" }, edit: ["done"] }, BOOKS.map((b) => ({ ...b, path: undefined })));
  assert.equal(el.querySelector(".na-check"), null);
  const box = el.querySelector('tbody tr input[type="checkbox"]') as HTMLInputElement;
  assert.equal(box.checked, true);
  box.checked = false;
  change(box);
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0][1], "done");
  assert.equal(calls.edits[0][2], false);
});

test("cells and layout are checked", () => {
  const one = (keys: Record<string, unknown>) => checkPanel({ view: "table", source: "s", ...keys }, true).errors;
  assert.deepEqual(one({ cells: { cover: "poster" } }), ["cells.cover: must be one of progress, sparkline, link, image, check"]);
  assert.deepEqual(one({ columns: ["name"], cells: { x: "link" } }), ['cells: "x" isn\'t one of the columns']);
  assert.deepEqual(one({ cells: { x: "link" } }), []);
  assert.deepEqual(one({ columns: ["name"], cells: { x: "poster" } }), ["cells.x: must be one of progress, sparkline, link, image, check", 'cells: "x" isn\'t one of the columns']);
  assert.deepEqual(one({ layout: "grid" }), ["layout must be cards"]);
  assert.deepEqual(one({ layout: "cards" }), []);
  assert.deepEqual(checkPanel({ view: "list", source: "s", cells: { a: "link" }, layout: "cards" }, true).errors, ['"cells" doesn\'t apply to list', '"layout" doesn\'t apply to list']);
});

// ---- Cards --------------------------------------------------------------------------------------

test("cards: a grid, the first picture on top, the next column the title, the rest label and value lines", () => {
  const { el, calls } = drawTable({
    source: "notes", from: "Books",
    layout: "cards", columns: ["cover", "name", "pct", "status"], labels: { pct: "Read" }, format: { pct: "0%" }, cells: { cover: "image", pct: "progress" },
  }, BOOKS);
  assert.equal(el.querySelector("table"), null);
  const cards = [...el.querySelectorAll(".na-cards > .na-rowcard")];
  assert.equal(cards.length, 2);
  const [dune, emma] = cards;
  assert.deepEqual([...dune.children].map((c) => c.className), ["na-rowcard-image", "na-rowcard-title", "na-rowcard-line", "na-rowcard-line"]);
  assert.equal(dune.querySelector(".na-rowcard-image img")!.getAttribute("src"), "https://example.com/dune.jpg");
  assert.equal(text_(dune.querySelector(".na-rowcard-title")), "Dune");
  assert.deepEqual([...dune.querySelectorAll(".na-rowcard-line")].map((l) => [text_(l.querySelector(".na-rowcard-label")), text_(l.querySelector(".na-rowcard-value"))]),
    [["Read", ""], ["status", "reading"]]);
  assert.equal(dune.querySelector(".na-rowcard-line .na-cell-bar")!.getAttribute("aria-label"), "40%");
  // An http picture draws nothing; the card still has its title.
  assert.equal(emma.querySelector(".na-rowcard-image img"), null);
  assert.equal(text_(emma.querySelector(".na-rowcard-title")), "Emma");
  // The title of a note is a link to it.
  (dune.querySelector(".na-rowcard-title a") as HTMLElement).click();
  assert.deepEqual(calls.opened, ["Books/Dune.md"]);
});

test("cards without an image or a note: the first column is the title, plain text", () => {
  const { el } = drawTable({ layout: "cards", columns: ["task", "room"] }, [{ task: "Bins", room: "kitchen" }]);
  const card = el.querySelector(".na-rowcard")!;
  assert.deepEqual([...card.children].map((c) => c.className), ["na-rowcard-title", "na-rowcard-line"]);
  assert.equal(text_(card.querySelector(".na-rowcard-title")), "Bins");
  assert.equal(card.querySelector("a"), null);
});

test("cards: a card can be selected with the mouse or the keyboard, its button runs the action, its inputs edit", () => {
  const { el, calls } = drawTable({
    layout: "cards", columns: ["name", "status", "done"], select: "book", action: "Open", open: "{path}", edit: ["status", "done"],
  }, BOOKS);
  const [dune, emma] = [...el.querySelectorAll(".na-rowcard")] as HTMLElement[];
  assert.ok(dune.classList.contains("na-selectable"));
  dune.click();
  assert.deepEqual(calls.picked, [BOOKS[0]]);
  assert.ok(dune.classList.contains("na-selected"));
  assert.ok(!emma.classList.contains("na-selected"));
  key(emma, "Enter");
  assert.deepEqual(calls.picked, [BOOKS[0], BOOKS[1]]);
  assert.ok(emma.classList.contains("na-selected"));
  assert.ok(!dune.classList.contains("na-selected"));

  // A click on the button or an input is that control's, not the card's.
  (emma.querySelector(".na-rowcard-actions button") as HTMLElement).click();
  assert.deepEqual(calls.ran, [BOOKS[1]]);
  assert.equal(calls.picked.length, 2);
  const status = dune.querySelector("input[type=text]") as HTMLInputElement;
  status.value = "done";
  change(status);
  assert.deepEqual(calls.edits.map((e) => [e[1], e[2]]), [["status", "done"]]);
  const done = emma.querySelector('input[type="checkbox"]') as HTMLInputElement;
  done.checked = true;
  change(done);
  assert.deepEqual(calls.edits.map((e) => [e[1], e[2]]), [["status", "done"], ["done", true]]);
});

test("cards show more than 200 rows behind Show all, like a table", () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ name: `n${i}` }));
  const { el } = drawTable({ layout: "cards" }, rows);
  assert.equal(el.querySelectorAll(".na-rowcard").length, 200);
  (el.querySelector("button.na-more") as HTMLElement).click();
  assert.equal(el.querySelectorAll(".na-rowcard").length, 205);
});

test("a card's edit writes back through the app, and the card updates in place", async () => {
  const fm = {
    app: "Shelf",
    data: { books: { source: "notes", from: "Books", fields: { status: ["to read", "reading", "done"] } } },
    panels: [{ view: "table", source: "books", sort: "name", layout: "cards", columns: ["name", "status"], edit: ["status"], action: "Open", open: "{path}" }],
  };
  const t = fakeEnv({
    "Apps/S.md": { fm },
    "Books/Dune.md": { fm: { status: "reading" } },
    "Books/Emma.md": { fm: { status: "to read" } },
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/S.md", t.env).load();
  await settle();
  assert.equal(root.querySelector(".na-error"), null);
  const grid = root.querySelector(".na-cards")!;
  const [dune, emma] = [...grid.querySelectorAll(".na-rowcard")];
  assert.deepEqual([...dune.querySelectorAll("select option")].map((o) => o.textContent), ["to read", "reading", "done"]);
  const status = dune.querySelector("select") as HTMLSelectElement;
  for (const o of status.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "done");
  change(status);
  await settle();
  assert.deepEqual(t.f.files.get("Books/Dune.md")!.fm, { status: "done" });
  assert.equal(root.querySelector(".na-cards"), grid, "patched in place, not redrawn");
  assert.equal(root.querySelectorAll(".na-rowcard")[0], dune);
  assert.equal(root.querySelectorAll(".na-rowcard")[1], emma);
  assert.equal(status.value, "2");

  (emma.querySelector(".na-rowcard-actions button") as HTMLElement).click();
  await settle();
  assert.deepEqual(t.opened, ["Books/Emma.md"]);
});

test("an image cell asks to load images from any site, since the host comes from the row's data", () => {
  const app = (cells: Record<string, string>) => readSpec({ app: "x", view: "table", source: "notes", from: "Books", cells })!;
  const asks = (cells: Record<string, string>) => permissionsOf(app(cells).spec!, "Apps/X.md");
  assert.deepEqual(asks({ cover: "image" }), ["images", "read:Books"]);
  assert.deepEqual(asks({ done: "check", cover: "image", rating: "progress" }), ["images", "read:Books"]);
  assert.deepEqual(asks({ done: "check", rating: "progress", site: "link" }), ["read:Books"]);
  assert.equal(describePermission("images"), "Load images from any site (image cells)");
  // The cells key is what asks, so a component that sets it is named.
  const notes = { "Components/Covers.md": { component: "Covers", panels: [{ view: "table", source: "notes", from: "Books", cells: { cover: "image" } }] } };
  const reader = { resolve: (link: string) => (link === "Covers" ? "Components/Covers.md" : undefined), frontmatter: (path: string) => (notes as Record<string, Record<string, unknown>>)[path] };
  const used = readSpec({ app: "x", panels: [{ use: "[[Covers]]" }] }, { notes: reader, path: "Apps/X.md" })!;
  assert.deepEqual(used.errors, []);
  assert.deepEqual([...askersOf(used.spec!, "Apps/X.md").get("images")!], ["Components/Covers.md"]);
});
