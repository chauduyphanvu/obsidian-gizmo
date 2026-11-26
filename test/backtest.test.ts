import "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backtest, EditSession, MAX_STEPS, SESSION_GAP_MS, type BacktestJob } from "../src/backtest.ts";
import { DataLayer } from "../src/datalayer.ts";
import { readSpec, type AppSpec } from "../src/spec.ts";
import { fakeEnv } from "./support/fakes.ts";

const APP = "Apps/Weight.md";
const DATA = "Apps/Weight data.md";
const day = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const stamp = (t: number) => { const d = new Date(t); return `2026-11-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const weightApp = (alert: string, expect?: unknown[]) => ({
  app: "Weight",
  panels: [{ view: "number", title: "Latest", source: "weight", field: "kg", agg: "last", alert }],
  ...(expect && { expect }),
});

/** Weights logged at these times, each written then (its ledger event carries the time). */
async function logged(entries: [number, number][], fm: Record<string, unknown>) {
  const t = fakeEnv({ [APP]: { fm } });
  const store = t.env.store!(DATA, APP);
  for (const [at, kg] of entries) {
    t.f.advance(at - t.f.host.now());
    await store.add("weight", { kg, at: stamp(at) });
  }
  return t;
}

function job(t: Awaited<ReturnType<typeof logged>>, after: Record<string, unknown>, before?: Record<string, unknown>, to = t.f.host.now()): BacktestJob {
  const spec = (fm: Record<string, unknown>) => readSpec(fm, { path: APP, notes: t.env.notes, now: new Date(to) })!.spec as AppSpec;
  return { layer: new DataLayer(t.env.data.host, { at: to }), appPath: APP, dataPath: DATA, before: before && spec(before), after: spec(after), to };
}

const WEIGHTS: [number, number][] = [[day(19, 8), 80], [day(20, 8), 77], [day(21, 8), 79], [day(22, 8), 74], [day(23, 8), 80], [day(24, 8), 76]];

test("an alert's threshold moved from < 75 to < 78 fires on three days instead of one: two added, none lost, at the times the weights came", async () => {
  const t = await logged(WEIGHTS, weightApp("< 75"));
  const r = (await backtest(job(t, weightApp("< 78"), weightApp("< 75"), day(24, 20))))!;
  assert.deepEqual(r.before!.map((f) => f.at), [day(22, 8)]);
  assert.deepEqual(r.after.map((f) => f.at), [day(20, 8), day(22, 8), day(24, 8)]);
  assert.deepEqual(r.added.map((f) => f.at), [day(20, 8), day(24, 8)]);
  assert.deepEqual(r.lost, []);
  assert.deepEqual([r.from, r.to, r.cut, r.errors], [day(19, 0), day(24, 20), false, []]);
  assert.equal(r.after[0].what, "Latest");
  // The past is read, not changed.
  assert.deepEqual((await t.env.store!(DATA, APP).rows("weight")).length, 6);
});

test("the same backtest twice gives the same result; one cancelled stops with none", async () => {
  const t = await logged(WEIGHTS, weightApp("< 78"));
  const a = await backtest(job(t, weightApp("< 78"), undefined, day(24, 20)));
  const b = await backtest(job(t, weightApp("< 78"), undefined, day(24, 20)));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual([a!.before, a!.added, a!.lost], [undefined, [], []]);
  let steps = 0;
  const stopped = await backtest({ ...job(t, weightApp("< 78")), progress: () => { steps++; }, cancelled: () => steps >= 2 });
  assert.equal(stopped, undefined);
});

test("a rhythm due by 10:00 misses the days with no row by then, a late row included; its then is named", async () => {
  const rule = { id: "weigh", every: "day", by: "10:00", source: "weight", say: "no weight by 10:00", then: { app: "[[Reminders]]", do: "nag" } };
  const t = await logged([[day(19, 8), 80], [day(20, 12), 79], [day(22, 9), 78]], weightApp("> 1000", [rule]));
  const r = (await backtest(job(t, weightApp("> 1000", [rule]), undefined, day(22, 18))))!;
  assert.deepEqual(r.after.map((f) => [f.at, f.what, f.then]), [
    [day(20, 10), "no weight by 10:00", "nag in Reminders"],
    [day(21, 10), "no weight by 10:00", "nag in Reminders"],
  ]);
});

test("an app with nothing kept yet is backtested from when its note was made, not from a month before", async () => {
  const rule = { id: "weigh", every: "day", by: "10:00", source: "weight", say: "no weight by 10:00" };
  const t = await logged([], weightApp("> 1000", [rule]));
  const info = t.f.host.fileInfo.bind(t.f.host);
  t.f.host.fileInfo = (p) => (p === APP ? { ...info(p)!, ctime: day(22, 11) } : info(p));
  const r = (await backtest(job(t, weightApp("> 1000", [rule]), undefined, day(24, 18))))!;
  // The 22nd's deadline came before the app did.
  assert.equal(r.from, day(22, 11));
  assert.deepEqual(r.after.map((f) => f.at), [day(23, 10), day(24, 10)]);
});

test("a state rule fires when a row comes to match it, as an alert does", async () => {
  const rule = { id: "heavy", source: "weight", none: { kg: "> 79" }, say: "over 79" };
  const t = await logged(WEIGHTS, weightApp("> 1000", [rule]));
  const r = (await backtest(job(t, weightApp("> 1000", [rule]), undefined, day(24, 20))))!;
  // The first weight is over 79 from the start, which is noted, not counted.
  assert.deepEqual(r.after.map((f) => [f.key, f.what]), []);
  const later = await logged([[day(19, 8), 70], [day(21, 8), 81]], weightApp("> 1000", [rule]));
  const r2 = (await backtest(job(later, weightApp("> 1000", [rule]), undefined, day(22, 8))))!;
  assert.deepEqual(r2.after.map((f) => [f.at, f.key, f.what]), [[day(21, 8), "expect:heavy", "over 79"]]);
});

test("steps past the limit start the backtest later and say so", async () => {
  // More times than a call takes as arguments, as a year of samples every few minutes would be.
  const many: [number, number][] = Array.from({ length: 150_000 }, (_, i) => [day(19, 0) + i * 100, 80]);
  const t = await logged(many.slice(0, 3), weightApp("< 75"));
  // Times of events alone are what is counted; three real ones and a stand-in for the rest.
  const j = job(t, weightApp("< 75"), undefined, day(19, 20));
  const ledger = j.layer.ledger!;
  ledger.times = async () => many.map(([at]) => at);
  const r = (await backtest(j))!;
  assert.equal(r.steps, MAX_STEPS);
  assert.equal(r.cut, true);
  assert.ok(r.from > day(19, 0));
});

test("a panel added above the alert moves it without changing it: nothing added or lost", async () => {
  const t = await logged(WEIGHTS, weightApp("< 78"));
  const moved = { ...weightApp("< 78"), panels: [{ view: "text", title: "Note", text: "Weigh in the morning" }, ...weightApp("< 78").panels] };
  const r = (await backtest(job(t, moved, weightApp("< 78"), day(24, 20))))!;
  assert.equal(r.before!.length, 3);
  assert.deepEqual([r.added, r.lost], [[], []]);
});

test("an editing session's before is the definition from before its first change after two minutes without one", () => {
  const s = new EditSession();
  // A note Obsidian hasn't read yet starts nothing.
  s.seen(undefined, 0);
  s.seen({ alert: "< 75" }, 0);
  assert.equal(s.changed(), false);
  s.seen({ alert: "< 7" }, 1000);
  s.seen({ alert: "< 78" }, 2000);
  assert.deepEqual(s.before, { alert: "< 75" });
  assert.equal(s.changed(), true);
  // Typing on within two minutes keeps the same before.
  s.seen({ alert: "< 79" }, 2000 + SESSION_GAP_MS - 1);
  assert.deepEqual(s.before, { alert: "< 75" });
  // A change after a pause starts a new session from what was there.
  s.seen({ alert: "< 80" }, 2000 + 3 * SESSION_GAP_MS);
  assert.deepEqual(s.before, { alert: "< 79" });
  s.seen({ alert: "< 79" }, 2000 + 3 * SESSION_GAP_MS + 1);
  assert.equal(s.changed(), false, "back as it was");
});

test("a backtest of an app in the vault: refused while the app has a mistake or nothing to replay, else run on a replay of what was kept", async () => {
  const { runtimeOn } = await import("./support/runtime.ts");
  const { backtestApp, watches } = await import("../src/backtest.ts");
  const t = await runtimeOn({
    "Apps/Quiet.md": { fm: { app: "Quiet", panels: [{ view: "number", source: "items", agg: "count" }] }, body: "" },
    "Apps/Loud.md": { fm: { app: "Loud", panels: [{ view: "number", title: "Many", source: "items", agg: "count", alert: "> 1" }] }, body: "" },
    "Apps/Loud data.md": { fm: { items: [{ n: 1, at: "2026-11-17T09:00" }, { n: 2, at: "2026-11-18T09:00" }] }, body: "" },
  });
  const now = new Date(2026, 10, 19, 12);
  assert.deepEqual(backtestApp(t.runtime, "Apps/Quiet.md", undefined, now), { message: "This app has no alerts and no expect rules (a rhythm or none:) to backtest." });
  assert.deepEqual(backtestApp(t.runtime, "Apps/Broken.md", undefined, now), { message: "The app has a mistake in it now; fix it first." });
  // A change that adds an alert is backtested though the app as it is has none.
  const change = backtestApp(t.runtime, "Apps/Quiet.md", { app: "Quiet", panels: [{ view: "number", source: "items", agg: "count", alert: "> 0" }] }, now);
  assert.ok("run" in change);
  const loud = backtestApp(t.runtime, "Apps/Loud.md", undefined, now);
  assert.ok("run" in loud);
  const steps: number[] = [];
  const r = await loud.run((done) => steps.push(done), () => false);
  assert.ok(r && !(r instanceof Error), String(r));
  assert.ok(steps.length > 0, "told of its steps");
  assert.equal(watches(undefined), false);
});
