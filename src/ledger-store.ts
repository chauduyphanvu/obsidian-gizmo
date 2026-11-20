import { fnv1a, stableJson } from "./hash.ts";
import { DEFINITION_KEYS } from "./store.ts";
import { ROW_INDEX } from "./sources/list.ts";
import type { Row } from "./data.ts";
import {
  Clock, Folder, baseIds, compareEvents, eventId, eventLine, fold, logFile, logFileParts, logFolder, newRowId, parseLog, parseStamp, undoneEvents,
  type Conflict, type FoldBase, type LedgerEvent, type Op,
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
}

/** Keys the snapshot adds to a data note beside its lists. */
export const SNAPSHOT_KEY = "gizmo-snapshot";
export const IDS_KEY = "gizmo-ids";
const HASH_KEY = "gizmo-hash";
/** Cells two devices set at once, kept with the snapshot so a fold that starts there still offers both. */
const CONFLICTS_KEY = "gizmo-conflicts";
/** Rows deleted (or added by an undone add), kept with the snapshot so a late copy of their add stays out after it. */
const GONE_KEY = "gizmo-gone";
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

interface LogFile {
  text: string;
  events: LedgerEvent[];
}

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
  /** Files changed since read. */
  dirty: Set<string>;
  /** The lists folded so far, kept so new events are applied on top. */
  folder?: Folder;
  /** Every event the folder has seen, applied or not. */
  seen: Set<string>;
  /** Something changed that applying on top can't follow (a file cut short or gone, new caps): fold again. */
  reset: boolean;
  /** The data note and app note as they were when the folder was made: a new snapshot or a hand edit folds again. */
  foldedFrom?: string;
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

  constructor(io: LedgerIO, device: () => string, now: () => number) {
    this.io = io;
    this.device = device;
    this.now = now;
  }

  private log(dataPath: string): NoteLog {
    let n = this.notes.get(dataPath);
    if (!n) {
      n = { files: new Map(), dirty: new Set(), seen: new Set(), reset: true, version: 0, caps: {}, out: new Map() };
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

  /** Reads the log files that changed since last time; a file that grew is read past what was seen, any other change in full. */
  private async refresh(dataPath: string): Promise<NoteLog> {
    const n = this.log(dataPath);
    const present = this.io.filesIn(logFolder(dataPath)).filter((p) => logFileParts(p));
    for (const p of [...n.files.keys()]) if (!present.includes(p)) {
      n.files.delete(p);
      n.reset = true;
      n.state = undefined;
    }
    for (const p of present) {
      if (n.files.has(p) && !n.dirty.has(p)) continue;
      const text = await this.io.readFile(p).catch(() => "");
      const had = n.files.get(p);
      if (had && text.startsWith(had.text)) {
        // Only complete lines: a line still being written is read when it ends.
        const end = text.lastIndexOf("\n") + 1;
        if (end > had.text.length) had.events.push(...parseLog(text.slice(had.text.length, end)).events);
        had.text = text.slice(0, Math.max(end, had.text.length));
      } else {
        const end = text.lastIndexOf("\n") + 1;
        n.files.set(p, { text: text.slice(0, end), events: parseLog(text.slice(0, end)).events });
        // A file read for the first time only adds events; one that changed otherwise needs a new fold.
        if (had) n.reset = true;
      }
      n.dirty.delete(p);
      n.state = undefined;
    }
    return n;
  }

  /** Keeps only the newest `cap` rows of these lists of a data note (what an app records on its own). */
  setCaps(dataPath: string, caps: Record<string, number>): void {
    const n = this.log(dataPath);
    if (JSON.stringify(n.caps) === JSON.stringify(caps)) return;
    n.caps = caps;
    n.reset = true;
    n.state = undefined;
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

  /**
   * `appFm` and `devices` are the app note and old device notes; a reader that leaves them out (the
   * activity list, a store that doesn't know the device notes) gets the last ones given, so readers
   * don't fold the note again for each other.
   */
  async state(dataPath: string, given?: Record<string, unknown>, givenDevices?: Record<string, unknown>[]): Promise<LedgerState> {
    const n = await this.refresh(dataPath);
    if (given) n.appFm = given;
    if (givenDevices) n.devices = givenDevices;
    const appFm = n.appFm ?? {};
    const devices = n.devices ?? [];
    const note = this.listsIn(dataPath);
    const fm = note.fm;
    const snapshot = readMark(fm);
    const handEdited = snapshot !== undefined && note.hash !== fm?.[HASH_KEY];
    const caps = n.caps;
    // The note's version stands for its lists: a note not snapshotted yet needn't be hashed at all.
    const from = `${note.id}\n${JSON.stringify(snapshot ?? null)}\n${listsHash(appFm)}\n${devices.map(listsHash).join(",")}`;
    if (n.foldedFrom !== from) n.reset = true;
    if (!n.reset && n.state) return n.state;
    const all = [...n.files.values()].flatMap((f) => f.events);
    if (!n.reset && n.folder) {
      // Events a save or a sync added since: applied on top when they come after all the rest and undo nothing.
      const fresh = [...new Map(all.filter((e) => !n.seen.has(eventId(e))).map((e) => [eventId(e), e])).values()].sort(compareEvents);
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
      for (const e of all) this.clock.seen(e.t);
      const fromSnapshot = snapshot && !handEdited ? this.tail(n, snapshot, fm!) : undefined;
      n.folder = (fromSnapshot
        ? fold(fromSnapshot.events, withApp(fromSnapshot.base, appFm), caps)
        : fold(all, withApp(snapshot ? await this.base(dataPath) : withDevices(note.lists, devices), appFm), caps)).folder;
      n.seen = new Set(all.map(eventId));
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
    // From every event, not only those the fold started past: an undo kept in a snapshot still counts.
    n.state = { lists, ticked: new Map(n.folder.ticked), undone: undoneEvents([...n.files.values()].flatMap((f) => f.events)), handEdited };
    return n.state;
  }

  /** The events after a snapshot, when folding only them onto it gives what folding everything would. */
  private tail(n: NoteLog, mark: SnapshotMark, fm: Record<string, unknown>): { base: FoldBase; events: LedgerEvent[] } | undefined {
    const at = parseStamp(mark.at)?.wall ?? 0;
    const events: LedgerEvent[] = [];
    for (const [path, f] of n.files) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      events.push(...f.events.slice(mark.files[name] ?? 0));
    }
    // A file the snapshot read more of than is there now (cut short, or gone) can't be trusted to start from.
    for (const [name, count] of Object.entries(mark.files)) {
      const f = [...n.files].find(([p]) => p.endsWith(`/${name}`))?.[1];
      if ((f?.events.length ?? 0) < count) return undefined;
    }
    // An event from before the snapshot that arrived after it would apply out of order.
    if (events.some((e) => (parseStamp(e.t)?.wall ?? 0) < at)) return undefined;
    const ids = new Set(events.map(eventId));
    if (events.some((e) => (e.op === "undo" || e.op === "redo") && e.ev.some((id) => !ids.has(id)))) return undefined;
    const kept = isRecord(fm[IDS_KEY]) ? fm[IDS_KEY] : {};
    const conflicts = isRecord(fm[CONFLICTS_KEY]) ? fm[CONFLICTS_KEY] : {};
    const gone = isRecord(fm[GONE_KEY]) ? fm[GONE_KEY] : {};
    const base = listsOf(fm, kept);
    for (const [name, l] of Object.entries(base.lists)) {
      const ids = kept[name];
      if (!Array.isArray(ids) || ids.length !== l.rows.length) return undefined;
      if (Array.isArray(conflicts[name])) l.conflicts = conflicts[name] as Conflict[];
    }
    // A list emptied by deletes isn't among the note's lists, but what it deleted still stays out.
    for (const [name, ids] of Object.entries(gone)) {
      if (!Array.isArray(ids)) continue;
      base.lists[name] ??= { rows: [], ids: [] };
      base.lists[name].gone = ids.map(String);
    }
    return { base, events };
  }

  /** What the data note held before its first snapshot, kept beside its logs. */
  private async base(dataPath: string): Promise<FoldBase> {
    const text = await this.io.readFile(`${logFolder(dataPath)}/base.json`).catch(() => "");
    try {
      const b = JSON.parse(text) as FoldBase;
      return isRecord(b.lists) && isRecord(b.ticked) ? b : { lists: {}, ticked: {} };
    } catch {
      return { lists: {}, ticked: {} };
    }
  }

  /** Appends events this device makes; returns their ids. */
  async write(dataPath: string, ops: Op[]): Promise<string[]> {
    if (!ops.length) return [];
    const n = await this.refresh(dataPath);
    const now = this.now();
    const d = this.device();
    const events = ops.map((op) => ({ ...op, t: this.clock.next(now), d }) as LedgerEvent);
    const path = logFile(dataPath, d, new Date(now));
    const text = events.map(eventLine).join("");
    await this.io.append(path, text);
    this.onWrite(path);
    const f = n.files.get(path) ?? { text: "", events: [] };
    f.text += text;
    f.events.push(...events);
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
    const n = await this.refresh(dataPath);
    const fm = this.io.frontmatter(dataPath);
    if (readMark(fm) === undefined) {
      const base = withDevices(this.listsIn(dataPath).lists, devices);
      if (Object.keys(base.lists).length || Object.keys(base.ticked).length) await this.io.writeFile(`${logFolder(dataPath)}/base.json`, JSON.stringify(base));
    }
    const state = await this.state(dataPath, appFm, devices);
    if (state.handEdited && !force) return;
    const files: Record<string, number> = {};
    let at = "";
    for (const [path, f] of n.files) {
      files[path.slice(path.lastIndexOf("/") + 1)] = f.events.length;
      for (const e of f.events) if (!at || compareTimes(e.t, at) > 0) at = e.t;
    }
    if (!at) return;
    // A list typed in the app note stays there until an event changes it; then the data note keeps it, as an edit always did.
    const kept = new Set([...Object.keys(fm ?? {}), ...devices.flatMap(listNames), ...[...n.files.values()].flatMap((f) => f.events.flatMap((e) => ("l" in e ? [e.l] : [])))]);
    await writeNote((note) => {
      for (const [name, l] of state.lists) if (kept.has(name)) note[name] = l.rows.map((r) => ({ ...r }));
      for (const [name, items] of state.ticked) if (kept.has(name) && !state.lists.has(name)) note[name] = [...items];
      // Discarding a hand edit takes out the lists it added, so the note says what the log does.
      if (force) {
        for (const [k, v] of Object.entries(note)) {
          // Only lists of rows: a list of text (a property like people: [[Ann]]) may be the person's own.
          const rows = Array.isArray(v) && v.length && v.every((x) => isRecord(x));
          if (!META_KEYS.includes(k) && rows && !state.lists.has(k) && !state.ticked.has(k)) delete note[k];
        }
      }
      note[IDS_KEY] = Object.fromEntries([...state.lists].filter(([name]) => kept.has(name)).map(([name, l]) => [name, l.rows.map((r) => rowIdOf(r)!)]));
      const gone = Object.fromEntries([...state.lists.keys()].filter((name) => kept.has(name)).map((name) => [name, n.folder!.goneIn(name)]).filter(([, ids]) => ids.length));
      if (Object.keys(gone).length) note[GONE_KEY] = gone;
      else delete note[GONE_KEY];
      const open = [...state.lists].filter(([name, l]) => kept.has(name) && l.conflicts.length);
      if (open.length) note[CONFLICTS_KEY] = Object.fromEntries(open.map(([name, l]) => [name, l.conflicts]));
      else delete note[CONFLICTS_KEY];
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
    const n = await this.refresh(dataPath);
    const appFm = given ?? n.appFm ?? {};
    const mark = readMark(fm);
    const all = [...n.files.values()].flatMap((f) => f.events);
    const folded = fold(all, withApp(mark ? await this.base(dataPath) : { lists: {}, ticked: {} }, appFm), n.caps);
    const note = listsOf(fm);
    const ops: Op[] = [];
    for (const [name, { rows }] of Object.entries(note.lists)) {
      const had = folded.lists.get(name) ?? { rows: [], ids: [] };
      const left = had.rows.map((r) => stableJson(r));
      for (const r of rows) {
        const i = left.indexOf(stableJson(r));
        if (i >= 0) left[i] = "\u0000";
        else ops.push({ op: "add", l: name, row: this.newRowId(), v: r });
      }
      left.forEach((k, i) => { if (k !== "\u0000") ops.push({ op: "del", l: name, row: had.ids[i] }); });
    }
    for (const [name, l] of folded.lists) if (!note.lists[name] && Object.hasOwn(fm ?? {}, name)) for (const id of l.ids) ops.push({ op: "del", l: name, row: id });
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
    const savedAt = (r: Row) => (typeof r.at === "string" ? r.at : "");
    const sorted = rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => savedAt(a).localeCompare(savedAt(b)) || i - j).map(([r]) => r);
    lists[name] = { rows: sorted, ids: baseIds(sorted) };
  }
  return { lists, ticked: base.ticked };
}

/** A base with the app note's own lists for those it lacks: lists typed there, not the keys that define the app. */
function withApp(base: FoldBase, appFm: Record<string, unknown>): FoldBase {
  const app = listsOf(Object.fromEntries(Object.entries(appFm).filter(([k]) => !DEFINITION_KEYS.includes(k))));
  const lists = { ...app.lists, ...base.lists };
  const ticked = { ...app.ticked, ...base.ticked };
  return { lists, ticked };
}
