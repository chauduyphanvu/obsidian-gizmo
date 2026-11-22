import assert from "node:assert/strict";
import { test } from "node:test";
import { previewInstall } from "../src/bundle.ts";
import { askLine, componentsNeeded, galleryApps, kitParams, planCopy, setUp, type GalleryNote } from "../src/gallery.ts";
import gallery from "../src/gallery-notes.ts";
import { readSpec } from "../src/spec.ts";
import { basename } from "../src/store.ts";
import { parseYaml } from "./support/yaml.ts";

const note = (path: string, text: string): GalleryNote => ({ path, text });
const app = (name: string) => galleryApps(gallery).find((a) => a.name === name)!.note;
const keys = (text: string) => parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as Record<string, unknown>;

const KIT = note("Components/Kit.md", "---\ncomponent: A tracker\nparams:\n  what: weight\n  unit: kg\n  goal: 75\n  colour:\npanels:\n  - view: text\n---\nAbout the kit\n");
const TRACKS = note("Apps/Tracks.md", '---\napp: Track it\nuse: "[[Kit]]"\nwith: {what: sleep, goal: 8}\n---\nBody text, with: nothing in it\n');

test("the gallery's kit apps ask for each param of their kit, with the values they give it", () => {
  for (const [name, values] of [["Weight", ["weight", "kg", 75]], ["Sleep", ["sleep", "hours", 8]]] as const) {
    const params = kitParams(app(name), componentsNeeded(app(name), gallery), parseYaml);
    assert.deepEqual(params.map((p) => [p.name, p.value, p.given]), [["what", values[0], true], ["unit", values[1], true], ["goal", values[2], true]], name);
  }
});

test("an app that isn't one whole kit asks for nothing, and is copied as it is", () => {
  for (const a of galleryApps(gallery).filter((x) => !["Weight", "Sleep"].includes(x.name))) {
    assert.deepEqual(kitParams(a.note, componentsNeeded(a.note, gallery), parseYaml), [], a.name);
  }
});

test("a param the app doesn't give takes the kit's default, or nothing", () => {
  assert.deepEqual(kitParams(TRACKS, [KIT], parseYaml), [
    { name: "what", value: "sleep", given: true },
    { name: "unit", value: "kg", given: false },
    { name: "goal", value: 8, given: true },
    { name: "colour", value: undefined, given: false },
  ]);
});

test("a kit with a param a field can't hold, or no kit found, asks for nothing", () => {
  const listed = note("Components/Kit.md", "---\ncomponent: K\nparams:\n  fields: [a, b]\npanels:\n  - view: text\n---\n");
  assert.deepEqual(kitParams(TRACKS, [listed], parseYaml), []);
  assert.deepEqual(kitParams(TRACKS, [], parseYaml), []);
});

test("the values typed go into the copied note's with:, on one line, and the rest of the note stays", () => {
  const params = kitParams(TRACKS, [KIT], parseYaml);
  const copied = setUp(TRACKS, params, { what: "resting heart rate", unit: "bpm", goal: "60" });
  assert.equal(copied.path, TRACKS.path);
  assert.equal(copied.text, '---\napp: Track it\nuse: "[[Kit]]"\nwith: {what: resting heart rate, unit: bpm, goal: 60}\n---\nBody text, with: nothing in it\n');
  assert.deepEqual(keys(copied.text).with, { what: "resting heart rate", unit: "bpm", goal: 60 });
});

test("nothing changed leaves the note exactly as the gallery wrote it", () => {
  const params = kitParams(app("Weight"), componentsNeeded(app("Weight"), gallery), parseYaml);
  assert.equal(setUp(app("Weight"), params, {}), app("Weight"));
  assert.equal(setUp(app("Weight"), params, { what: "weight", goal: "75" }), app("Weight"));
});

test("an empty field, or a number field without a number, keeps the value it started with", () => {
  const params = kitParams(TRACKS, [KIT], parseYaml);
  const copied = setUp(TRACKS, params, { what: "  ", goal: "eight", unit: "h" });
  assert.deepEqual(keys(copied.text).with, { what: "sleep", unit: "h", goal: 8 });
});

