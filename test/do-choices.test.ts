import assert from "node:assert/strict";
import { test } from "node:test";
import { doChoices } from "../src/do-choices.ts";

// Do… reads a line no shortcut reads as a name: the apps whose name has every word typed, then
// Gizmo's own windows, in the order given, at most five.

const APPS = [
  { name: "Chores", path: "Apps/Chores.md" },
  { name: "Weekly chores", path: "Apps/Weekly chores.md" },
  { name: "Weather", path: "Apps/Weather.md" },
];

test("a line names apps to open and Gizmo's windows by every word typed, apps first", () => {
  const opened: string[] = [];
  const ran: string[] = [];
  const actions = [{ name: "Automation map", run: () => ran.push("map") }, { name: "Activity of every app", run: () => ran.push("activity") }];
  const choices = doChoices("chores", APPS, actions, (p) => opened.push(p));
  assert.deepEqual(choices.map((c) => c.label), ["Open Chores", "Open Weekly chores"]);
  choices[1].run();
  assert.deepEqual(opened, ["Apps/Weekly chores.md"]);
  assert.deepEqual(doChoices("week ch", APPS, actions, () => {}).map((c) => c.label), ["Open Weekly chores"]);
  const map = doChoices("map", APPS, actions, () => {});
  assert.deepEqual(map.map((c) => c.label), ["Automation map"]);
  map[0].run();
  assert.deepEqual(ran, ["map"]);
  assert.deepEqual(doChoices("  ", APPS, actions, () => {}), []);
  assert.deepEqual(doChoices("zzz", APPS, actions, () => {}), []);
  assert.equal(doChoices("a", Array.from({ length: 9 }, (_, i) => ({ name: `App ${i}`, path: `${i}` })), [], () => {}).length, 5);
});
