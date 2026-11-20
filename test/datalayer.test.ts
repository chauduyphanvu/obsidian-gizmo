import assert from "node:assert/strict";
import { test } from "node:test";
import { DataLayer } from "../src/datalayer.ts";
import { readSpec } from "../src/spec.ts";
import { fakeHost } from "./support/fakes.ts";

const FILES = { appPath: "Apps/X.md", dataPath: "Apps/X data.md" };
const NOW = new Date(2026, 10, 18);
const WEATHER = "https://api.example.com/forecast?lat=1";

test("three panels on one URL make one request", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const spec = readSpec({
    app: "Weather",
    panels: [
      { view: "number", source: WEATHER, pick: "current", field: "t" },
      { view: "text", source: WEATHER, pick: "current", text: "{t}" },
      { view: "line", source: WEATHER, pick: "hourly", x: "time", y: "t" },
    ],
  })!.spec!;
  const data = await Promise.all(spec.panels.map(({ panel: p }) => dl.panelData(p.source, p, FILES, { ttlMs: 60_000, now: NOW })));
  assert.equal(f.requests.length, 1);
  assert.deepEqual(data[0], { t: 7 });
  assert.deepEqual(data[2], { time: ["a", "b"], t: [1, 2] });
});

test("a second app on the same URL reuses the response until it expires", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await dl.fetch(WEATHER, undefined, 60_000);
  await dl.fetch(WEATHER, undefined, 60_000);
  assert.equal(f.requests.length, 1);
  f.advance(61_000);
  await dl.fetch(WEATHER, undefined, 60_000);
  assert.equal(f.requests.length, 2);
  dl.forgetUrls([WEATHER]);
  await dl.fetch(WEATHER, undefined, 60_000);
  assert.equal(f.requests.length, 3);
});

test("failures aren't cached; secrets are filled at fetch time only", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await assert.rejects(dl.fetch("https://api.example.com/fail", undefined, 60_000), /api.example.com answered 503/);
  await assert.rejects(dl.fetch("https://api.example.com/fail", undefined, 60_000));
  assert.equal(f.requests.length, 2);
  await dl.fetch("https://api.example.com/q?k={secret:demo}", undefined, 60_000, false, undefined, ["demo"]);
  assert.equal(f.requests.at(-1), "https://api.example.com/q?k=s3cret");
  await assert.rejects(dl.fetch("https://api.example.com/q?k={secret:nope}", undefined, 60_000, false, undefined, ["nope"]), /Missing secret "nope"/);
});

test("lists come from the data note first, then the app note, through the pipeline", async () => {
  const f = fakeHost({
    "Apps/X.md": { fm: { app: "x", books: ["Dune"] } },
    "Apps/X data.md": { fm: { doses: [{ at: "2026-11-18T08:00" }, { at: "2026-11-17T08:00" }] } },
  });
  const dl = new DataLayer(f.host);
  const p = readSpec({ app: "x", view: "number", source: "doses", where: { at: "today" } })!.spec!.panels[0].panel;
  assert.deepEqual(await dl.panelData("doses", p, FILES, { ttlMs: 0, now: NOW }), [{ at: "2026-11-18T08:00" }]);
  assert.deepEqual(await dl.panelData("books", p, FILES, { ttlMs: 0, now: NOW }), []);
});

test("notes queries follow edits, and only the touched scope hears about it", () => {
  const f = fakeHost({
    "Health/Dentist.md": { fm: { date: "2026-12-04" }, tags: ["#health/appointment"] },
    "Books/Dune.md": { fm: { finished: "2026-02-10" } },
  });
  const dl = new DataLayer(f.host);
  assert.deepEqual(dl.notes("Health").map((r) => r.date), ["2026-12-04"]);
  assert.equal(dl.notes("#health").length, 1);
  const heard: string[][] = [];
  dl.subscribe(["notes:Health"], (c) => heard.push([...c]));
  dl.subscribe(["notes:Books"], (c) => heard.push([...c]));
  f.files.get("Health/Dentist.md")!.fm = { date: "2026-12-20" };
  dl.fileChanged("Health/Dentist.md");
  f.flush();
  assert.deepEqual(heard, [["notes:Health"]]);
  assert.deepEqual(dl.notes("Health").map((r) => r.date), ["2026-12-20"]);
});

