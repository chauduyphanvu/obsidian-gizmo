import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { fakeBackground } from "./support/fakes.ts";

const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const MIN = 60_000;
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

/** The Kp feed answers with `kp.now` as its newest reading. */
function kpFeed(t: ReturnType<typeof fakeBackground>) {
  const kp = { now: 3 };
  t.f.host.fetch = async (url) => {
    t.f.requests.push(url);
    const rows = [{ time_tag: "2026-11-18T11:58:00", kp_index: 1 }, { time_tag: "2026-11-18T11:59:00", kp_index: kp.now }];
    return { status: 200, text: JSON.stringify(rows), contentType: "application/json" };
  };
  return kp;
}

test("a pinned value is in the status bar, kept current on its data and on the app's refresh", async () => {
  const t = fakeBackground({
    "Apps/Meds.md": { fm: { app: "Meds", panels: [
      { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds" },
      { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", pin: "status" },
    ] } },
    "Apps/Weight.md": { fm: { app: "Weight", view: "number", title: "Weight", source: "weights", field: "weight", unit: "kg", decimals: 1, pin: "status" } },
    "Apps/Weight data.md": { fm: { weights: [{ weight: 80.25 }] } },
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: { source: KP, sort: "-time_tag", limit: 1 } }, panels: [
      { view: "number", title: "Kp", source: "kp", field: "kp_index", pin: "status" },
    ] } },
  });
  const kp = kpFeed(t);
  await t.bg.start();
  assert.deepEqual(t.out.status, [
    { appPath: "Apps/Kp.md", text: "Kp: 3", title: "Kp" },
    { appPath: "Apps/Meds.md", text: "Doses today: 0", title: "Meds" },
    { appPath: "Apps/Weight.md", text: "Weight: 80.3 kg", title: "Weight" },
  ]);
  await t.bg.runCommand("Apps/Meds.md:took-meds");
  await settle();
  assert.equal(t.out.status[1].text, "Doses today: 1");

  // A web value is fetched again on the app's refresh (10 minutes unless it says otherwise).
  kp.now = 4;
  t.advance(5 * MIN);
  await t.bg.tick();
  assert.equal(t.out.status[0].text, "Kp: 3");
  assert.equal(t.f.requests.length, 1);
  t.advance(5 * MIN);
  await t.bg.tick();
  assert.equal(t.out.status[0].text, "Kp: 4");
  assert.equal(t.f.requests.length, 2);

  // Unpinned, it leaves; an app no longer allowed shows nothing.
  t.f.files.get("Apps/Weight.md")!.fm!.pin = null;
  t.changed("Apps/Weight.md");
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.appPath), ["Apps/Kp.md", "Apps/Meds.md"]);
  t.denied.add("Apps/Meds.md");
  await t.bg.tick();
  assert.deepEqual(t.out.status.map((s) => s.appPath), ["Apps/Kp.md"]);
});

test("an alert tells once when it turns true, and again only after it has been false", async () => {
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", refresh: "1m", data: { kp: { source: KP, sort: "-time_tag", limit: 1 } }, panels: [
      { view: "number", title: "Kp now", source: "kp", field: "kp_index", alert: ">= 5" },
      { view: "table", title: "Storm readings", source: KP, alert: { kp_index: ">= 5" } },
    ] } },
  });
  const kp = kpFeed(t);
  const step = async (value: number) => {
    kp.now = value;
    t.advance(MIN);
    await t.bg.tick();
  };
  await t.bg.start();
  assert.deepEqual(t.notices, []);
  await step(6);
  assert.deepEqual(t.notices, ["Kp: Kp now 6", "Kp: Storm readings (1 row)"]);
  await step(7);
  assert.equal(t.notices.length, 2);
  await step(2);
  assert.equal(t.notices.length, 2);
  await step(5);
  assert.deepEqual(t.notices.slice(2), ["Kp: Kp now 5", "Kp: Storm readings (1 row)"]);
});

test("an alert already true at startup is told once; editing the app doesn't tell it again", async () => {
  const fm = { app: "Kp", data: { kp: { source: KP, sort: "-time_tag", limit: 1 } }, panels: [
    { view: "number", title: "Kp now", source: "kp", field: "kp_index", alert: ">= 5" },
  ] };
  const t = fakeBackground({ "Apps/Kp.md": { fm } });
  kpFeed(t).now = 8;
  await t.bg.start();
  assert.deepEqual(t.notices, ["Kp: Kp now 8"]);
  t.f.files.get("Apps/Kp.md")!.fm = { ...fm, refresh: "5m" };
  t.changed("Apps/Kp.md");
  await settle();
  assert.equal(t.notices.length, 1);
});

test("view: alerts lists what needs attention across the vault and follows it", async () => {
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", refresh: "1m", data: { kp: { source: KP, sort: "-time_tag", limit: 1 } }, panels: [
      { view: "number", title: "Kp now", source: "kp", field: "kp_index", alert: ">= 5" },
    ] } },
    "Apps/Attention.md": { fm: { app: "What needs my attention", view: "alerts", title: "Needs attention" } },
  });
  const kp = kpFeed(t);
  t.env.alerts = t.bg.alerts;
  await t.bg.start();
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Attention.md", t.env).load();
  await settle();
  assert.equal(text(root.querySelector(".na-view-alerts .na-empty")), "Nothing needs attention.");

  kp.now = 6;
  t.advance(MIN);
  await t.bg.tick();
  const items = [...root.querySelectorAll(".na-alerts li")];
  assert.deepEqual(items.map((li) => [...li.children].map((c) => text(c))), [["Kp", "Kp now", "6"]]);
  (items[0].querySelector("a") as HTMLElement).click();
  assert.deepEqual(t.opened, ["Apps/Kp.md"]);

  kp.now = 1;
  t.advance(MIN);
  await t.bg.tick();
  assert.equal(text(root.querySelector(".na-view-alerts .na-empty")), "Nothing needs attention.");
});
