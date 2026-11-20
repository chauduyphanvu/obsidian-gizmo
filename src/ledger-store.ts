import { fnv1a, stableJson } from "./hash.ts";
import { DEFINITION_KEYS } from "./store.ts";
import { areRules } from "./expect.ts";
import { ROW_INDEX } from "./sources/list.ts";
import type { Row } from "./data.ts";
import { toTime } from "./time.ts";
import {
  Clock, Folder, baseIds, compareEvents, eventId, eventLine, eventsAt, fold, foldOnto, logFile, logFileParts, logFolder, newRowId, parseLog, parseStamp, undoneEvents,
  type Conflict, type FoldBase, type FolderState, type LedgerEvent, type Op,
} from "./ledger.ts";

/** What the ledger reads and writes through: files of any kind in the vault. */
export interface LedgerIO {
  /** The files directly in a folder, any extension. */
  filesIn(folder: string): string[];
  readFile(path: string): Promise<string>;
  /** Adds text at the end of a file, making it and its folders when there's none. */
  append(path: string, text: string): Promise<void>;
  /** Writes a whole file, making it and its folders when there's none. */
  writeFile(path: string, text: string): Promise<void>;
  frontmatter(path: string): Record<string, unknown> | undefined;
  /** A file's size in bytes, when the host knows it without reading the file; without it every log file is read. */
  size?(path: string): number | undefined;
}

/** Keys the snapshot adds to a data note beside its lists. */
export const SNAPSHOT_KEY = "gizmo-snapshot";
export const IDS_KEY = "gizmo-ids";
const HASH_KEY = "gizmo-hash";
/** Why a write is refused in the app as it was at a past time. */
export const PAST = "This is the app as it was; nothing can be changed here";

/** What snapshots kept in the data note before checkpoints kept it: taken out at the next snapshot. */
const CONFLICTS_KEY = "gizmo-conflicts";
const GONE_KEY = "gizmo-gone";
/** Rows deleted (or added by an undone add) a checkpoint keeps, so a late copy of their add stays out. */
const MAX_GONE = 1000;
/** A recorded list keeps its newest rows in the data note; the app and the ledger have them all, up to the cap. */
export const NOTE_ROWS = 500;
const DAY = 86_400_000;
/** Events this old are settled: a checkpoint holds them, and late ones from before are rare. */
export const SETTLE_MS = 7 * DAY;
/** The snapshot's own keys, and Obsidian's lists of properties, which are no app's data. */
const META_KEYS = [SNAPSHOT_KEY, IDS_KEY, HASH_KEY, CONFLICTS_KEY, GONE_KEY, "tags", "aliases", "cssclasses"];

/** What a snapshot says it was folded from: how many lines of each log file, and the newest event's time. */
export interface SnapshotMark {
  files: Record<string, number>;
  at: string;
}

/** A row's id, carried on the rows a list source loads, not enumerable so rows still compare and save as typed. */
export const ROW_ID = Symbol("row id");

/** A row's cells another device set at the same time from the same value: the value that lost, and who set it. */
export const ROW_CONFLICTS = Symbol("row conflicts");

export function conflictsOf(row: unknown): { field: string; value: unknown; by: string }[] {
  const c = row && typeof row === "object" ? (row as Record<symbol, unknown>)[ROW_CONFLICTS] : undefined;
  return Array.isArray(c) ? c : [];
}

export function rowIdOf(row: unknown): string | undefined {
  const id = row && typeof row === "object" ? (row as Record<symbol, unknown>)[ROW_ID] : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * The lists a data note holds as a person or a snapshot wrote them: row lists and checklists, without
 * the snapshot's own keys. Rows take the ids in `kept` (a snapshot's) when it has as many, else ids
 * from their content.
 */
export function listsOf(fm: Record<string, unknown> | undefined, kept: Record<string, unknown> = {}): FoldBase {
  const base: FoldBase = { lists: {}, ticked: {} };
  for (const [k, v] of Object.entries(fm ?? {})) {
    // An empty list could be either kind; events say which it is.
    if (META_KEYS.includes(k) || !Array.isArray(v) || !v.length) continue;
    if (v.every((x) => typeof x === "string")) base.ticked[k] = v as string[];
    else if (v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
      const ids = kept[k];
      base.lists[k] = { rows: v as Row[], ids: Array.isArray(ids) && ids.length === v.length ? ids.map(String) : baseIds(v) };
    }
  }
  return base;
}

