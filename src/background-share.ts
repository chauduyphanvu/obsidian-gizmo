/**
 * Shared kinds, kept in step through their relay by the device that runs background work: what it
 * reads from the relay is taken in (see share-ingest.ts), and the rows this vault logged go out,
 * one sealed message each, with another add when one is changed, a retract when one stops being
 * logged and another add when it is logged again, each numbered with a version that only grows. A
 * save here never waits on the relay: a row is saved first, and goes when the relay answers. Each
 * member also posts which rows it holds from each writer, at which versions, so a writer sends its
 * rows again to a member it accepted that missed some, or missed a change, and the vault that made
 * a guest page sends again what the page sent; rows still reach everyone as long as two members are
 * online within the relay's keeping time of each other.
 */
import type { Change } from "./activity.ts";
import { storeOf } from "./actions.ts";
import type { AppEntry, BackgroundEnv } from "./background.ts";
import type { Row } from "./data.ts";
import { stableJson } from "./hash.ts";
import { lineOf, ROW_FIELDS } from "./kind.ts";
import { rowIdOf } from "./ledger-store.ts";
import {
  MAX_MESSAGE, kindKeys, messageBytes, open, readIdentity, seal, signerOf, type Holding, type KindKeys, type Opened, type Payload, type Signer,
} from "./share-crypto.ts";
import { ingest, remoteRowId, type WriterState } from "./share-ingest.ts";
import { rowId } from "./ledger.ts";
import { ntfyRelay, type Relay } from "./share-relay.ts";
import type { KindSpec } from "./spec.ts";

/** What this vault decided about a writer of a kind, as data.json keeps it under `<kind path>\n<writer>`. */
export interface WriterRecord {
  name: string;
  state: WriterState;
  at: number;
  /** A guest page this vault made, for the map to say so. */
  guest?: true;
}

/** At most this many messages go out for a kind in one run: the rest go on the next. */
export const MAX_SENDS = 20;
/** Rows taken from one writer in an hour, at most: a flood waits, and catch-up brings it later. */
export const MAX_PER_HOUR = 200;
/** How often a member says what it holds when nothing changed. */
export const HAVE_EVERY_MS = 3_600_000;
const HOUR = 3_600_000;
/** Members whose summaries are kept, at most: only those this vault accepted, the longest silent dropped first. */
export const MAX_PEERS = 32;
/** A member behind is sent rows again at most this often, whatever it says meanwhile. */
export const CATCH_UP_EVERY_MS = 15 * 60_000;
/** What a guest page sent, kept to send again, at most this many of its newest messages a page. */
export const MAX_GUEST_KEPT = 200;

/** One device's record of one shared kind, kept in its own file. */
interface KindState {
  /** The last relay message read. */
  cursor?: string;
  /** This vault's rows sent: `a` added, `r` taken back since, `x` too long to send. */
  sent: Record<string, "a" | "r" | "x">;
  /** The version of the last add or take-back sent of each of this vault's rows. */
  v: Record<string, number>;
  /** What each of this vault's rows held when it was last added (or found too long), as a digest: a row that holds other fields now is sent again. */
  h: Record<string, string>;
  /** Of each row from another vault: the version of the add its fields are from, or minus the version of the take-back that set it aside (see ingest). */
  seen: Record<string, number>;
  /** What each guest page this vault made sent, as it came (sealed and signed by the page), by the page and the page's id for the row. */
  guests: Record<string, Record<string, string>>;
  /** What each other member said it holds, and when that was read. */
  peers: Record<string, { c: Record<string, Holding>; at: number }>;
  /** What this member last said it holds, and when. */
  told?: { c: string; at: number };
  /**
   * For each member behind: when its rows were last sent again, where the next batch starts, what it
   * held then, and how long to wait before the next batch when that didn't change.
   */
  resend: Record<string, { at: number; from: number; had?: string; wait?: number }>;
  /** Rows taken from each writer in the current hour. */
  hour: Record<string, [number, number]>;
  fails: number;
  next: number;
  /** Messages read that didn't open: changed, cut short, sealed with another key. */
  ignored: number;
}

