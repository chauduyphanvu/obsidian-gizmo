import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
// Imported as Node imports it, with nothing standing in for Obsidian: had anything the runtime
// reaches imported "obsidian", this file would not load.
import { GizmoRuntime } from "../src/runtime.ts";
import { DEVICE_FOLDERS, PRIORITY, deviceFile } from "../src/device.ts";
import { textHash } from "../src/hash.ts";
import { backtest } from "../src/backtest.ts";
import { DataLayer } from "../src/datalayer.ts";
import { makeSandbox } from "../src/sandbox.ts";
import { readSpec } from "../src/spec.ts";
import { fakeEnv } from "./support/fakes.ts";
import { runtimeOn } from "./support/runtime.ts";
import { parseYaml } from "./support/yaml.ts";

const DAY = 86_400_000;

test("the runtime loads in plain Node: no window, and nothing it reaches imports Obsidian", () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  assert.equal(typeof GizmoRuntime, "function");
});

test("allowing is kept in data.json and told; taking back tells onRevoke first, saying whether the app asks for nothing", async () => {
  const t = await runtimeOn({
    "Apps/Clock.md": { fm: { app: "Clock", panels: [{ view: "countdown", to: "2027-01-01" }] } },
    "Apps/Weather.md": { fm: { app: "Weather", panels: [{ view: "number", source: "https://api.example.com/w", field: "t" }] } },
  });
  await t.runtime.start();
  const told: string[] = [];
  t.runtime.onRevoke((key, asksNothing) => told.push(`revoke ${key} ${asksNothing}`));
  t.runtime.onGrantsChange(() => told.push("changed"));
  await t.runtime.grant("Apps/Weather.md", ["net:api.example.com"]);
  await t.runtime.grant("Apps/Clock.md", []);
  assert.deepEqual(t.saved().grants, { "Apps/Weather.md": ["net:api.example.com"], "Apps/Clock.md": [] });
  assert.equal(t.runtime.isGranted("Apps/Weather.md", ["net:api.example.com"]), true);
  // Allowing again what is already allowed is no news.
  await t.runtime.grant("Apps/Clock.md", []);
  assert.deepEqual(told, ["changed", "changed"]);

  told.length = 0;
  t.runtime.setHeadline("Apps/Weather.md", "7°");
  await t.runtime.revoke("Apps/Weather.md");
  await t.runtime.revoke("Apps/Clock.md");
  await t.runtime.revoke("Apps/Nothing.md");
  assert.deepEqual(told, ["revoke Apps/Weather.md false", "changed", "revoke Apps/Clock.md true", "changed"]);
  assert.deepEqual(t.saved().grants, {});
  assert.equal(t.runtime.headlines.has("Apps/Weather.md"), false, "a revoked app's figure goes");
  t.runtime.stop();
});

test("a policy applied is kept, every app is checked again, and the policy note read as it is now", async () => {
  const t = await runtimeOn({});
  let checked = 0;
  t.runtime.background.policyChanged = () => { checked++; };
  assert.deepEqual(t.runtime.readPolicyNote(), { none: true });
  assert.equal(t.runtime.policyPending(), false);
  t.f.files.set("Gizmo policy.md", { fm: { labels: { "Health/**": "private" } } });
  const read = t.runtime.readPolicyNote();
  assert.ok("applied" in read, JSON.stringify(read));
  assert.equal(t.runtime.policyPending(), true);
  await t.runtime.applyPolicy(read.applied);
  assert.equal(checked, 1);
  assert.equal(t.saved().policy?.hash, read.applied.hash);
  assert.equal(t.runtime.policyPending(), false);
  await t.runtime.applyPolicy(undefined);
  assert.equal(t.saved().policy, undefined);
  assert.equal(checked, 2);
});

test("data.json changed by a sync: what another device allowed comes in, what this one hasn't saved stays, and a new policy is checked", async () => {
  const t = await runtimeOn({}, { settings: { grants: { "Apps/A.md": [] } } });
  let checked = 0;
  let told = 0;
  t.runtime.background.policyChanged = () => { checked++; };
  t.runtime.onGrantsChange(() => { told++; });
  // Kept here, not saved yet.
  t.runtime.store.grants["Apps/Here.md"] = [];
  t.disk.json = JSON.stringify({ grants: { "Apps/A.md": [], "Apps/There.md": ["net:x.org"] }, policy: { hash: "p1", rules: { labels: { "Health/**": "private" } } } });
  await t.runtime.settingsChanged();
  assert.deepEqual(Object.keys(t.runtime.store.grants).sort(), ["Apps/A.md", "Apps/Here.md", "Apps/There.md"]);
  assert.equal(checked, 1);
  assert.equal(told, 1);
  await t.runtime.settingsChanged();
  assert.equal(checked, 1, "the same policy isn't checked again");
});