/** The names of the row lists a note holds. */
function listNames(fm: Record<string, unknown> | undefined): string[] {
  return Object.entries(fm ?? {}).filter(([k, v]) => !META_KEYS.includes(k) && Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))).map(([k]) => k);
}

/** The fingerprint of a note's lists, for telling a hand edit from the last snapshot. */
export function listsHash(fm: Record<string, unknown> | undefined): string {
  const keys = Object.keys(fm ?? {}).filter((k) => !META_KEYS.includes(k) && Array.isArray(fm![k])).sort();
  // Keys in a fixed order; rows as their note's text orders their keys, which a write and a read keep.
  return fnv1a(JSON.stringify(keys.map((k) => [k, fm![k]]))).toString(36);
}

/** A log file as read: how much of it (whole lines), a hash of that, and its events. */
interface LogFile {
  chars: number;
  hash: number;
  bytes: number;
  events: LedgerEvent[];
  /** The newest event's time (ms); 0 for none. */
  newest: number;
}

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;
const wallOf = (e: LedgerEvent) => parseStamp(e.t)!.wall;
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Every event up to a settled time, folded, kept beside the logs in a file of the device that wrote
 * it: opening an app folds only the events after it. `files` says how much of each log it read and
 * the newest time in it, so a log that hasn't changed and holds nothing newer needn't be read.
 */
interface Checkpoint {
  v: 1;
  /** What it was folded from: base.json, lists typed in the app note, caps. */
  from: string;
  settled: number;
  files: Record<string, { n: number; bytes: number; newest: number }>;
  /** What the settled undos and redos left undone. */
  undone: string[];
  /** Undos and redos after it that name an event in it: folded in, so the events after it fold on. */
  accounted: string[];
  folder: FolderState;
}

const CHECKPOINT = /\/checkpoint-[^/]+\.json$/;

/** A note's lists and their fingerprint, each worked out once for each version of the note, when first needed. */
let noteListsMade = 0;

class NoteLists {
  /** Unique to this reading of the note: a new reading may hold other lists. */
  readonly id = ++noteListsMade;
  readonly version: number;
  readonly fm: Record<string, unknown> | undefined;
  private hash_: string | undefined;
  private lists_: FoldBase | undefined;

  constructor(version: number, fm: Record<string, unknown> | undefined) {
    this.version = version;
    this.fm = fm;
  }

  get hash(): string {
    return (this.hash_ ??= listsHash(this.fm));
  }

  get lists(): FoldBase {
    return (this.lists_ ??= listsOf(this.fm));
  }
}

interface NoteLog {
  files: Map<string, LogFile>;
  /** Files left unread: the checkpoint folded from holds all they did. */
  skipped: Set<string>;
  /** The checkpoint the fold started from, if any. */
  checkpoint?: Checkpoint;
  /** Files changed since read. */
  dirty: Set<string>;
  /** The lists folded so far, kept so new events are applied on top. */
  folder?: Folder;
  /** Every event the folder has seen, applied or not. */
  seen: Set<string>;
  /** Something changed that applying on top can't follow (a file cut short or gone, new caps): fold again. */
  reset: boolean;
  /** What the folder was made from: the app note's lists, caps, and the data note until it has a snapshot. */
  foldedFrom?: string;
  /** The data note's reading `state` was last given for: a new one says again whether it was edited by hand. */
  noteId?: number;
  version: number;
  /** Recorded lists keep only their newest rows. */
  caps: Record<string, number>;
  /** What `state` gave, handed out again while nothing changed. */
  state?: LedgerState;
  /** The app note and old device notes last given for this note, used when a reader doesn't know them. */
  appFm?: Record<string, unknown>;
  devices?: Record<string, unknown>[];
  /** Each row as handed out, with its id: made again only for rows an event changed. */
  out: Map<string, Row>;
}

/** A data note's lists as the ledger folds them, and whether its note was edited by hand since the last snapshot. */
export interface LedgerState {
  lists: Map<string, { rows: Row[]; conflicts: Conflict[] }>;
  ticked: Map<string, string[]>;
  undone: Set<string>;
  /** The data note's lists differ from what the last snapshot wrote: someone edited it. */
  handEdited: boolean;
}

/**
 * Every app's data as the log of what happened to it (see ledger.ts): this device appends to its
 * own files, reads everyone's, and folds them onto the data note's last snapshot. The device that
 * runs background work writes that snapshot back into the data note, so the note stays readable
 * and searchable and opening an app needn't fold a year of events.
 */