const fresh = (): KindState => ({ sent: {}, v: {}, h: {}, seen: {}, guests: {}, peers: {}, resend: {}, hour: {}, fails: 0, next: 0, ignored: 0 });

/** A set of row ids (each with its version) as one short text, the same whatever their order. */
const digest = (ids: readonly string[]) => rowId([...ids].sort().join(","));

/** A row held, as a member's summary names it: its id and the version of the add its fields are from. */
const held = (id: string, version: number | undefined) => `${id}:${version ?? 0}`;

/** A row as it travels: its own fields, never the ones Gizmo keeps. */
function travelling(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !ROW_FIELDS.includes(k)));
}

/** What a row holds as it travels, as one short text: a change to any of its fields changes it. */
const contentOf = (r: Record<string, unknown>) => rowId(stableJson(r));

/** Rows a member may lack from one writer: what this vault holds of them (a digest), and each one's message, ready to send again. */
interface CatchUp {
  /** Where its resends are kept beside the member's: "" for this vault's own rows, else the guest page's writer. */
  key: string;
  writer: string;
  mine: string;
  batch: (() => Promise<boolean>)[];
}

export interface SharesHost {
  granted(entry: AppEntry): boolean;
  say(message: string): void;
}

export class Shares {
  private env: BackgroundEnv;
  private host: SharesHost;
  private state: Promise<{ kinds: Record<string, KindState> }> | undefined;
  private saved = "";
  private saving: Promise<void> = Promise.resolve();
  private keys = new Map<string, Promise<{ keys: KindKeys; signer: Signer }>>();
  private working = new Map<string, { done: Promise<void>; again: boolean; read: boolean }>();
  /** What was told once for each kind, so a lasting problem isn't told on every run. */
  private told = new Map<string, string>();
  /** The writers whose rows were left out and told so, by kind: told once a session. */
  private warned = new Set<string>();
  /** Whether this device ran as the runner when last asked: one that becomes it again reads what the others kept meanwhile. */
  private runner = false;

  constructor(env: BackgroundEnv, host: SharesHost) {
    this.env = env;
    this.host = host;
  }

  /** What this vault decided about each writer of a kind. */
  writers(kindPath: string): Record<string, WriterRecord> {
    return this.env.writers?.(kindPath) ?? {};
  }

  /**
   * Reads the relay and sends what waits, for a shared kind this device may share: only where
   * background work runs, once the kind is allowed and its secret holds a key. Asked again while it
   * runs, it runs once more after, reading the relay then if either asked to. Never rejects.
   */
  run(entry: AppEntry, read = true): Promise<void> {
    const kind = entry.spec.kind;
    if (!this.env.runsBackground()) {
      this.runner = false;
      return Promise.resolve();
    }
    if (!this.runner) {
      this.runner = true;
      if (!this.working.size) this.state = undefined;
    }
    if (!kind?.share || !this.host.granted(entry)) return Promise.resolve();
    const busy = this.working.get(entry.path);
    if (busy) {
      busy.again = true;
      busy.read ||= read;
      return busy.done;
    }
    const job = { again: false, read, done: Promise.resolve() };
    job.done = (async () => {
      try {
        do {
          const reads = job.read;
          job.again = false;
          job.read = false;
          await this.once(entry, kind, reads).catch(() => {});
        } while (job.again);
      } finally {
        this.working.delete(entry.path);
      }
    })();
    this.working.set(entry.path, job);
    return job.done;
  }

