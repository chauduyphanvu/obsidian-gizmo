import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer, cacheKey } from "../src/datalayer.ts";
import { KEEP_MS, MAX_DEVICE_BYTES, ResponseHistory, STILL_EVERY_MS, asOfText, sha256 } from "../src/responses.ts";
import { fakeEnv, fakeHost, memoryAdapter } from "./support/fakes.ts";

const URL_T = "https://api.example.com/now";
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const NOW = new Date(2026, 10, 18, 12, 0).getTime();
/** The age a panel marks its disk copy with (drawn by CSS from the attribute). */
const asOf = (root: Element) => root.querySelector(".gz-panel.gz-asof")?.getAttribute("data-asof") ?? undefined;

test("a successful response is kept, and read back parsed", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  assert.deepEqual(await dl.cached(URL_T, undefined), undefined);
  await dl.fetch(URL_T, undefined, 60_000);
  await settle(2);
  const text = JSON.stringify({ current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } });
  const blob = `plugin/responses/d1mac000/blobs/${await sha256(text)}.txt`;
  assert.deepEqual([...f.disk.files.keys()].sort(), [blob, "plugin/responses/d1mac000/index.jsonl", "plugin/responses/d1mac000/latest.json"]);
  assert.deepEqual(await dl.cached(URL_T, undefined), { data: { current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } }, at: 1_000_000 });
  // A failure keeps nothing.
  await assert.rejects(dl.fetch("https://api.example.com/fail", undefined, 60_000));
  await settle(2);
  assert.equal(f.disk.files.size, 3);
});

test("the kept copy survives a restart and goes through the panel's pipeline", async () => {
  const before = fakeHost();
  await new DataLayer(before.host).fetch(URL_T, undefined, 60_000);
  await settle(2);
  const after = fakeHost({}, before.disk);
  const dl = new DataLayer(after.host);
  const p = { view: "number", source: URL_T, pick: "hourly.t" };
  assert.deepEqual(await dl.cachedPanelData(URL_T, p, { appPath: "A.md", dataPath: "A data.md" }, new Date(NOW)), { data: [1, 2], at: 1_000_000 });
  assert.equal(after.requests.length, 0);
  // Sources that aren't on the web have no copy.
  assert.equal(await dl.cachedPanelData("doses", { view: "number", source: "doses" }, { appPath: "A.md", dataPath: "A data.md" }, new Date(NOW)), undefined);
});

test("a request with a secret is sent with it filled in, and neither the secret nor the answer is kept", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await dl.fetch("https://api.example.com/q?k={secret:demo}", { Authorization: "Bearer {secret:demo}" }, 60_000, false, undefined, ["demo"]);
  await settle(2);
  assert.equal(f.requests.at(-1), "https://api.example.com/q?k=s3cret");
  assert.equal(f.disk.files.size, 0);
  assert.equal(await dl.cached("https://api.example.com/q?k={secret:demo}", { Authorization: "Bearer {secret:demo}" }), undefined);
});

/** A history on an in-memory folder with a clock the test moves. */
function history(device = "mac", disk = memoryAdapter(), clock = { now: NOW }) {
  return { h: new ResponseHistory(disk.adapter, "r", () => device, () => clock.now), disk, clock };
}
const lines = (disk: ReturnType<typeof memoryAdapter>, device = "mac") => (disk.files.get(`r/${device}/index.jsonl`)?.text ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { k: string; at: number; h: string });

test("answers over 1 MB aren't kept", async () => {
  const { h, disk } = history();
  await h.record("big", "x".repeat(1_000_001), "text/plain");
  assert.equal(disk.files.size, 0);
  assert.equal(await h.latest("big"), undefined);
  await h.record("small", "x".repeat(1000), "text/plain");
  assert.equal((await h.latest("small"))?.text.length, 1000);
});

test("an answer is kept once however often it comes; a line when it changes, and hourly while it doesn't", async () => {
  const { h, disk, clock } = history();
  await h.record("a", "1", "");
  clock.now += 60_000;
  await h.record("a", "1", "");
  await h.record("b", "1", "");
  clock.now += STILL_EVERY_MS;
  await h.record("a", "1", "");
  clock.now += 60_000;
  await h.record("a", "2", "");
  assert.deepEqual(lines(disk).map((l) => `${l.k}@${(l.at - NOW) / 60_000}`), ["a@0", "b@1", "a@61", "a@62"]);
  assert.equal([...disk.files.keys()].filter((p) => p.includes("/blobs/")).length, 2, "one blob for 1, one for 2");
  // The newest is the last fetch, even when no line was written for it.
  clock.now += 60_000;
  await h.record("a", "2", "");
  assert.equal((await h.latest("a"))?.at, NOW + 63 * 60_000);
});