test("a new policy is acted on though the host read data.json again before it was told (gizmod reads it whenever asked)", async () => {
  const t = await runtimeOn({}, { writes: false });
  let checked = 0;
  t.runtime.background.policyChanged = () => { checked++; };
  t.disk.json = JSON.stringify({ grants: {}, policy: { hash: "p1", rules: { labels: { "Health/**": "private" } } } });
  // Read already, as gizmod's settings are on any request, before the change is told.
  await t.runtime.host.settings.reload();
  await t.runtime.settingsChanged();
  assert.equal(checked, 1);
  await t.runtime.settingsChanged();
  assert.equal(checked, 1, "the same policy isn't checked again");
});

test("another device's kept web answers are read again on the next tick, not only once this device keeps one", async () => {
  const t = await runtimeOn({});
  const responses = t.runtime.dataLayer.host.responses!;
  let changed = 0;
  const was = responses.changed.bind(responses);
  responses.changed = () => { changed++; was(); };
  await t.runtime.tick();
  assert.equal(changed, 1);
});

test("a rename here: data.json's keys, the activity, Explain's definitions, the data note and its logs all follow", async () => {
  const t = await runtimeOn({
    "Apps/Pills.md": { fm: { app: "Pills", panels: [{ view: "button", label: "Took", save: "doses" }] } },
    "Apps/Pills data.md": { fm: {} },
    "Mine/log.md": { body: "a note of the person's own" },
  }, { settings: { grants: { "Apps/Pills.md": [] }, linkKeys: { "Apps/Pills.md#took": "k1" } } });
  t.f.others.set("Apps/Pills data/log/d1mac000-2026-11.jsonl", "{}\n");
  await t.runtime.activity.add({ app: "Apps/Pills.md", actor: "you", what: "Took", changes: [{ kind: "property", path: "Apps/Pills data.md", field: "n", from: 1, to: 2, had: true }] });
  await t.runtime.definitions.seen("Apps/Pills.md", { p0: JSON.stringify({ view: "button" }) });
  // Obsidian has moved the note itself by the time it says so.
  t.f.files.set("Meds/Pills.md", t.f.files.get("Apps/Pills.md")!);
  t.f.files.delete("Apps/Pills.md");
  t.runtime.fileRenamed("Meds/Pills.md", "Apps/Pills.md");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.renamed, [["Apps/Pills data.md", "Meds/Pills data.md"], ["Apps/Pills data/log", "Meds/Pills data/log"]]);
  assert.ok(t.f.others.has("Meds/Pills data/log/d1mac000-2026-11.jsonl"));
  assert.deepEqual(t.saved().grants, { "Meds/Pills.md": [] });
  assert.deepEqual(t.saved().linkKeys, { "Meds/Pills.md#took": "k1" });
  assert.equal((await t.runtime.activity.list("Meds/Pills.md")).length, 1);
  assert.equal((await t.runtime.activity.list("Apps/Pills.md")).length, 0);
  await t.runtime.definitions.seen("Meds/Pills.md", { p0: JSON.stringify({ view: "number" }) });
  assert.equal((await t.runtime.definitions.since("Meds/Pills.md", "p0", 0)).length, 1, "the keys seen before the rename are the new path's");
});

test("undo writes through the host's own queue: a line an app added is taken out, and a note it made goes to the trash while unchanged", async () => {
  const t = await runtimeOn({ "Daily.md": { body: "# Today\n- walked\n" }, "Notes/Made.md": { body: "made" } });
  const entry = await t.runtime.activity.add({
    app: "Apps/Walks.md", actor: "you", what: "Logged a walk",
    changes: [{ kind: "line-added", path: "Daily.md", line: "- walked", created: false }],
  });
  const done = await t.runtime.undo(entry!);
  assert.equal(done.undone, 1, JSON.stringify(done));
  assert.equal(t.f.files.get("Daily.md")?.body, "# Today\n");
  assert.equal((await t.runtime.activity.get(entry!.id))?.undone, 1);
  const made = await t.runtime.activity.add({ app: "Apps/Notes.md", actor: "you", what: "Made a note", changes: [{ kind: "note-created", path: "Notes/Made.md", hash: textHash("made") }] });
  assert.equal((await t.runtime.undo(made!)).undone, 1);
  assert.deepEqual(t.trashed, ["Notes/Made.md"]);
});

