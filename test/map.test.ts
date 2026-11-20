import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "../src/activity.ts";
import { askGroup, buildMap, everyWords, writersOf } from "../src/map.ts";
import { fakeBackground } from "./support/fakes.ts";

const NOTES = {
  "Apps/Meds.md": {
    fm: {
      app: "Log every dose",
      panels: [
        { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds", then: { app: "[[Inbox]]", do: "add", fill: { task: "Refill" } } },
        { view: "number", title: "Doses today", source: "doses", agg: "count", alert: ">= 3" },
      ],
    },
  },
  "Apps/Inbox.md": {
    fm: {
      app: "Capture tasks",
      panels: [{ view: "form", title: "Add", fields: { task: "text" }, append: "Tasks/Inbox", line: "- [ ] {task}", shortcut: "add" }],
    },
  },
  "Apps/Weather.md": {
    fm: {
      app: "Weather",
      data: { now: { source: "https://api.example.com/now", record: "1h", into: "temps" } },
      panels: [{ view: "number", source: "now", field: "t", alert: "> 30", then: { app: "[[Inbox]]", do: "add", fill: { task: "Water the plants" } } }],
    },
  },
  "Apps/Projects.md": {
    fm: { app: "Projects", panels: [{ view: "board", source: "notes", from: "Projects", group: "status" }] },
  },
  "Apps/Journal.md": { fm: { app: "Journal", panels: [{ view: "form", fields: { line: "text" }, append: "Apps/Journal", line: "- {line}" }] } },
  "Projects/Garden.md": { fm: { status: "idea" } },
  "Tasks/Inbox.md": { fm: {} },
};

async function summaries() {
  const t = fakeBackground(NOTES, { "https://api.example.com/now": { t: 21 } });
  await t.bg.start();
  return { t, apps: t.bg.list() };
}

test("the background lists each app with its asks, shortcuts, records, alerts and thens, the target found", async () => {
  const { apps } = await summaries();
  const meds = apps.find((a) => a.path === "Apps/Meds.md")!;
  assert.deepEqual(meds.shortcuts, [{ id: "took-meds", label: "Took meds", view: "button", fields: [] }]);
  assert.deepEqual(meds.thens, [{ from: "Took meds", app: "[[Inbox]]", do: "add", path: "Apps/Inbox.md" }]);
  assert.deepEqual(meds.alerts, [{ title: "Doses today", then: undefined }]);
  assert.equal(meds.dataPath, "Apps/Meds data.md");
  assert.deepEqual(meds.wanted, ["run:Inbox#add"]);
  const weather = apps.find((a) => a.path === "Apps/Weather.md")!;
  assert.deepEqual(weather.records, [{ block: "now", list: "temps", everyMs: 3_600_000 }]);
  assert.deepEqual(weather.alerts[0].then, { app: "[[Inbox]]", do: "add", path: "Apps/Inbox.md" });
  assert.deepEqual(weather.thens, [], "an alert's then is listed with its alert");
  assert.equal(apps.find((a) => a.path === "Apps/Journal.md")!.writesSelf, true);
  assert.equal(meds.writesSelf, false);
});

test("the map: state from the grants, asks grouped and marked new, what makes each app act, who runs it", async () => {
  const { apps } = await summaries();
  const grants = {
    "Apps/Meds.md": ["run:Inbox#add"],
    "Apps/Inbox.md": [],
    "Apps/Weather.md": ["net:api.example.com"],
    "Daily.md#abc": ["net:api.example.com"],
    "Components/Review.md": ["edit:Decisions"],
  };
  const map = buildMap(apps, grants, [["Components/Review.md", "Decisions"]], []);
  const by = (name: string) => map.apps.find((a) => a.name === name)!;
  assert.equal(by("Meds").state, "allowed");
  assert.equal(by("Inbox").state, "asks-again", "it now writes Tasks/Inbox.md, which wasn't allowed");
  assert.deepEqual(by("Inbox").asks.map((a) => [a.group, a.text, a.isNew]), [["Changes", "Add lines to Tasks/Inbox.md", true]]);
  assert.equal(by("Projects").state, "not-opened");
  assert.deepEqual(by("Projects").asks.map((a) => a.isNew), [false, false], "nothing is new before anything was allowed");
  assert.deepEqual(by("Weather").acts, [
    "Records now into temps every hour",
    "When “Weather” turns true, runs “add” in Inbox",
  ]);
  assert.deepEqual(by("Meds").acts, ["Tells you when “Doses today” turns true", "“Took meds” then runs “add” in Inbox"]);
  assert.deepEqual(by("Inbox").runBy.map((r) => [r.name, r.do]), [["Meds", "add"], ["Weather", "add"]]);
  assert.deepEqual(map.apps.map((a) => a.name), ["Inbox", "Journal", "Meds", "Projects", "Weather"]);
  assert.deepEqual(map.embeds, [{ key: "Daily.md#abc", hostPath: "Daily.md", allowed: ["net:api.example.com"] }]);
  assert.deepEqual(map.lenses, [{ path: "Components/Review.md", name: "Review", scope: "Decisions", allowed: ["edit:Decisions"] }]);
});

test("the map shows each app's last change from the activity log", async () => {
  const { apps } = await summaries();
  const activity: Entry[] = [
    { id: "2", at: 2000, app: "Apps/Meds.md", actor: "link", what: "Took meds", undone: 0, changes: [{ kind: "row-added", path: "Apps/Meds data.md", list: "doses", row: { at: "2026-11-18T09:00" } }] },
    { id: "1", at: 1000, app: "Apps/Meds.md", actor: "you", what: "Took meds", undone: 0, changes: [] },
  ];
  const meds = buildMap(apps, {}, [], activity).apps.find((a) => a.name === "Meds")!;
  assert.deepEqual(meds.last, { at: 2000, actor: "A link", what: "Saved a row to doses in Meds data" });
});

test("which apps can change a note: data notes, appended notes, scopes, the app's own note, and the log", async () => {
  const { t, apps } = await summaries();
  const inScope = (scope: string, path: string) => t.data.inScope(scope, path);
  const names = (path: string, activity: Entry[] = []) => writersOf(path, apps, activity, inScope).map((w) => `${w.name}: ${w.reason ?? w.last?.what}`);
  assert.deepEqual(names("Apps/Meds data.md"), ["Meds: keeps its data here"]);
  assert.deepEqual(names("Tasks/Inbox.md"), ["Inbox: Add lines to Tasks/Inbox.md"]);
  assert.deepEqual(names("Projects/Garden.md"), ["Projects: Change properties of notes in Projects"]);
  assert.deepEqual(names("Apps/Journal.md"), ["Journal: changes its own note"]);
  assert.deepEqual(names("Daily.md"), []);
  const activity: Entry[] = [
    { id: "1", at: 1000, app: "Apps/Old.md", actor: "you", what: "Log", undone: 0, changes: [{ kind: "line-added", path: "Daily.md", line: "walked", created: false }] },
  ];
  assert.deepEqual(names("Daily.md", activity), ["Old: Added to Daily the line “walked”"]);
});

test("words: permission groups and record intervals", () => {
  assert.equal(askGroup("read:Projects"), "Reads");
  assert.equal(askGroup("net:api.example.com"), "Fetches");
  assert.equal(askGroup("secret:key"), "Fetches");
  assert.equal(askGroup("send:api.example.com|typed.q"), "Sends");
  assert.equal(askGroup("post:api.example.com"), "Sends");
  assert.equal(askGroup("run:Inbox#add"), "Runs");
  assert.equal(askGroup("create:Books"), "Changes");
  assert.equal(everyWords(60_000), "every minute");
  assert.equal(everyWords(600_000), "every 10 minutes");
  assert.equal(everyWords(3_600_000), "every hour");
  assert.equal(everyWords(7_200_000), "every 2 hours");
  assert.equal(everyWords(86_400_000), "every day");
});

test("the background tells listeners when an app's keys change, and revoking drops its pins at once", async () => {
  const t = fakeBackground({
    "Apps/P.md": { fm: { app: "P", panels: [{ view: "number", title: "N", source: "items", agg: "count", pin: "status" }] } },
    "Apps/P data.md": { fm: { items: [{ a: 1 }] } },
  });
  await t.bg.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.out.status.length, 1);
  let told = 0;
  const stop = t.bg.onIndexChange(() => told++);
  t.f.files.get("Apps/P.md")!.fm = { app: "P", panels: [{ view: "number", title: "Count", source: "items", agg: "count", pin: "status" }] };
  t.changed("Apps/P.md");
  assert.equal(told, 1);
  stop();
  t.bg.revoked("Apps/P.md");
  assert.deepEqual(t.out.status, []);
});

