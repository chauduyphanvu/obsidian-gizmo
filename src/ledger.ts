import type { Row } from "./data.ts";

/**
 * An app's data as a log of what happened to it, one log per device per month, instead of lists
 * rewritten in a note. Each device appends only to its own files, so a sync never has to merge a
 * file; reading folds every device's events into the lists the app shows.
 *
 * A line: `{"t":"2026-11-19T08:14:03.112Z/3","d":"d1mac000","op":"add","l":"spend","row":"…","v":{…}}`.
 */
export type Op =
  /** A row added to list `l`, with id `row` and value `v`. */
  | { op: "add"; l: string; row: string; v: Row }
  /** Field `f` of a row set to `v`; `from` is what the writer saw there, for telling conflicts. */
  | { op: "set"; l: string; row: string; f: string; v: unknown; from: unknown }
  /** A row taken out. */
  | { op: "del"; l: string; row: string }
  /** A checklist's item ticked or unticked. */
  | { op: "tick" | "untick"; l: string; item: string }
  /** A checklist cleared of the items ticked before this event. */
  | { op: "clear"; l: string }
  /** Events undone, or done again, by their ids. */
  | { op: "undo" | "redo"; ev: string[] };

export type LedgerEvent = Op & {
  /** Hybrid logical time: wall clock in ISO form, then a counter, `…Z/3`. */
  t: string;
  /** The device that wrote it. */
  d: string;
};

/** An event's id: its device and time, unique since each device's clock only moves forward. */
export function eventId(e: Pick<LedgerEvent, "d" | "t">): string {
  return `${e.d}@${e.t}`;
}

/** A hybrid logical clock: wall time, but never behind anything this device has written or read. */
export class Clock {
  private wall = 0;
  private counter = 0;

