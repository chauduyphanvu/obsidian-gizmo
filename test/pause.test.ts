import assert from "node:assert/strict";
import { test } from "node:test";
import { PAUSE_TELL_MS } from "../src/background-pauses.ts";
import { EXPECT_MISSED } from "../src/background-rhythms.ts";
import { carryOver } from "../src/background-fired.ts";
import { permissionsOf } from "../src/permissions.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MEDS = {
  app: "Meds",
  panels: [{ view: "button", label: "Took it", save: "doses", shortcut: "took" }],
  expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", say: "no dose by 10:00" }],
};
const WITH_WEATHER = { ...MEDS, panels: [...MEDS.panels, { view: "number", title: "Rain", source: "https://api.example.com/rain", pick: "mm" }] };

/** Meds, opened and allowed as it asks; the fakes' clock starts Wednesday 18 November, 12:00. */
async function allowed() {
  const t = fakeBackground({ "Apps/Meds.md": { fm: MEDS } }, {}, { seen: true });
  t.grants["Apps/Meds.md"] = [];
  await t.bg.start();
  await settle();
  return t;
}
const told = (t: Awaited<ReturnType<typeof allowed>>) => (t.notices as string[]).filter((n) => n.startsWith("Meds"));
const edit = async (t: Awaited<ReturnType<typeof allowed>>, fm: Record<string, unknown>) => {
  t.f.files.get("Apps/Meds.md")!.fm = fm;
  t.changed("Apps/Meds.md");
  await settle();
};

test("an allowed app that comes to ask for more is paused, not dropped: shown at once, told once by the runner after ten minutes, pushed beyond the notice", async () => {
  const t = await allowed();
  await edit(t, WITH_WEATHER);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.out.paused.map((p) => [p.name, p.reason]), [["Meds", "now asks to fetch data from api.example.com"]]);
  assert.deepEqual(told(t), [], "a component edit may reach here before the grant that covers it: nothing is told yet");
  t.advance(PAUSE_TELL_MS);
  await t.bg.tick();
  await t.bg.tick();
  await settle();
  assert.deepEqual(told(t), ["Meds is paused in the background: it now asks to fetch data from api.example.com. Open it to allow it."]);
  assert.deepEqual(t.out.pushed.map((p) => `${p.app}: ${p.panel}`), ["Meds: paused in the background"]);
});

test("a pause is kept across a restart: told once, not told again by the same device starting over", async () => {
  const t = await allowed();
  await edit(t, WITH_WEATHER);
  await t.bg.tick();
  t.advance(PAUSE_TELL_MS);
  await t.bg.tick();
  await settle();
  assert.equal(told(t).length, 1);
  // Obsidian restarts: what this device kept is read again, and the app is indexed afresh.
  const again = fakeBackground({ "Apps/Meds.md": { fm: WITH_WEATHER } }, {}, { seen: true, triggers: t.triggers });
  again.grants["Apps/Meds.md"] = [];
  again.advance(PAUSE_TELL_MS * 2);
  await again.bg.start();
  again.advance(PAUSE_TELL_MS * 2);
  await again.bg.tick();
  await settle();
  assert.equal(again.out.paused.length, 1);
  assert.deepEqual(told(again), []);
});

test("a device that doesn't run background work shows a pause but never tells it", async () => {
  const t = await allowed();
  t.device.background = false;
  await edit(t, WITH_WEATHER);
  await t.bg.tick();
  t.advance(PAUSE_TELL_MS * 3);
  await t.bg.tick();
  await settle();
  assert.equal(t.out.paused.length, 1);
  assert.deepEqual([told(t), t.out.pushed], [[], []]);
});

test("a paused app keeps its rhythm's place: allowed again, every deadline missed meanwhile is kept and told as missed while paused", async () => {
  const t = await allowed();
  await edit(t, WITH_WEATHER);
  await t.bg.tick();
  // Paused from Wednesday noon to Saturday noon: Thursday's, Friday's and Saturday's 10:00 pass.
  t.advance(3 * DAY);
  await t.bg.tick();
  await settle();
  assert.deepEqual(told(t).filter((n) => n.startsWith("Meds: ")), [], "nothing is decided while paused");
  t.grants["Apps/Meds.md"] = permissionsOf(t.bg.spec("Apps/Meds.md")!, "Apps/Meds.md");
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.out.paused, []);
  const missed = await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED);
  assert.deepEqual(missed.map((r) => r.window), ["2026-11-19", "2026-11-20", "2026-11-21"]);
  assert.deepEqual(told(t).filter((n) => n.startsWith("Meds: ")), [
    "Meds: no dose by 10:00 (2026-11-19, missed while paused)",
    "Meds: no dose by 10:00 (2026-11-20, missed while paused)",
    "Meds: no dose by 10:00 (2026-11-21, missed while paused)",
  ]);
});

test("a revoked app isn't paused: nothing is told, and allowed again its rhythm starts over from then", async () => {
  const t = await allowed();
  delete t.grants["Apps/Meds.md"];
  await t.bg.tick();
  t.advance(2 * DAY);
  await t.bg.tick();
  await settle();
  assert.deepEqual([t.out.paused, told(t), t.out.pushed], [[], [], []]);
  t.grants["Apps/Meds.md"] = [];
  await t.bg.tick();
  await settle();
  assert.deepEqual(await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED), []);
});

test("a device taking over carries each rhythm on from the latest point any device decided it to; alerts start over, but what was told stays told", () => {
  const mine = {
    "A.md\nexpect:r": { decided: 100 },
    "A.md\npaused:": { paused: 5, reason: "now asks to …" },
    "A.md\nrain": { on: true },
    "A.md\nrain\ntold": { on: true },
  };
  const theirs = { "A.md\nexpect:r": { decided: 200 }, "B.md\nexpect:s": { decided: 50 }, "B.md\nwind": { on: true }, "B.md\nwind\ntold": { on: true } };
  const gone = { "C.md\nfrost\ntold": { on: true } };
  assert.deepEqual(carryOver(mine, [theirs, gone], [theirs]), {
    "A.md\nexpect:r": { decided: 200 },
    "A.md\npaused:": { paused: 5, reason: "now asks to …" },
    "A.md\nrain\ntold": { on: true },
    "B.md\nexpect:s": { decided: 50 },
    "B.md\nwind\ntold": { on: true },
  });
});

test("taking over from a device that decided Thursday's and Friday's deadlines, this one decides Saturday's, and only that", async () => {
  const t = await allowed();
  // The other device ran background work since: it decided up to Friday's 10:00.
  t.others.push(JSON.stringify({ v: 2, fired: { "Apps/Meds.md\nexpect:meds": { decided: new Date(2026, 10, 20, 10).getTime() } } }));
  t.advance(3 * DAY);
  t.bg.startOver();
  await t.bg.tick();
  await settle();
  const missed = await t.env.store!("Apps/Meds data.md", "Apps/Meds.md").rows(EXPECT_MISSED);
  assert.deepEqual(missed.map((r) => r.window), ["2026-11-21"]);
  assert.deepEqual(told(t), ["Meds: no dose by 10:00"]);
});