export class Ledger {
  private io: LedgerIO;
  private device: () => string;
  private now: () => number;
  private clock = new Clock();
  private notes = new Map<string, NoteLog>();
  /** Told the path of each log file this device appended to. */
  onWrite: (path: string) => void = () => {};
  /** How many times each note changed, as told; a note's lists are read again only when it did. */
  private versions = new Map<string, number>();
  private noteLists = new Map<string, NoteLists>();
  /** base.json and checkpoints as last read, by path, with the version they were read at. */
  private readCache = new Map<string, { version: number; text: string; parsed?: unknown }>();

  /**
   * The lists as they were at this time (ms): only events up to it are folded, from the base kept
   * before the first snapshot (a snapshot may hold later ones), and nothing is written.
   */
  until: number | undefined;

  constructor(io: LedgerIO, device: () => string, now: () => number, until?: number) {
    this.io = io;
    this.device = device;
    this.now = now;
    this.until = until;
  }

  private log(dataPath: string): NoteLog {
    let n = this.notes.get(dataPath);
    if (!n) {
      n = { files: new Map(), skipped: new Set(), dirty: new Set(), seen: new Set(), reset: true, version: 0, caps: {}, out: new Map() };
      this.notes.set(dataPath, n);
    }
    return n;
  }

  /** A file changed: when it is one of a data note's logs, that note is read again. */
  fileChanged(path: string): string | undefined {
    if (!path.endsWith(".jsonl") || !logFileParts(path)) {
      this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
      return undefined;
    }
    const folder = path.slice(0, path.lastIndexOf("/"));
    const dataPath = `${folder.replace(/\/log$/, "")}.md`;
    const n = this.notes.get(dataPath);
    if (!n) return dataPath;
    n.dirty.add(path);
    n.state = undefined;
    n.version++;
    return dataPath;
  }

  /**
   * Reads the log files that changed since last time; a file that grew is read past what was seen, any
   * other change in full. Unless `all`, a file the checkpoint folded from holds all of, unchanged, is
   * left unread.
   */
  private async refresh(dataPath: string, all = false): Promise<NoteLog> {
    const n = this.log(dataPath);
    const present = this.io.filesIn(logFolder(dataPath)).filter((p) => logFileParts(p));
    for (const p of [...n.files.keys(), ...n.skipped]) if (!present.includes(p)) {
      n.files.delete(p);
      n.skipped.delete(p);
      n.reset = true;
      n.state = undefined;
    }
    for (const p of present) {
      const read = n.files.has(p);
      if (read && !n.dirty.has(p)) continue;
      // A log is only appended to: one the same size as the checkpoint read it hasn't changed.
      if (!read && !all && this.settledIn(n, p)) {
        n.skipped.add(p);
        n.dirty.delete(p);
        continue;
      }
      n.skipped.delete(p);
      await this.read(n, p);
    }
    return n;
  }

  /** Whether the checkpoint folded from holds every event of this file, which hasn't changed since. */
  private settledIn(n: NoteLog, path: string): boolean {
    const mark = n.checkpoint?.files[nameOf(path)];
    return !!mark && mark.newest <= n.checkpoint!.settled && this.io.size?.(path) === mark.bytes;
  }

  private async read(n: NoteLog, p: string): Promise<void> {
    const text = await this.io.readFile(p).catch(() => "");
    const had = n.files.get(p);
    // Only complete lines: a line still being written is read when it ends.
    const end = text.lastIndexOf("\n") + 1;
    if (had && end >= had.chars && fnv1a(text.slice(0, had.chars)) === had.hash) {
      if (end > had.chars) {
        const more = text.slice(had.chars, end);
        const events = parseLog(more).events;
        had.events.push(...events);
        for (const e of events) had.newest = Math.max(had.newest, wallOf(e));
        had.hash = fnv1a(more, had.hash);
        had.chars = end;
        had.bytes += bytesOf(more);
      }
    } else {
      const whole = text.slice(0, end);
      const events = parseLog(whole).events;
      n.files.set(p, { chars: end, hash: fnv1a(whole), bytes: bytesOf(whole), events, newest: events.reduce((m, e) => Math.max(m, wallOf(e)), 0) });
      // A file read for the first time only adds events; one that changed otherwise needs a new fold.
      if (had) n.reset = true;
    }
    n.dirty.delete(p);
    n.state = undefined;
  }

