import assert from "node:assert/strict";
import { test } from "node:test";
import { CATCH_UP_EVERY_MS, MAX_PER_HOUR, MAX_SENDS, sharedAlready } from "../src/background-share.ts";
import type { DataStore } from "../src/datastore.ts";
import { lineOf } from "../src/kind.ts";
import { rowIdOf } from "../src/ledger-store.ts";
import { parseLog, parseStamp } from "../src/ledger.ts";
import {
  GUEST_SEAL_SOURCE, guestKeyBytes, identityText, kindKeys, newIdentity, newKindKey, newSigningKey, seal, signerOf, writerOf, type Identity, type Opened, type Payload,
} from "../src/share-crypto.ts";
import { ingest, remoteRowId, type WriterState } from "../src/share-ingest.ts";
import { readShare } from "../src/share.ts";
import { checkFlows, flowContext, violationText } from "../src/flows.ts";
import { describePermission, permissionsOf } from "../src/permissions.ts";
import { readPolicy } from "../src/policy.ts";
import { readSpec } from "../src/spec.ts";
import { toTime } from "../src/time.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";
import { RELAY, memoryRelay, seeded } from "./support/relay.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };

const KIND = "Kinds/Chore.md";
const KIND_DATA = "Kinds/Chore data.md";
const CHORE = { kind: "chore", fields: { task: "text", who: ["Alex", "Sam"], minutes: "number" } };
const SPEC = { name: "chore", fields: CHORE.fields as Record<string, string | string[]> };
const MAI = "aaaaaaaaaaaaaaaa";
const ME = "eeeeeeeeeeeeeeee";

const msg = (writer: string, name: string, payload: Payload): Opened => ({ kid: "m", writer, name, payload });

/** Every event in the kind's logs, as written. */
function events(t: ReturnType<typeof fakeEnv>) {
  return [...t.f.others].filter(([p]) => p.startsWith("Kinds/Chore data/log/") && p.endsWith(".jsonl")).flatMap(([, text]) => parseLog(text).events);
}

function setup(writers: Record<string, WriterState> = {}) {
  const t = fakeEnv({ [KIND]: { fm: CHORE } });
  const store = t.env.store!(KIND_DATA, KIND);
  // The ledger stamps events by the host's clock; rows are judged by the app's day, 2026-11-18 12:00.
  const clock = () => t.f.host.now();
  // Kept across reads, as a device keeps them in its share state.
  const versions: Record<string, number> = {};
  const take = (...m: Opened[]) => ingest(store, SPEC, m, { self: ME, writers: (w) => writers[w], now: t.env.now(), versions });
  return { t, store, clock, take };
}

// ---- The spike: what another vault sends never reaches this vault's log, clock or rows ----------

test("hostile: a far-future time never moves this device's clock; the row is refused, and Gizmo's own fields in it are left out", async () => {
  const { t, store, clock, take } = setup({ [MAI]: "accepted" });
  await store.add("chore", { task: "Dishes", at: "2026-11-18T08:00" });
  const before = events(t);
  const far = await take(msg(MAI, "Mai", { t: "add", id: "0000000000000001", r: { task: "Bins", at: "9999-12-31T23:59", t: "9999-12-31T23:59:59.999Z/999", d: "evil0000" } }));
  assert.deepEqual([far.added.length, far.refused], [0, ["a row from Mai: its time is more than a day ahead"]]);
  assert.equal(events(t).length, before.length, "nothing written");
  // A row a few hours ahead (another clock) is kept: its own at says so, and nothing else moves.
  const soon = await take(msg(MAI, "Mai", { t: "add", id: "0000000000000002", r: { task: "Bins", at: new Date(t.env.now().getTime() + 3 * 3_600_000).toISOString(), line: "planned", matched: "x", by: "Root", writer: ME, t: "9999-12-31T23:59:59.999Z/999" } }));
  assert.equal(soon.added.length, 1);
  assert.deepEqual(Object.keys(soon.added[0]).sort(), ["at", "by", "task", "writer"], "line, matched and the sender's own by and writer are never taken");
  assert.deepEqual([soon.added[0].by, soon.added[0].writer], ["Mai", MAI]);
  // Every event is this device's, stamped by its own clock; the next one written follows on from now, not from 9999.
  await store.add("chore", { task: "Laundry", at: "2026-11-18T09:00" });
  const all = events(t);
  assert.ok(all.every((e) => e.d === "d1mac000"), JSON.stringify(all.map((e) => e.d)));
  assert.ok(all.every((e) => parseStamp(e.t)!.wall <= clock()), JSON.stringify(all.map((e) => e.t)));
  assert.equal(parseStamp(all.at(-1)!.t)!.wall, clock());
});

test("hostile: a forged message whose id collides with a row here changes nothing, and a retract can't reach a row it didn't add", async () => {
  const { t, store, take } = setup({ [MAI]: "accepted" });
  // A row of this vault's whose id is what Mai's 00…0a would be here, as if a collision had been found; and an ordinary one.
  const collided = remoteRowId(MAI, "000000000000000a");
  await t.data.ledger!.write(KIND_DATA, [{ op: "add", l: "chore", row: collided, v: { task: "Mine", at: "2026-11-17T08:00" } }]);
  await store.add("chore", { task: "Also mine", at: "2026-11-17T09:00" });
  const [, mine] = await store.rows("chore");
  const localId = rowIdOf(mine)!;
  const before = JSON.stringify(await store.rows("chore"));

  const r = await take(
    msg(MAI, "Mai", { t: "add", id: "000000000000000a", r: { task: "Forged", at: "2026-11-17T08:00" } }),
    msg(MAI, "Mai", { t: "retract", id: "000000000000000a" }),
    // A message naming this vault's own row id is a new row under an id of Mai's, never that row.
    msg(MAI, "Mai", { t: "retract", id: localId }),
  );
  assert.deepEqual([r.added.length, r.dismissed.length], [0, 0]);
  assert.equal(JSON.stringify(await store.rows("chore")), before, "both rows exactly as they were");
  const reuse = await take(msg(MAI, "Mai", { t: "add", id: localId, r: { task: "Look-alike", at: "2026-11-17T09:00" } }));
  assert.equal(reuse.added.length, 1);
  const rows = await store.rows("chore");
  assert.deepEqual(rows.map((x) => [rowIdOf(x), x.task]), [[collided, "Mine"], [localId, "Also mine"], [remoteRowId(MAI, localId), "Look-alike"]]);
  // Another writer's retract of Mai's row doesn't reach it either.
  const other = await take(msg("bbbbbbbbbbbbbbbb", "Bo", { t: "retract", id: localId }));
  assert.equal(other.dismissed.length, 0);
  assert.equal((await store.rows("chore")).at(-1)!.line, undefined);
});

