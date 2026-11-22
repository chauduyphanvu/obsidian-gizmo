import {
  countedIn, fileRowsAsks, inOrder, plannedAsks, rhythmAnswer, rhythmAsks, rhythmLine, tomorrow, waitingWriterAsks, type Ask, type RowChange, type WriterDecision,
} from "./asks.ts";
import { storeOf } from "./actions.ts";
import type { FiredStore } from "./background-fired.ts";
import { EXPECT_MISSED } from "./background-rhythms.ts";
import type { AppEntry, Background, BackgroundEnv } from "./background.ts";
import type { CaptureIndex } from "./capture.ts";
import { rowsOf, type Row } from "./data.ts";
import type { Edit } from "./datastore.ts";
import { ASKS_DEP } from "./deps.ts";
import { plannedPanel, type Rhythm, type Window } from "./expect.ts";
import { rowIdOf } from "./ledger-store.ts";
import { settlements } from "./match.ts";
import type { Panel } from "./spec.ts";

/** The asks of every allowed app, oldest first, and word when they change. */
export interface AskFeed {
  list(): Ask[];
  /** Calls back on every change; returns what stops it. */
  subscribe(cb: () => void): () => void;
}

/** What working out asks needs of the Background. */
export interface AsksHost {
  apps: ReadonlyMap<string, AppEntry>;
  fired: FiredStore;
  granted: (entry: AppEntry) => boolean;
  evaluate: Background["evaluate"];
  captureIndex: () => CaptureIndex;
}

/** Where a skip is kept in `fired`: under no app's path, so editing or pausing an app keeps it. */
const skipKey = (id: string) => `skip:${id}`;

/**
 * Works out what each allowed app asks of the person (see asks.ts), when its data changes and on
 * every tick, and publishes the queue: for the Next window, `source: asks` and the status bar. An
 * ask skipped here stays out of the queue until the next day, across restarts.
 */
export class Asks {
  private env: BackgroundEnv;
  private apps: AsksHost["apps"];
  private fired: FiredStore;
  private granted: AsksHost["granted"];
  private evaluate: AsksHost["evaluate"];
  private captureIndex: AsksHost["captureIndex"];
  private byApp = new Map<string, Ask[]>();
  /** Until when each skipped ask stays out, by its id. */
  private skips = new Map<string, number>();
  private listeners = new Set<() => void>();
  private shown = "[]";
  /** The app being worked out now, and whether it was asked for again meanwhile. */
  private working = new Map<string, { done: Promise<void>; again: boolean }>();

  readonly feed: AskFeed = {
    list: () => this.list(),
    subscribe: (cb) => {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    },
  };

  constructor(env: BackgroundEnv, host: AsksHost) {
    this.env = env;
    this.apps = host.apps;
    this.fired = host.fired;
    this.granted = host.granted;
    this.evaluate = host.evaluate;
    this.captureIndex = host.captureIndex;
  }