  /** Every event read of a data note's logs. */
  private events(n: NoteLog): LedgerEvent[] {
    return [...n.files.values()].flatMap((f) => f.events);
  }

  /** A small file beside the logs (base.json, a checkpoint), read again only when it changed. */
  private async cached(path: string): Promise<{ text: string; parsed?: unknown }> {
    const version = this.versions.get(path) ?? 0;
    const had = this.readCache.get(path);
    if (had && had.version === version) return had;
    const text = await this.io.readFile(path).catch(() => "");
    const entry = { version, text };
    this.readCache.set(path, entry);
    return entry;
  }

  /** Writes a small file beside the logs, keeping what was written as read. */
  private async writeKept(path: string, text: string, parsed?: unknown): Promise<void> {
    await this.io.writeFile(path, text);
    const version = (this.versions.get(path) ?? 0) + 1;
    this.versions.set(path, version);
    this.readCache.set(path, { version, text, parsed });
  }

  /** Keeps the same newest rows of recorded lists as another ledger does: a replay folds as the live one. */
  capsFrom(other: Ledger): void {
    for (const [path, n] of other.notes) if (Object.keys(n.caps).length) this.setCaps(path, n.caps);
  }

  /** Keeps only the newest `cap` rows of these lists of a data note (what an app records on its own). */
  setCaps(dataPath: string, caps: Record<string, number>): void {
    const n = this.log(dataPath);
    if (JSON.stringify(n.caps) === JSON.stringify(caps)) return;
    n.caps = caps;
    n.reset = true;
    n.state = undefined;
  }

  /** Whether a data note holds lists an app records on its own (samples), which grow by the minute. */
  recorded(dataPath: string): boolean {
    return Object.keys(this.notes.get(dataPath)?.caps ?? {}).length > 0;
  }

  /** The version of a data note's log: it moves whenever an event is added or read. */
  version(dataPath: string): number {
    return this.notes.get(dataPath)?.version ?? 0;
  }

  /**
   * A data note's lists: the snapshot in the note, with the events after it; or, when that can't be
   * trusted (no snapshot, a late event from before it, an undo of an event in it), every event on
   * the base the first snapshot kept. Lists typed in the app note are the base of lists the data
   * note doesn't have. `caps` keeps the newest rows of recorded lists.
   */
  /** A data note's lists as it holds them now, worked out again only when it changed. */
  private listsIn(path: string): NoteLists {
    const fm = this.io.frontmatter(path);
    const version = this.versions.get(path) ?? 0;
    const kept = this.noteLists.get(path);
    if (kept && kept.version === version && kept.fm === fm) return kept;
    const lists = new NoteLists(version, fm);
    this.noteLists.set(path, lists);
    return lists;
  }

  /** When each of a data note's events was written (ms), every device's: the moments its lists changed. */
  async times(dataPath: string): Promise<number[]> {
    const n = await this.refresh(dataPath, true);
    return [...n.files.values()].flatMap((f) => f.events.map((e) => parseStamp(e.t)!.wall));
  }

