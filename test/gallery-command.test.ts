import assert from "node:assert/strict";
import { test } from "node:test";
import { componentsNeeded, galleryApps, planCopy, type GalleryNote } from "../src/gallery.ts";
import { basename } from "../src/store.ts";
import gallery from "../scripts/gallery-notes.ts";

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

const names = (list: GalleryNote[]) => list.map((n) => basename(n.path));

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

test("an app brings the kinds it reads or saves to with a whole link, from Kinds/; so does a component it uses", () => {
  const spend = note("Kinds/Spend.md", "---\nkind: spend\nfields: {amount: number}\n---\nBody");
  const trips = note("Kinds/Trips.md", "---\nkind: trips\nfields: {city: text}\n---\n");
  const kit = note("Components/Kit.md", '---\ncomponent: Kit\npanels:\n  - {view: table, source: "[[Trips]]"}\n---\n');
  const app = note("Apps/B.md", [
    "---", "app: B", "data:", "  spend:", '    source: "[[Spend]]"', "panels:", '  - {view: form, save: "[[Spend]]"}',
    '  - view: text', '    text: "[[Trips]]"', '  - view: table', '    source: "[[Trips]] notes"', '  - source: "[[Weather]]"', "    view: table", "---", "",
  ].join("\n"));
  const all = [spend, trips, kit, app, WEATHER];
  assert.deepEqual(names(componentsNeeded(app, all)), ["Spend"], "a link that is only part of a value, or names no kind, brings nothing");
  assert.deepEqual(names(componentsNeeded(note("Apps/C.md", '---\napp: C\npanels:\n  - use: "[[Kit]]"\n---\n'), all)), ["Kit", "Trips"]);
  assert.deepEqual(planCopy(app, [spend], { Spend: [spend.text] }), { create: [app], reuse: ["Spend"] }, "a kind there word for word is reused");
  assert.deepEqual(planCopy(app, [spend], { Spend: ["kind: spend"] }), { refusal: "“Spend” already exists and isn't the one “B” needs" });
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
  assert.ok(paths.length > 0 && paths.every((p) => /^(Apps|Components|Kinds)\/[^/]+\.md$/.test(p)), paths.join(", "));
  assert.ok(paths.includes("Apps/Trip planner.md") && paths.includes("Components/Destination weather.md") && paths.includes("Kinds/Spend.md"));
  assert.ok(gallery.every((n) => n.text.startsWith("---\n")));
  // A kind's sample rows sit beside it in gallery/ for the repo's own vault; a copy never takes them.
  assert.deepEqual(paths.filter((p) => / data\.md$/.test(p)), []);
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
    assert.deepEqual(links.filter((l) => !parts.some((p) => basename(p.path) === l)), [], app.name);
  }
  assert.deepEqual(names(componentsNeeded(apps.find((a) => a.name === "Trip planner")!.note, gallery)), ["Destination weather", "Spend"]);
  assert.deepEqual(names(componentsNeeded(apps.find((a) => a.name === "Budget")!.note, gallery)), ["Spend"]);
  assert.deepEqual(names(componentsNeeded(apps.find((a) => a.name === "Medication log")!.note, gallery)), ["Dose"]);
  assert.deepEqual(names(componentsNeeded(apps.find((a) => a.name === "Bills and renewals")!.note, gallery)), ["Spend", "Renewal"]);
});

test("an app that is a whole kit brings the kit; a second app on the same kit reuses the copy already there", () => {
  const practice = galleryApps(gallery).find((a) => a.name === "Practice")!.note;
  // A second app on the kit, as someone would make one from Practice.
  const reading = note("Apps/Reading.md", practice.text.replace("with: {what: practice, unit: minutes, goal: 30}", "with: {what: reading, unit: pages, goal: 20}"));
  const kit = gallery.find((n) => n.path === "Components/Tracker kit.md")!;
  assert.deepEqual(componentsNeeded(practice, gallery), [kit]);
  assert.deepEqual(componentsNeeded(reading, gallery), [kit]);
  assert.deepEqual(planCopy(practice, [kit], {}), { create: [kit, practice], reuse: [] });
  assert.deepEqual(planCopy(reading, [kit], { "Tracker kit": [kit.text] }), { create: [reading], reuse: ["Tracker kit"] });
});