test("a rename moves a note between scopes", () => {
  const f = fakeHost({ "Inbox/Idea.md": {} });
  const dl = new DataLayer(f.host);
  assert.equal(dl.notes("Projects").length, 0);
  f.files.set("Projects/Idea.md", f.files.get("Inbox/Idea.md")!);
  f.files.delete("Inbox/Idea.md");
  dl.fileRenamed("Projects/Idea.md", "Inbox/Idea.md");
  assert.equal(dl.notes("Projects").length, 1);
  assert.equal(dl.notes("Inbox").length, 0);
});

test("500 changes reach a listener as one batch", () => {
  const notes = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`Health/n${i}.md`, { fm: { i } }]));
  const f = fakeHost(notes);
  const dl = new DataLayer(f.host);
  dl.notes("Health");
  let calls = 0;
  dl.subscribe(["notes:Health", "file:Apps/X data.md"], () => calls++);
  for (let i = 0; i < 500; i++) dl.fileChanged(`Health/n${i}.md`);
  dl.fileChanged("Apps/X data.md");
  assert.equal(f.flush(), 1);
  assert.equal(calls, 1);
});

test("three panels on one data block make one request", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const spec = readSpec({
    app: "Weather",
    data: { forecast: { source: WEATHER } },
    panels: [
      { view: "number", source: "forecast", pick: "current", field: "t" },
      { view: "text", source: "forecast", pick: "current", text: "{t}" },
      { view: "line", source: "forecast", pick: "hourly", x: "time", y: "t" },
    ],
  })!.spec!;
  await Promise.all(spec.panels.map(({ panel: p }) => dl.panelData(p.source, p, FILES, { ttlMs: 60_000, now: NOW })));
  assert.equal(f.requests.length, 1);
});

test("the one file reader serves a note's body, a file's text and a stored file, and rejects with one message", async () => {
  const f = fakeHost({ "Notes/a.md": { fm: { x: 1 }, body: "- [ ] task" }, "Finance/bank.csv": { raw: "a,b\n1,2" } });
  f.others.set("Books.base", "filters: x");
  assert.equal(await f.host.readFile("Notes/a.md"), "- [ ] task");
  assert.equal(await f.host.readFile("Finance/bank.csv"), "a,b\n1,2");
  assert.equal(await f.host.readFile("Books.base"), "filters: x");
  await assert.rejects(f.host.readFile("Nope.md"), { message: "Can't find Nope.md" });
  await assert.rejects(f.host.readFile("Nope.csv"), { message: "Can't find Nope.csv" });
});

test("a web response over 10 MB isn't read", async () => {
  const f = fakeHost();
  f.host.fetch = async () => ({ status: 200, text: `[${"1,".repeat(5_000_001)}1]`, contentType: "application/json" });
  const dl = new DataLayer(f.host);
  await assert.rejects(dl.fetch(WEATHER, undefined, 60_000), /api\.example\.com sent more than 10 MB/);
});

test("a response fetched with a secret or a body is never kept on disk, so a token or an account isn't left in the vault", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const flushDisk = () => new Promise((r) => setTimeout(r, 20));
  const authorized = { Authorization: "Bearer {secret:demo}" };
  await dl.fetch("https://bank.example/balance", authorized, 60_000, false, undefined, ["demo"]);
  await dl.fetch("https://api.example.com/key?k={secret:demo}", undefined, 60_000, false, undefined, ["demo"]);
  await dl.fetch("https://api.example.com/search", undefined, 60_000, false, { q: "x" });
  await dl.fetch(WEATHER, undefined, 60_000);
  await flushDisk();
  // The weather's answer, its line and its newest copy: nothing of the others.
  const kept = [...f.disk.files.values()].map((file) => file.text).join("\n");
  assert.equal(f.disk.files.size, 3);
  assert.ok(kept.includes("api.example.com/forecast"));
  assert.ok(!kept.includes("bank.example") && !kept.includes("api.example.com/key") && !kept.includes("api.example.com/search"));
  assert.equal(await dl.cached("https://bank.example/balance", authorized), undefined);
  assert.ok(await dl.cached(WEATHER, undefined));
});