test("gizmo blocks in a note's text, found by the key their grant is kept under", async () => {
  const { gizmoBlocks } = await import("../src/map.ts");
  const { blockKey } = await import("../src/hosted.ts");
  const text = "# Day\n```gizmo\nview: countdown\nto: 2027-01-01\n```\n\n````gizmo\napp: \"[[Meds]]\"\n````\n```js\nnot: this\n```\n";
  const blocks = gizmoBlocks(text);
  assert.deepEqual(blocks, ["view: countdown\nto: 2027-01-01", "app: \"[[Meds]]\""]);
  assert.equal(blockKey("Daily.md", blocks[0]), blockKey("Daily.md", "view: countdown\nto: 2027-01-01\n"));
});

test("the map as a canvas: reads on the left, apps in the middle, writes on the right, a line per then", async () => {
  const { mapCanvas } = await import("../src/map-canvas.ts");
  const { apps } = await summaries();
  const exists = (path: string) => path !== "Apps/Meds data.md";
  const canvas = mapCanvas(apps, exists);
  const byText = (n: { file?: string; text?: string }) => n.file ?? n.text;
  const node = (name: string) => canvas.nodes.find((n) => byText(n) === name)!;
  const meds = node("Apps/Meds.md");
  const inbox = node("Apps/Inbox.md");
  assert.equal(meds.type, "file");
  assert.ok(node("api.example.com").x < meds.x && meds.x < node("Tasks/Inbox.md").x);
  assert.equal(node("Apps/Meds data.md").type, "text", "a data note not made yet is a text card");
  const label = (from: { id: string }, to: { id: string }) => canvas.edges.filter((e) => e.fromNode === from.id && e.toNode === to.id).map((e) => e.label);
  assert.deepEqual(label(meds, inbox), ["then: add"]);
  assert.deepEqual(label(node("api.example.com"), node("Apps/Weather.md")), ["fetches"]);
  assert.deepEqual(label(inbox, node("Tasks/Inbox.md")), ["adds lines"]);
  const projects = canvas.nodes.filter((n) => byText(n) === "Notes in Projects").sort((a, b) => a.x - b.x);
  assert.deepEqual(label(projects[0], node("Apps/Projects.md")), ["reads"], "what it reads is on the left");
  assert.deepEqual(label(node("Apps/Projects.md"), projects[1]), ["changes"], "and what it changes on the right");
  assert.equal(new Set(canvas.nodes.map((n) => n.id)).size, canvas.nodes.length, "ids are unique");
  assert.deepEqual(mapCanvas(apps, exists), canvas, "the same apps make the same canvas");
});
