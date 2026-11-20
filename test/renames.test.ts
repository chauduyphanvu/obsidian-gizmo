import assert from "node:assert/strict";
import { test } from "node:test";
import { PENDING_MS } from "../src/identity.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MEDS = {
  app: "Meds",
  panels: [{ view: "button", label: "Took it", save: "doses", shortcut: "took" }],
  expect: [{ id: "meds", every: "day", by: "10:00", source: "doses", say: "no dose by 10:00" }],
};

/** Meds allowed, its rhythm noted on Wednesday 18 November at noon. */
async function started() {
  const t = fakeBackground({ "Apps/Meds.md": { fm: MEDS } }, {}, { seen: true });
  t.grants["Apps/Meds.md"] = [];
  await t.bg.start();
  await settle();
  return t;
}
type T = Awaited<ReturnType<typeof started>>;
const gone = async (t: T, path: string) => {
  t.f.files.delete(path);
  t.data.fileDeleted(path);
  t.f.flush();
  t.bg.noteChanged(path);
  await settle();
};
const made = async (t: T, path: string, fm: Record<string, unknown>) => {
  t.f.files.set(path, { fm });
  t.changed(path);
  t.bg.noteChanged(path);
  await settle();
};
/** The renaming device's data.json arrives: its grants already moved. */
const movedGrants = (t: T, from: string, to: string) => {
  t.grants[to] = t.grants[from];
  delete t.grants[from];
};
const fired = (t: T) => JSON.parse(t.triggers.text ?? "{}").fired as Record<string, unknown>;

for (const order of ["delete first", "create first"] as const) {
  test(`a note renamed on another device arrives by sync as a delete and a create (${order}): its rhythm keeps its place here`, async () => {
    const t = await started();
    t.advance(HOUR);
    if (order === "delete first") {
      await gone(t, "Apps/Meds.md");
      await made(t, "Health/Pills.md", MEDS);
    } else {
      await made(t, "Health/Pills.md", MEDS);
      await gone(t, "Apps/Meds.md");
    }
    assert.deepEqual(t.out.renamed, [["Apps/Meds.md", "Health/Pills.md"]], "this device's activity follows");
    movedGrants(t, "Apps/Meds.md", "Health/Pills.md");
    await t.bg.tick();
    await settle();
    assert.equal(fired(t)["Apps/Meds.md\nexpect:meds"], undefined);
    assert.deepEqual(fired(t)["Health/Pills.md\nexpect:meds"], { decided: new Date(2026, 10, 18, 12).getTime() }, "decided from Wednesday noon, not from the rename");
    // Thursday 10:00 passes with no dose: told under the app's new name.
    t.advance(22 * HOUR);
    await t.bg.tick();
    await settle();
    assert.deepEqual((t.notices as string[]).filter((n) => n.includes("no dose")), ["Pills: no dose by 10:00"]);
  });
}

test("a delete with no create to match keeps what this device kept for the app for a day, then drops it", async () => {
  const t = await started();
  await gone(t, "Apps/Meds.md");
  await t.bg.tick();
  await settle();
  assert.ok(fired(t)["Apps/Meds.md\nexpect:meds"], "kept while it may come back under another name");
  t.advance(PENDING_MS + HOUR);
  await t.bg.tick();
  await settle();
  assert.equal(fired(t)["Apps/Meds.md\nexpect:meds"], undefined);
  assert.deepEqual(t.out.dropped, ["Apps/Meds.md"], "and what data.json keeps for it can go");
});

test("two new notes with the same keys are no rename: neither takes the deleted app's place", async () => {
  const t = await started();
  t.advance(HOUR);
  await made(t, "A/Meds.md", MEDS);
  await made(t, "B/Meds.md", MEDS);
  await gone(t, "Apps/Meds.md");
  t.grants["A/Meds.md"] = [];
  t.grants["B/Meds.md"] = [];
  await t.bg.tick();
  await settle();
  assert.ok(fired(t)["Apps/Meds.md\nexpect:meds"], "the deleted app's state waits");
  const wednesdayNoon = new Date(2026, 10, 18, 12).getTime();
  for (const path of ["A/Meds.md", "B/Meds.md"]) {
    assert.notEqual((fired(t)[`${path}\nexpect:meds`] as { decided: number } | undefined)?.decided, wednesdayNoon, path);
  }
});

test("a rename made here moves this device's state at once; the caller moves the rest", async () => {
  const t = await started();
  t.advance(HOUR);
  t.f.files.set("Health/Pills.md", t.f.files.get("Apps/Meds.md")!);
  t.f.files.delete("Apps/Meds.md");
  movedGrants(t, "Apps/Meds.md", "Health/Pills.md");
  t.bg.renamed("Apps/Meds.md", "Health/Pills.md");
  await settle();
  await t.bg.tick();
  await settle();
  assert.deepEqual(fired(t)["Health/Pills.md\nexpect:meds"], { decided: new Date(2026, 10, 18, 12).getTime() });
  assert.deepEqual(t.out.renamed, [], "a rename made here: the caller moves the rest itself");
});

test("until the renaming device's data.json arrives, what the renamed app carried waits for its grant", async () => {
  const t = await started();
  t.advance(HOUR);
  await gone(t, "Apps/Meds.md");
  await made(t, "Health/Pills.md", MEDS);
  // Ticks with no grant under the new name yet: never allowed as far as this device knows.
  await t.bg.tick();
  t.advance(HOUR);
  await t.bg.tick();
  await settle();
  assert.deepEqual(fired(t)["Health/Pills.md\nexpect:meds"], { decided: new Date(2026, 10, 18, 12).getTime() });
  movedGrants(t, "Apps/Meds.md", "Health/Pills.md");
  await t.bg.tick();
  await settle();
  assert.deepEqual(fired(t)["Health/Pills.md\nexpect:meds"], { decided: new Date(2026, 10, 18, 12).getTime() }, "kept once allowed");
});
