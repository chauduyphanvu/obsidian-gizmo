import assert from "node:assert/strict";
import { test } from "node:test";
import { componentsNeeded, galleryApps, noteName, planCopy, type GalleryNote } from "../src/gallery.ts";
import gallery from "../src/gallery-notes.ts";

const note = (path: string, text: string): GalleryNote => ({ path, text });
const NOTES = [
  note("Apps/Trip.md", '---\napp: "Plan a trip: days, packing"\npanels:\n  - view: number\n  - use: "[[Weather]]"\n    with: {city: Tokyo}\n---\nBody'),
  note("Apps/Plain.md", "---\napp: Do one thing\nview: text\ntext: hi\n---\n"),
  note("Apps/Deep.md", "---\napp: Needs a chain\npanels:\n  - use: '[[Outer]]'\n---\n"),
  note("Components/Weather.md", "---\ncomponent: Weather for a place\nparams: [city]\npanels:\n  - view: text\n---\n"),
  note("Components/Outer.md", "---\ncomponent: Outer\npanels:\n  - {use: \"[[Components/Inner|inner]]\", with: {a: 1}}\n---\n"),
  note("Components/Inner.md", "---\ncomponent: Inner\npanels:\n  - view: text\n---\n"),
];
const [TRIP, PLAIN, DEEP, WEATHER, OUTER, INNER] = NOTES;

const names = (list: GalleryNote[]) => list.map((n) => noteName(n.path));

test("the apps are listed by name with their app: line, and components are not apps", () => {
  const apps = galleryApps(NOTES);
  assert.deepEqual(apps.map((a) => [a.name, a.about]), [["Deep", "Needs a chain"], ["Plain", "Do one thing"], ["Trip", "Plan a trip: days, packing"]]);
  assert.equal(apps[2].note, TRIP);
});

test("an app with no component needs none", () => {
  assert.deepEqual(componentsNeeded(PLAIN, NOTES), []);
  assert.deepEqual(planCopy(PLAIN, [], {}), { create: [PLAIN], reuse: [] });
});

test("an app with a component needs it, and is created after it", () => {
  assert.deepEqual(names(componentsNeeded(TRIP, NOTES)), ["Weather"]);
  assert.deepEqual(planCopy(TRIP, [WEATHER], {}), { create: [WEATHER, TRIP], reuse: [] });
});

test("a component that uses another needs both, the inner one first", () => {
  assert.deepEqual(names(componentsNeeded(DEEP, NOTES)), ["Inner", "Outer"]);
  assert.deepEqual(planCopy(DEEP, [INNER, OUTER], {}), { create: [INNER, OUTER, DEEP], reuse: [] });
});

test("components that use each other, or the app's own name, don't loop", () => {
  const a = note("Components/A.md", '---\ncomponent: A\npanels:\n  - use: "[[B]]"\n---\n');
  const b = note("Components/B.md", '---\ncomponent: B\npanels:\n  - use: "[[A]]"\n---\n');
  const app = note("Apps/Loop.md", '---\napp: Loop\npanels:\n  - use: "[[A]]"\n  - use: "[[Loop]]"\n  - use: "[[a]]"\n---\n');
  assert.deepEqual(names(componentsNeeded(app, [app, a, b])), ["B", "A"]);
});

test("a name the gallery has no component for is left out, and so is a use that is only text", () => {
  const app = note("Apps/X.md", '---\napp: X\ntext: "to use: [[Weather]] write it"\npanels:\n  - use: "[[Ticker]]"\n  - view: text\n    text: reuse: [[Weather]]\n---\n');
  assert.deepEqual(componentsNeeded(app, NOTES), []);
});

test("only the frontmatter is read for uses", () => {
  const app = note("Apps/X.md", '---\napp: X\nview: text\n---\nuse: "[[Weather]]"\n');
  assert.deepEqual(componentsNeeded(app, NOTES), []);
});

test("an existing note with the app's name stops the copy, naming it", () => {
  assert.deepEqual(planCopy(PLAIN, [], { Plain: ["anything at all"] }), { refusal: "“Plain” already exists" });
  assert.deepEqual(planCopy(TRIP, [WEATHER], { Trip: ["x"] }), { refusal: "“Trip” already exists" });
});

