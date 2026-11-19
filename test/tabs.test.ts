import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { suggestionsFor } from "../src/hints.ts";
import { HostedApp } from "../src/hosted.ts";
import { readComponentPreview, readSpec } from "../src/spec.ts";
import { contextAt, labelOf, lineOf } from "../src/yamlpos.ts";
import { fakeEnv } from "./support/fakes.ts";
import { parseYaml } from "./support/yaml.ts";

// `tabs:` groups panels: each tab name with its list of panels, beside or instead of `panels:`.

const APP = "Apps/Tabs.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

/** A note's frontmatter, as the test parser reads the YAML between its fences. */
const frontmatter = (lines: string[]) => parseYaml(lines.slice(1, lines.indexOf("---", 1)).join("\n")) as Record<string, unknown>;

const LOG = { doses: [{ at: "2026-11-18T08:00", what: "a" }, { at: "2026-11-17T08:00", what: "b" }] };

test("a panel listed under a tab is the same panel with tab: set; tabs come after those panels: names, in the order typed", async () => {
  const fm = {
    app: "x",
    panels: [
      { view: "number", title: "Doses", source: "doses" },
      { view: "list", title: "Older", source: "doses", tab: "History" },
    ],
    tabs: {
      Today: [{ view: "list", title: "Today", source: "doses", where: { at: "today" } }],
      History: [{ view: "table", title: "All", source: "doses", columns: ["at", "what"] }],
      Empty: [],
    },
  };
  const r = readSpec(fm, { path: APP })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels.map((ps) => [ps.label, ps.panel.title, ps.panel.tab]), [
    ["panel 1", "Doses", undefined],
    ["panel 2", "Older", "History"],
    ["tabs.Today panel 1", "Today", "Today"],
    ["tabs.History panel 1", "All", "History"],
  ]);
  // Written the long way, the app is the same app.
  const long = readSpec({
    app: "x",
    panels: [...fm.panels, { ...fm.tabs.Today[0], tab: "Today" }, { ...fm.tabs.History[0], tab: "History" }],
  }, { path: APP })!;
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel), long.spec!.panels.map((ps) => ps.panel));

  const t = fakeEnv({ [APP]: { fm }, "Apps/Tabs data.md": { fm: LOG } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, APP, t.env);
  started.push(app);
  app.load();
  await settle();
  const tabs = [...root.querySelectorAll("button.na-tab")];
  assert.deepEqual(tabs.map(text), ["History", "Today"]);
  const shown = () => [...root.querySelectorAll(".na-panel:not(.na-off) .na-title")].map(text);
  assert.deepEqual(shown(), ["Doses", "Older", "All"]);
  click(tabs[1]);
  assert.deepEqual(shown(), ["Doses", "Today"]);
});

test("tab: inside tabs, a tabs that isn't names with lists, and a panel's problems are named by tab and place", () => {
  const r = readSpec({
    app: "x",
    tabs: {
      Score: [{ view: "number", source: "doses" }, { view: "table", source: "doses", unit: "kg", tab: "Other" }],
      Broken: { view: "number" },
      Odd: ["text"],
    },
  }, { path: APP })!;
  assert.deepEqual(r.errors, [
    'tabs.Score panel 2: leave out tab; this panel is in the tab "Score" it is listed under',
    "tabs.Broken must be a list of panels",
    'tabs.Score panel 2: "unit" doesn\'t apply to table',
    "tabs.Odd panel 1: must be a set of keys",
  ]);
  assert.deepEqual(r.spec!.panels.map((ps) => ps.panel.tab), ["Score", "Score"]);
  assert.deepEqual(readSpec({ app: "x", tabs: [{ view: "number", source: "d" }] }, { path: APP })!.errors, [
    "tabs must be tab names, each with a list of panels, e.g. tabs: {Score: [{view: table, source: due}]}",
  ]);
  assert.equal(readSpec({ app: "x", tabs: { A: [] } }, { path: APP })!.empty, true);
  assert.deepEqual(readSpec({ app: "x", use: "[[K]]", tabs: { A: [] } }, { path: APP })!.errors, ["put - use: … inside panels to mix a component with other panels"]);
  assert.deepEqual(readSpec({ app: "x", panels: [{ view: "button", label: "Go", save: "tabs" }] }, { path: APP })!.errors, [
    'panel 1: save can\'t use "tabs", which names part of the app',
  ]);
});