test("where data.json is only read (gizmod), nothing makes a key or moves one, and a save is refused rather than lost", async () => {
  const t = await runtimeOn({ "Apps/A.md": { fm: { app: "A", panels: [] } } }, { writes: false, settings: { grants: { "Apps/A.md": [] } } });
  assert.equal(t.runtime.writesSettings, false);
  assert.equal(t.runtime.linkKey("Apps/A.md", "go", true), undefined);
  await assert.rejects(t.runtime.saveSettings(), /never writes it/);
  t.f.files.set("Apps/B.md", t.f.files.get("Apps/A.md")!);
  t.runtime.fileRenamed("Apps/B.md", "Apps/A.md");
  assert.deepEqual(Object.keys(t.runtime.store.grants), ["Apps/A.md"]);
});

test("the daily seal: on the device running background work, an allowed sealed kind is sealed once a day, when it has new lines", async () => {
  const kind = { kind: "dose", fields: { what: "text" }, seal: true };
  const ev = (t: number, row: string) => `${JSON.stringify({ op: "add", l: "dose", row, v: { what: "morning" }, t: `${new Date(t).toISOString()}/0`, d: "d1mac000" })}\n`;
  const log = "Kinds/Dose data/log/d1mac000-2026-11.jsonl";
  const t = await runtimeOn({ "Kinds/Dose.md": { fm: kind } });
  // A seal covers what was logged before its time.
  t.f.advance(Date.UTC(2026, 10, 22) - t.f.host.now());
  /** How many seals each device's chain holds. */
  const seals = () => [...t.f.others].filter(([p]) => p.endsWith(".seals")).map(([, text]) => text.trim().split("\n").length);
  t.f.others.set(log, ev(Date.UTC(2026, 10, 19), "00000000000000a1"));
  await t.runtime.beat.beat();
  assert.equal(t.runtime.beat.isRunner(), true);

  await t.runtime.sealDue();
  assert.deepEqual(seals(), [], "a kind not allowed seals nothing");
  t.runtime.store.grants["Kinds/Dose.md"] = [];
  await t.runtime.sealDue();
  assert.deepEqual(seals(), [1]);
  t.f.others.set(log, t.f.others.get(log)! + ev(Date.UTC(2026, 10, 20), "00000000000000a2"));
  await t.runtime.sealDue();
  assert.deepEqual(seals(), [1], "not again within the day");
  t.f.advance(DAY);
  await t.runtime.sealDue();
  assert.deepEqual(seals(), [2]);

  // Another device, more suited to it, runs background work now: it seals, not this one.
  t.kept.set(deviceFile(DEVICE_FOLDERS.beats, "gz000001"), JSON.stringify({ id: "gz000001", name: "gizmod", host: "mac", priority: PRIORITY.gizmod, seen: t.f.host.now() }));
  await t.runtime.beat.beat();
  assert.equal(t.runtime.beat.isRunner(), false);
  assert.equal(t.runtime.beat.quietHere(), true, "and it tells of alerts, not this one beside it");
  t.f.others.set(log, t.f.others.get(log)! + ev(Date.UTC(2026, 10, 21), "00000000000000a3"));
  t.f.advance(DAY);
  await t.runtime.sealDue();
  assert.deepEqual(seals(), [2]);
});

test("a backtest long enough to pause, and a try, run in plain Node: they pause and schedule as their host says", async () => {
  const APP = "Apps/Weight.md";
  const DATA = "Apps/Weight data.md";
  const app = { app: "Weight", panels: [{ view: "number", title: "Latest", source: "weight", field: "kg", agg: "last", alert: "< 75" }] };
  const t = fakeEnv({ [APP]: { fm: app } });
  const store = t.env.store!(DATA, APP);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 80; i++) {
    const at = new Date(2026, 8, 1 + i, 8);
    t.f.advance(at.getTime() - t.f.host.now());
    await store.add("weight", { kg: 70 + (i % 10), at: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T08:00` });
  }
  const to = t.f.host.now();
  const spec = readSpec(app, { path: APP, notes: t.env.notes, now: new Date(to) })!.spec!;
  const run = () => backtest({ layer: new DataLayer(t.env.data.host, { at: to }), appPath: APP, dataPath: DATA, after: spec, to });
  // Nothing draws here, so nothing pauses; past 50 steps it once waited on a window timer.
  const r = await run();
  assert.ok(r && r.after.length > 0, JSON.stringify(r));
  let pauses = 0;
  t.env.data.host.pause = async () => { pauses++; };
  await run();
  assert.ok(pauses >= 1, `paused ${pauses} times`);

  const scheduled: string[] = [];
  const box = makeSandbox({
    appPath: APP,
    notes: new Map([[APP, { frontmatter: app, text: "" }]]),
    parseYaml,
    now: () => new Date(to),
    schedule: (cb) => { scheduled.push("soon"); setTimeout(cb, 0); },
    fetch: async () => ({ status: 200, text: "{}", contentType: "application/json" }),
    copy: () => {},
  });
  box.env.data.fileChanged(APP);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(scheduled.length >= 1, "the try batches its notices with the schedule it was given");
});