  private async once(entry: AppEntry, kind: KindSpec, read: boolean): Promise<void> {
    const share = kind.share!;
    const secret = this.env.data.host.secret(share.secret);
    const id = readIdentity(secret);
    if (!id) {
      this.tellOnce(entry.path, "key", secret ? `${entry.name}: the secret ${share.secret} doesn't hold a key for sharing; copy the key from a device that shares ${entry.name} (“Invite to a kind”, Copy key) and paste it with “Invite to a kind” on this one`
        : `${entry.name}: nothing is shared from this device until the secret ${share.secret} holds the kind's key; if another device shares ${entry.name}, copy its key there (“Invite to a kind”, Copy key) and paste it with “Invite to a kind” here`);
      return;
    }
    const { keys, signer } = await this.keysOf(secret!, id);
    const states = await this.load();
    const st = (states.kinds[entry.path] ??= fresh());
    const now = this.env.now().getTime();
    if (st.next > now) return;
    const relay = ntfyRelay(share.relay, (url, headers, init) => this.env.data.host.fetch(url, headers, init));
    try {
      if (read) await this.pull(entry, kind, keys, signer, st, relay);
      await this.push(entry, kind, keys, signer, st, relay);
      if (st.fails >= 3) this.host.say(`${entry.name}: ${share.host} answers again; what waited here is going out`);
      st.fails = 0;
      st.next = 0;
      this.told.delete(`${entry.path}\nrelay`);
    } catch (e) {
      st.fails++;
      st.next = now + Math.min(60, 2 ** st.fails) * 60_000;
      if (st.fails >= 3) this.tellOnce(entry.path, "relay", `${entry.name}: couldn't reach ${share.host} (${(e as Error).message}); rows are kept here and go when it answers`);
    } finally {
      this.save();
    }
  }

  private keysOf(secret: string, id: NonNullable<ReturnType<typeof readIdentity>>): Promise<{ keys: KindKeys; signer: Signer }> {
    let k = this.keys.get(secret);
    if (!k) {
      k = (async () => ({ keys: await kindKeys(id.key), signer: await signerOf(id.sign, id.name) }))();
      this.keys.set(secret, k);
    }
    return k;
  }