test("hostile: a row id used again with a past time, a replay, or a row undone here: nothing comes back", async () => {
  const { t, store, take } = setup({ [MAI]: "accepted" });
  const add: Payload = { t: "add", id: "00000000000000b1", r: { task: "Bins", who: "Sam", at: "2026-11-17T20:00" } };
  assert.equal((await take(msg(MAI, "Mai", add))).added.length, 1);
  assert.equal((await take(msg(MAI, "Mai", add))).added.length, 0, "a replay adds nothing");
  assert.equal((await take(msg(MAI, "Mai", { t: "retract", id: "00000000000000b1" }))).dismissed.length, 1);
  // The same id again, with other values and last year's time.
  const again = await take(msg(MAI, "Mai", { t: "add", id: "00000000000000b1", r: { task: "Something else", who: "Alex", at: "2025-01-01T08:00" } }));
  assert.equal(again.added.length, 0);
  const [row] = await store.rows("chore");
  assert.deepEqual({ ...row }, { task: "Bins", who: "Sam", at: "2026-11-17T20:00", by: "Mai", writer: MAI, line: "dismissed" });

  // A row taken in and then undone here (its add undone) stays out when it is sent again.
  const second: Payload = { t: "add", id: "00000000000000b2", r: { task: "Sweep", at: "2026-11-17T21:00" } };
  const took = await take(msg(MAI, "Mai", second));
  await store.undo([took.done[0].event!]);
  assert.equal((await store.rows("chore")).length, 1);
  assert.equal((await take(msg(MAI, "Mai", second))).added.length, 0);
  assert.equal((await store.rows("chore")).length, 1);
  assert.ok(events(t).every((e) => e.d === "d1mac000"));
});

test("a row's own writer changes its fields with a newer version; an older copy, the same again or another writer's message changes nothing, and a take-back still wins over an older change", async () => {
  const BO = "bbbbbbbbbbbbbbbb";
  const { store, take } = setup({ [MAI]: "accepted", [BO]: "accepted" });
  const id = "00000000000000e1";
  const at = "2026-11-17T20:00";
  const add = (q: number, r: Record<string, unknown>) => msg(MAI, "Mai", { t: "add", id, r: { at, ...r }, q });
  const row = async () => (await store.rows("chore")).find((r) => rowIdOf(r) === remoteRowId(MAI, id))!;
  await take(add(10, { task: "Bins", who: "Sam" }));
  const changed = await take(add(12, { task: "Bins", who: "Alex", minutes: 5 }));
  assert.deepEqual(changed.changed.map((r) => [r.task, r.who, r.minutes]), [["Bins", "Alex", 5]]);
  // An older version read late, or one read again, changes nothing.
  for (const late of [add(11, { task: "Old", who: "Sam" }), add(12, { task: "Bins", who: "Alex", minutes: 5 }), add(10, { task: "Bins", who: "Sam" })]) {
    assert.deepEqual((await take(late)).done, [], JSON.stringify(late.payload));
  }
  assert.deepEqual({ ...(await row()) }, { task: "Bins", who: "Alex", minutes: 5, at, by: "Mai", writer: MAI });
  // A field left out is taken out; a value that doesn't fit the kind is refused, and changes nothing.
  await take(add(13, { task: "Bins", who: "Alex" }));
  assert.equal((await row()).minutes, undefined);
  const wrong = await take(add(14, { task: "Bins", who: "Zed" }));
  assert.deepEqual(wrong.refused, ["a row from Mai: who isn't one of Alex, Sam"]);
  assert.equal((await row()).who, "Alex");
  // Another writer's message under the same id is a row of its own, never Mai's.
  await take(msg(BO, "Bo", { t: "add", id, r: { task: "Hijack", at }, q: 99 }));
  assert.equal((await row()).task, "Bins");
  // Taken back at 16: a change at 15 read after it changes nothing; put back at 17, it has its fields as they are then.
  await take(msg(MAI, "Mai", { t: "retract", id, q: 16 }));
  assert.deepEqual((await take(add(15, { task: "Late", who: "Sam" }))).done, []);
  assert.deepEqual([(await row()).line, (await row()).task], ["dismissed", "Bins"]);
  await take(add(17, { task: "Bins and recycling", who: "Sam" }));
  assert.deepEqual([(await row()).line, (await row()).task, (await row()).who], [undefined, "Bins and recycling", "Sam"]);
  // Read together, an add and a newer change of it make one row, as the change says.
  const both = await take(msg(MAI, "Mai", { t: "add", id: "00000000000000e2", r: { task: "Sweep", at }, q: 1 }), msg(MAI, "Mai", { t: "add", id: "00000000000000e2", r: { task: "Sweep the yard", at }, q: 2 }));
  assert.deepEqual(both.added.map((r) => r.task), ["Sweep the yard"]);
});

test("a writer this vault doesn't know arrives attested; one it removed doesn't arrive; its own messages are skipped", async () => {
  const writers: Record<string, WriterState> = { cccccccccccccccc: "removed" };
  const { store, take } = setup(writers);
  const r = await take(
    msg(MAI, "Mai", { t: "add", id: "00000000000000c1", r: { task: "Bins", at: "2026-11-17T20:00" } }),
    msg("cccccccccccccccc", "Cy", { t: "add", id: "00000000000000c2", r: { task: "Spam", at: "2026-11-17T20:00" } }),
    msg(ME, "Me", { t: "add", id: "00000000000000c3", r: { task: "Echo", at: "2026-11-17T20:00" } }),
  );
  assert.deepEqual(r.added.map((x) => [x.task, x.line]), [["Bins", "attested"]]);
  // An add and its retract read together: set aside at once.
  const both = await take(msg(MAI, "Mai", { t: "add", id: "00000000000000c4", r: { task: "Oops", at: "2026-11-17T20:00" } }), msg(MAI, "Mai", { t: "retract", id: "00000000000000c4" }));
  assert.deepEqual(both.added.map((x) => x.line), ["dismissed"]);
  assert.equal((await store.rows("chore")).length, 2);
});

// ---- Vaults sharing a kind through a relay -------------------------------------------------------

const SHARED = { ...CHORE, share: { relay: RELAY, key: { secret: "chore-key" } } };
const NAMES = ["Ann", "Bo", "Cy"];

type Vault = { t: ReturnType<typeof fakeBackground>; name: string; fp: string; store: DataStore; id: Identity };