  /** Works out an app's asks again; asked again meanwhile, it runs once more after. */
  check(entry: AppEntry): Promise<void> {
    const busy = this.working.get(entry.path);
    if (busy) {
      busy.again = true;
      return busy.done;
    }
    const state = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await this.readSkips();
          const asks = await this.compute(entry).catch(() => this.byApp.get(entry.path) ?? []);
          if (this.apps.get(entry.path) !== entry) return;
          this.byApp.set(entry.path, asks);
          this.publish();
        } while (state.again && this.apps.get(entry.path) === entry);
      } finally {
        this.working.delete(entry.path);
      }
    })();
    this.working.set(entry.path, state);
    return state.done;
  }

  private async compute(entry: AppEntry): Promise<Ask[]> {
    if (!this.granted(entry)) return [];
    const now = this.env.now();
    const zone = this.env.zone?.();
    const files = { appPath: entry.path, dataPath: entry.dataPath, devices: entry.devices };
    const read = async (list: string, extra: Partial<Panel> = {}) =>
      rowsOf(await this.env.data.rawData(list, { view: "table", source: list, ...extra }, files, { ttlMs: 0, now }));
    const out: Ask[] = [];
    const rules = entry.spec.expect.filter((r): r is Rhythm => r.kind === "rhythm");
    const missed = rules.length ? await read(EXPECT_MISSED) : [];
    const index = this.captureIndex();
    for (const rule of rules) {
      const ps = entry.spec.expected[rule.id];
      const r = ps && (await this.evaluate(entry.path, ps));
      if (!r || !("panel" in r)) continue;
      const plan = plannedPanel(ps);
      const p = plan && (await this.evaluate(entry.path, plan));
      const planned = p && "panel" in p ? rowsOf(p.rows) : [];
      out.push(...rhythmAsks({ path: entry.path, app: entry.name, rule, rows: rowsOf(r.rows), planned, missed, start: this.lineStart(entry, rule, ps.panel, index), index, now, zone }));
    }
    const kind = entry.spec.kind;
    if (kind) {
      const rows = await read(kind.name, { lines: "all" });
      out.push(
        ...plannedAsks({ path: entry.path, app: entry.name, list: kind.name, fields: Object.keys(kind.fields), rows, now }),
        ...fileRowsAsks({ path: entry.path, app: entry.name, rows, rule: kind.match }),
        ...(kind.share ? this.writerAsks(entry, rows) : []),
      );
    }
    return out;
  }

  private lineStart(entry: AppEntry, rule: Rhythm, counted: Panel, index: CaptureIndex) {
    const kept = countedIn(counted, entry.path);
    return kept && rhythmLine(rule, kept, entry.path, this.apps.values(), index, this.env.now());
  }

  /**
   * The capture line that logs a missed window of a rhythm, for a push to offer: only one that runs
   * as it stands, with nothing left to type.
   */
  lineFor(entry: AppEntry, rule: Rhythm, w: Window): string | undefined {
    const ps = entry.spec.expected[rule.id];
    if (!ps) return undefined;
    const index = this.captureIndex();
    const answer = rhythmAnswer(this.lineStart(entry, rule, ps.panel, index), w, index, this.env.now());
    return "line" in answer && answer.ready ? answer.line : undefined;
  }

  /** Keeps an ask out of the queue here until the start of tomorrow. */
  async skip(id: string): Promise<void> {
    const until = tomorrow(this.env.now());
    const fired = await this.fired.state();
    fired[skipKey(id)] = { skipped: until };
    this.fired.save();
    this.skips.set(id, until);
    this.publish();
  }

  /** The skips kept, those still running; the rest are dropped. */
  private async readSkips(): Promise<void> {
    const fired = await this.fired.state();
    const now = this.env.now().getTime();
    let gone = false;
    this.skips.clear();
    for (const [key, value] of Object.entries(fired)) {
      if (!key.startsWith("skip:") || !("skipped" in value)) continue;
      if (value.skipped > now) this.skips.set(key.slice(5), value.skipped);
      else {
        delete fired[key];
        gone = true;
      }
    }
    if (gone) this.fired.save();
  }

  /**
   * Answers an ask that changes a row (a planned row that happened), or dismisses one for good (a
   * miss acknowledged, a planned row set aside): one change, kept in the activity log as the person's.
   */
  /** A shared kind's writers waiting to be accepted, each named as its rows name it. */
  private writerAsks(entry: AppEntry, rows: readonly Row[]): Ask[] {
    const decided = this.env.writers?.(entry.path) ?? {};
    const known = new Set(Object.values(decided).map((w) => w.name));
    return waitingWriterAsks({ path: entry.path, app: entry.name, rows, decided: (w) => decided[w] !== undefined, known });
  }

  async settle(ask: Ask, how: "answer" | "dismiss"): Promise<{ ok: boolean; error?: string; entryId?: string; what?: string }> {
    const decision = how === "dismiss" ? ask.refuse : "writer" in ask.answer ? ask.answer.writer : undefined;
    if (decision) return this.decide(ask, decision);
    const change: RowChange | undefined = how === "dismiss" ? ask.dismiss : "change" in ask.answer ? ask.answer.change : undefined;
    const entry = this.apps.get(ask.path);
    if (!change || !entry) return { ok: false, error: `${ask.app} has nothing to change for that` };
    if (!this.granted(entry)) return { ok: false, error: `Open ${entry.name} once to allow it` };
    const deps = this.env.actionDeps(entry.path, entry.dataPath, "you");
    const store = storeOf(deps);
    const row: Row = change.row;
    const r = await store.set(change.list, { id: rowIdOf(row), shown: row }, change.field, change.value);
    if (!("row" in r)) return { ok: false, error: r.refused === "gone" ? "That row is gone" : "That row has changed meanwhile" };
    const entryId = await deps.log?.(change.what, [{
      kind: "row-edited", path: store.dataPath, list: change.list, row: r.row, field: change.field, from: row[change.field], to: change.value, ...(r.event && { event: r.event }),
    }])?.catch(() => undefined);
    void this.check(entry);
    return { ok: true, entryId, what: change.what };
  }

  /**
   * Accepts a writer of a shared kind, or refuses it: kept for the kind, so its later rows arrive
   * logged or not at all, and the rows it sent so far become logged, or are set aside, in one change.
   */
  private async decide(ask: Ask, d: WriterDecision): Promise<{ ok: boolean; error?: string; entryId?: string; what?: string }> {
    const entry = this.apps.get(ask.path);
    const kind = entry?.spec.kind;
    if (!entry || !kind) return { ok: false, error: `${ask.app} has nothing to change for that` };
    if (!this.env.setWriter) return { ok: false, error: `Accept or refuse ${d.name} in Obsidian` };
    if (!this.granted(entry)) return { ok: false, error: `Open ${entry.name} once to allow it` };
    this.env.setWriter(entry.path, d.writer, { name: d.name, state: d.accept ? "accepted" : "removed", at: this.env.now().getTime() });
    const deps = this.env.actionDeps(entry.path, entry.dataPath, "you");
    const store = storeOf(deps);
    const rows = await store.rows(kind.name);
    const waiting = rows.filter((r) => r.writer === d.writer && r.line === "attested");
    const value = d.accept ? undefined : "dismissed";
    const what = d.accept ? `Accepted rows from ${d.name}` : `Refused rows from ${d.name}`;
    let entryId: string | undefined;
    if (waiting.length) {
      const edits: Edit[] = waiting.map((row) => ({ op: "set", list: kind.name, ref: { id: rowIdOf(row), shown: row }, field: "line", value }));
      // Accepted, they count as logged: each settles the planned row it matches, as a row logged here does.
      const logged = d.accept ? waiting.flatMap((row) => (rowIdOf(row) === undefined ? [] : [{ id: rowIdOf(row)!, row }])) : [];
      for (const { plan, id } of settlements(logged, rows, kind.match)) edits.push({ op: "set", list: kind.name, ref: { id: rowIdOf(plan), shown: plan }, field: "matched", value: id });
      const done = await store.batch(edits);
      if ("refused" in done) return { ok: false, error: "Those rows have changed meanwhile" };
      entryId = await deps.log?.(what, done.map((x, i) => {
        const e = edits[i] as Extract<Edit, { op: "set" }>;
        return { kind: "row-edited" as const, path: store.dataPath, list: kind.name, row: x.row, field: e.field, from: e.ref.shown[e.field], to: e.value, ...(x.event && { event: x.event }) };
      }))?.catch(() => undefined) ?? undefined;
    }
    void this.check(entry);
    return { ok: true, entryId, what };
  }

  /** Takes an app's asks out of the queue: it's gone, paused or no longer allowed. */
  drop(path: string): void {
    if (this.byApp.delete(path)) this.publish();
  }

  /** The background stopped: nothing is asked, and nobody is told. */
  clear(): void {
    this.byApp.clear();
    this.listeners.clear();
  }

  private list(): Ask[] {
    const now = this.env.now().getTime();
    return inOrder([...this.byApp.values()].flat().filter((a) => (this.skips.get(a.id) ?? 0) <= now));
  }

  /** Tells the Next window, the status bar and `source: asks` when the queue changed. */
  private publish(): void {
    const json = JSON.stringify(this.list());
    if (json === this.shown) return;
    this.shown = json;
    this.env.data.told(ASKS_DEP);
    for (const cb of [...this.listeners]) cb();
  }
}