  /**
   * `appFm` and `devices` are the app note and old device notes; a reader that leaves them out (the
   * activity list, a store that doesn't know the device notes) gets the last ones given, so readers
   * don't fold the note again for each other.
   */
  async state(dataPath: string, given?: Record<string, unknown>, givenDevices?: Record<string, unknown>[]): Promise<LedgerState> {
    const n = this.log(dataPath);
    if (given) n.appFm = given;
    if (givenDevices) n.devices = givenDevices;
    const appFm = n.appFm ?? {};
    const devices = n.devices ?? [];
    const note = this.listsIn(dataPath);
    const fm = note.fm;
    const marked = readMark(fm) !== undefined;
    const handEdited = marked && note.hash !== fm?.[HASH_KEY];
    const live = this.until === undefined;
    // Once a note has a snapshot, folds start from base.json or a checkpoint, not the note: a new snapshot needn't fold again.
    const from = `${this.until ?? ""}\n${marked ? "marked" : `${note.id}\n${devices.map(listsHash).join(",")}`}\n${listsHash(appLists(appFm))}\n${stableJson(n.caps)}`;
    if (n.foldedFrom !== from) n.reset = true;
    if (n.noteId !== note.id) {
      n.noteId = note.id;
      n.state = undefined;
    }
    // A fold from a checkpoint reads only the logs it needs, once it knows which.
    if (!((n.reset || !n.folder) && marked && live)) await this.refresh(dataPath, !live);
    if (!n.reset && n.state) return n.state;
    const visible = () => (live ? this.events(n) : eventsAt(this.events(n), this.until!));
    if (!n.reset && n.folder) {
      // Events a save or a sync added since: applied on top when they come after all the rest and undo nothing.
      const fresh = [...new Map(visible().filter((e) => !n.seen.has(eventId(e))).map((e) => [eventId(e), e])).values()].sort(compareEvents);
      if (fresh.every((e) => e.op !== "undo" && e.op !== "redo") && (!fresh.length || n.folder.follows(fresh[0]))) {
        for (const e of fresh) {
          this.clock.seen(e.t);
          n.folder.apply(e);
          n.seen.add(eventId(e));
        }
        for (const id of n.folder.takeTouched()) n.out.delete(id);
      } else n.reset = true;
    }
    if (n.reset || !n.folder) {
      n.foldedFrom = from;
      n.folder = marked && live ? await this.foldMarked(dataPath, n, appFm) : undefined;
      if (!n.folder) {
        n.checkpoint = undefined;
        await this.refresh(dataPath, true);
        const base = marked ? await this.base(dataPath) : withDevices(note.lists, devices);
        n.folder = fold(visible(), withApp(base, appFm), n.caps).folder;
      }
      for (const e of visible()) this.clock.seen(e.t);
      n.seen = new Set(visible().map(eventId));
      n.out.clear();
      n.reset = false;
    }
    const lists = new Map<string, { rows: Row[]; conflicts: Conflict[] }>();
    for (const [name, l] of n.folder.lists_()) {
      const byRow = new Map<string, { field: string; value: unknown; by: string }[]>();
      for (const c of l.conflicts) byRow.set(c.row, [...(byRow.get(c.row) ?? []), { field: c.field, value: c.value, by: c.by }]);
      lists.set(name, {
        rows: l.rows.map((r, i) => {
          const id = l.ids[i];
          const kept = n.out.get(id);
          // A row keeps its place among the rows as handed out; one whose place changed is made again.
          if (kept && (kept as Record<symbol, unknown>)[ROW_INDEX] === i) return kept;
          // Its id, and its place in the list for what still finds rows that way.
          const row = { ...r };
          Object.defineProperty(row, ROW_ID, { value: id });
          Object.defineProperty(row, ROW_INDEX, { value: i });
          const conflicts = byRow.get(id);
          if (conflicts) Object.defineProperty(row, ROW_CONFLICTS, { value: conflicts });
          n.out.set(id, row);
          return row;
        }),
        conflicts: l.conflicts,
      });
    }
    // From every event, not only those the fold started past: an undo a checkpoint holds still counts.
    const settled = n.checkpoint?.settled ?? -Infinity;
    const undone = undoneEvents(visible().filter((e) => wallOf(e) > settled), n.checkpoint?.undone);
    n.state = { lists, ticked: new Map(n.folder.ticked), undone, handEdited: handEdited && live };
    return n.state;
  }

  /**
   * A snapshotted note's lists from the newest checkpoint that fits, with the events after it, reading
   * only the logs that have them; undefined when none fits, or folding on from it wouldn't give what
   * folding everything would: a late event from before it, a log cut short, an undo of an event in it.
   */
  private async foldMarked(dataPath: string, n: NoteLog, appFm: Record<string, unknown>): Promise<Folder | undefined> {
    const from = await this.checkpointFrom(dataPath, appFm, n.caps);
    let best: Checkpoint | undefined;
    for (const p of this.io.filesIn(logFolder(dataPath)).filter((x) => CHECKPOINT.test(x))) {
      const cp = await this.checkpointAt(p);
      if (cp && cp.from === from && (!best || cp.settled > best.settled)) best = cp;
    }
    if (!best) return undefined;
    n.checkpoint = best;
    await this.refresh(dataPath);
    const after = this.after(n, best);
    if (!after) return undefined;
    return foldOnto(Folder.load(best.folder, n.caps), after).folder;
  }

  /** The events after a checkpoint, when folding them onto it gives what folding everything would. */
  private after(n: NoteLog, cp: Checkpoint): LedgerEvent[] | undefined {
    const present = new Set([...n.files.keys(), ...n.skipped].map(nameOf));
    if (Object.keys(cp.files).some((name) => !present.has(name))) return undefined;
    const tail = new Map<string, LedgerEvent>();
    for (const [p, f] of n.files) {
      const mark = cp.files[nameOf(p)];
      if (mark && f.events.length < mark.n) return undefined;
      for (const [i, e] of f.events.entries()) {
        if (wallOf(e) > cp.settled) tail.set(eventId(e), e);
        // An event from before it that it didn't fold would apply out of order.
        else if (!mark || i >= mark.n) return undefined;
      }
    }
    const accounted = new Set(cp.accounted);
    for (const e of tail.values()) if ((e.op === "undo" || e.op === "redo") && !accounted.has(eventId(e)) && e.ev.some((id) => !tail.has(id))) return undefined;
    return [...tail.values()];
  }

