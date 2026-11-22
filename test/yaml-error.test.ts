import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { AppController } from "../src/app.ts";
import { yamlProblem } from "../src/app-cards.ts";
import { fakeEnv } from "./support/fakes.ts";

// Obsidian's parseYaml, past its own quick reader, is the yaml package's parse, which throws the
// first error it finds, with where it is.
const obsidianYaml = (text: string): unknown => parse(text);
const problemOf = (lines: string[]) => yamlProblem(lines, obsidianYaml);

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const PATH = "Apps/Water.md";
const GOOD = ["---", "app: Water", "panels:", "  - view: countdown", "    to: 2027-01-01", "    label: New year", "---", ""];
const GOOD_FM = { app: "Water", panels: [{ view: "countdown", to: "2027-01-01", label: "New year" }] };
/** A colon in a plain value, as typed on line 6 of the note. */
const COLON = ["---", "app: Water", "panels:", "  - view: countdown", "    to: 2027-01-01", "    label: Note: new year", "---", ""];

test("a colon in a plain value, a tab, an unclosed brace: the line of the note, and the parser's first line without its own place", () => {
  assert.deepEqual(problemOf(COLON), { line: 5, message: "Nested mappings are not allowed in compact mappings" });
  assert.deepEqual(problemOf(["---", "app: Water", "\tpanels:", "---"]), { line: 2, message: "Tabs are not allowed as indentation" });
  assert.deepEqual(problemOf(["---", "app: Water", "where: {at: today", "---"]), {
    line: 2, message: "Flow map in block collection must be sufficiently indented and end with a }",
  });
  assert.deepEqual(problemOf(["---", "app: Water", "panels", "---"]), { line: 2, message: "Implicit map keys need to be followed by map values" });
});

test("properties that parse to a list or a lone word aren't keys, which Obsidian drops too", () => {
  assert.deepEqual(problemOf(["---", "app", "---"]), { message: "each one needs a name and a colon, like app: …" });
  assert.deepEqual(problemOf(["---", "- app: Water", "---"]), { message: "each one needs a name and a colon, like app: …" });
});

test("no problem without properties, with empty ones, with keys, or with no closing fence", () => {
  for (const lines of [["just text"], ["---", "---"], ["---", "# nothing yet", "---"], GOOD, ["---", "app: a: b"], []]) {
    assert.equal(problemOf(lines), undefined, JSON.stringify(lines));
  }
});

test("a parser that names no line gets none, and a line past the properties is their last", () => {
  const lines = ["---", "app: Water", "x: 1", "---"];
  assert.deepEqual(yamlProblem(lines, () => { throw new Error("Bad input\nmore detail"); }), { message: "Bad input" });
  const late = Object.assign(new Error("Unexpected end at line 9, column 1:\n\n"), { linePos: [{ line: 9, col: 1 }] });
  assert.deepEqual(yamlProblem(lines, () => { throw late; }), { line: 2, message: "Unexpected end" });
});

function open(fm: Record<string, unknown> | undefined, lines: string[]) {
  const t = fakeEnv({ [PATH]: { fm } });
  t.f.host.parseYaml = obsidianYaml;
  t.source.lines = lines;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, PATH, t.env);
  app.load();
  /** A save of the note: what Obsidian's cache keeps of its properties, and its text. */
  const save = async (next: Record<string, unknown> | undefined, nextLines: string[]) => {
    t.f.files.get(PATH)!.fm = next;
    t.source.lines = nextLines;
    t.changed(PATH);
    await settle();
  };
  return { ...t, root, app, save };
}

const card = (root: Element) => root.querySelector(".gz-yaml-error");
const faded = (root: Element) => [...root.querySelectorAll(".gz-faded")];

test("properties that stop parsing say where, over the app as last drawn, faded and out of reach; the next good save brings it back", async () => {
  const t = open(GOOD_FM, GOOD);
  await settle();
  const body = t.root.querySelector(".gz-body");
  assert.ok(body?.querySelector(".gz-view-countdown"));

  await t.save(undefined, COLON);
  assert.equal(text(card(t.root)?.firstElementChild), "The properties aren't valid YAML: line 6: Nested mappings are not allowed in compact mappings");
  assert.ok(t.root.querySelector(".gz-body") === body, "the drawing stays");
  assert.ok(body!.hasAttribute("inert") && body!.classList.contains("gz-faded"));
  // The title and the rest of the old header stay too, faded; the card itself can be used.
  assert.ok(faded(t.root).some((el) => el.querySelector(".gz-app-title")));
  assert.ok(!card(t.root)!.closest("[inert]"));
  assert.equal(t.root.querySelector(".gizmo")!.firstElementChild?.contains(card(t.root)), true, "the card is on top");

  (card(t.root)!.querySelector("button") as HTMLButtonElement).click();
  assert.deepEqual(t.source.shownAt, [5]);

  await t.save(GOOD_FM, GOOD);
  assert.ok(!card(t.root));
  assert.equal(faded(t.root).length, 0);
  assert.equal(t.root.querySelectorAll("[inert]").length, 0);
  assert.ok(t.root.querySelector(".gz-body") === body, "the same panels, not drawn afresh");
  assert.ok(body!.querySelector(".gz-view-countdown"));
  t.app.dispose();
});

