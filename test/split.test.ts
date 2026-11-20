import assert from "node:assert/strict";
import { test } from "node:test";
import { logFile } from "../src/ledger.ts";
import { Ledger } from "../src/ledger-store.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { isAllowed } from "../src/grants.ts";
import { fakeBackground, listsIn } from "./support/fakes.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };

const CHORES = {
  app: "Chores",
  panels: [
    { view: "form", title: "Did a chore", fields: { chore: "text", who: "text" }, save: "done", shortcut: "did" },
    { view: "number", title: "This week", source: "done", agg: "count" },
    { view: "number", title: "Last", source: "done", field: "chore", agg: "last" },
  ],
};

test("devices: split is still read, asks for nothing, and what was allowed for it stays harmless", () => {
  const old = readSpec({ ...CHORES, devices: "split" }, { path: "Apps/Chores.md" })!;
  assert.deepEqual(old.errors, []);
  assert.deepEqual(permissionsOf(old.spec!, "Apps/Chores.md"), []);
  assert.deepEqual(readSpec({ ...CHORES, devices: "yes" }, { path: "Apps/Chores.md" })!.errors, ["devices must be split, e.g. devices: split"]);
  // A grant from when it asked for split: still allows it: what an app no longer asks for takes nothing away.
  const grants = { "Apps/Chores.md": ["split:Apps/Chores data"] };
  assert.equal(isAllowed(grants, "Apps/Chores.md", permissionsOf(old.spec!, "Apps/Chores.md"), true), true);
});

test("the rows each device kept in its own note under devices: split are read in, in the order saved, and kept by the first snapshot", async () => {
  const t = fakeBackground({
    "Apps/Chores.md": { fm: { ...CHORES, devices: "split" } },
    "Apps/Chores data.md": { fm: { done: [{ chore: "bins", who: "Ann", at: "2026-11-16T08:00" }] } },
    "Apps/Chores data/iPhone-77aa.md": { fm: { device: "77aa0000", done: [{ chore: "dishes", who: "Bo", at: "2026-11-17T20:00" }, { chore: "plants", who: "Bo", at: "2026-11-18T13:00" }] } },
  });
  await t.bg.start();
  const spec = t.bg.spec("Apps/Chores.md")!;
  const count = await t.bg.evaluate("Apps/Chores.md", spec.panels[1]);
  assert.equal("value" in count && count.value, 3);
  const link = new URL(t.bg.shortcutLinks().find((l) => l.shortcut === "did")!.link);
  await t.bg.runUri({ ...Object.fromEntries(link.searchParams), chore: "laundry", who: "Ann" });
  await settle();
  // The old notes' rows in the order they were saved, then what was added since, in the order it was added.
  assert.deepEqual((listsIn(t.f.files.get("Apps/Chores data.md")!.fm)!.done as { chore: string }[]).map((r) => r.chore), ["bins", "dishes", "plants", "laundry"]);
  const last = await t.bg.evaluate("Apps/Chores.md", spec.panels[2]);
  assert.equal("value" in last && last.value, "laundry");
});

/** Two devices on one synced vault: each a background over the same files, with its own id and clock. */
function twoDevices() {
  const mac = fakeBackground({ "Apps/Chores.md": { fm: CHORES } });
  const files = mac.f.files;
  const others = mac.f.others;
  const phone = fakeBackground({});
  // The phone sees the Mac's files, as a sync makes them the same folder.
  phone.f.files.clear();
  for (const [k, v] of files) phone.f.files.set(k, v);
  const ledger = (t: typeof mac, id: string) => new Ledger({
    filesIn: (folder) => [...files.keys(), ...others.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    readFile: async (p) => others.get(p) ?? "",
    append: async (p, text) => { others.set(p, (others.get(p) ?? "") + text); },
    writeFile: async (p, text) => { others.set(p, text); },
    frontmatter: (p) => files.get(p)?.fm,
  }, () => id, () => t.f.host.now());
  return { mac, phone, files, others, ledger };
}

test("two devices saving at once each append to their own log, and both read every row", async () => {
  const { files, others, ledger, mac } = twoDevices();
  const a = ledger(mac, "mac00000");
  const b = ledger(mac, "phone000");
  await a.write("Apps/Chores data.md", [{ op: "add", l: "done", row: "r1", v: { chore: "bins" } }]);
  await b.write("Apps/Chores data.md", [{ op: "add", l: "done", row: "r2", v: { chore: "dishes" } }]);
  const month = new Date(mac.f.host.now());
  assert.deepEqual([...others.keys()].sort(), [logFile("Apps/Chores data.md", "mac00000", month), logFile("Apps/Chores data.md", "phone000", month)]);
  for (const d of [a, b]) {
    for (const p of others.keys()) d.fileChanged(p);
    assert.deepEqual((await d.state("Apps/Chores data.md")).lists.get("done")!.rows.map((r) => r.chore).sort(), ["bins", "dishes"]);
  }
  assert.equal(files.get("Apps/Chores data.md"), undefined, "neither wrote the data note: only the device running background work does");
});

test("two devices that sample the same interval keep one row", async () => {
  const t = fakeBackground({
    "Apps/Kp.md": { fm: { app: "Kp", data: { kp: { source: "https://kp.example/now", record: "1h", pick: "now" } }, view: "number", source: "kp_log", field: "kp" } },
  }, { "https://kp.example/": { now: { kp: 3 } } });
  await t.bg.start();
  await settle();
  // The other device took the same hour's sample a moment earlier, under the same id.
  const store = t.env.store!("Apps/Kp data.md", "Apps/Kp.md");
  const rows = await store.rows("kp_log");
  assert.equal(rows.length, 1);
  t.advance(60_000);
  await t.bg.tick();
  await settle();
  assert.equal((await store.rows("kp_log")).length, 1, "a second sample within the hour isn't taken");
});