  /** Reads what the relay holds after the cursor: counts from members, rows to take in. */
  private async pull(entry: AppEntry, kind: KindSpec, keys: KindKeys, signer: Signer, st: KindState, relay: Relay): Promise<void> {
    const got = await relay.poll(keys.topic, st.cursor);
    const now = this.env.now();
    const writers = this.writers(entry.path);
    const accepted = (w: string) => writers[w]?.state === "accepted";
    const opened: Opened[] = [];
    for (const m of got) {
      const o = await open(m.text, keys.topic, keys);
      if ("error" in o) {
        st.ignored++;
        continue;
      }
      opened.push(o);
      // A guest page this vault made: what it sent is kept as it came, to send again to a member who missed it.
      if (o.payload.t === "add" && o.kid === o.writer && writers[o.writer]?.guest && accepted(o.writer)) {
        const kept = (st.guests[o.writer] ??= {});
        if (kept[o.payload.id] === undefined) {
          kept[o.payload.id] = m.text;
          const ids = Object.keys(kept);
          for (const old of ids.slice(0, Math.max(0, ids.length - MAX_GUEST_KEPT))) delete kept[old];
        }
      }
    }
    // Only members this vault accepted are caught up: anyone with the key can make new keys and say anything.
    for (const o of opened) {
      if (o.payload.t === "have" && o.writer !== signer.writer) st.peers[o.writer] = { c: o.payload.c, at: now.getTime() };
    }
    const peers = Object.entries(st.peers).filter(([w]) => accepted(w) && !writers[w]?.guest).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_PEERS);
    st.peers = Object.fromEntries(peers);
    for (const key of Object.keys(st.resend)) if (!st.peers[key.split("\n")[0]]) delete st.resend[key];
    const deps = this.env.actionDeps(entry.path, entry.dataPath, "share");
    const capped = new Set<string>();
    // Anyone with the key can make new signing keys: writers not accepted share one hour's allowance too.
    const may = (w: string) => (accepted(w) || this.mayTake(st, "*", now.getTime())) && this.mayTake(st, w, now.getTime());
    const r = await ingest(storeOf(deps), kind, opened, {
      self: signer.writer, now, writers: (w) => writers[w]?.state, name: (w) => writers[w]?.name, versions: st.seen,
      may: (w) => may(w) || void capped.add(w) || false,
    });
    for (const w of capped) {
      const name = opened.find((o) => o.writer === w)?.name ?? "a writer";
      const who = st.hour[w]?.[1] === MAX_PER_HOUR ? name : "people you haven't accepted";
      this.tellOnce(`${entry.path}\n${who}`, `cap ${Math.floor(now.getTime() / HOUR)}`, `${entry.name}: more than ${MAX_PER_HOUR} rows from ${who} this hour; the rest come when they're sent again`);
    }
    if (got.length) st.cursor = got[got.length - 1].id;
    if (r.done.length) {
      const names = [...new Set(r.done.filter((d) => d.edit.op === "add" || (d.edit.op === "set" && d.edit.field !== "matched")).map((d) => (typeof d.row.by === "string" ? d.row.by : "someone")))];
      const changes: Change[] = r.done.map((d) => d.edit.op === "set"
        ? { kind: "row-edited", path: deps.dataPath, list: kind.name, row: d.row, field: d.edit.field, from: d.from, to: d.edit.value, ...(d.event && { event: d.event }) }
        : { kind: "row-added", path: deps.dataPath, list: kind.name, row: d.row, ...(d.event && { event: d.event }) });
      const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
      const parts = [
        ...(r.added.length ? [`took in ${rows(r.added.length)}`] : []),
        ...(r.changed.length ? [`changed ${rows(r.changed.length)}`] : []),
        ...(r.dismissed.length ? [`set aside ${r.dismissed.length} taken back`] : []),
        ...(r.restored.length ? [`counted ${rows(r.restored.length)} again`] : []),
      ];
      if (parts.length) await deps.log?.(`${parts.join(", ")} from ${names.join(", ")}`.replace(/^./, (c) => c.toUpperCase()), changes);
    }
    // A writer whose rows don't fit is told once a session, not at every read.
    const told = r.refused.filter((_, i) => !this.warned.has(`${entry.path}\n${r.refusedFrom[i]}`));
    for (const w of r.refusedFrom) this.warned.add(`${entry.path}\n${w}`);
    if (told.length) this.host.say(`${entry.name}: left out ${told[0]}${told.length > 1 ? `, and ${told.length - 1} more` : ""}`);
  }

  /** Whether one more row from a writer fits in its hour, counting it when it does. */
  private mayTake(st: KindState, writer: string, now: number): boolean {
    const [start, n] = st.hour[writer] ?? [now, 0];
    const [s, k] = now - start >= HOUR ? [now, 0] : [start, n];
    if (k >= MAX_PER_HOUR) return false;
    st.hour[writer] = [s, k + 1];
    return true;
  }

  /**
   * Sends this vault's rows not sent yet (or logged again since they were taken back), a retract for
   * each sent one no longer logged, what it holds, and rows a member missed.
   */
  private async push(entry: AppEntry, kind: KindSpec, keys: KindKeys, signer: Signer, st: KindState, relay: Relay): Promise<void> {
    const deps = this.env.actionDeps(entry.path, entry.dataPath);
    const rows = await storeOf(deps).rows(kind.name);
    const own = rows.filter((r) => r.writer === undefined && rowIdOf(r) !== undefined);
    const live = new Map(own.filter((r) => lineOf(r) === "logged").map((r) => [rowIdOf(r)!, r]));
    const now = this.env.now().getTime();
    let budget = MAX_SENDS;
    const post = async (text: string): Promise<boolean> => {
      if (budget <= 0) return false;
      budget--;
      await relay.post(keys.topic, text);
      return true;
    };
    // Each add or take-back of a row gets a version above the last one sent, whatever the clock says.
    const next = (id: string) => Math.max(now, (st.v[id] ?? 0) + 1);
    const version = (id: string) => (st.v[id] = next(id));
    /** Posts a message; "long" when it is too long to post, which is told. */
    const send = async (payload: Payload): Promise<boolean | "long"> => {
      if (budget <= 0) return false;
      const text = await seal(keys.topic, "m", keys.member, signer, payload);
      if (messageBytes(text) > MAX_MESSAGE) {
        this.host.say(`${entry.name}: a row is too long to share (more than 4 KB once sealed); it stays in this vault only`);
        return "long";
      }
      return post(text);
    };
    // A row not sent yet, logged again since it was taken back, or changed since it was sent (or found too long).
    for (const [id, row] of live) {
      if (budget <= 0) break;
      const r = travelling(row);
      const content = contentOf(r);
      // A device of an older Gizmo kept no content of what it sent: taken as sent as it is now.
      if (st.sent[id] === "a" && st.h[id] === undefined) st.h[id] = content;
      if ((st.sent[id] === "a" || st.sent[id] === "x") && st.h[id] === content) continue;
      const q = next(id);
      const done = await send({ t: "add", id, r, q });
      if (!done) continue;
      if (done === true) {
        st.sent[id] = "a";
        st.v[id] = q;
      } else {
        // Changed until too long: the others take back the version they hold, as it is here only now.
        if (st.sent[id] === "a") {
          if ((await send({ t: "retract", id, q })) !== true) continue;
          st.v[id] = q;
        }
        st.sent[id] = "x";
      }
      st.h[id] = content;
    }
    for (const [id, s] of Object.entries(st.sent)) {
      if (s !== "a" || live.has(id) || budget <= 0) continue;
      if ((await send({ t: "retract", id, q: version(id) })) === true) st.sent[id] = "r";
    }
    if (budget <= 0) return;
    // What it holds from each other writer: their rows, how many of them are set aside, and which the rest are, at which versions.
    const holding = new Map<string, { n: number; set: number; ids: string[]; at: string[] }>();
    for (const r of rows) {
      if (typeof r.writer !== "string") continue;
      const h = holding.get(r.writer) ?? { n: 0, set: 0, ids: [], at: [] };
      holding.set(r.writer, h);
      h.n++;
      if (lineOf(r) === "dismissed") h.set++;
      else {
        h.ids.push(rowIdOf(r)!);
        h.at.push(held(rowIdOf(r)!, st.seen[rowIdOf(r)!]));
      }
    }
    const counts: Record<string, Holding> = Object.fromEntries([...holding].map(([w, h]) => [w, [h.n, h.set, digest(h.at)]]));
    const said = JSON.stringify(counts);
    if (!st.told || st.told.c !== said || now - st.told.at >= HAVE_EVERY_MS) {
      if ((await send({ t: "have", c: counts })) === true) st.told = { c: said, at: now };
    }
    // This vault's own rows, sealed again at their versions; and what each guest page it made sent, as it came.
    const sentLive = [...live.keys()].filter((id) => st.sent[id] === "a");
    const sources: CatchUp[] = [{
      key: "",
      writer: signer.writer,
      mine: digest(sentLive.map((id) => held(remoteRowId(signer.writer, id), st.v[id]))),
      // A take-back to send again: a row no longer logged, or one sent before that became too long.
      batch: [...sentLive.reverse(), ...Object.keys(st.sent).filter((id) => st.sent[id] === "r" || (st.sent[id] === "x" && st.v[id] !== undefined))].map((id) => async () => {
        const row = st.sent[id] === "a" ? live.get(id) : undefined;
        const q = st.v[id] ?? version(id);
        return (await send(row ? { t: "add", id, r: travelling(row), q } : { t: "retract", id, q })) === true;
      }),
    }];
    for (const [guest, kept] of Object.entries(st.guests)) {
      const ids = new Set(holding.get(guest)?.ids ?? []);
      const texts = Object.entries(kept).filter(([id]) => ids.has(remoteRowId(guest, id))).map(([, text]) => text);
      sources.push({ key: guest, writer: guest, mine: digest(holding.get(guest)?.at ?? []), batch: texts.reverse().map((text) => () => post(text)) });
    }
    await this.catchUp(st, sources, now);
  }

  /**
   * A member whose rows from a writer, set aside or not, aren't the rows this vault holds of it gets
   * them again (this vault's own rows and retracts, or what a guest page it made sent), a batch at a
   * time, newest first: what it holds says so by its digest, which counts alone can't (a missed add
   * and a missed retract cancel out). Each batch waits for that member to say what it holds since,
   * and at least CATCH_UP_EVERY_MS; when that didn't change (it set rows aside itself), the next
   * waits twice as long, up to a day.
   */
  private async catchUp(st: KindState, sources: readonly CatchUp[], now: number): Promise<void> {
    for (const [peer, p] of Object.entries(st.peers)) {
      for (const source of sources) {
        const at = source.key ? `${peer}\n${source.key}` : peer;
        const done = st.resend[at];
        const had = p.c[source.writer]?.[2] ?? digest([]);
        if (had === source.mine || !source.batch.length) {
          delete st.resend[at];
          continue;
        }
        if (done && (done.at >= p.at || now - done.at < CATCH_UP_EVERY_MS || (done.had === had && now < done.at + (done.wait ?? 0)))) continue;
        const wait = done?.had === had ? Math.min(Math.max(2 * (done.wait ?? 0), HOUR), 24 * HOUR) : 0;
        let i = done ? done.from % source.batch.length : 0;
        for (let n = 0; n < Math.min(MAX_SENDS, source.batch.length); n++, i = (i + 1) % source.batch.length) {
          if (!(await source.batch[i]())) break;
        }
        st.resend[at] = { at: now, from: i, had, wait };
      }
    }
  }

  private tellOnce(path: string, what: string, message: string): void {
    const key = `${path}\n${what}`;
    if (this.told.get(key) === message) return;
    this.told.set(key, message);
    this.host.say(message);
  }

  private load(): Promise<{ kinds: Record<string, KindState> }> {
    this.state ??= (async () => {
      const read = async (text: string | undefined) => {
        try {
          const parsed = text ? JSON.parse(text) as { v?: unknown; kinds?: unknown } : undefined;
          return parsed?.v === 1 && parsed.kinds && typeof parsed.kinds === "object" ? parsed.kinds as Record<string, KindState> : {};
        } catch {
          return {};
        }
      };
      await this.saving;
      const text = await this.env.shareState?.read().catch(() => undefined);
      this.saved = text ?? "";
      const kinds = await read(text);
      for (const k of Object.values(kinds)) Object.assign(k, { ...fresh(), ...k });
      // A device taking over from another: what that one sent isn't sent again, and the newer of the two goes on.
      for (const other of (await this.env.otherShareStates?.().catch(() => [])) ?? []) {
        for (const [path, theirs] of Object.entries(await read(other))) {
          const mine = (kinds[path] ??= fresh());
          for (const [id, s] of Object.entries(theirs.sent ?? {})) {
            const v = theirs.v?.[id] ?? 0;
            if (mine.sent[id] !== undefined && v <= (mine.v[id] ?? 0)) continue;
            mine.sent[id] = s;
            if (v) mine.v[id] = v;
            if (theirs.h?.[id] !== undefined) mine.h[id] = theirs.h[id];
          }
          for (const [id, v] of Object.entries(theirs.seen ?? {})) if (Math.abs(v) > Math.abs(mine.seen[id] ?? 0)) mine.seen[id] = v;
          for (const [guest, kept] of Object.entries(theirs.guests ?? {})) mine.guests[guest] = { ...kept, ...mine.guests[guest] };
        }
      }
      return { kinds };
    })();
    return this.state;
  }

  private save(): void {
    void this.state?.then((s) => {
      const text = JSON.stringify({ v: 1, kinds: s.kinds });
      if (text === this.saved) return;
      this.saved = text;
      this.saving = this.saving.then(() => this.env.shareState?.write(text)).catch(() => {});
    });
  }

  /** Forgets what a kind's sharing kept on this device (its note is gone). */
  drop(path: string): void {
    void this.state?.then((s) => {
      if (!s.kinds[path]) return;
      delete s.kinds[path];
      this.save();
    });
  }
}

/**
 * Whether a kind is shared already, so this device must take the key the others use rather than
 * make a new one: rows came in from another vault, this vault decided about a writer of it (it
 * joined, or accepted someone), or another of its devices sent rows of it.
 */
export function sharedAlready(kindPath: string, rows: readonly Row[], writers: Record<string, WriterRecord>, otherStates: readonly string[]): boolean {
  if (rows.some((r) => typeof r.writer === "string") || Object.keys(writers).length) return true;
  return otherStates.some((text) => {
    try {
      const kinds = (JSON.parse(text) as { kinds?: Record<string, { sent?: Record<string, unknown> }> }).kinds;
      return Object.keys(kinds?.[kindPath]?.sent ?? {}).length > 0;
    } catch {
      return false;
    }
  });
}
