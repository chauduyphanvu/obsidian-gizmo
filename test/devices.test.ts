import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityLog, type Entry } from "../src/activity.ts";
import { PRIORITY, UNSEEN_MS, defaultName, readBeat, runnerOf, startsOver, thisDevice, type Beat, type PlatformInfo } from "../src/device.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const DESKTOP: PlatformInfo = { isMobile: false, isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isTablet: false };
const PHONE: PlatformInfo = { ...DESKTOP, isMobile: true, isMacOS: false, isIosApp: true };

function memoryStore() {
  const kept = new Map<string, unknown>();
  return { kept, load: (k: string) => kept.get(k) ?? null, save: (k: string, v: unknown) => void kept.set(k, structuredClone(v)) };
}

test("a device is made once and kept on it, named for what it is", () => {
  const store = memoryStore();
  const mac = thisDevice(store, DESKTOP, () => "abc12345");
  assert.deepEqual(mac, { id: "abc12345", name: "Mac" });
  assert.deepEqual(thisDevice(store, DESKTOP, () => "other"), mac, "read back, not made again");
  assert.deepEqual(thisDevice(memoryStore(), PHONE, () => "p"), { id: "p", name: "iPhone" });
  // One kept before devices agreed on a runner keeps its id and name.
  store.save("gizmo-device", { id: "old00000", name: "Work Mac", background: false });
  assert.deepEqual(thisDevice(store, DESKTOP), { id: "old00000", name: "Work Mac" });
  assert.equal(defaultName({ ...PHONE, isTablet: true }), "iPad");
  assert.equal(defaultName({ ...DESKTOP, isMacOS: false, isWin: true }), "Windows PC");
});

test("one device runs background work: gizmod over a desktop over a phone, then the lowest id, of those heard from lately", () => {
  const now = 10 * UNSEEN_MS;
  const beat = (id: string, priority: number, ago: number): Beat => ({ id, name: id, host: "", priority, seen: now - ago });
  const phone = beat("p", PRIORITY.phone, 0);
  const mac = beat("m2", PRIORITY.desktop, 60_000);
  const imac = beat("m1", PRIORITY.desktop, 120_000);
  const daemon = beat("g", PRIORITY.gizmod, 30_000);
  assert.equal(runnerOf([phone], now)?.id, "p", "a phone alone runs it");
  assert.equal(runnerOf([phone, mac, imac], now)?.id, "m1", "two desktops: the lower id");
  assert.equal(runnerOf([phone, mac, imac, daemon], now)?.id, "g");
  // gizmod unseen for 20 minutes: the desktops take over; until then they wait.
  assert.equal(runnerOf([phone, mac, { ...daemon, seen: now - UNSEEN_MS + 1000 }], now)?.id, "g");
  assert.equal(runnerOf([phone, mac, { ...daemon, seen: now - UNSEEN_MS }], now)?.id, "m2");
  assert.equal(runnerOf([], now), undefined);
  // gizmod quitting says so: the desktop takes over at once, and gizmod again when it's back.
  assert.equal(runnerOf([phone, mac, { ...daemon, seen: now - 1000, left: true }], now)?.id, "m2");
  assert.equal(runnerOf([phone, mac, { ...daemon, seen: now }], now)?.id, "g");
  assert.deepEqual(readBeat(JSON.stringify({ ...daemon, left: true })), { ...daemon, left: true });
  assert.deepEqual(readBeat(JSON.stringify({ ...daemon, left: "yes" })), daemon, "only true counts");
  // A beat written before priorities were kept is left out: that device decides for itself, and beats too seldom to count.
  assert.equal(readBeat(JSON.stringify({ id: "x", name: "Mac", background: true, seen: 5 })), undefined);
  assert.deepEqual(readBeat(JSON.stringify({ id: "x", name: "Mac", priority: 1, seen: 5 })), { id: "x", name: "Mac", host: "", priority: PRIORITY.desktop, seen: 5 });
  assert.equal(readBeat("{nope"), undefined);
});

test("a runner starts its alerts over when it takes over from another device, not on every launch", () => {
  const now = 10 * UNSEEN_MS;
  const phone: Beat = { id: "p", name: "iPhone", host: "", priority: PRIORITY.phone, seen: now };
  // Mid-session: taking over from another device starts over; staying the runner doesn't; nor does not being it.
  assert.equal(startsOver("m", "m", "p", false, undefined, [phone]), true);
  assert.equal(startsOver("m", "m", "m", false, undefined, [phone]), false);
  assert.equal(startsOver("m", "p", "m", false, undefined, [phone]), false);
  // A launch: another device heard from long after this one's last beat ran things meanwhile.
  assert.equal(startsOver("m", "m", undefined, true, now - 3 * UNSEEN_MS, [phone]), true);
  // The phone was only around briefly after the Mac left, while the Mac's beat still counted: what the Mac kept holds.
  assert.equal(startsOver("m", "m", undefined, true, now - UNSEEN_MS / 2, [phone]), false);
  assert.equal(startsOver("m", "m", undefined, true, now - 3 * UNSEEN_MS, []), false, "no other device: it was the runner throughout");
  assert.equal(startsOver("m", "m", undefined, true, undefined, []), true, "never ran here before");
});

test("on a device that doesn't run background work, records and alerts' thens don't run; becoming the runner, alerts start from what is true now", async () => {
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