/** `n` vaults sharing Chore, each with its own signing key and the kind's one key; each accepts the others unless told not to. */
async function sharedVaults(n: number, relay: ReturnType<typeof memoryRelay>, o: { accepted?: boolean; key?: Uint8Array } = {}): Promise<Vault[]> {
  const key = o.key ?? newKindKey();
  const ids = await Promise.all(NAMES.slice(0, n).map((name) => newIdentity(name, key)));
  const fps = await Promise.all(ids.map((i) => writerOf(i.sign)));
  const vaults = ids.map((id, i): Vault => {
    const t = fakeBackground({ [KIND]: { fm: SHARED } });
    t.f.secrets["chore-key"] = identityText(id);
    const plain = t.f.host.fetch;
    t.f.host.fetch = (url, headers, init) => (url.startsWith(RELAY) ? relay.fetch(url, headers, init) : plain(url, headers, init));
    if (o.accepted !== false) fps.forEach((fp, j) => { if (j !== i) t.writers[`${KIND}\n${fp}`] = { name: NAMES[j], state: "accepted", at: 0 }; });
    return { t, name: NAMES[i], fp: fps[i], store: t.env.store!(KIND_DATA, KIND), id };
  });
  for (const v of vaults) await v.t.bg.start();
  return vaults;
}

const advanceAll = (vaults: Vault[], ms: number) => { for (const v of vaults) v.t.advance(ms); };
const own = async (v: Vault) => (await v.store.rows("chore")).filter((r) => r.writer === undefined);
/** A row as it is compared across vaults: its id there and the fields it travels with. */
const shown = (id: string, r: Record<string, unknown>) => JSON.stringify([id, r.task ?? null, r.who ?? null, r.minutes ?? null, toTime(r.at) ?? null]);
const loggedFrom = async (v: Vault, w: Vault) => (await v.store.rows("chore")).filter((r) => r.writer === w.fp && lineOf(r) === "logged").map((r) => shown(rowIdOf(r)!, r)).sort();
const liveOf = async (w: Vault) => (await own(w)).filter((r) => lineOf(r) === "logged").map((r) => shown(remoteRowId(w.fp, rowIdOf(r)!), r)).sort();

async function converged(vaults: Vault[]): Promise<string | undefined> {
  for (const v of vaults) for (const w of vaults) {
    if (v === w) continue;
    const [got, want] = [await loggedFrom(v, w), await liveOf(w)];
    if (JSON.stringify(got) !== JSON.stringify(want)) return `${v.name} holds ${got.length} of ${w.name}'s rows, ${w.name} has ${want.length} logged; ${v.name} differs in ${got.filter((g) => !want.includes(g)).join(" ")}`;
  }
  return undefined;
}

test("two and three vaults converge over a relay that loses, duplicates and reorders, whatever order they add, change, take back, delete, put back with Undo and sync in", async () => {
  for (const n of [2, 3]) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = seeded(seed * 7 + n);
      let vaults: Vault[] = [];
      const relay = memoryRelay({ random, now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
      vaults = await sharedVaults(n, relay);
      Object.assign(relay.faults, { lose: 0.25, duplicate: 0.25, reorder: 0.3 });
      let made = 0;
      // Deletes and take-backs not undone yet, each vault's: Undo puts the row back, logged again.
      const undoable = new Map<Vault, string[]>(vaults.map((v) => [v, []]));
      for (let step = 0; step < 60; step++) {
        const v = vaults[Math.floor(random() * n)];
        const op = random();
        if (op < 0.33) await v.store.add("chore", { task: `${v.name} ${made++}`, who: "Sam", at: v.t.env.now().toISOString() });
        else if (op < 0.43) {
          // A change to a row of its own, or Undo of one: each goes as a newer version of the row.
          const mine = (await own(v)).filter((r) => lineOf(r) !== "planned");
          const row = mine[Math.floor(random() * mine.length)];
          const [field, value] = random() < 0.5 ? ["who", random() < 0.5 ? "Alex" : "Sam"] : random() < 0.5 ? ["minutes", Math.floor(random() * 60)] : ["task", `${String(row?.task ?? "")} again`];
          const done = row ? await v.store.set("chore", { id: rowIdOf(row), shown: row }, field, value) : undefined;
          if (done && "event" in done && done.event) undoable.get(v)!.push(done.event);
        } else if (op < 0.55) {
          const mine = (await own(v)).filter((r) => lineOf(r) === "logged");
          const row = mine[Math.floor(random() * mine.length)];
          const done = !row ? undefined : op < 0.48 ? await v.store.set("chore", { id: rowIdOf(row), shown: row }, "line", "dismissed") : await v.store.delete("chore", { id: rowIdOf(row), shown: row });
          if (done && "event" in done && done.event) undoable.get(v)!.push(done.event);
        } else if (op < 0.62) {
          const events = undoable.get(v)!;
          const event = events.splice(Math.floor(random() * events.length), 1)[0];
          if (event) await v.store.undo([event]);
        } else if (op < 0.9) await v.t.bg.share(KIND);
        else advanceAll(vaults, Math.floor(random() * 20) * 60_000);
      }
      // The relay works again: members come online within its keeping time of each other.
      Object.assign(relay.faults, { lose: 0, duplicate: 0, reorder: 0 });
      let why: string | undefined = "never ran";
      for (let round = 0; round < 15 && why; round++) {
        advanceAll(vaults, 61 * 60_000);
        for (const v of [...vaults].sort(() => random() - 0.5)) await v.t.bg.share(KIND);
        why = await converged(vaults);
      }
      assert.equal(why, undefined, `${n} vaults, seed ${seed}: ${why}`);
      for (const v of vaults) assert.ok((await v.store.rows("chore")).every((r) => r.writer !== v.fp), "no vault takes in its own rows");
    }
  }
});

test("a change to a row goes to the others as a newer version from its writer; one lost on the way is sent again once a member's summary shows the older version", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const sync = async () => {
    advanceAll(vaults, 61 * 60_000);
    await ann.t.bg.share(KIND);
    await bo.t.bg.share(KIND);
  };
  const bos = async () => (await bo.store.rows("chore")).map((r) => [r.task, r.who ?? null, r.minutes ?? null]);
  await ann.store.add("chore", { task: "Dishes", who: "Sam", at: "2026-11-18T08:00" });
  await sync();
  const [dishes] = await own(ann);
  await ann.store.set("chore", { id: rowIdOf(dishes), shown: dishes }, "who", "Alex");
  await sync();
  assert.deepEqual(await bos(), [["Dishes", "Alex", null]]);
  assert.deepEqual((await bo.t.activity.list(KIND)).map((e) => e.what)[0], "Changed 1 row from Ann");
  // The next change is lost on the way; Bo's summary still names the version before it, so Ann sends the row again.
  relay.faults.lose = 1;
  const [now] = await own(ann);
  await ann.store.set("chore", { id: rowIdOf(now), shown: now }, "minutes", 20);
  await ann.t.bg.share(KIND);
  relay.faults.lose = 0;
  for (let round = 0; round < 4; round++) await sync();
  assert.deepEqual(await bos(), [["Dishes", "Alex", 20]]);
  assert.equal(await converged(vaults), undefined);
});