  /** What a checkpoint must have been folded from to be folded on from now. */
  private async checkpointFrom(dataPath: string, appFm: Record<string, unknown>, caps: Record<string, number>): Promise<string> {
    const base = await this.cached(`${logFolder(dataPath)}/base.json`);
    return fnv1a(`${base.text}\n${listsHash(appLists(appFm))}\n${stableJson(caps)}`).toString(36);
  }

  private async checkpointAt(path: string): Promise<Checkpoint | undefined> {
    const entry = await this.cached(path);
    if (entry.parsed === undefined) {
      try {
        const cp = JSON.parse(entry.text) as Checkpoint;
        entry.parsed = cp?.v === 1 && typeof cp.from === "string" && typeof cp.settled === "number" && isRecord(cp.files) && Array.isArray(cp.undone) && Array.isArray(cp.accounted) && isRecord(cp.folder) ? cp : null;
      } catch {
        entry.parsed = null;
      }
    }
    return (entry.parsed as Checkpoint | null) ?? undefined;
  }

  /**
   * Writes this device's checkpoint, everything up to a week before the newest event, when that moved
   * on a day since its last or none fit. It folds every event, so it reads every log, about once a
   * day; then the settled logs are let go of, and read again only when they change.
   */
  private async checkpoint(dataPath: string, appFm: Record<string, unknown>): Promise<void> {
    const n = this.log(dataPath);
    const newest = this.events(n).reduce((m, e) => Math.max(m, wallOf(e)), 0);
    if (!newest) return;
    const settled = Math.min(newest, this.now()) - SETTLE_MS;
    const from = await this.checkpointFrom(dataPath, appFm, n.caps);
    const path = `${logFolder(dataPath)}/checkpoint-${this.device()}.json`;
    const mine = await this.checkpointAt(path);
    if (mine && mine.from === from && n.checkpoint && settled - mine.settled < DAY) return;
    await this.refresh(dataPath, true);
    const events = this.events(n);
    const upTo = events.filter((e) => wallOf(e) <= settled);
    if (!upTo.length) return;
    // An undo or redo still to settle that names a settled event is folded in with them.
    const accounted = events.filter((e) => (e.op === "undo" || e.op === "redo") && wallOf(e) > settled
      && e.ev.some((id) => (parseStamp(id.slice(id.indexOf("@") + 1))?.wall ?? Infinity) <= settled));
    const folder = fold([...upTo, ...accounted], withApp(await this.base(dataPath), appFm), n.caps).folder;
    const files: Checkpoint["files"] = {};
    for (const [p, f] of n.files) files[nameOf(p)] = { n: f.events.length, bytes: f.bytes, newest: f.newest };
    const cp: Checkpoint = { v: 1, from, settled, files, undone: [...undoneEvents(upTo)], accounted: accounted.map(eventId), folder: folder.save(MAX_GONE) };
    await this.writeKept(path, JSON.stringify(cp), cp);
    n.checkpoint = cp;
    for (const [p, f] of [...n.files]) if (f.newest <= settled && this.io.size?.(p) === f.bytes) {
      n.files.delete(p);
      n.skipped.add(p);
    }
  }

  /** What the data note held before its first snapshot, kept beside its logs. */
  private async base(dataPath: string): Promise<FoldBase> {
    const { text } = await this.cached(`${logFolder(dataPath)}/base.json`);
    try {
      const b = JSON.parse(text) as FoldBase;
      return isRecord(b.lists) && isRecord(b.ticked) ? b : { lists: {}, ticked: {} };
    } catch {
      return { lists: {}, ticked: {} };
    }
  }