test("each save that still doesn't parse is read again, so the card follows the typing", async () => {
  const t = open(GOOD_FM, GOOD);
  await settle();
  await t.save(undefined, COLON);
  await t.save(undefined, ["---", "app: Water", "\tpanels:", "---"]);
  assert.equal(t.root.querySelectorAll(".gz-yaml-error").length, 1);
  assert.equal(text(card(t.root)?.firstElementChild), "The properties aren't valid YAML: line 3: Tabs are not allowed as indentation");
  (card(t.root)!.querySelector("button") as HTMLButtonElement).click();
  assert.deepEqual(t.source.shownAt, [2]);
  t.app.dispose();
});

test("a note whose properties never parsed shows the card alone", async () => {
  const t = open(undefined, COLON);
  await settle();
  assert.match(text(card(t.root)), /^The properties aren't valid YAML: line 6: /);
  assert.ok(!t.root.querySelector(".gz-body"));
  assert.equal(faded(t.root).length, 0);
  assert.ok(!t.root.querySelector(".gz-rail-slot"));

  // Fixed, it draws as any app does.
  await t.save(GOOD_FM, GOOD);
  assert.ok(!card(t.root));
  assert.ok(t.root.querySelector(".gz-view-countdown"));
  t.app.dispose();
});

test("properties with no line the parser names link to their first line", async () => {
  const t = open(undefined, ["---", "app", "---"]);
  await settle();
  assert.equal(text(card(t.root)?.firstElementChild), "The properties aren't valid YAML: each one needs a name and a colon, like app: …");
  (card(t.root)!.querySelector("button") as HTMLButtonElement).click();
  assert.deepEqual(t.source.shownAt, [1]);
  t.app.dispose();
});

test("a note that truly has no app line still says so, and an app drawn before goes", async () => {
  for (const [fm, lines] of [[{ title: "Water" }, ["---", "title: Water", "---"]], [undefined, ["Just text"]], [undefined, ["---", "---"]]] as const) {
    const t = open(fm, [...lines]);
    await settle();
    assert.equal(text(t.root.querySelector(".gz-header")), "This note has no app key.");
    assert.ok(!card(t.root));
    t.app.dispose();
  }
  const t = open(GOOD_FM, GOOD);
  await settle();
  await t.save({ title: "Water" }, ["---", "title: Water", "---"]);
  assert.equal(text(t.root.querySelector(".gz-header")), "This note has no app key.");
  assert.ok(!t.root.querySelector(".gz-body"));
  assert.equal(faded(t.root).length, 0);
  t.app.dispose();
});

test("a read of the note that comes back after the app was closed draws nothing and listens to nothing", async () => {
  const t = open(GOOD_FM, GOOD);
  await settle();
  let answer!: (lines: string[]) => void;
  t.env.sourceLines = () => new Promise((r) => { answer = r; });
  t.f.files.get(PATH)!.fm = undefined;
  t.changed(PATH);
  t.app.dispose();
  let listened = 0;
  const subscribe = t.data.subscribe.bind(t.data);
  t.data.subscribe = (...args) => { listened++; return subscribe(...args); };
  answer(COLON);
  await settle();
  assert.equal(t.root.querySelectorAll(".gizmo").length, 0);
  assert.equal(listened, 0);
});

test("an embed of the app keeps its own word for a note that isn't an app", async () => {
  const t = fakeEnv({ [PATH]: {} });
  t.f.host.parseYaml = obsidianYaml;
  t.source.lines = COLON;
  const root = document.createElement("div");
  const app = new AppController(root, PATH, t.env, { kind: "app", grantKey: "Daily.md#gizmo", hostPath: "Daily.md", definition: () => undefined });
  app.load();
  await settle();
  assert.equal(text(root.querySelector(".gz-header")), "[[Water]] isn't an app (it has no app: line)");
  assert.ok(!card(root));
  app.dispose();
});
