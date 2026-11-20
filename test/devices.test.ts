import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityLog, type Entry } from "../src/activity.ts";
import { RUNNING_WITHIN_MS, defaultName, otherRunners, thisDevice, type PlatformInfo } from "../src/device.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const DESKTOP: PlatformInfo = { isMobile: false, isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isTablet: false };
const PHONE: PlatformInfo = { ...DESKTOP, isMobile: true, isMacOS: false, isIosApp: true };

function memoryStore() {
  const kept = new Map<string, unknown>();
  return { kept, load: (k: string) => kept.get(k) ?? null, save: (k: string, v: unknown) => void kept.set(k, structuredClone(v)) };
}

test("a device is made once and kept on it: named for what it is, running background work unless it's a phone and another device does", () => {
  const store = memoryStore();
  const mac = thisDevice(store, DESKTOP, true, () => "abc12345");
  assert.deepEqual(mac, { id: "abc12345", name: "Mac", background: true });
  assert.deepEqual(thisDevice(store, DESKTOP, false, () => "other"), mac, "read back, not made again");
  assert.deepEqual(thisDevice(memoryStore(), PHONE, true, () => "p"), { id: "p", name: "iPhone", background: false });
  // A phone that is the only device (or the first to update) keeps what it ran before.
  assert.deepEqual(thisDevice(memoryStore(), PHONE, false, () => "p"), { id: "p", name: "iPhone", background: true });
  assert.equal(defaultName({ ...PHONE, isTablet: true }), "iPad");
  assert.equal(defaultName({ ...DESKTOP, isMacOS: false, isWin: true }), "Windows PC");
});

test("other devices running background work: only recent ones, not this one, not ones that turned it off", () => {
  const now = 10 * RUNNING_WITHIN_MS;
  const seen = [
    { id: "me", name: "Mac", background: true, seen: now },
    { id: "a", name: "iMac", background: true, seen: now - 1000 },
    { id: "b", name: "Old laptop", background: true, seen: now - RUNNING_WITHIN_MS - 1 },
    { id: "c", name: "iPhone", background: false, seen: now },
  ];
  assert.deepEqual(otherRunners(seen, "me", now).map((s) => s.name), ["iMac"]);
});

test("with background work off, records and alerts' thens don't run here; turned on, alerts start from what is true now", async () => {
  const notes = {
    "Apps/R.md": {
      fm: {
        app: "R",
        data: { kp: { source: "https://api.example.com/kp", record: "1h", limit: 1 } },
        panels: [{ view: "number", title: "Due", source: "items", agg: "count", alert: { due: "past" }, then: { app: "[[Inbox]]", do: "add", fill: { task: "{what}" } } }],
      },
    },
    "Apps/R data.md": { fm: { items: [{ what: "a", due: "2026-11-01", at: "2026-11-01T09:00" }] } },
    "Apps/Inbox.md": { fm: { app: "Inbox", panels: [{ view: "form", fields: { task: "text" }, save: "todo", shortcut: "add" }] } },
  };
  const t = fakeBackground(notes, { "https://api.example.com/kp": { t: 1 } });
  t.device.background = false;
  await t.bg.start();
  await settle();
  assert.equal(t.f.files.get("Apps/R data.md")!.fm!.kp_log, undefined, "nothing recorded");
  const fm = t.f.files.get("Apps/R data.md")!.fm!;
  fm.items = [...fm.items as unknown[], { what: "b", due: "2026-11-02", at: "2026-11-02T09:00" }];
  t.changed("Apps/R data.md");
  await settle();
  assert.equal(t.f.files.get("Apps/Inbox data.md"), undefined, "no then ran");

  t.device.background = true;
  t.bg.startOver();
  t.changed("Apps/R data.md");
  await settle();
  assert.equal(t.f.files.get("Apps/Inbox data.md"), undefined, "what was already due is noted, not run");
  fm.items = [...fm.items as unknown[], { what: "c", due: "2026-11-03", at: "2026-11-03T09:00" }];
  t.changed("Apps/R data.md");
  await settle();
  assert.deepEqual((t.f.files.get("Apps/Inbox data.md")!.fm!.todo as { task: string }[]).map((r) => r.task), ["c"]);
});

test("the activity log writes only this device's own, lists every device's, and only this device's can be undone", async () => {
  let mine: string | undefined;
  const theirs: Entry[] = [
    { id: "x1", at: 1500, app: "Apps/Meds.md", actor: "you", what: "Took meds", undone: 0, changes: [{ kind: "row-added", path: "Apps/Meds data.md", list: "doses", row: { at: "t" } }] },
  ];
  let clock = 1000;
  const log = new ActivityLog(
    { read: async () => mine, write: async (text) => { mine = text; } },
    () => clock,
    async () => [{ device: "iPhone", text: JSON.stringify(theirs) }, { device: "Broken", text: "{not json" }],
  );
  await log.add({ app: "Apps/Meds.md", actor: "you", what: "Took meds", changes: [{ kind: "row-added", path: "Apps/Meds data.md", list: "doses", row: { at: "u" } }] });
  clock = 2000;
  await log.add({ app: "Apps/Meds.md", actor: "link", what: "Took meds", changes: [{ kind: "row-added", path: "Apps/Meds data.md", list: "doses", row: { at: "v" } }] });
  const listed = await log.list("Apps/Meds.md");
  assert.deepEqual(listed.map((e) => [e.at, e.device]), [[2000, undefined], [1500, "iPhone"], [1000, undefined]]);
  assert.equal((JSON.parse(mine!) as Entry[]).length, 2, "only its own are written");
  // A log another device copied over (the same ids) isn't shown twice.
  const copy = new ActivityLog({ read: async () => mine, write: async () => {} }, () => clock, async () => [{ device: "iMac", text: mine! }]);
  assert.equal((await copy.list()).length, 2);
});
