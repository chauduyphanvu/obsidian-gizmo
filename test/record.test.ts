import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { MAX_SAMPLES } from "../src/background.ts";
import { askersOf, permissionsOf, readSpec } from "../src/spec.ts";
import { fakeBackground } from "./support/fakes.ts";

const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const READINGS = [
  { time_tag: "2026-11-18T11:58:00", kp_index: 3, estimated_kp: 3.33 },
  { time_tag: "2026-11-18T11:59:00", kp_index: 4, estimated_kp: 4.33 },
];
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const MIN = 60_000;

/** A space-weather app recording the newest Kp reading every hour. */
function kpApp(block: Record<string, unknown> = { source: KP, sort: "-time_tag", limit: 1, record: "1h" }, data: Record<string, unknown> = {}) {
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: block }, panels: [{ view: "number", title: "Kp now", source: "kp", field: "kp_index" }] } },
    "Apps/Kp data.md": { fm: data },
  }, { [KP]: READINGS });
  const log = () => t.f.files.get("Apps/Kp data.md")!.fm![(block.into as string) ?? "kp_log"] as Record<string, unknown>[] | undefined;
  return { ...t, log };
}

test("a recorded block is sampled at its interval, as {at, …the row}", async () => {
  const t = kpApp();
  await t.bg.start();
  assert.deepEqual(t.log(), [{ at: "2026-11-18T12:00", time_tag: "2026-11-18T11:59:00", kp_index: 4, estimated_kp: 4.33 }]);
  t.advance(30 * MIN);
  await t.bg.tick();
  assert.equal(t.log()!.length, 1, "younger than the interval: skipped");
  t.advance(31 * MIN);
  await t.bg.tick();
  assert.deepEqual(t.log()!.map((r) => r.at), ["2026-11-18T12:00", "2026-11-18T13:01"]);
  assert.equal(t.f.requests.length, 2);
});

test("into names the list; the interval is at least a minute", async () => {
  const t = kpApp({ source: KP, sort: "-time_tag", limit: 1, record: "10s", into: "kp_samples" });
  await t.bg.start();
  t.advance(30_000);
  await t.bg.tick();
  assert.equal(t.log()!.length, 1);
  t.advance(30_000);
  await t.bg.tick();
  assert.equal(t.log()!.length, 2);
});

test("the last sample's time survives a restart", async () => {
  const t = kpApp(undefined, { kp_log: [{ at: "2026-11-18T11:30", kp_index: 2 }] });
  await t.bg.start();
  assert.equal(t.f.requests.length, 0, "the last sample is 30 minutes old");
  t.advance(30 * MIN);
  await t.bg.tick();
  assert.equal(t.log()!.length, 2);
});

test("record needs one row: told once a session, and again when the app is opened", async () => {
  const t = kpApp({ source: KP, sort: "-time_tag", record: "1h" });
  await t.bg.start();
  assert.deepEqual(t.notices, ["Kp: data.kp: record needs one row; add limit: 1 or pick"]);
  assert.equal(t.log(), undefined);
  t.advance(MIN);
  await t.bg.tick();
  assert.equal(t.notices.length, 1);
  t.bg.opened("Apps/Kp.md");
  await settle();
  assert.equal(t.notices.length, 2);
});

test("at most 10,000 rows are kept, the newest", async () => {
  const old = Array.from({ length: MAX_SAMPLES }, (_, i) => ({ at: "2026-11-17T00:00", n: i }));
  const t = kpApp(undefined, { kp_log: old });
  await t.bg.start();
  const log = t.log()!;
  assert.equal(log.length, MAX_SAMPLES);
  assert.equal(log[0].n, 1);
  assert.equal(log.at(-1)!.at, "2026-11-18T12:00");
});

test("an app that isn't allowed is never fetched for", async () => {
  const t = kpApp();
  t.denied.add("Apps/Kp.md");
  await t.bg.start();
  t.bg.opened("Apps/Kp.md");
  t.advance(2 * 60 * MIN);
  await t.bg.tick();
  await settle();
  assert.equal(t.f.requests.length, 0);
  assert.deepEqual(t.writes, []);
});