  /** The next time to write at. */
  next(now: number): string {
    if (now > this.wall) {
      this.wall = now;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return stampOf(this.wall, this.counter);
  }

  /** Hears of an event read from any device, so the next one written sorts after it. */
  seen(t: string): void {
    const p = parseStamp(t);
    if (!p) return;
    if (p.wall > this.wall || (p.wall === this.wall && p.counter > this.counter)) {
      this.wall = p.wall;
      this.counter = p.counter;
    }
  }
}

function stampOf(wall: number, counter: number): string {
  return `${new Date(wall).toISOString()}/${counter}`;
}

export function parseStamp(t: string): { wall: number; counter: number } | undefined {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\/(\d+)$/.exec(t);
  if (!m) return undefined;
  const wall = Date.parse(m[1]);
  return Number.isNaN(wall) ? undefined : { wall, counter: Number(m[2]) };
}

/** The order events apply in: time, then counter, then device. */
export function compareEvents(a: LedgerEvent, b: LedgerEvent): number {
  const pa = parseStamp(a.t)!;
  const pb = parseStamp(b.t)!;
  return pa.wall - pb.wall || pa.counter - pb.counter || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
}

/** The log files of one data note: beside it, in `<note>/log/`, one per device and month. */
export function logFolder(dataPath: string): string {
  return `${dataPath.replace(/\.md$/i, "")}/log`;
}

export function logFile(dataPath: string, device: string, at: Date): string {
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${logFolder(dataPath)}/${device}-${month}.jsonl`;
}

/** Which device and month a log file is: `<device>-<YYYY-MM>.jsonl`, a sync's copy (`… 2.jsonl`) too. */
export function logFileParts(path: string): { device: string; month: string } | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = /^(.+)-(\d{4}-\d\d)(?: \d+)?\.jsonl$/.exec(name);
  return m ? { device: m[1], month: m[2] } : undefined;
}

export function eventLine(e: LedgerEvent): string {
  return `${JSON.stringify(e)}\n`;
}

/**
 * The events in a log file's text. A line that isn't a whole event (a write cut short, a hand
 * edit) is skipped and counted, never guessed at.
 */
export function parseLog(text: string): { events: LedgerEvent[]; bad: number } {
  const events: LedgerEvent[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEvent;
      if (isEvent(e)) events.push(e);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

function isEvent(e: unknown): e is LedgerEvent {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  if (typeof x.t !== "string" || !parseStamp(x.t) || typeof x.d !== "string") return false;
  switch (x.op) {
    case "add": return typeof x.l === "string" && typeof x.row === "string" && !!x.v && typeof x.v === "object" && !Array.isArray(x.v);
    case "set": return typeof x.l === "string" && typeof x.row === "string" && typeof x.f === "string";
    case "del": return typeof x.l === "string" && typeof x.row === "string";
    case "tick": case "untick": return typeof x.l === "string" && typeof x.item === "string";
    case "clear": return typeof x.l === "string";
    case "undo": case "redo": return Array.isArray(x.ev) && x.ev.every((v) => typeof v === "string");
    default: return false;
  }
}

/** A row id: 16 hex characters, two FNV-1a hashes of the seed made in one pass. */
export function rowId(seed: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** A new row's id, from who wrote it and when: unique across devices. */
export function newRowId(device: string, t: string): string {
  return rowId(`${device}\n${t}`);
}

/**
 * Ids for rows that came from a note rather than the log (a hand-kept data note, a list typed in
 * the app note): from what they hold and which copy of it they are, so the same rows always get
 * the same ids, on every device, and an insert above a row doesn't change its id.
 */
export function baseIds(list: readonly unknown[]): string[] {
  const seen = new Map<string, number>();
  return list.map((r) => {
    // A row's keys come in the order its note's text has them, the same on every device.
    const content = JSON.stringify(r);
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    return rowId(`base\n${content}\n${n}`);
  });
}

/** A cell two devices set from the same value: the one that lost, kept to show beside the winner. */
export interface Conflict {
  row: string;
  field: string;
  value: unknown;
  by: string;
  t: string;
}

/** One list as folded: its rows in the order they were added, with their ids. */
export interface FoldedList {
  rows: Row[];
  ids: string[];
  conflicts: Conflict[];
}

/** Every list of a data note, as folded, and which events were undone. */
export interface Folded {
  lists: Map<string, FoldedList>;
  /** Checklists: the items ticked, in the order they were ticked. */
  ticked: Map<string, string[]>;
  undone: Set<string>;
  /** Events applied, by id: what a row id or an undo needs to find. */
  applied: Set<string>;
}

/** Where folding starts: lists as a note held them (a snapshot, or a hand-kept note), with their ids. */
export interface FoldBase {
  lists: Record<string, { rows: Row[]; ids: string[]; conflicts?: Conflict[]; gone?: string[] }>;
  ticked: Record<string, string[]>;
}

/** The last set of a cell, for telling a later set that didn't see it. */
type Cell = { value: unknown; from: unknown; t: string; d: string };

/** A Folder as a checkpoint keeps it: everything a fold needs to go on from where it stopped. */
export interface FolderState {
  lists: Record<string, { order: string[]; rows: Row[]; cells: [string, Cell][]; conflicts: Conflict[] }>;
  ticked: Record<string, string[]>;
  /** `<list>\n<row id>`, as the folder keeps them. */
  gone: string[];
  last?: { t: string; d: string };
}

/**
 * Lists being folded: a base, then events applied one at a time in the order they apply. Kept
 * between reads, so the events a save or a sync adds are applied on top rather than folding
 * everything again; it says which rows each application changed.
 */
export class Folder {
  private lists = new Map<string, { order: string[]; rows: Map<string, Row>; cells: Map<string, Cell>; conflicts: Conflict[] }>();
  readonly ticked: Map<string, string[]>;
  readonly applied = new Set<string>();
  /** The last event applied: one that comes after it can be applied on top. */
  last: LedgerEvent | undefined;
  /** Rows deleted, or added by an event that was undone: another add of the same id doesn't bring them back. */
  private gone = new Set<string>();
  /** Rows changed since last taken. */
  private touched = new Set<string>();
  private caps: Record<string, number>;

  constructor(base: FoldBase, caps: Record<string, number>) {
    this.caps = caps;
    for (const [name, { rows, ids, conflicts, gone }] of Object.entries(base.lists)) {
      const l = this.listOf(name);
      l.conflicts.push(...(conflicts ?? []));
      for (const id of gone ?? []) this.gone.add(`${name}\n${id}`);
      // A base row is copied only when an event changes it.
      rows.forEach((r, i) => {
        if (l.rows.has(ids[i])) return;
        l.order.push(ids[i]);
        l.rows.set(ids[i], r);
      });
    }
    this.ticked = new Map(Object.entries(base.ticked).map(([k, v]) => [k, [...v]]));
  }

  private listOf(name: string) {
    let l = this.lists.get(name);
    if (!l) {
      l = { order: [], rows: new Map(), cells: new Map(), conflicts: [] };
      this.lists.set(name, l);
    }
    return l;
  }

  /** Whether an event comes after everything applied, so applying it on top gives what folding everything would. */
  follows(e: LedgerEvent): boolean {
    return !this.last || compareEvents(e, this.last) > 0;
  }

  /**
   * An undone add: its row stays out even when another runner added the same row under the same id,
   * so undoing either takes the row away.
   */
  hide(e: LedgerEvent): void {
    if (e.op === "add") this.gone.add(`${e.l}\n${e.row}`);
  }

  /** Makes the list an event names, even when the event itself doesn't apply (it was undone). */
  names(e: LedgerEvent): void {
    if (e.op === "add" || e.op === "set" || e.op === "del") this.listOf(e.l);
    else if ((e.op === "tick" || e.op === "untick" || e.op === "clear") && !this.ticked.has(e.l)) this.ticked.set(e.l, []);
  }

  apply(e: LedgerEvent): void {
    this.names(e);
    if (!this.last || compareEvents(e, this.last) > 0) this.last = e;
    if (e.op === "undo" || e.op === "redo") return;
    this.applied.add(eventId(e));
    switch (e.op) {
      case "add": {
        const l = this.listOf(e.l);
        if (l.rows.has(e.row) || this.gone.has(`${e.l}\n${e.row}`)) break;
        l.order.push(e.row);
        l.rows.set(e.row, e.v);
        this.touched.add(e.row);
        break;
      }
      case "set": {
        const l = this.listOf(e.l);
        const was = l.rows.get(e.row);
        if (!was) break;
        const row = { ...was };
        l.rows.set(e.row, row);
        this.touched.add(e.row);
        const key = `${e.row}\n${e.f}`;
        const last = l.cells.get(key);
        // Two sets from the same value that didn't see each other: the later wins, the other is kept.
        if (last && last.d !== e.d && JSON.stringify(last.from) === JSON.stringify(e.from)) {
          l.conflicts.push({ row: e.row, field: e.f, value: last.value, by: last.d, t: last.t });
        } else if (JSON.stringify(row[e.f]) === JSON.stringify(e.from)) {
          // A set that saw the value before it settles the cell.
          l.conflicts = l.conflicts.filter((c) => !(c.row === e.row && c.field === e.f));
        }
        row[e.f] = e.v;
        l.cells.set(key, { value: e.v, from: e.from, t: e.t, d: e.d });
        break;
      }
      case "del": {
        const l = this.listOf(e.l);
        this.gone.add(`${e.l}\n${e.row}`);
        if (!l.rows.delete(e.row)) break;
        l.order = l.order.filter((r) => r !== e.row);
        l.conflicts = l.conflicts.filter((c) => c.row !== e.row);
        this.touched.add(e.row);
        break;
      }
      case "tick": {
        const items = this.ticked.get(e.l) ?? [];
        if (!items.includes(e.item)) this.ticked.set(e.l, [...items, e.item]);
        break;
      }
      case "untick": {
        this.ticked.set(e.l, (this.ticked.get(e.l) ?? []).filter((i) => i !== e.item));
        break;
      }
      case "clear": {
        this.ticked.set(e.l, []);
        break;
      }
    }
  }

  /**
   * What the folder holds, to go on from later. A list with a cap keeps only its newest rows (one
   * that dropped out comes back only if newer ones are deleted, which samples aren't), and each list
   * its newest `maxGone` rows that stay out.
   */
  save(maxGone: number): FolderState {
    const lists: FolderState["lists"] = {};
    for (const [name, l] of this.lists) {
      const cap = this.caps[name];
      const order = cap !== undefined && l.order.length > cap ? l.order.slice(l.order.length - cap) : l.order;
      const kept = new Set(order);
      lists[name] = {
        order: [...order],
        rows: order.map((id) => l.rows.get(id)!),
        cells: [...l.cells].filter(([key]) => kept.has(key.slice(0, key.indexOf("\n")))),
        conflicts: l.conflicts.filter((c) => kept.has(c.row)),
      };
    }
    const gone = [...this.lists.keys()].flatMap((name) => this.goneIn(name).slice(-maxGone).map((id) => `${name}\n${id}`));
    return { lists, ticked: Object.fromEntries(this.ticked), gone, ...(this.last && { last: { t: this.last.t, d: this.last.d } }) };
  }

  /** A folder going on from a saved state; what it holds is its own, never the state's. */
  static load(state: FolderState, caps: Record<string, number>): Folder {
    const f = new Folder({ lists: {}, ticked: {} }, caps);
    for (const [name, l] of Object.entries(state.lists)) {
      const into = f.listOf(name);
      into.order = [...l.order];
      l.order.forEach((id, i) => into.rows.set(id, l.rows[i]));
      into.cells = new Map(l.cells);
      into.conflicts = [...l.conflicts];
    }
    for (const [name, items] of Object.entries(state.ticked)) f.ticked.set(name, [...items]);
    for (const key of state.gone) f.gone.add(key);
    if (state.last) f.last = state.last as LedgerEvent;
    return f;
  }

  /** Each list's rows that stay out whatever add comes later, for a snapshot to keep. */
  goneIn(list: string): string[] {
    const prefix = `${list}\n`;
    return [...this.gone].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /** The rows applications changed since last asked. */
  takeTouched(): Set<string> {
    const t = this.touched;
    this.touched = new Set();
    return t;
  }

  lists_(): Map<string, FoldedList> {
    const out = new Map<string, FoldedList>();
    for (const [name, l] of this.lists) {
      let ids = l.order;
      const cap = this.caps[name];
      if (cap !== undefined && ids.length > cap) ids = ids.slice(ids.length - cap);
      const keep = cap !== undefined ? new Set(ids) : undefined;
      out.set(name, { rows: ids.map((id) => l.rows.get(id)!), ids: [...ids], conflicts: keep ? l.conflicts.filter((c) => keep.has(c.row)) : [...l.conflicts] });
    }
    return out;
  }
}

/**
 * Folds events onto a base into the lists they make. The order files were read in doesn't matter:
 * events apply by time, then counter, then device. A second copy of an event (a sync's
 * "… 2.jsonl") is dropped, an add for a row that exists is ignored, and undone events don't apply.
 * `caps` keeps only the newest rows of lists that grow on their own (recorded samples).
 */
export function fold(events: readonly LedgerEvent[], base: FoldBase = { lists: {}, ticked: {} }, caps: Record<string, number> = {}): Folded & { folder: Folder } {
  return foldOnto(new Folder(base, caps), events);
}

/**
 * Folds events onto a folder that holds every event before them (a checkpoint's): what an undo or
 * redo among them names must be among them too.
 */
export function foldOnto(folder: Folder, events: readonly LedgerEvent[]): Folded & { folder: Folder } {
  const unique = new Map<string, LedgerEvent>();
  for (const e of events) if (!unique.has(eventId(e))) unique.set(eventId(e), e);
  const ordered = [...unique.values()].sort(compareEvents);
  const undone = undoneEvents(ordered);
  for (const e of ordered) if (undone.has(eventId(e))) folder.hide(e);
  // A list whose every event was undone is still there, empty: its note's copy must say so.
  for (const e of ordered) {
    if (undone.has(eventId(e))) folder.names(e);
    else folder.apply(e);
  }
  folder.takeTouched();
  return { lists: folder.lists_(), ticked: folder.ticked, undone, applied: folder.applied, folder };
}

/** Which events are undone: the last undo or redo of each, in order, decides; `from`, those undone before them. */
export function undoneEvents(events: readonly LedgerEvent[], from: Iterable<string> = []): Set<string> {
  const undone = new Set<string>(from);
  for (const e of [...events].filter((x) => x.op === "undo" || x.op === "redo").sort(compareEvents)) {
    for (const id of (e as { ev: string[] }).ev) {
      if (e.op === "undo") undone.add(id);
      else undone.delete(id);
    }
  }
  return undone;
}

/** The events up to and including time `at` (ms): the data as it was then. */
export function eventsAt(events: readonly LedgerEvent[], at: number): LedgerEvent[] {
  return events.filter((e) => parseStamp(e.t)!.wall <= at);
}