test("an error in a tab is a link to that panel's line", () => {
  const lines = [
    "---",
    "app: x",
    "panels:",
    "  - view: number",
    "    source: doses",
    "tabs:",
    "  Score:",
    "    - view: number",
    "      source: doses",
    "    - view: table",
    "      source: doses",
    "      unit: kg",
    "  Track record:",
    "    - {view: number, source: doses, unit: kg, layout: x}",
    "---",
  ];
  const errors = readSpec(frontmatter(lines), { path: APP })!.errors;
  assert.deepEqual(errors, ['tabs.Score panel 2: "unit" doesn\'t apply to table', 'tabs.Track record panel 1: "layout" doesn\'t apply to number']);
  assert.deepEqual(labelOf(errors[0]), { kind: "tab", tab: "Score", n: 2 });
  assert.deepEqual(errors.map((e) => lineOf(lines, e)), [9, 13]);
  assert.equal(lineOf(lines, "tabs.Score panel 3: x"), undefined);
  assert.equal(lineOf(lines, "tabs.Waiting panel 1: x"), undefined);
  assert.equal(lineOf(lines, "panel 1 (from [[Kit]] tabs.Score panel 1): x"), 3);
});

test("keys are offered inside a panel listed under a tab, and tabs at the top", () => {
  const at = (snippet: string, isComponent = false) => {
    const lines = snippet.split("\n");
    const line = lines.findIndex((l) => l.includes("‸"));
    const ch = lines[line].indexOf("‸");
    lines[line] = lines[line].replace("‸", "");
    const ctx = contextAt(lines, line, ch);
    return ctx ? suggestionsFor(ctx, isComponent).map((s) => s.text) : [];
  };
  assert.deepEqual(at("---\napp: A\ntabs:\n  Score:\n    - view: countdown\n      ‸\n---"), ["title", "tab", "span", "to", "label"]);
  assert.deepEqual(at("---\napp: A\ntabs:\n  Score:\n    - view: form\n      fields:\n        mood: ‸\n---").slice(0, 2), ["text", "number"]);
  assert.deepEqual(at("---\napp: A\ntabs:\n  Score:\n    - view: ‸\n---").slice(0, 2), ["number", "text"]);
  assert.ok(at("---\napp: A\nta‸\n---").includes("tabs"));
  assert.ok(at("---\ncomponent: C\nta‸\n---", true).includes("tabs"));
});

test("a component may group its panels in tabs; a use: inside a tab puts all of its panels there", () => {
  const notes: Record<string, Record<string, unknown>> = {
    "Components/Kit.md": {
      component: "k", params: { log: "doses" },
      panels: [{ view: "number", title: "Count", source: "$log" }],
      tabs: { Log: [{ view: "list", title: "List", source: "$log" }], More: [{ view: "table", source: "$log", unit: "kg" }] },
    },
  };
  const reader = { resolve: (l: string) => Object.keys(notes).find((p) => p === `${l}.md` || p.endsWith(`/${l}.md`)), frontmatter: (p: string) => notes[p] };
  const whole = readSpec({ app: "x", use: "[[Kit]]" }, { path: APP, notes: reader })!;
  assert.deepEqual(whole.errors, ['[[Kit]] tabs.More panel 1: "unit" doesn\'t apply to table']);
  assert.deepEqual(whole.spec!.panels.map((ps) => [ps.panel.title, ps.panel.tab]), [["Count", undefined], ["List", "Log"], [undefined, "More"]]);
  const tabbed = readSpec({ app: "x", tabs: { Mine: [{ use: "[[Kit]]" }] } }, { path: APP, notes: reader })!;
  assert.deepEqual(tabbed.errors, ['tabs.Mine panel 1 (from [[Kit]] tabs.More panel 1): "unit" doesn\'t apply to table']);
  assert.deepEqual(tabbed.spec!.panels.map((ps) => [ps.panel.title, ps.panel.tab]), [["Count", "Mine"], ["List", "Mine"], [undefined, "Mine"]]);
  assert.deepEqual(readComponentPreview(notes["Components/Kit.md"], { path: "Components/Kit.md", notes: reader }).result.spec!.panels.length, 3);
});

test("a note-app block may hold tabs", async () => {
  const t = fakeEnv({ "Daily.md": { fm: {} }, "Daily data.md": { fm: LOG } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const value = { tabs: { Now: [{ view: "number", title: "Doses", source: "doses" }], Then: [{ view: "list", title: "Doses then", source: "doses" }] } };
  const h = new HostedApp(root, value, JSON.stringify(value), "Daily.md", t.env);
  started.push(h);
  h.load();
  await settle();
  assert.deepEqual([...root.querySelectorAll("button.na-tab")].map(text), ["Now", "Then"]);
  assert.equal(root.querySelectorAll(".na-error").length, 0);
});
