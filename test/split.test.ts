import assert from "node:assert/strict";
import { test } from "node:test";
import { describePermission, permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { ROW_SOURCE } from "../src/sources/list.ts";
import { rowKey } from "../src/views/common.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };

const CHORES = {
  app: "Chores",
  devices: "split",
  panels: [
    { view: "form", title: "Did a chore", fields: { chore: "text", who: "text" }, save: "done", shortcut: "did" },
    { view: "number", title: "This week", source: "done", agg: "count" },
    { view: "number", title: "Last", source: "done", field: "chore", agg: "last" },
  ],
};
const MINE = "Apps/Chores data/Mac-d1ma.md";
const PHONE = "Apps/Chores data/iPhone-77aa.md";

test("devices: split is checked, offered as a permission of its own, and can't share a name with a list", () => {
  const ok = readSpec(CHORES, { path: "Apps/Chores.md" })!;
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.spec!.split, true);
  assert.deepEqual(permissionsOf(ok.spec!, "Apps/Chores.md"), ["split:Apps/Chores data"]);
  assert.equal(describePermission("split:Apps/Chores data"), "Keep a note of its own for each device in Apps/Chores data");
  assert.deepEqual(permissionsOf(readSpec({ ...CHORES, store: "[[Logs/Chores]]" }, { path: "Apps/Chores.md" })!.spec!, "Apps/Chores.md"), ["split:Logs/Chores", "store:Logs/Chores.md"]);
  assert.deepEqual(readSpec({ ...CHORES, devices: "yes" }, { path: "Apps/Chores.md" })!.errors, ["devices must be split, e.g. devices: split"]);
  const named = { ...CHORES, panels: [{ view: "button", label: "Go", save: "device" }] };
  assert.deepEqual(readSpec(named, { path: "Apps/Chores.md" })!.errors, ['with devices: split, a list can\'t be called "device"; that names each device\'s note']);
  // Without devices: split, a list may well be called that.
  assert.deepEqual(readSpec({ ...named, devices: undefined }, { path: "Apps/Chores.md" })!.errors, []);
});

test("each device adds rows to its own note; the app reads every device's, in the order they were saved", async () => {
  const t = fakeBackground({
    "Apps/Chores.md": { fm: CHORES },
    "Apps/Chores data.md": { fm: { done: [{ chore: "bins", who: "Ann", at: "2026-11-16T08:00" }] } },
    [PHONE]: { fm: { device: "77aa0000", done: [{ chore: "dishes", who: "Bo", at: "2026-11-17T20:00" }, { chore: "plants", who: "Bo", at: "2026-11-18T13:00" }] } },
  });
  await t.bg.start();
  const link = new URL(t.bg.shortcutLinks().find((l) => l.shortcut === "did")!.link);
  await t.bg.runUri({ ...Object.fromEntries(link.searchParams), chore: "laundry", who: "Ann" });
  assert.deepEqual(t.f.files.get(MINE)!.fm, { device: "d1mac000", done: [{ chore: "laundry", who: "Ann", at: "2026-11-18T12:00" }] });
  assert.equal((t.f.files.get(PHONE)!.fm!.done as unknown[]).length, 2, "the other device's note is never written by this one");
  assert.equal((t.f.files.get("Apps/Chores data.md")!.fm!.done as unknown[]).length, 1, "nor is the shared data note");
  const spec = t.bg.spec("Apps/Chores.md")!;
  const count = await t.bg.evaluate("Apps/Chores.md", spec.panels[1]);
  const last = await t.bg.evaluate("Apps/Chores.md", spec.panels[2]);
  assert.equal("value" in count && count.value, 4);
  assert.equal("value" in last && last.value, "plants", "13:00 on the phone came after 12:00 here");
  const log = await t.activity.list();
  assert.equal(log[0].changes[0].path, MINE, "undo finds the row in this device's note");
});

