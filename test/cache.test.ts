import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DiskCache, MAX_ENTRIES, asOfText, cacheHash } from "../src/cache.ts";
import { DataLayer, cacheKey } from "../src/datalayer.ts";
import { fakeEnv, fakeHost, memoryAdapter } from "./support/fakes.ts";

const URL_T = "https://api.example.com/now";
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const NOW = new Date(2026, 10, 18, 12, 0).getTime();
/** The age a panel marks its disk copy with (drawn by CSS from the attribute). */
const asOf = (root: Element) => root.querySelector(".na-panel.na-asof")?.getAttribute("data-asof") ?? undefined;

test("a successful response is written through to disk and read back parsed", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  assert.deepEqual(await dl.cached(URL_T, undefined), undefined);
  await dl.fetch(URL_T, undefined, 60_000);
  await settle(1);
  const [path] = [...f.disk.files.keys()];
  assert.equal(path, `plugin/cache/${cacheHash(cacheKey(URL_T, undefined))}.json`);
  assert.deepEqual(await dl.cached(URL_T, undefined), { data: { current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } }, at: 1_000_000 });
  // A failure writes nothing.
  await assert.rejects(dl.fetch("https://api.example.com/fail", undefined, 60_000));
  await settle(1);
  assert.equal(f.disk.files.size, 1);
});

test("the disk copy survives a restart and goes through the panel's pipeline", async () => {
  const before = fakeHost();
  await new DataLayer(before.host).fetch(URL_T, undefined, 60_000);
  await settle(1);
  const after = fakeHost({}, before.disk);
  const dl = new DataLayer(after.host);
  const p = { view: "number", source: URL_T, pick: "hourly.t" };
  assert.deepEqual(await dl.cachedPanelData(URL_T, p, { appPath: "A.md", dataPath: "A data.md" }, new Date(NOW)), { data: [1, 2], at: 1_000_000 });
  assert.equal(after.requests.length, 0);
  // Sources that aren't on the web have no disk copy.
  assert.equal(await dl.cachedPanelData("doses", { view: "number", source: "doses" }, { appPath: "A.md", dataPath: "A data.md" }, new Date(NOW)), undefined);
});

test("keys hold secret placeholders; secret values never reach the disk", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await dl.fetch("https://api.example.com/q?k={secret:demo}", { Authorization: "Bearer {secret:demo}" }, 60_000, false, undefined, ["demo"]);
  await settle(1);
  assert.equal(f.requests.at(-1), "https://api.example.com/q?k=s3cret");
  const stored = [...f.disk.files.values()].map((file) => file.text).join("\n");
  assert.match(stored, /\{secret:demo\}/);
  assert.doesNotMatch(stored, /s3cret/);
  assert.ok(await dl.cached("https://api.example.com/q?k={secret:demo}", { Authorization: "Bearer {secret:demo}" }));
});

test("entries over 1 MB aren't stored", async () => {
  const disk = memoryAdapter();
  const cache = new DiskCache(disk.adapter, "c");
  await cache.write("big", { at: 1, text: "x".repeat(1_000_001), contentType: "text/plain" });
  assert.equal(disk.files.size, 0);
  assert.equal(await cache.read("big"), undefined);
  await cache.write("small", { at: 1, text: "x".repeat(1000), contentType: "text/plain" });
  assert.equal((await cache.read("small"))?.text.length, 1000);
});

test("at most 200 entries; the oldest go first, also after a restart", async () => {
  let clock = 0;
  const disk = memoryAdapter(() => clock);
  const cache = new DiskCache(disk.adapter, "c");
  for (let i = 0; i < MAX_ENTRIES; i++) {
    clock = 1000 + i;
    await cache.write(`k${i}`, { at: clock, text: `${i}`, contentType: "" });
  }
  assert.equal(disk.files.size, MAX_ENTRIES);
  // Read again from the folder: write times come from the files.
  const restarted = new DiskCache(disk.adapter, "c");
  clock = 5000;
  await restarted.write("new", { at: clock, text: "n", contentType: "" });
  assert.equal(disk.files.size, MAX_ENTRIES);
  assert.equal(await restarted.read("k0"), undefined);
  assert.equal((await restarted.read("k1"))?.text, "1");
  assert.equal((await restarted.read("new"))?.text, "n");
});

