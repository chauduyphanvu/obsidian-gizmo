import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { readSpec } from "../src/spec.ts";
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

test("the status bar and an alert's notice say a value as its view does: values, format, unit and decimals", async () => {
  const t = fakeBackground({
    "Apps/Money.md": { fm: { app: "Money", panels: [
      { view: "number", title: "Spent", source: "buys", field: "amount", agg: "sum", format: "$0,0.00", pin: "status", alert: "> 1000" },
      { view: "number", title: "Weather", source: "now", field: "code", values: { code: { 1: "Mostly clear" } }, unit: "x", pin: "status" },
      { view: "number", title: "Weight", source: "weights", field: "kg", unit: "kg", decimals: 1, pin: "status", alert: ">= 80" },
      { view: "text", title: "Last buy", source: "buys", text: "{shop}: {amount}", format: { amount: "$0.00" }, values: { shop: { a: "Apple" } }, pin: "status" },
      { view: "progress", title: "Budget", source: "buys", field: "amount", agg: "sum", max: 2000, format: "$0,0", alert: ">= 1000" },
    ] } },
    "Apps/Money data.md": { fm: { buys: [{ shop: "a", amount: 1234.5 }], now: [{ code: 1 }], weights: [{ kg: 80.25 }] } },
  });
  await t.bg.start();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Spent: $1,234.50", "Weather: Mostly clear", "Weight: 80.3 kg", "Last buy: Apple: $1234.50"]);
  assert.deepEqual(t.notices, ["Money: Spent $1,234.50", "Money: Weight 80.3 kg", "Money: Budget $1,235"]);
  assert.deepEqual(t.bg.alerts.list().map((a) => a.text), ["$1,234.50", "80.3 kg", "$1,235"]);
});

test("a compare panel that is pinned or alerting reads its current window, not the previous one too", async () => {
  const fm = { app: "Doses", panels: [
    { view: "number", title: "Doses", source: "doses", where: { at: "this week" }, agg: "count", compare: "previous", pin: "status", alert: ">= 3" },
    { view: "number", title: "Late", source: "doses", where: { at: "this week", late: true }, agg: "count", compare: "previous", alert: { late: true } },
  ] };
  // 18 November 2026 is a Wednesday: this week starts on Monday the 16th.
  const doses = [
    { at: "2026-11-17T08:00" }, { at: "2026-11-18T08:00" },
    { at: "2026-11-10T08:00", late: true }, { at: "2026-11-11T08:00" }, { at: "2026-11-12T08:00" },
  ];
  const t = fakeBackground({ "Apps/Doses.md": { fm }, "Apps/Doses data.md": { fm: { doses } } });
  await t.bg.start();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Doses: 2"]);
  assert.deepEqual(t.notices, []);
  const [pinned, late] = readSpec(fm, { path: "Apps/Doses.md" })!.spec!.panels;
  const r = await t.bg.evaluate("Apps/Doses.md", pinned);
  assert.deepEqual("rows" in r && r.rows, [{ at: "2026-11-17T08:00" }, { at: "2026-11-18T08:00" }]);
  // The earlier week's late dose is not this week's.
  const l = await t.bg.evaluate("Apps/Doses.md", late);
  assert.equal("value" in l && l.value, 0);

  doses.push({ at: "2026-11-18T20:00" });
  t.f.files.get("Apps/Doses data.md")!.fm = { doses };
  t.changed("Apps/Doses data.md");
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Doses: 3"]);
  assert.deepEqual(t.notices, ["Doses: Doses 3"]);
});

test("a pinned panel that reads $this works while the app is closed, with the app note as $this", async () => {
  const t = fakeBackground({
    "Apps/Meds.md": { fm: { app: "Meds", owner: "ann", panels: [
      { view: "number", title: "Doses", source: "doses", where: { who: "$this.owner" }, agg: "count", pin: "status" },
      { view: "number", title: "Under my name", source: "doses", where: { who: "$this.name" }, agg: "count", pin: "status" },
      { view: "number", title: "Not a property", source: "doses", where: { who: "$this.nothing" }, agg: "count", pin: "status" },
    ] } },
    "Apps/Meds data.md": { fm: { doses: [{ who: "ann" }, { who: "bob" }, { who: "ann" }, { who: "Meds" }] } },
  });
  await t.bg.start();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Doses: 2", "Under my name: 1", "Not a property: 0"]);

  // The data it reads is watched like any other panel's.
  t.f.files.get("Apps/Meds data.md")!.fm = { doses: [{ who: "ann" }] };
  t.changed("Apps/Meds data.md");
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Doses: 1", "Under my name: 0", "Not a property: 0"]);

  // And so is the note itself: another owner, another count.
  t.f.files.get("Apps/Meds.md")!.fm!.owner = "bob";
  t.changed("Apps/Meds.md");
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Doses: 0", "Under my name: 0", "Not a property: 0"]);
});

test("a pinned compare panel's status says the number its view shows, the current window's sum", async () => {
  // This week (from Monday the 16th) spent 20; the week before, 100.
  const fm = { app: "Spend", panels: [{
    view: "number", title: "This week", source: "spend", field: "amount", agg: "sum",
    where: { at: "this week" }, compare: "previous", pin: "status", alert: ">= 50",
  }] };
  const spend = [{ at: "2026-11-10T09:00", amount: 100 }, { at: "2026-11-17T09:00", amount: 20 }];
  const t = fakeBackground({ "Apps/Spend.md": { fm }, "Apps/Spend data.md": { fm: { spend } } });
  await t.bg.start();
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Spend.md", t.env).load();
  await settle(8);
  const shown = root.querySelector(".na-big")?.textContent;
  assert.equal(shown, "20");
  assert.deepEqual(t.out.status.map((s) => s.text), [`This week: ${shown}`]);
  assert.deepEqual(t.notices, [], "120 across both weeks would have been told");
});
