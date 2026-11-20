import { fnv1a, stableJson } from "./hash.ts";
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

/** A row id: 16 hex characters. */
export function rowId(seed: string): string {
  return fnv1a(seed).toString(16).padStart(8, "0") + fnv1a(seed, 0x01000193).toString(16).padStart(8, "0");
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
    const content = stableJson(r);
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
  lists: Record<string, { rows: Row[]; ids: string[]; conflicts?: Conflict[] }>;
  ticked: Record<string, string[]>;
}

/**
 * Folds events onto a base into the lists they make. The order files were read in doesn't matter:
 * events apply by time, then counter, then device. A second copy of an event (a sync's
 * "… 2.jsonl") is dropped, an add for a row that exists is ignored, and undone events don't apply.
 * `caps` keeps only the newest rows of lists that grow on their own (recorded samples).
 */
export function fold(events: readonly LedgerEvent[], base: FoldBase = { lists: {}, ticked: {} }, caps: Record<string, number> = {}): Folded {
  const unique = new Map<string, LedgerEvent>();
  for (const e of events) if (!unique.has(eventId(e))) unique.set(eventId(e), e);
  const ordered = [...unique.values()].sort(compareEvents);

  // What's undone is settled first: the last undo or redo of an event, in order, decides.
  const undone = new Set<string>();
  for (const e of ordered) {
    if (e.op !== "undo" && e.op !== "redo") continue;
    for (const id of e.ev) {
      if (e.op === "undo") undone.add(id);
      else undone.delete(id);
    }
  }

  type Cell = { value: unknown; from: unknown; t: string; d: string };
  const lists = new Map<string, { order: string[]; rows: Map<string, Row>; cells: Map<string, Cell>; conflicts: Conflict[] }>();
  const listOf = (name: string) => {
    let l = lists.get(name);
    if (!l) {
      l = { order: [], rows: new Map(), cells: new Map(), conflicts: [] };
      lists.set(name, l);
    }
    return l;
  };
  for (const [name, { rows, ids, conflicts }] of Object.entries(base.lists)) {
    const l = listOf(name);
    l.conflicts.push(...(conflicts ?? []));
    rows.forEach((r, i) => {
      if (l.rows.has(ids[i])) return;
      l.order.push(ids[i]);
      l.rows.set(ids[i], { ...r });
    });
  }
  const ticked = new Map<string, string[]>(Object.entries(base.ticked).map(([k, v]) => [k, [...v]]));
  const applied = new Set<string>();
  // A list whose every event was undone is still there, empty: its note's copy must say so.
  for (const e of ordered) {
    if (e.op === "add" || e.op === "set" || e.op === "del") listOf(e.l);
    else if ((e.op === "tick" || e.op === "untick" || e.op === "clear") && !ticked.has(e.l)) ticked.set(e.l, []);
  }

  for (const e of ordered) {
    const id = eventId(e);
    if (e.op === "undo" || e.op === "redo" || undone.has(id)) continue;
    applied.add(id);
    switch (e.op) {
      case "add": {
        const l = listOf(e.l);
        if (l.rows.has(e.row)) break;
        l.order.push(e.row);
        l.rows.set(e.row, { ...e.v });
        break;
      }
      case "set": {
        const l = listOf(e.l);
        const row = l.rows.get(e.row);
        if (!row) break;
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
        const l = listOf(e.l);
        if (!l.rows.delete(e.row)) break;
        l.order = l.order.filter((r) => r !== e.row);
        l.conflicts = l.conflicts.filter((c) => c.row !== e.row);
        break;
      }
      case "tick": {
        const items = ticked.get(e.l) ?? [];
        if (!items.includes(e.item)) ticked.set(e.l, [...items, e.item]);
        break;
      }
      case "untick": {
        ticked.set(e.l, (ticked.get(e.l) ?? []).filter((i) => i !== e.item));
        break;
      }
      case "clear": {
        ticked.set(e.l, []);
        break;
      }
    }
  }

  const out = new Map<string, FoldedList>();
  for (const [name, l] of lists) {
    let ids = l.order;
    const cap = caps[name];
    if (cap !== undefined && ids.length > cap) ids = ids.slice(ids.length - cap);
    const keep = new Set(ids);
    out.set(name, { rows: ids.map((id) => l.rows.get(id)!), ids: [...ids], conflicts: l.conflicts.filter((c) => keep.has(c.row)) });
  }
  return { lists: out, ticked, undone, applied };
}

/** Which events are undone: the last undo or redo of each, in order, decides. */
export function undoneEvents(events: readonly LedgerEvent[]): Set<string> {
  const undone = new Set<string>();
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