test("a row from a writer nobody accepted waits in Next; Accept counts it and what comes after, Refuse sets it aside and ends the rest", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(3, relay, { accepted: false });
  const [ann, bo, cy] = vaults;
  await ann.store.add("chore", { task: "Bins", who: "Sam", at: "2026-11-18T08:00" });
  await ann.t.bg.share(KIND);
  for (const v of [bo, cy]) {
    await v.t.bg.tick();
    await settle();
  }
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line, r.by]), [["Bins", "attested", "Ann"]]);
  const ask = () => bo.t.bg.asks.list().find((a) => a.id.startsWith("writer\n"));
  assert.equal(ask()?.text, "Accept rows from Ann in Chore? 1 row waits, and later ones will count as logged");
  assert.ok(ask()!.refuse, "x refuses it");
  // Rows waiting on a writer aren't rows from a file.
  assert.ok(!bo.t.bg.asks.list().some((a) => a.id.startsWith("file\n")));
  const r = await bo.t.bg.settleAsk(ask()!, "answer");
  assert.deepEqual([r.ok, r.what], [true, "Accepted rows from Ann"]);
  assert.equal(bo.t.writers[`${KIND}\n${ann.fp}`]?.state, "accepted");
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line]), [["Bins", undefined]]);
  await settle();
  assert.equal(ask(), undefined);
  // Cy refuses Ann: the row is set aside, and Ann's next row doesn't come in.
  const refuse = cy.t.bg.asks.list().find((a) => a.id.startsWith("writer\n"))!;
  assert.equal((await cy.t.bg.settleAsk(refuse, "dismiss")).what, "Refused rows from Ann");
  await ann.store.add("chore", { task: "Dishes", who: "Alex", at: "2026-11-18T09:00" });
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  await cy.t.bg.share(KIND);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line]), [["Bins", undefined], ["Dishes", undefined]], "accepted: arrives logged");
  assert.deepEqual((await cy.store.rows("chore")).map((r) => [r.task, r.line]), [["Bins", "dismissed"]], "refused: nothing more");
  // Each is one change in the activity: what came in is the share's, the accept is the person's.
  const entries = await bo.t.activity.list(KIND);
  assert.deepEqual(entries.map((e) => [e.actor, e.what]), [["share", "Took in 1 row from Ann"], ["you", "Accepted rows from Ann"], ["share", "Took in 1 row from Ann"]]);
});

test("a new key under a name already accepted is asked about as another key, not as the person you know", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const keys = await kindKeys(ann.id.key);
  const eve = await signerOf(await newSigningKey(), "Ann");
  relay.post(keys.topic, await seal(keys.topic, "m", keys.member, eve, { t: "add", id: "00000000000000e1", r: { task: "Fake", at: "2026-11-18T08:00" } }));
  await bo.t.bg.share(KIND);
  await settle();
  const ask = bo.t.bg.asks.list().find((a) => a.id.startsWith("writer\n"));
  assert.equal(ask?.text, `Accept rows from Ann (another key than the Ann you know, ${eve.writer.slice(0, 4)}) in Chore? 1 row waits, and later ones will count as logged`);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line]), [["Fake", "attested"]]);
});

test("a row taken back, or deleted, is set aside in the other vaults; a writer removed here stops, and its rows already here stay", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  await ann.store.add("chore", { task: "Bins", at: "2026-11-18T08:00" });
  await ann.store.add("chore", { task: "Dishes", at: "2026-11-18T08:30" });
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line]), [["Bins", undefined], ["Dishes", undefined]]);
  const [bins, dishes] = await own(ann);
  await ann.store.set("chore", { id: rowIdOf(bins), shown: bins }, "line", "dismissed");
  await ann.store.delete("chore", { id: rowIdOf(dishes), shown: dishes });
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line]), [["Bins", "dismissed"], ["Dishes", "dismissed"]]);
  // Bo removes Ann, as Remove on the map does: Ann's later rows don't come in; the two already here stay.
  bo.t.writers[`${KIND}\n${ann.fp}`] = { name: "Ann", state: "removed", at: 1 };
  await ann.store.add("chore", { task: "Laundry", at: "2026-11-18T09:00" });
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => r.task), ["Bins", "Dishes"]);
});

test("caps: a writer's flood is cut at its hour's share, and a row too long to send stays here, said once", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const keys = await kindKeys(ann.id.key);
  const signer = await signerOf(ann.id.sign, "Ann");
  for (let i = 0; i < MAX_PER_HOUR + 5; i++) {
    relay.post(keys.topic, await seal(keys.topic, "m", keys.member, signer, { t: "add", id: i.toString(16).padStart(16, "0"), r: { task: `flood ${i}`, at: "2026-11-18T08:00" } }));
  }
  await bo.t.bg.share(KIND);
  assert.equal((await bo.store.rows("chore")).length, MAX_PER_HOUR);
  assert.ok(bo.t.notices.includes(`Chore: more than ${MAX_PER_HOUR} rows from Ann this hour; the rest come when they're sent again`), bo.t.notices.join(" | "));

  await ann.store.add("chore", { task: "x".repeat(3200), at: "2026-11-18T08:00" });
  await ann.store.add("chore", { task: "Short", at: "2026-11-18T08:01" });
  await ann.t.bg.share(KIND);
  await ann.t.bg.share(KIND);
  assert.equal(ann.t.notices.filter((n) => n.includes("too long")).length, 1);
  assert.deepEqual(ann.t.notices.filter((n) => n.includes("too long")), ["Chore: a row is too long to share (more than 4 KB once sealed); it stays in this vault only"]);
  assert.equal((await own(ann)).length, 2, "both saved here");
  advanceAll(vaults, 61 * 60_000);
  await bo.t.bg.share(KIND);
  assert.ok((await bo.store.rows("chore")).some((r) => r.task === "Short"));
  assert.ok(!(await bo.store.rows("chore")).some((r) => String(r.task).startsWith("xxx")));
});

test("caps: anyone with the key making new signing keys is cut at one hour's allowance for all the writers not accepted", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const keys = await kindKeys(ann.id.key);
  for (let k = 0; k < 6; k++) {
    const signer = await signerOf(await newSigningKey(), `Eve ${k}`);
    for (let i = 0; i < 50; i++) relay.post(keys.topic, await seal(keys.topic, "m", keys.member, signer, { t: "add", id: i.toString(16).padStart(16, "0"), r: { task: `spam ${k}.${i}`, at: "2026-11-18T08:00" } }));
  }
  await ann.store.add("chore", { task: "Bins", at: "2026-11-18T08:00" });
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  const rows = await bo.store.rows("chore");
  assert.equal(rows.filter((r) => String(r.task).startsWith("spam")).length, MAX_PER_HOUR);
  assert.ok(rows.every((r) => !String(r.task).startsWith("spam") || r.line === "attested"), "and they wait to be accepted");
  assert.ok(rows.some((r) => r.task === "Bins" && r.line === undefined), "an accepted writer's row still comes in");
  assert.ok(bo.t.notices.includes(`Chore: more than ${MAX_PER_HOUR} rows from people you haven't accepted this hour; the rest come when they're sent again`), bo.t.notices.join(" | "));
});