  /** Appends events this device makes; returns their ids. */
  async write(dataPath: string, ops: Op[]): Promise<string[]> {
    if (this.until !== undefined) throw new Error(PAST);
    if (!ops.length) return [];
    const n = await this.refresh(dataPath);
    const now = this.now();
    const d = this.device();
    const events = ops.map((op) => ({ ...op, t: this.clock.next(now), d }) as LedgerEvent);
    const path = logFile(dataPath, d, new Date(now));
    // The file appended to is read first, so what's kept of it goes on from all it holds.
    if (n.skipped.delete(path)) await this.read(n, path);
    const text = events.map(eventLine).join("");
    await this.io.append(path, text);
    this.onWrite(path);
    const f = n.files.get(path) ?? { chars: 0, hash: fnv1a(""), bytes: 0, events: [], newest: 0 };
    f.hash = fnv1a(text, f.hash);
    f.chars += text.length;
    f.bytes += bytesOf(text);
    f.events.push(...events);
    for (const e of events) f.newest = Math.max(f.newest, wallOf(e));
    n.files.set(path, f);
    n.dirty.delete(path);
    n.state = undefined;
    n.version++;
    return events.map(eventId);
  }

  /** A new row's id, as this device would give it now. */
  newRowId(): string {
    return newRowId(this.device(), `${this.now()}:${Math.random()}`);
  }

  /**
   * Writes the folded lists back into the data note, with where they were folded to and the ids of
   * their rows. Before the first one, what the note held is kept as the base later folds start from.
   * A note edited by hand is left as it is, unless `force` (after Import, or to discard the edit).
   */
  async snapshot(
    dataPath: string, appFm: Record<string, unknown>, writeNote: (fn: (fm: Record<string, unknown>) => void) => Promise<void>,
    force = false, devices: Record<string, unknown>[] = [],
  ): Promise<void> {
    const fm = this.io.frontmatter(dataPath);
    if (readMark(fm) === undefined) {
      const base = withDevices(this.listsIn(dataPath).lists, devices);
      if (Object.keys(base.lists).length || Object.keys(base.ticked).length) await this.writeKept(`${logFolder(dataPath)}/base.json`, JSON.stringify(base));
    }
    const state = await this.state(dataPath, appFm, devices);
    const n = this.log(dataPath);
    const files: Record<string, number> = {};
    let at = "";
    for (const [path, f] of n.files) {
      files[nameOf(path)] = f.events.length;
      for (const e of f.events) if (!at || compareTimes(e.t, at) > 0) at = e.t;
    }
    for (const path of n.skipped) files[nameOf(path)] = n.checkpoint?.files[nameOf(path)]?.n ?? 0;
    if (!at) return;
    await this.checkpoint(dataPath, appFm);
    if (state.handEdited && !force) return;
    // A list typed in the app note stays there until an event changes it; then the data note keeps it, as an edit always did.
    const kept = new Set([...Object.keys(fm ?? {}), ...devices.flatMap(listNames), ...[...n.files.values()].flatMap((f) => f.events.flatMap((e) => ("l" in e ? [e.l] : [])))]);
    // A recorded list keeps its newest rows in the note.
    const shown = (name: string, rows: Row[]) => (n.caps[name] !== undefined ? rows.slice(-NOTE_ROWS) : rows);
    await writeNote((note) => {
      for (const [name, l] of state.lists) if (kept.has(name)) note[name] = shown(name, l.rows).map((r) => ({ ...r }));
      for (const [name, items] of state.ticked) if (kept.has(name) && !state.lists.has(name)) note[name] = [...items];
      // Discarding a hand edit takes out the lists it added, so the note says what the log does.
      if (force) {
        for (const [k, v] of Object.entries(note)) {
          // Only lists of rows: a list of text (a property like people: [[Ann]]) may be the person's own.
          const rows = Array.isArray(v) && v.length && v.every((x) => isRecord(x));
          if (!META_KEYS.includes(k) && rows && !state.lists.has(k) && !state.ticked.has(k)) delete note[k];
        }
      }
      note[IDS_KEY] = Object.fromEntries([...state.lists].filter(([name]) => kept.has(name)).map(([name, l]) => [name, shown(name, l.rows).map((r) => rowIdOf(r)!)]));
      // Checkpoints keep these now.
      delete note[GONE_KEY];
      delete note[CONFLICTS_KEY];
      note[SNAPSHOT_KEY] = { files, at } satisfies SnapshotMark;
      note[HASH_KEY] = listsHash(note);
    });
  }