test("the answer at a time is the newest kept at or before it, from any device", async () => {
  const disk = memoryAdapter();
  const clock = { now: NOW };
  const mac = history("mac", disk, clock).h;
  const phone = history("phone", disk, clock).h;
  await mac.record("k", "one", "");
  clock.now = NOW + 10;
  await phone.record("k", "two", "");
  clock.now = NOW + 20;
  await mac.record("k", "three", "");
  const reader = history("ipad", disk, clock).h;
  assert.equal(await reader.at("k", NOW - 1), undefined);
  assert.equal((await reader.at("k", NOW))?.text, "one");
  assert.equal((await reader.at("k", NOW + 15))?.text, "two");
  assert.equal((await reader.at("k", NOW + 20))?.text, "three");
  assert.deepEqual(await reader.times("k"), [NOW, NOW + 10, NOW + 20]);
});

test("lines past 90 days go, then the oldest past 200 MB, with the answers nothing names any more", async () => {
  const { h, disk, clock } = history();
  await h.record("old", "o", "");
  clock.now += 1000;
  await h.record("k", "a", "");
  clock.now += 1000;
  await h.record("k", "b", "");
  clock.now += 1000;
  await h.record("k", "c", "");
  // Stand in for big answers: what the lines say of their size is what pruning counts.
  const kept = lines(disk).map((l) => ({ ...l, n: l.k === "k" ? MAX_DEVICE_BYTES / 2 + 1 : 1 }));
  disk.files.set("r/mac/index.jsonl", { text: kept.map((l) => `${JSON.stringify(l)}\n`).join(""), mtime: 0 });
  const latest = JSON.parse(disk.files.get("r/mac/latest.json")!.text) as { latest: Record<string, { n: number }> };
  latest.latest.k.n = MAX_DEVICE_BYTES / 2 + 1;
  disk.files.set("r/mac/latest.json", { text: JSON.stringify(latest), mtime: 0 });
  // Restarted 90 days after the first answer: it goes, and of a, b and c only what fits stays.
  clock.now = NOW + KEEP_MS + 500;
  const again = new ResponseHistory(disk.adapter, "r", () => "mac", () => clock.now);
  assert.equal(await again.latest("old"), undefined);
  assert.deepEqual(lines(disk).map((l) => l.k), ["k"]);
  assert.equal((await again.latest("k"))?.text, "c");
  assert.equal((await again.at("k", NOW + 2000)), undefined, "b went for room");
  assert.equal([...disk.files.keys()].filter((p) => p.includes("/blobs/")).length, 1);
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
  await t.f.keep(cacheKey(URL_T, undefined), JSON.stringify({ current: { t: 3 } }), NOW - 2 * 3_600_000);
  new AppController(t.root, "Apps/W.md", t.env).load();
  await settle(2);
  assert.ok(t.root.querySelector(".gz-view-number")!.classList.contains("gz-loading"), "waits briefly for the network first");
  await settle(6);
  assert.equal(text(t.root.querySelector(".gz-big")), "3");
  assert.equal(asOf(t.root), "as of 2 hours ago");
  t.answer(200, { current: { t: 9 } });
  await settle(2);
  assert.equal(text(t.root.querySelector(".gz-big")), "9");
  assert.equal(asOf(t.root), undefined);
});

test("the network failing shows the disk copy with its age instead of an error", async () => {
  const t = coldApp();
  await t.f.keep(cacheKey(URL_T, undefined), JSON.stringify({ current: { t: 3 } }), NOW - 3 * 86_400_000);
  new AppController(t.root, "Apps/W.md", t.env).load();
  await settle(1);
  t.answer(503, {});
  await settle(3);
  assert.equal(t.root.querySelector(".gz-error"), null);
  assert.equal(text(t.root.querySelector(".gz-big")), "3");
  assert.equal(asOf(t.root), "as of 3 days ago");
});

test("the network failing without a disk copy shows the error", async () => {
  const t = coldApp();
  new AppController(t.root, "Apps/W.md", t.env).load();
  await settle(1);
  t.answer(503, {});
  await settle(3);
  assert.match(text(t.root.querySelector(".gz-error")), /api.example.com answered 503/);
  assert.equal(asOf(t.root), undefined);
});

test("the age stays on a panel while its view draws itself again", async () => {
  const t = fakeEnv({ "Apps/W.md": { fm: { app: "x", view: "line", source: URL_T, pick: "hourly", x: "time", y: "t" } } });
  await t.f.keep(cacheKey(URL_T, undefined), JSON.stringify({ hourly: { time: ["a", "b"], t: [1, 2] } }), NOW - 60_000);
  t.f.host.fetch = async () => ({ status: 503, text: "", contentType: "" });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Apps/W.md", t.env);
  app.load();
  await settle(3);
  const chart = root.querySelector(".gz-chart-svg");
  assert.equal(asOf(root), "as of 1 minute ago");
  // A chart draws itself again at a new width, emptying its panel.
  Object.defineProperty(root.querySelector(".gizmo"), "clientWidth", { value: 700, configurable: true });
  app.resize();
  await settle(20);
  assert.notEqual(root.querySelector(".gz-chart-svg"), chart);
  assert.equal(asOf(root), "as of 1 minute ago");
});