test("a failing fetch writes nothing and is tried again next tick; one app's failure doesn't stop another", async () => {
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: { source: KP, sort: "-time_tag", limit: 1, record: "1h" } }, view: "number", source: "kp", field: "kp_index" } },
    "Apps/Down.md": { fm: { app: "Down", data: { s: { source: "https://api.example.com/fail", record: "1h" } }, view: "number", source: "s", field: "t" } },
  }, { [KP]: READINGS });
  const fetch = t.f.host.fetch;
  let failures = 1;
  t.f.host.fetch = async (url, headers) => (url.startsWith(KP) && failures-- > 0 ? { status: 500, text: "", contentType: "" } : fetch(url, headers));
  await t.bg.start();
  assert.equal(t.f.files.get("Apps/Kp data.md"), undefined);
  t.advance(MIN);
  await t.bg.tick();
  assert.equal((t.f.files.get("Apps/Kp data.md")!.fm!.kp_log as unknown[]).length, 1);
  assert.equal(t.f.files.get("Apps/Down data.md"), undefined);
  assert.deepEqual(t.notices, []);
});

test("panels reading the recorded list update after a sample, and opening the app samples when due", async () => {
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: { source: KP, sort: "-time_tag", limit: 1, record: "1h" } }, panels: [
      { view: "number", title: "Samples", source: "kp_log", agg: "count" },
    ] } },
  }, { [KP]: READINGS });
  t.env.opened = (path) => t.bg.opened(path);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const big = () => root.querySelector(".na-big")?.textContent;
  await t.bg.start();
  new AppController(root, "Apps/Kp.md", t.env).load();
  await settle();
  assert.equal(big(), "1");
  t.advance(61 * MIN);
  await t.bg.tick();
  await settle();
  assert.equal(big(), "2");
  // Opening the app samples what is due, without waiting for the timer.
  t.advance(61 * MIN);
  new AppController(document.createElement("div"), "Apps/Kp.md", t.env).load();
  await settle();
  assert.equal(big(), "3");
});

test("a recorded block asks for everything it sends, as a panel naming it would: its body and the secrets in it", async () => {
  const GQL = "https://api.example.com/graphql";
  const block = { source: GQL, headers: { "X-Key": "{secret:hkey}" }, body: { token: "{secret:demo}", query: "{ kp }" }, record: "1h" };
  const fm = { app: "Kp", data: { kp: block }, panels: [{ view: "table", source: "kp_log" }] };
  const spec = readSpec(fm, { path: "Apps/Kp.md" })!.spec!;
  const wanted = ["net:api.example.com", "post:api.example.com", "secret:demo", "secret:hkey"];
  assert.deepEqual(permissionsOf(spec, "Apps/Kp.md"), wanted);
  assert.deepEqual([...askersOf(spec, "Apps/Kp.md").keys()].sort(), wanted);
  // The same app with a panel naming the block asks for the same.
  const shown = readSpec({ ...fm, panels: [{ view: "table", source: "kp" }] }, { path: "Apps/Kp.md" })!.spec!;
  assert.deepEqual(permissionsOf(shown, "Apps/Kp.md"), wanted);
  // A text body asks too.
  const text = readSpec({ ...fm, data: { kp: { source: GQL, body: "token={secret:demo}", record: "1h" } } }, { path: "Apps/Kp.md" })!.spec!;
  assert.deepEqual(permissionsOf(text, "Apps/Kp.md"), ["net:api.example.com", "post:api.example.com", "secret:demo"]);

  const t = fakeBackground({ "Apps/Kp.md": { fm }, "Apps/Kp data.md": { fm: {} } }, { [GQL]: { kp: 3 } });
  t.f.secrets.hkey = "h3ader";
  await t.bg.start();
  assert.deepEqual(t.f.calls.map((c) => [c.method, c.headers["X-Key"], JSON.parse(c.body!).token]), [["POST", "h3ader", "s3cret"]]);
  assert.deepEqual((t.f.files.get("Apps/Kp data.md")!.fm!.kp_log as unknown[]).length, 1);
});

test("a recorded block whose keys can't be read as a panel says why, and records nothing", async () => {
  const fm = {
    app: "Kp", inputs: { region: ["eu.example.com", "us.example.com"] },
    data: { kp: { source: "https://$region/kp", record: "1h" } }, panels: [{ view: "number", source: "kp_log", agg: "count" }],
  };
  const r = readSpec(fm, { path: "Apps/Kp.md" })!;
  assert.ok(r.errors.includes("data.kp: $region can't be part of a URL's host"), r.errors.join("; "));
  assert.deepEqual(permissionsOf(r.spec!, "Apps/Kp.md"), []);
  const t = fakeBackground({ "Apps/Kp.md": { fm } });
  await t.bg.start();
  assert.deepEqual(t.f.requests, []);
});