test("offline: a save here always succeeds, the relay's failure backs off and is told once, and what waited goes when it answers", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  relay.faults.down = true;
  for (let i = 0; i < 4; i++) {
    const r = await ann.store.add("chore", { task: `offline ${i}`, at: ann.t.env.now().toISOString() });
    assert.ok(r.id);
    await ann.t.bg.share(KIND);
    advanceAll(vaults, 20 * 60_000);
  }
  assert.equal((await own(ann)).length, 4);
  const told = ann.t.notices.filter((n) => n.includes("couldn't reach"));
  assert.deepEqual(told, ["Chore: couldn't reach relay.test (no answer); rows are kept here and go when it answers"]);
  // While it backs off, nothing is asked of the relay at all.
  await ann.t.bg.share(KIND);
  const asked = relay.requests.length;
  await ann.t.bg.share(KIND);
  assert.equal(relay.requests.length, asked);
  relay.faults.down = false;
  advanceAll(vaults, 61 * 60_000);
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  assert.equal((await loggedFrom(bo, ann)).length, 4);
  assert.ok(ann.t.notices.includes("Chore: relay.test answers again; what waited here is going out"));
});

test("a guest page's row arrives logged where its maker accepted it, attested elsewhere; it can't take anything back", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const page = await newSigningKey();
  const pageWriter = await writerOf(page);
  ann.t.writers[`${KIND}\n${pageWriter}`] = { name: "Sitter", state: "accepted", at: 0, guest: true };
  const keys = await kindKeys(ann.id.key);
  const gzSeal = new Function(`${GUEST_SEAL_SOURCE}; return gzSeal;`)() as (...a: unknown[]) => Promise<string>;
  const raw = await guestKeyBytes(ann.id.key, pageWriter);
  relay.post(keys.topic, await gzSeal(keys.topic, pageWriter, raw, page, "Sitter", { t: "add", id: "00000000000000f1", r: { task: "Fed the cat", at: "2026-11-18T07:00" } }));
  relay.post(keys.topic, await gzSeal(keys.topic, pageWriter, raw, page, "Sitter", { t: "retract", id: "00000000000000f1" }));
  await ann.t.bg.share(KIND);
  await bo.t.bg.share(KIND);
  assert.deepEqual((await ann.store.rows("chore")).map((r) => [r.task, r.line, r.by]), [["Fed the cat", undefined, "Sitter"]]);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line, r.by]), [["Fed the cat", "attested", "Sitter"]]);
});

test("a tampered message, or one sealed with another kind's key, is left out without a word", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  await ann.store.add("chore", { task: "Bins", at: "2026-11-18T08:00" });
  await ann.t.bg.share(KIND);
  const keys = await kindKeys(ann.id.key);
  const [good] = relay.topics.get(keys.topic)!;
  relay.post(keys.topic, good.message.slice(0, -6) + (good.message.endsWith("AAAAAA") ? "BBBBBB" : "AAAAAA"));
  const stranger = await newIdentity("Eve");
  const theirs = await kindKeys(stranger.key);
  relay.post(keys.topic, await seal(keys.topic, "m", theirs.member, await signerOf(stranger.sign, "Eve"), { t: "add", id: "00000000000000e1", r: { task: "Spam", at: "2026-11-18T08:00" } }));
  relay.post(keys.topic, "hello");
  await bo.t.bg.share(KIND);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => r.task), ["Bins"]);
  assert.deepEqual(bo.t.notices, []);
});

test("with no share: anywhere, nothing asks the network for anything the notes don't name, in the plugin or in gizmod", async () => {
  const t = fakeBackground({ [KIND]: { fm: CHORE }, "Apps/Chores.md": { fm: { app: "c", panels: [{ view: "form", save: "[[Chore]]", title: "Did" }, { view: "table", source: "[[Chore]]" }] } } });
  await t.bg.start();
  await t.env.store!(KIND_DATA, KIND).add("chore", { task: "Bins", at: "2026-11-18T08:00" });
  for (let i = 0; i < 3; i++) {
    t.advance(61 * 60_000);
    await t.bg.tick();
    await settle();
  }
  assert.deepEqual(t.f.calls, []);
});

// ---- The kind note: share:, its permissions and the data policy ----------------------------------

test("share: names an ntfy server and the secret that holds the key; anything else says what to write", () => {
  assert.deepEqual(readShare({ relay: "https://ntfy.sh/", key: { secret: "chore-key" } }), { share: { relay: "https://ntfy.sh", host: "ntfy.sh", secret: "chore-key" }, errors: [] });
  assert.deepEqual(readShare({ relay: "http://127.0.0.1:8080", key: { secret: "k" } }).share?.host, "127.0.0.1:8080", "plain http only on this computer");
  const help = 'share needs relay (an ntfy server) and key (a secret), e.g. share: {relay: "https://ntfy.sh", key: {secret: chore-key}}';
  assert.deepEqual(readShare("yes").errors, [help]);
  assert.deepEqual(readShare({ relay: "http://ntfy.example", key: { secret: "k" } }).errors, ['share: relay must be the https address of an ntfy server, e.g. https://ntfy.sh, not "http://ntfy.example"']);
  assert.deepEqual(readShare({ relay: "https://ntfy.sh/?t=1", key: { secret: "k" } }).errors.length, 1);
  assert.deepEqual(readShare({ relay: "https://ntfy.sh", key: "gzk1.abc" }).errors, ["share: key must name a secret of lowercase letters, digits and dashes, e.g. key: {secret: chore-key}"]);
  assert.deepEqual(readShare({ relay: "https://ntfy.sh", key: { secret: "k" }, topic: "x" }).errors, [`share: unknown key "topic"; ${help}`]);
});

test("a shared kind asks before anything is sent: to share through its relay, with its secret; a kind that isn't shared asks for nothing", () => {
  const t = fakeEnv({ [KIND]: { fm: SHARED } });
  const spec = readSpec({ ...SHARED, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } } }, { notes: t.env.notes, path: KIND })!;
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(permissionsOf(spec.spec!, KIND), ["secret:chore-key", "share:Kinds/Chore.md|ntfy.sh"]);
  assert.equal(describePermission("share:Kinds/Chore.md|ntfy.sh"), "Share the rows of Chore through ntfy.sh: each row you add goes there sealed, and rows from the people you share it with come in");
  assert.deepEqual(permissionsOf(readSpec(CHORE, { notes: t.env.notes, path: KIND })!.spec!, KIND), []);
  assert.deepEqual(readSpec({ ...CHORE, share: { relay: "ntfy.sh" } }, { notes: t.env.notes, path: KIND })!.errors.length, 1);
});