test("a component that is already there word for word is reused, not created again", () => {
  assert.deepEqual(planCopy(TRIP, [WEATHER], { Weather: [WEATHER.text] }), { create: [TRIP], reuse: ["Weather"] });
  assert.deepEqual(planCopy(TRIP, [WEATHER], { Weather: [WEATHER.text, WEATHER.text] }), { create: [TRIP], reuse: ["Weather"] });
});

test("a component of the same name with other text stops the copy, naming it", () => {
  const plan = planCopy(TRIP, [WEATHER], { Weather: [`${WEATHER.text} changed`] });
  assert.deepEqual(plan, { refusal: "“Weather” already exists and isn't the one “Trip” needs" });
  // One identical copy among others that differ is still a clash: the link would be ambiguous.
  assert.ok("refusal" in planCopy(TRIP, [WEATHER], { Weather: [WEATHER.text, "other"] }));
});

test("of two components, the one that clashes stops the copy, the other is not made", () => {
  const plan = planCopy(DEEP, [INNER, OUTER], { Inner: [INNER.text], Outer: ["different"] });
  assert.deepEqual(plan, { refusal: "“Outer” already exists and isn't the one “Deep” needs" });
  assert.deepEqual(planCopy(DEEP, [INNER, OUTER], { Inner: [INNER.text] }), { create: [OUTER, DEEP], reuse: ["Inner"] });
});

test("an app note's name wins over its components in what is reported", () => {
  assert.deepEqual(planCopy(TRIP, [WEATHER], { Trip: ["x"], Weather: ["different"] }), { refusal: "“Trip” already exists" });
});

// ---- The real gallery --------------------------------------------------------------------------------

test("the built-in gallery holds every app and component, with the text of its note, and nothing else", () => {
  const paths = gallery.map((n) => n.path);
  assert.ok(paths.length > 0 && paths.every((p) => /^(Apps|Components)\/[^/]+\.md$/.test(p)), paths.join(", "));
  assert.ok(paths.includes("Apps/Trip planner.md") && paths.includes("Components/Destination weather.md"));
  assert.ok(gallery.every((n) => n.text.startsWith("---\n")));
});

test("every gallery app can be copied into an empty vault, with exactly the components it uses", () => {
  const apps = galleryApps(gallery);
  assert.ok(apps.length >= 10);
  for (const app of apps) {
    assert.ok(app.about.length > 10 && !app.about.startsWith('"'), `${app.name}: "${app.about}"`);
    const parts = componentsNeeded(app.note, gallery);
    const plan = planCopy(app.note, parts, {});
    assert.deepEqual(plan, { create: [...parts, app.note], reuse: [] });
    // Every `use` in the app is met by the gallery, so the copy opens without a missing link.
    const links = [...app.note.text.matchAll(/use:\s*"\[\[([^\]]+)\]\]"/g)].map((m) => m[1]);
    assert.deepEqual(links.filter((l) => !parts.some((p) => noteName(p.path) === l)), [], app.name);
  }
  assert.deepEqual(names(componentsNeeded(apps.find((a) => a.name === "Trip planner")!.note, gallery)), ["Destination weather"]);
  assert.deepEqual(componentsNeeded(apps.find((a) => a.name === "Medication log")!.note, gallery), []);
});

test("an app that is a whole kit brings the kit; a second app on the same kit reuses the copy already there", () => {
  const apps = galleryApps(gallery);
  const [weight, sleep] = ["Weight", "Sleep"].map((n) => apps.find((a) => a.name === n)!.note);
  const kit = gallery.find((n) => n.path === "Components/Tracker kit.md")!;
  assert.deepEqual(componentsNeeded(weight, gallery), [kit]);
  assert.deepEqual(componentsNeeded(sleep, gallery), [kit]);
  assert.deepEqual(planCopy(weight, [kit], {}), { create: [kit, weight], reuse: [] });
  assert.deepEqual(planCopy(sleep, [kit], { "Tracker kit": [kit.text] }), { create: [sleep], reuse: ["Tracker kit"] });
});