  /**
   * What a hand edit changed against the folded lists, as events that would make the log say the
   * same: rows added or removed (an edited row is both), items ticked or unticked.
   */
  async importOps(dataPath: string, given?: Record<string, unknown>): Promise<Op[]> {
    const fm = this.io.frontmatter(dataPath);
    const n = await this.refresh(dataPath, true);
    const appFm = given ?? n.appFm ?? {};
    const mark = readMark(fm);
    const folded = fold(this.events(n), withApp(mark ? await this.base(dataPath) : { lists: {}, ticked: {} }, appFm), n.caps);
    const note = listsOf(fm);
    // The rows the note was written with, by their ids: a recorded list's older rows were never in it.
    const written = isRecord(fm?.[IDS_KEY]) ? fm[IDS_KEY] : {};
    const wrote = (name: string) => {
      const l = folded.lists.get(name) ?? { rows: [], ids: [] };
      const ids = written[name];
      if (!Array.isArray(ids)) return l;
      const keep = new Set(ids.map(String));
      const at = l.ids.flatMap((id, i) => (keep.has(id) ? [i] : []));
      return { rows: at.map((i) => l.rows[i]), ids: at.map((i) => l.ids[i]) };
    };
    const ops: Op[] = [];
    for (const [name, { rows }] of Object.entries(note.lists)) {
      const had = wrote(name);
      const left = had.rows.map((r) => stableJson(r));
      for (const r of rows) {
        const i = left.indexOf(stableJson(r));
        if (i >= 0) left[i] = "\u0000";
        else ops.push({ op: "add", l: name, row: this.newRowId(), v: r });
      }
      left.forEach((k, i) => { if (k !== "\u0000") ops.push({ op: "del", l: name, row: had.ids[i] }); });
    }
    for (const name of folded.lists.keys()) if (!note.lists[name] && Object.hasOwn(fm ?? {}, name)) for (const id of wrote(name).ids) ops.push({ op: "del", l: name, row: id });
    // A checklist emptied by hand is an empty list, which is neither kind: everything ticked is unticked.
    for (const [name, had] of folded.ticked) {
      const v = fm?.[name];
      if (!note.ticked[name] && Array.isArray(v) && v.length === 0) for (const i of had) ops.push({ op: "untick", l: name, item: i });
    }
    for (const [name, items] of Object.entries(note.ticked)) {
      const had = folded.ticked.get(name) ?? [];
      for (const i of items) if (!had.includes(i)) ops.push({ op: "tick", l: name, item: i });
      for (const i of had) if (!items.includes(i)) ops.push({ op: "untick", l: name, item: i });
    }
    return ops;
  }
}

function readMark(fm: Record<string, unknown> | undefined): SnapshotMark | undefined {
  const m = fm?.[SNAPSHOT_KEY];
  if (!isRecord(m) || !isRecord(m.files) || typeof m.at !== "string") return undefined;
  return { files: Object.fromEntries(Object.entries(m.files).map(([k, v]) => [k, Number(v) || 0])), at: m.at };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function compareTimes(a: string, b: string): number {
  const pa = parseStamp(a)!;
  const pb = parseStamp(b)!;
  return pa.wall - pb.wall || pa.counter - pb.counter;
}

/**
 * A data note's lists with the rows each device kept in a note of its own under `devices: split`,
 * in the order they were saved; the first snapshot keeps them all in the base.
 */
function withDevices(base: FoldBase, devices: Record<string, unknown>[]): FoldBase {
  if (!devices.length) return base;
  const lists: FoldBase["lists"] = {};
  const names = new Set([...Object.keys(base.lists), ...devices.flatMap((d) => Object.keys(listsOf(d).lists))]);
  for (const name of names) {
    const rows = [...(base.lists[name]?.rows ?? []), ...devices.flatMap((d) => listsOf(d).lists[name]?.rows ?? [])];
    const savedAt = (r: Row) => toTime(r.at) ?? 0;
    const sorted = rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => savedAt(a) - savedAt(b) || i - j).map(([r]) => r);
    lists[name] = { rows: sorted, ids: baseIds(sorted) };
  }
  return { lists, ticked: base.ticked };
}

/** What an app note holds that isn't the app: lists typed there. */
function appLists(appFm: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(appFm).filter(([k, v]) => !DEFINITION_KEYS.includes(k) && !(k === "expect" && areRules(v))));
}

/** A base with the app note's own lists for those it lacks: lists typed there, not the keys that define the app. */
function withApp(base: FoldBase, appFm: Record<string, unknown>): FoldBase {
  const app = listsOf(appLists(appFm));
  const lists = { ...app.lists, ...base.lists };
  const ticked = { ...app.ticked, ...base.ticked };
  return { lists, ticked };
}