test("the data policy's share place: a kind labelled private isn't shared until the policy clears share for it", () => {
  const spec = readSpec(SHARED, { path: KIND })!.spec!;
  const wanted = permissionsOf(spec, KIND);
  const judge = (fm: Record<string, unknown>) => {
    const policy = readPolicy(fm).policy!;
    return checkFlows(spec, wanted, { policy, appPath: KIND, dataPath: KIND_DATA, hostPath: KIND, tags: () => [], thenTarget: () => undefined });
  };
  assert.deepEqual(judge({ labels: { "Kinds/**": "private" } }).violations.map(violationText), ["Chore: Chore (private) → the people it's shared with (personal)"]);
  const cleared = judge({ labels: { "Kinds/**": "private" }, sinks: { share: "private" } });
  assert.deepEqual(cleared.violations, []);
  assert.ok(cleared.asked.includes(`share:${KIND}|relay.test`), "sharing is still asked for, never granted by the policy");
});

test("a shared kind's note shows who wrote each row, which isn't edited there; a kind that isn't shared shows as before", () => {
  const table = (fm: Record<string, unknown>) => readSpec(fm, { path: KIND })!.spec!.panels[1].panel;
  assert.deepEqual([table(SHARED).columns, table(SHARED).labels, table(SHARED).edit], [["at", "task", "who", "minutes", "by"], { at: "When", by: "By" }, ["task", "who", "minutes"]]);
  assert.deepEqual([table(CHORE).columns, table(CHORE).labels, table(CHORE).edit], [["at", "task", "who", "minutes"], { at: "When" }, ["task", "who", "minutes"]]);
});

// ---- Rows put back, rows accepted elsewhere, rows that settle a plan ------------------------------

test("a row put back after its take-back reaches the others again: deleted then undone, or moved ahead then answered as happened; an old message read late changes nothing", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const sync = async () => {
    for (const v of vaults) v.t.advance(61 * 60_000);
    await ann.t.bg.share(KIND);
    await bo.t.bg.share(KIND);
  };
  const show = async (v: Vault) => (await v.store.rows("chore")).map((r) => [r.task, lineOf(r)]);
  await ann.store.add("chore", { task: "Dishes", at: "2026-11-18T08:00" });
  await sync();
  const [dishes] = await own(ann);
  const del = await ann.store.delete("chore", { id: rowIdOf(dishes), shown: dishes });
  await sync();
  assert.deepEqual(await show(bo), [["Dishes", "dismissed"]]);
  // Every message so far, kept to be read again later, out of order.
  const old = [...(relay.topics.values().next().value ?? [])].map((m) => m.message);
  await ann.store.undo(["event" in del ? del.event! : ""]);
  await sync();
  assert.deepEqual(await show(bo), [["Dishes", "logged"]], "the row back, logged, in Bo's vault");
  for (const m of old.reverse()) relay.post((await kindKeys(ann.id.key)).topic, m);
  await bo.t.bg.share(KIND);
  assert.deepEqual(await show(bo), [["Dishes", "logged"]], "the old add and take-back, read again, change nothing");

  // Moved to a time still to come (planned, so taken back), then answered as happened: logged again everywhere.
  const [row] = await own(ann);
  await ann.store.set("chore", { id: rowIdOf(row), shown: row }, "line", "planned");
  await sync();
  assert.deepEqual(await show(bo), [["Dishes", "dismissed"]]);
  const [planned] = await own(ann);
  await ann.store.set("chore", { id: rowIdOf(planned), shown: planned }, "line", undefined);
  await sync();
  assert.deepEqual(await show(bo), [["Dishes", "logged"]]);
  assert.equal(await converged(vaults), undefined);
});

test("a row taken in waiting, on a device that hadn't heard yet that its writer was accepted, counts at the next read; it settles the planned row it matches", async () => {
  const DOSE = { kind: "dose", shortcut: "dose", fields: { med: ["A", "B"] }, match: { med: "exact", at: "0d" }, share: { relay: RELAY, key: { secret: "dose-key" } } };
  const t = fakeBackground({ "Kinds/Dose.md": { fm: DOSE } });
  const id = await newIdentity("Me");
  t.f.secrets["dose-key"] = identityText(id);
  const relay = memoryRelay({ now: () => t.env.now().getTime() });
  const plain = t.f.host.fetch;
  t.f.host.fetch = (url, headers, init) => (url.startsWith(RELAY) ? relay.fetch(url, headers, init) : plain(url, headers, init));
  await t.bg.start();
  assert.ok((await t.bg.capture("dose A @2026-11-19 08:00")).ok);
  t.writers[`Kinds/Dose.md\n${MAI}`] = { name: "Mai", state: "accepted", at: 0 };
  const store = t.env.store!("Kinds/Dose data.md", "Kinds/Dose.md");
  // Another device of this vault, before data.json said Mai is accepted, took in her dose waiting.
  await ingest(store, { name: "dose", fields: DOSE.fields }, [msg(MAI, "Mai", { t: "add", id: "00000000000000d1", r: { med: "A", at: "2026-11-19T08:05" } })], { self: ME, writers: () => undefined, now: t.env.now() });
  t.advance(21 * 3_600_000); // Thu 19th 09:00
  await t.bg.tick();
  await settle();
  const rows = await store.rows("dose");
  const hers = rows.find((r) => r.writer === MAI)!;
  assert.deepEqual(rows.map((r) => [r.med, lineOf(r)]), [["A", "planned"], ["A", "logged"]]);
  assert.equal(rows[0].matched, rowIdOf(hers), "her dose settles the planned one");
  assert.deepEqual(t.bg.asks.list().map((a) => a.text), [], "Next doesn't ask whether the planned dose happened");
  // Bo isn't accepted: his dose waits; accepted in Next, it counts and settles the dose planned for then.
  assert.ok((await t.bg.capture("dose B @2026-11-19 10:00")).ok);
  await ingest(store, { name: "dose", fields: DOSE.fields }, [msg("bbbbbbbbbbbbbbbb", "Bo", { t: "add", id: "00000000000000d2", r: { med: "B", at: "2026-11-19T09:58" } })], { self: ME, writers: () => undefined, now: t.env.now() });
  await t.bg.tick();
  await settle();
  const accept = t.bg.asks.list().find((a) => a.text.startsWith("Accept rows from Bo"))!;
  assert.ok(accept, t.bg.asks.list().map((a) => a.text).join(" | "));
  assert.ok((await t.bg.settleAsk(accept, "answer")).ok);
  const after = await store.rows("dose");
  const bos = after.find((r) => r.writer === "bbbbbbbbbbbbbbbb")!;
  assert.deepEqual([lineOf(bos), after.find((r) => r.med === "B" && r.line === "planned")?.matched], ["logged", rowIdOf(bos)]);
});