test("a device's note that syncs in later is read at once, and its rows count as their own for keys and alerts", async () => {
  const fm = {
    ...CHORES,
    panels: [{ view: "number", title: "Chores", source: "done", agg: "count", alert: { chore: "!= nothing" }, then: { app: "[[Inbox]]", do: "add", fill: { task: "Thank {who}" } } }],
  };
  const t = fakeBackground({
    "Apps/Chores.md": { fm },
    [MINE]: { fm: { device: "d1mac000", done: [{ chore: "bins", who: "Ann", at: "2026-11-18T09:00" }] } },
    "Apps/Inbox.md": { fm: { app: "Inbox", panels: [{ view: "form", fields: { task: "text" }, save: "todo", shortcut: "add" }] } },
  });
  await t.bg.start();
  await settle();
  // Two devices saved in the same minute: two rows, two thens.
  t.f.files.set(PHONE, { fm: { device: "77aa0000", done: [{ chore: "mop", who: "Bo", at: "2026-11-18T09:00" }] } });
  t.changed(PHONE);
  await settle();
  const spec = t.bg.spec("Apps/Chores.md")!;
  const r = await t.bg.evaluate("Apps/Chores.md", spec.panels[0]);
  assert.equal("value" in r && r.value, 2);
  assert.deepEqual((t.f.files.get("Apps/Inbox data.md")?.fm?.todo as { task: string }[]).map((x) => x.task), ["Thank Bo"]);
  const rows = ("rows" in r ? r.rows : []) as Record<string | symbol, unknown>[];
  assert.deepEqual(rows.map((row) => row[ROW_SOURCE]), [MINE, PHONE]);
  assert.notEqual(rowKey(rows[0]), rowKey(rows[1]), "each note's first row is told apart");
  // A note in the folder that doesn't say which device it is isn't a device's.
  t.f.files.set("Apps/Chores data/Notes.md", { fm: { done: [{ chore: "x", at: "2026-11-18T10:00" }] } });
  t.changed("Apps/Chores data/Notes.md");
  const again = await t.bg.evaluate("Apps/Chores.md", spec.panels[0]);
  assert.equal("value" in again && again.value, 2);
});

test("record takes a sample only when no device took one within its interval, into this device's note", async () => {
  const fm = { app: "Kp", devices: "split", data: { kp: { source: "https://api.example.com/kp", record: "1h", limit: 1 } }, view: "number", source: "kp_log", agg: "count" };
  const t = fakeBackground({
    "Apps/Kp.md": { fm },
    "Apps/Kp data/iPhone-77aa.md": { fm: { device: "77aa0000", kp_log: [{ t: 1, at: "2026-11-18T11:30" }] } },
  }, { "https://api.example.com/kp": { t: 2 } });
  await t.bg.start();
  await settle();
  assert.equal(t.f.files.get("Apps/Kp data/Mac-d1ma.md"), undefined, "the phone sampled half an hour ago");
  t.advance(31 * 60_000);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.f.files.get("Apps/Kp data/Mac-d1ma.md")?.fm, { device: "d1mac000", kp_log: [{ t: 2, at: "2026-11-18T12:31" }] });
});

test("an edit to a row another device saved changes that device's note, and Undo puts it back there", async () => {
  const { fakeEnv } = await import("./support/fakes.ts");
  const { AppWrites } = await import("../src/app-writes.ts");
  const { undoEntry } = await import("../src/activity.ts");
  const { splitOf } = await import("../src/store.ts");
  const { deviceNoteName } = await import("../src/device.ts");
  const t = fakeEnv({
    "Apps/Chores.md": { fm: CHORES },
    [PHONE]: { fm: { device: "77aa0000", done: [{ chore: "dishes", who: "Bo", at: "2026-11-17T20:00" }] } },
  });
  const split = splitOf("Apps/Chores data.md", { id: "d1mac000", name: "Mac" }, deviceNoteName);
  const files = { appPath: "Apps/Chores.md", dataPath: "Apps/Chores data.md", split };
  const p = readSpec(CHORES, { path: "Apps/Chores.md" })!.spec!.panels[1].panel;
  const rows = await t.data.panelData("done", { ...p, view: "table", edit: ["who"] }, files, { ttlMs: 0, now: new Date() }) as Record<string, unknown>[];
  const entries: unknown[] = [];
  const writes = new AppWrites({ ...t.env, log: (e) => void entries.push(e) }, {
    appPath: "Apps/Chores.md", hostPath: "Apps/Chores.md", dataPath: () => "Apps/Chores data.md", split: () => split, checklistName: () => "",
  });
  await writes.editRow({ p: { ...p, view: "table", source: "done", edit: ["who"] } }, rows[0], "who", "Cy", () => {});
  assert.equal((t.f.files.get(PHONE)!.fm!.done as { who: string }[])[0].who, "Cy");
  assert.equal(t.f.files.get(MINE), undefined);
  const entry = { id: "1", at: 0, app: "Apps/Chores.md", actor: "you" as const, what: "x", undone: 0, ...(entries[0] as { changes: never[] }) };
  assert.equal(entry.changes[0]?.["path" as never], PHONE);
  const io = {
    frontmatter: (path: string) => t.f.files.get(path)?.fm,
    updateFrontmatter: t.env.updateFrontmatter,
    processText: async () => false,
    trashIf: async () => "gone" as const,
    setTaskDone: async () => false,
  };
  assert.equal((await undoEntry(entry, io)).refusal, undefined);
  assert.equal((t.f.files.get(PHONE)!.fm!.done as { who: string }[])[0].who, "Bo");
});
