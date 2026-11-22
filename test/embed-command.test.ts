import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHosted } from "../src/hosted.ts";
import { blockAt, embedBlock, embedChoices, embedPanels } from "../src/open-app.ts";
import { pickPanels, readSpec, type AppSpec } from "../src/spec.ts";
import { parseYaml } from "./support/yaml.ts";

const spec = (fm: Record<string, unknown>): AppSpec => {
  const r = readSpec({ app: "Meds", ...fm })!;
  assert.deepEqual(r.errors, []);
  return r.spec!;
};

const MEDS = spec({
  inputs: { period: ["week", "month"] },
  panels: [
    { view: "button", label: "Took meds", save: "doses" },
    { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count" },
    { view: "table", source: "doses", sort: "-at", columns: ["at"] },
    { view: "number", title: "Doses this $period", source: "doses", agg: "count" },
    { view: "number", title: "Streak: days", source: "doses", agg: "count" },
  ],
});

/** The panels a block's text shows, read back as the embed reads it. */
function shownBy(block: string, app: AppSpec): number[] {
  const yaml = /^```gizmo\n([\s\S]*)\n```$/.exec(block)![1];
  const hosted = parseHosted(parseYaml(yaml));
  assert.ok(!("error" in hosted) && hosted.kind === "app");
  const panels = hosted.panels === undefined ? app.panels : pickPanels(app, hosted.panels, "[[Meds]]").spec.panels;
  return panels.map((ps) => app.panels.indexOf(ps) + 1);
}

test("each panel is offered by its title, else its label; one nothing can name says why", () => {
  assert.deepEqual(embedChoices(MEDS), [
    { name: "Took meds", panels: 1 },
    { name: "Doses today", panels: 1 },
    { view: "table", reason: "It has no title or label" },
    { view: "number", reason: "Its title changes with an input" },
    { name: "Streak: days", panels: 1 },
  ]);
});

test("a name two panels share is one choice, which shows both", () => {
  const twice = spec({ panels: [
    { view: "number", title: "Today", source: "a", agg: "count" },
    { view: "number", title: "Today", source: "b", agg: "count" },
    { view: "number", title: "Later", source: "a", label: "Today", agg: "count" },
  ] });
  assert.deepEqual(embedChoices(twice), [{ name: "Today", panels: 3 }, { name: "Later", panels: 1 }]);
});

test("the block names the chosen panels exactly as the embed finds them, quoting what YAML would misread", () => {
  const choices = embedChoices(MEDS);
  const panels = embedPanels(choices, ["Took meds", "Streak: days"]);
  assert.deepEqual(panels, ["Took meds", "Streak: days"]);
  const block = embedBlock("Apps/Meds", panels);
  assert.equal(block, '```gizmo\napp: "[[Apps/Meds]]"\npanels: [Took meds, "Streak: days"]\n```');
  assert.deepEqual(shownBy(block, MEDS), [1, 5]);
});

test("every panel chosen leaves panels: out, as a block without it shows them all", () => {
  const all = spec({ panels: [{ view: "button", label: "Took meds", save: "doses" }, { view: "number", title: "Doses", source: "doses", agg: "count" }] });
  const panels = embedPanels(embedChoices(all), ["Took meds", "Doses"]);
  assert.equal(panels, undefined);
  assert.equal(embedBlock("Meds", panels), '```gizmo\napp: "[[Meds]]"\n```');
  assert.deepEqual(shownBy(embedBlock("Meds", panels), all), [1, 2]);
});

test("with a panel nothing can name, choosing every other one still names them, so that one stays out", () => {
  const panels = embedPanels(embedChoices(MEDS), ["Took meds", "Doses today", "Streak: days"]);
  assert.deepEqual(panels, ["Took meds", "Doses today", "Streak: days"]);
  assert.deepEqual(shownBy(embedBlock("Meds", panels), MEDS), [1, 2, 5]);
});

test("an app with no panel an embed can name is embedded whole", () => {
  const unnamed = spec({ panels: [{ view: "button", save: "doses" }, { view: "number", source: "doses", agg: "count" }] });
  assert.deepEqual(embedChoices(unnamed), [{ view: "button", reason: "It has no title or label" }, { view: "number", reason: "It has no title or label" }]);
  assert.equal(embedPanels(embedChoices(unnamed), []), undefined);
  assert.deepEqual(shownBy(embedBlock("Meds", undefined), unnamed), [1, 2]);
});

test("the block goes in on lines of its own, wherever the cursor is on its line", () => {
  const block = "```gizmo\napp: \"[[Meds]]\"\n```";
  assert.equal(blockAt("", "", block), block);
  assert.equal(blockAt("Today I ", "", block), `\n${block}`);
  assert.equal(blockAt("", " and more", block), `${block}\n`);
  assert.equal(blockAt("Before ", " after", block), `\n${block}\n`);
  assert.equal(blockAt("   ", "  ", block), block);
});