test("a row from another vault that arrives logged, or is accepted later, settles the planned row it matches, as a row logged here does", async () => {
  const DOSE = { kind: "dose", shortcut: "dose", fields: { med: ["A", "B"] }, match: { med: "exact", at: "0d" } };
  const t = fakeBackground({ "Kinds/Dose.md": { fm: DOSE } });
  await t.bg.start();
  for (const line of ["dose A @2026-11-19 08:00", "dose A @2026-11-20 08:00"]) assert.ok((await t.bg.capture(line)).ok);
  const store = t.env.store!("Kinds/Dose data.md", "Kinds/Dose.md");
  const kind = { name: "dose", fields: DOSE.fields as Record<string, string | string[]>, match: { med: { kind: "exact" as const }, at: { kind: "days" as const, days: 0 } } };
  const r = await ingest(store, kind, [msg(MAI, "Mai", { t: "add", id: "00000000000000d1", r: { med: "A", at: "2026-11-19T08:05" } })], { self: ME, writers: () => "accepted", now: new Date(2026, 10, 19, 9) });
  const [p19, p20, hers] = await store.rows("dose");
  assert.equal(p19.matched, rowIdOf(hers));
  assert.equal(p20.matched, undefined);
  assert.deepEqual(r.done.map((d) => d.edit.op === "set" ? d.edit.field : d.edit.op), ["add", "matched"], "in the same write");
  // Bo isn't accepted: his dose of the 20th waits, and settles the 20th's plan when he is accepted in Next.
  await ingest(store, kind, [msg("bbbbbbbbbbbbbbbb", "Bo", { t: "add", id: "00000000000000d2", r: { med: "A", at: "2026-11-20T08:01" } })], { self: ME, writers: () => undefined, now: new Date(2026, 10, 20, 9) });
  assert.equal((await store.rows("dose"))[1].matched, undefined);
});

// ---- What a key holder who isn't accepted can and can't make a vault do ---------------------------

test("summaries from keys this vault didn't accept change nothing: no rows sent again, no state kept; a member's catch-up waits between batches", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  for (let i = 0; i < 30; i++) await bo.store.add("chore", { task: `bo ${i}`, at: "2026-11-18T08:00" });
  await bo.t.bg.share(KIND);
  await ann.t.bg.share(KIND);
  advanceAll(vaults, 61 * 60_000);
  await bo.t.bg.share(KIND);
  const keys = await kindKeys(ann.id.key);
  const posts = () => relay.requests.filter((q) => q.method === "POST").length;
  const sizes: number[] = [];
  for (let run = 0; run < 3; run++) {
    for (let k = 0; k < 50; k++) {
      const fresh = await signerOf(await newSigningKey(), "x");
      relay.post(keys.topic, await seal(keys.topic, "m", keys.member, fresh, { t: "have", c: { [bo.fp]: [0, 0, "0123456789abcdef"] } }));
    }
    const before = posts();
    bo.t.advance(60_000);
    await bo.t.bg.share(KIND);
    assert.equal(posts() - before, 0, `run ${run}: nothing sent again for a stranger`);
    sizes.push(bo.t.shareState.text!.length);
  }
  assert.equal(new Set(sizes).size, 1, `the state doesn't grow: ${sizes.join(", ")}`);
  const st = Object.values(JSON.parse(bo.t.shareState.text!).kinds)[0] as { peers: Record<string, unknown>; resend: Record<string, unknown> };
  assert.deepEqual(Object.keys(st.peers), [ann.fp], "only the member Bo accepted");
  assert.ok(Object.keys(st.resend).every((k) => k === ann.fp));
  // Ann, accepted, says she lacks every row: one batch goes, and the next not before the catch-up gap, whatever she says meanwhile.
  const annSigner = await signerOf(ann.id.sign, "Ann");
  const lacks = async () => relay.post(keys.topic, await seal(keys.topic, "m", keys.member, annSigner, { t: "have", c: {} }));
  await lacks();
  let before = posts();
  bo.t.advance(CATCH_UP_EVERY_MS);
  await bo.t.bg.share(KIND);
  assert.equal(posts() - before, MAX_SENDS);
  await lacks();
  before = posts();
  bo.t.advance(60_000);
  await bo.t.bg.share(KIND);
  assert.equal(posts() - before, 0, "too soon after the last batch");
  await lacks();
  before = posts();
  bo.t.advance(CATCH_UP_EVERY_MS);
  await bo.t.bg.share(KIND);
  assert.ok(posts() - before > 0);
});

test("a guest page's row reaches a member who was offline longer than the relay keeps it: the page's maker sends it again, still signed by the page", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  relay.faults.retentionMs = 12 * 3_600_000;
  const page = await newSigningKey();
  const pageWriter = await writerOf(page);
  ann.t.writers[`${KIND}\n${pageWriter}`] = { name: "Sitter", state: "accepted", at: 0, guest: true };
  const keys = await kindKeys(ann.id.key);
  const gzSeal = new Function(`${GUEST_SEAL_SOURCE}; return gzSeal;`)() as (...a: unknown[]) => Promise<string>;
  const raw = await guestKeyBytes(ann.id.key, pageWriter);
  relay.post(keys.topic, await gzSeal(keys.topic, pageWriter, raw, page, "Sitter", { t: "add", id: "00000000000000f1", r: { task: "Fed the cat", at: "2026-11-18T07:00" } }));
  await ann.t.bg.share(KIND);
  // Bo is offline for 13 hours; then both are online.
  advanceAll(vaults, 13 * 3_600_000);
  for (let round = 0; round < 4; round++) {
    advanceAll(vaults, 61 * 60_000);
    await ann.t.bg.share(KIND);
    await bo.t.bg.share(KIND);
  }
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.line, r.by, r.writer]), [["Fed the cat", "attested", "Sitter", pageWriter]]);
});