test("values YAML would read as something else are quoted, so they stay as typed", () => {
  const params = kitParams(TRACKS, [KIT], parseYaml);
  const copied = setUp(TRACKS, params, { what: "8", unit: "yes", colour: "a, b: c" });
  assert.match(copied.text, /^with: \{what: "8", unit: "yes", goal: 8, colour: "a, b: c"\}$/m);
});

test("a with: written over several lines is replaced whole; a note without one gets it after use:", () => {
  const block = note("Apps/B.md", '---\napp: B\nuse: "[[Kit]]"\nwith:\n  what: sleep\n  goal: 8\nspec: 1\n---\n');
  const params = kitParams(block, [KIT], parseYaml);
  assert.deepEqual(params.map((p) => p.value), ["sleep", "kg", 8, undefined]);
  assert.equal(setUp(block, params, { goal: "9" }).text, '---\napp: B\nuse: "[[Kit]]"\nwith: {what: sleep, goal: 9}\nspec: 1\n---\n');
  const bare = note("Apps/C.md", '---\napp: C\nuse: "[[Kit]]"\n---\n');
  assert.equal(setUp(bare, kitParams(bare, [KIT], parseYaml), { unit: "lb" }).text, '---\napp: C\nuse: "[[Kit]]"\nwith: {unit: lb}\n---\n');
});

test("Windows line endings stay as they were", () => {
  const crlf = note(TRACKS.path, TRACKS.text.replace(/\n/g, "\r\n"));
  const copied = setUp(crlf, kitParams(crlf, [KIT], parseYaml), { goal: "7" });
  assert.equal(copied.text, '---\r\napp: Track it\r\nuse: "[[Kit]]"\r\nwith: {what: sleep, goal: 7}\r\n---\r\nBody text, with: nothing in it\r\n');
});

test("the set-up Weight is a working app on the same kit, and the copy plan creates it in place of the gallery's", () => {
  const weight = app("Weight");
  const components = componentsNeeded(weight, gallery);
  const copied = setUp(weight, kitParams(weight, components, parseYaml), { goal: "68.5", unit: "lb" });
  const plan = planCopy(copied, components, {});
  assert.ok("create" in plan);
  assert.deepEqual(plan.create.map((n) => basename(n.path)), ["Tracker kit", "Weight"]);
  assert.equal(plan.create[1], copied);
  // The kit is the gallery's own, word for word, so a vault that has it already keeps using it.
  assert.deepEqual(planCopy(copied, components, { "Tracker kit": [components[0].text] }), { create: [copied], reuse: ["Tracker kit"] });
  const kit = components[0];
  const notes = { resolve: (link: string) => (link === "Tracker kit" ? "Tracker kit.md" : undefined), frontmatter: (p: string) => (p === "Tracker kit.md" ? keys(kit.text) : undefined) };
  const r = readSpec(keys(copied.text), { notes, path: "Weight.md" })!;
  assert.deepEqual(r.errors, []);
  const goal = r.spec!.panels.find((ps) => ps.panel.goal !== undefined)!.panel;
  assert.equal(goal.goal, 68.5);
  assert.equal(goal.unit, "lb");
});

test("the line about what it asks for is worded as installing it would word it", () => {
  assert.equal(askLine([]), "It asks for nothing: it only keeps its own data beside it.");
  assert.equal(askLine(["Fetch data from api.open-meteo.com", "Use your saved secret \"x\""]), 'When you open it, it will ask your OK to fetch data from api.open-meteo.com; use your saved secret "x".');
  const weight = app("Weight");
  const shared = [weight, ...componentsNeeded(weight, gallery)].map((n) => ({ name: basename(n.path), text: n.text }));
  const preview = previewInstall(shared, { folder: "", existing: () => [], notes: { resolve: () => undefined, frontmatter: () => undefined }, parse: parseYaml });
  assert.ok(!("error" in preview));
  assert.equal(askLine(preview.asks), "It asks for nothing: it only keeps its own data beside it.");
});