test("a file holding another key is never served for this one", async () => {
  const disk = memoryAdapter();
  const cache = new DiskCache(disk.adapter, "c");
  await cache.write("https://a.example.com/x|{}", { at: 1, text: "A", contentType: "" });
  // Stand in for a hash collision: B's file name holding A's response.
  const [[, file]] = [...disk.files];
  disk.files.set(`c/${cacheHash("https://b.example.com/y|{}")}.json`, file);
  const restarted = new DiskCache(disk.adapter, "c");
  assert.equal(await restarted.read("https://b.example.com/y|{}"), undefined);
  assert.equal((await restarted.read("https://a.example.com/x|{}"))?.text, "A");
  assert.equal(cacheHash("x").length, 16);
  assert.notEqual(cacheHash("ab"), cacheHash("ba"));
});

test("relative age of a copy", () => {
  assert.equal(asOfText(NOW - 20_000, NOW), "as of just now");
  assert.equal(asOfText(NOW - 60_000, NOW), "as of 1 minute ago");
  assert.equal(asOfText(NOW - 2 * 3_600_000 - 5, NOW), "as of 2 hours ago");
  assert.equal(asOfText(NOW - 3 * 86_400_000, NOW), "as of 3 days ago");
});

/** An app with one number panel on URL_T, whose network answers when `answer` is called. */
function coldApp() {
  const t = fakeEnv({ "Apps/W.md": { fm: { app: "x", view: "number", source: URL_T, pick: "current", field: "t" } } });
  let answer: (res: { status: number; text: string; contentType: string }) => void = () => {};
  t.f.host.fetch = () => new Promise((resolve) => { answer = resolve; });
  const root = document.createElement("div");
  document.body.appendChild(root);
  return { ...t, root, answer: (status: number, body: unknown) => answer({ status, text: JSON.stringify(body), contentType: "application/json" }) };
}

test("cold start: the disk copy paints first, with its age, then the network's answer replaces it", async () => {
  const t = coldApp();
  await t.f.host.cacheWrite!(cacheKey(URL_T, undefined), { at: NOW - 2 * 3_600_000, text: JSON.stringify({ current: { t: 3 } }), contentType: "application/json" });
  new AppController(t.root, "Apps/W.md", t.env).load();
  await settle(2);
  assert.ok(t.root.querySelector(".na-view-number")!.classList.contains("na-loading"), "waits briefly for the network first");
  await settle(6);
  assert.equal(text(t.root.querySelector(".na-big")), "3");
  assert.equal(asOf(t.root), "as of 2 hours ago");
  t.answer(200, { current: { t: 9 } });
  await settle(2);
  assert.equal(text(t.root.querySelector(".na-big")), "9");
  assert.equal(asOf(t.root), undefined);
});

test("the network failing shows the disk copy with its age instead of an error", async () => {
  const t = coldApp();
  await t.f.host.cacheWrite!(cacheKey(URL_T, undefined), { at: NOW - 3 * 86_400_000, text: JSON.stringify({ current: { t: 3 } }), contentType: "application/json" });
  new AppController(t.root, "Apps/W.md", t.env).load();
  await settle(1);
  t.answer(503, {});
  await settle(3);
  assert.equal(t.root.querySelector(".na-error"), null);
  assert.equal(text(t.root.querySelector(".na-big")), "3");
  assert.equal(asOf(t.root), "as of 3 days ago");
});

test("the network failing without a disk copy shows the error", async () => {
  const t = coldApp();
  new AppController(t.root, "Apps/W.md", t.env).load();
  await settle(1);
  t.answer(503, {});
  await settle(3);
  assert.match(text(t.root.querySelector(".na-error")), /api.example.com answered 503/);
  assert.equal(asOf(t.root), undefined);
});

test("the age stays on a panel while its view draws itself again", async () => {
  const t = fakeEnv({ "Apps/W.md": { fm: { app: "x", view: "line", source: URL_T, pick: "hourly", x: "time", y: "t" } } });
  await t.f.host.cacheWrite!(cacheKey(URL_T, undefined), { at: NOW - 60_000, text: JSON.stringify({ hourly: { time: ["a", "b"], t: [1, 2] } }), contentType: "application/json" });
  t.f.host.fetch = async () => ({ status: 503, text: "", contentType: "" });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Apps/W.md", t.env);
  app.load();
  await settle(3);
  const chart = root.querySelector(".na-chart-svg");
  assert.equal(asOf(root), "as of 1 minute ago");
  // A chart draws itself again at a new width, emptying its panel.
  Object.defineProperty(root.querySelector(".note-app"), "clientWidth", { value: 700, configurable: true });
  app.resize();
  await settle(20);
  assert.notEqual(root.querySelector(".na-chart-svg"), chart);
  assert.equal(asOf(root), "as of 1 minute ago");
});