test("names are compared as people read them, a row's by is the name this vault knows its writer by, and a writer whose rows don't fit is told once", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann, bo] = vaults;
  const keys = await kindKeys(ann.id.key);
  const post = async (signer: Awaited<ReturnType<typeof signerOf>>, payload: Payload) => relay.post(keys.topic, await seal(keys.topic, "m", keys.member, signer, payload));
  // A new key under "Ann" with a zero-width space and a compatibility letter is another key than the Ann Bo knows.
  const eve = await signerOf(await newSigningKey(), "Ａnn​");
  await post(eve, { t: "add", id: "00000000000000e1", r: { task: "Fake", at: "2026-11-18T08:00" } });
  // Ann, accepted as Ann, writes under another name: her row says Ann.
  await post(await signerOf(ann.id.sign, "Bo"), { t: "add", id: "00000000000000a1", r: { task: "Bins", at: "2026-11-18T08:00" } });
  await bo.t.bg.share(KIND);
  await settle();
  assert.equal(bo.t.bg.asks.list().find((a) => a.id.startsWith("writer\n"))?.text, `Accept rows from Ann (another key than the Ann you know, ${eve.writer.slice(0, 4)}) in Chore? 1 row waits, and later ones will count as logged`);
  assert.deepEqual((await bo.store.rows("chore")).map((r) => [r.task, r.by]), [["Fake", "Ann"], ["Bins", "Ann"]]);
  // Rows that don't fit the kind: a time that isn't one, a choice it doesn't have, text for a number. Told once a session.
  const mai = await signerOf(await newSigningKey(), "Mai");
  for (const [i, r] of ([
    { task: "x", at: `2026-11-18 08:00 (${"y".repeat(3000)})` }, { task: "x", who: "Mallory", at: "2026-11-18T08:00" }, { task: "x", minutes: "lots", at: "2026-11-18T08:00" },
  ] as Record<string, unknown>[]).entries()) {
    await post(mai, { t: "add", id: `00000000000000b${i}`, r });
    bo.t.advance(60_000);
    await bo.t.bg.share(KIND);
  }
  assert.equal((await bo.store.rows("chore")).length, 2, "none of Mai's rows comes in");
  assert.deepEqual(bo.t.notices.filter((n) => n.includes("left out")), ["Chore: left out a row from Mai: it has no time"]);
  const kept = await ingest(bo.store, SPEC, [msg(MAI, "Mai", { t: "add", id: "00000000000000c1", r: { task: "y", who: "Sam", minutes: "15", at: "2026-11-18T08:00:30Z" } })], { self: ME, writers: () => "accepted", now: bo.t.env.now() });
  assert.deepEqual({ ...kept.added[0] }, { at: "2026-11-18T08:00+00:00", task: "y", who: "Sam", minutes: 15, by: "Mai", writer: MAI }, "an ISO time kept as a stamp, its own clock and offset");
});

test("a guest page's key is made for each page that sends, and only the newest few are kept", async () => {
  const keys = await kindKeys(newKindKey());
  const proto = Object.getPrototypeOf(crypto.subtle);
  const orig = proto.deriveBits;
  let derived = 0;
  proto.deriveBits = function (...a: unknown[]) { derived++; return orig.apply(this, a); };
  try {
    const first = await keys.guest("0000000000000000");
    for (let i = 1; i <= 100; i++) await keys.guest(i.toString(16).padStart(16, "0"));
    assert.equal(derived, 101);
    assert.notEqual(await keys.guest("0000000000000000"), first, "the oldest was let go, and made again");
    await keys.guest("0000000000000064");
    assert.equal(derived, 102, "the newest are kept");
  } finally {
    proto.deriveBits = orig;
  }
});

test("a device that stops and starts again as the runner reads what the other device sent meanwhile, and sends none of it twice", async () => {
  let vaults: Vault[] = [];
  const relay = memoryRelay({ now: () => vaults[0]?.t.env.now().getTime() ?? 0 });
  vaults = await sharedVaults(2, relay);
  const [ann] = vaults;
  await ann.store.add("chore", { task: "Bins", at: "2026-11-18T08:00" });
  await ann.t.bg.share(KIND);
  // Another device of Ann's vault runs for a while and sends a row; its file syncs here.
  ann.t.device.background = false;
  await ann.t.bg.share(KIND);
  await ann.store.add("chore", { task: "Dishes", at: "2026-11-18T08:30" });
  const [, dishes] = await own(ann);
  const theirs = JSON.parse(ann.t.shareState.text!);
  Object.values(theirs.kinds as Record<string, { sent: Record<string, string>; v: Record<string, number> }>)[0].sent[rowIdOf(dishes)!] = "a";
  ann.t.otherShareStates.push(JSON.stringify(theirs));
  ann.t.device.background = true;
  const posts = () => relay.requests.filter((q) => q.method === "POST").length;
  const before = posts();
  await ann.t.bg.share(KIND);
  assert.equal(posts() - before, 0, "Dishes, sent by the other device, isn't sent again");
});

test("a kind is shared already, so a device without its key is told to take the others' key rather than make one, when rows came in, a writer was decided, or another device sent rows", () => {
  const sent = JSON.stringify({ v: 1, kinds: { [KIND]: { sent: { "0123456789abcdef": "a" } } } });
  assert.equal(sharedAlready(KIND, [{ task: "Mine", at: "2026-11-18T08:00" }], {}, []), false, "never shared: a key may be made");
  assert.equal(sharedAlready(KIND, [{ task: "Bins", at: "2026-11-18T08:00", by: "Mai", writer: MAI }], {}, []), true);
  assert.equal(sharedAlready(KIND, [], { [MAI]: { name: "Mai", state: "accepted", at: 0 } }, []), true, "joined from an invite");
  assert.equal(sharedAlready(KIND, [], {}, [sent]), true, "another device of this vault sends it");
  assert.equal(sharedAlready("Kinds/Other.md", [], {}, [sent, "{not json"]), false);
});

test("a kind takes the labels of the folders it imports files from: a private bank folder's rows aren't shared, or sent by an app that reads them, until the policy clears it", () => {
  const BANK = { ...SHARED, fields: { ...CHORE.fields, amount: "number" }, import: { bank: { folder: "Finance/Bank", at: "Date", amount: "Amount", task: "Description" } } };
  const notes = { resolve: (link: string) => (link === "Chore" ? KIND : undefined), frontmatter: (p: string) => (p === KIND ? BANK : undefined) };
  const policy = readPolicy({ labels: { "Finance/**": "private" } }).policy!;
  const spec = readSpec(BANK, { path: KIND })!.spec!;
  const wanted = permissionsOf(spec, KIND);
  const judged = checkFlows(spec, wanted, { policy, appPath: KIND, dataPath: KIND_DATA, hostPath: KIND, tags: () => [], thenTarget: () => undefined });
  assert.deepEqual(judged.violations.map(violationText), ["Chore: Chore (private) → the people it's shared with (personal)"]);
  assert.ok(judged.covered.includes("read:Finance/Bank"), "reading the folder is still the policy's to judge, where the rows go");
  const cleared = readPolicy({ labels: { "Finance/**": "private" }, sinks: { share: "private" } }).policy!;
  assert.deepEqual(checkFlows(spec, wanted, { policy: cleared, appPath: KIND, dataPath: KIND_DATA, hostPath: KIND, tags: () => [], thenTarget: () => undefined }).violations, []);
  // An app that tells the rows in a notice reads them with the folder's label too.
  const APP = { app: "Tell", panels: [{ view: "number", title: "Spent", source: "[[Chore]]", field: "amount", agg: "sum", alert: "> 10", notify: "spent {value}" }] };
  const app = readSpec(APP, { path: "Apps/Tell.md", notes })!.spec!;
  const ctx = flowContext(policy, { appPath: "Apps/Tell.md", dataPath: "Apps/Tell data.md", hostPath: "Apps/Tell.md" }, notes, (s) => s, () => []);
  assert.deepEqual(checkFlows(app, permissionsOf(app, "Apps/Tell.md"), ctx).violations.map(violationText), ["Spent: Chore.amount (private) → a notice (personal)"]);
});
