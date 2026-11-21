import type { Row } from "./data.ts";
import { rowIdOf, type Ledger } from "./ledger-store.ts";
import { resolveList } from "./store.ts";

/** A row as shown, to find again where it is kept: by its id in the ledger, by its place in a note's list. */
export interface RowRef {
  id?: string;
  index?: number;
  shown: Row;
}

/** What changing a field did: the row as it is now and the event that did it, or why nothing was written. */
export type SetResult = { row: Row; event?: string } | { refused: "changed" | "gone" };

/**
 * Where an app's lists are written: rows added and edited, checklist items ticked, unticked and
 * cleared. Each write gives the event it made, when the store keeps events, so the activity log can
 * undo exactly that later, from any device.
 */
export interface DataStore {
  readonly dataPath: string;
  /** A list's rows as they are now. */
  rows(list: string): Promise<Row[]>;
  /** Adds a row; `id` makes two runs that add the same row (two devices sampling, a then run twice) add it once. */
  add(list: string, row: Row, opts?: { id?: string; cap?: number }): Promise<{ event?: string; already?: boolean }>;
  set(list: string, ref: RowRef, field: string, value: unknown): Promise<SetResult>;
  /** Ticks an item; undefined when it was already ticked. */
  tick(list: string, item: string): Promise<{ event?: string } | undefined>;
  /** Unticks an item; undefined when it wasn't ticked. */
  untick(list: string, item: string): Promise<{ event?: string } | undefined>;
  /** Unticks every item; the items it unticked. */
  clear(list: string): Promise<{ event?: string; items: string[] }>;
  /** Takes back events this or another device made. */
  undo(events: string[]): Promise<void>;
}

/** Whether a stored list row still holds what was shown for it, apart from the field being changed. */
function holds(stored: unknown, shown: Row, field: string): stored is Row {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return false;
  return Object.entries(stored).every(([k, v]) => k === field || JSON.stringify(v) === JSON.stringify(shown[k]));
}

const itemsOf = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/**
 * Lists kept in a note's properties, rewritten on each change: what a dry run or a try writes into
 * its copies of the notes.
 */
export function frontmatterStore(
  dataPath: string,
  write: (path: string, fn: (fm: Record<string, unknown>) => void) => Promise<void>,
  read: (path: string) => Record<string, unknown> | undefined,
  appFm: () => Record<string, unknown> = () => ({}),
): DataStore {
  return {
    dataPath,
    async rows(list) {
      const rows = resolveList(list, read(dataPath), appFm());
      return Array.isArray(rows) ? rows.filter((r): r is Row => r !== null && typeof r === "object" && !Array.isArray(r)) : [];
    },
    async add(list, row, opts) {
      await write(dataPath, (fm) => {
        const had = Array.isArray(fm[list]) ? (fm[list] as unknown[]) : [];
        const next = [...had, row];
        fm[list] = opts?.cap !== undefined && next.length > opts.cap ? next.slice(next.length - opts.cap) : next;
      });
      return {};
    },
    async set(list, ref, field, value) {
      let result: SetResult = { refused: "changed" };
      await write(dataPath, (fm) => {
        const rows = resolveList(list, fm, appFm());
        const stored: unknown = Array.isArray(rows) && ref.index !== undefined ? rows[ref.index] : undefined;
        if (!Array.isArray(rows) || !holds(stored, ref.shown, field)) return;
        const next: unknown[] = [...(rows as unknown[])];
        next[ref.index!] = { ...stored, [field]: value };
        fm[list] = next;
        result = { row: next[ref.index!] as Row };
      });
      return result;
    },
    async tick(list, item) {
      let ticked = false;
      await write(dataPath, (fm) => {
        const had = itemsOf(fm[list]);
        if (had.includes(item)) return;
        ticked = true;
        fm[list] = [...had, item];
      });
      return ticked ? {} : undefined;
    },
    async untick(list, item) {
      let unticked = false;
      await write(dataPath, (fm) => {
        const had = itemsOf(fm[list]);
        if (!had.includes(item)) return;
        unticked = true;
        fm[list] = had.filter((i) => i !== item);
      });
      return unticked ? {} : undefined;
    },
    async clear(list) {
      let items: string[] = [];
      await write(dataPath, (fm) => {
        items = itemsOf(fm[list]);
        fm[list] = [];
      });
      return { items };
    },
    async undo() {},
  };
}

/** Lists kept as the ledger's events: each write is one event this device appends. */
export function ledgerStore(ledger: Ledger, dataPath: string, appFm: () => Record<string, unknown> = () => ({})): DataStore {
  const ticked = async (list: string) => (await ledger.state(dataPath, appFm())).ticked.get(list) ?? [];
  return {
    dataPath,
    async rows(list) {
      return (await ledger.state(dataPath, appFm())).lists.get(list)?.rows ?? [];
    },
    async add(list, row, opts) {
      const id = opts?.id ?? ledger.newRowId();
      // A row another run already added under this id stays as it is.
      if (opts?.id && (await ledger.state(dataPath, appFm())).lists.get(list)?.rows.some((r) => rowIdOf(r) === id)) return { already: true };
      const [event] = await ledger.write(dataPath, [{ op: "add", l: list, row: id, v: row }]);
      return { event };
    },
    async set(list, ref, field, value) {
      const rows = (await ledger.state(dataPath, appFm())).lists.get(list)?.rows ?? [];
      const row = rows.find((r) => rowIdOf(r) === ref.id);
      if (!ref.id || !row) return { refused: "gone" };
      // Written from what was shown: when another device changed it meanwhile, both are kept as a conflict.
      const [event] = await ledger.write(dataPath, [{ op: "set", l: list, row: ref.id, f: field, v: value, from: ref.shown[field] }]);
      return { row: { ...row, [field]: value }, event };
    },
    async tick(list, item) {
      if ((await ticked(list)).includes(item)) return undefined;
      const [event] = await ledger.write(dataPath, [{ op: "tick", l: list, item }]);
      return { event };
    },
    async untick(list, item) {
      if (!(await ticked(list)).includes(item)) return undefined;
      const [event] = await ledger.write(dataPath, [{ op: "untick", l: list, item }]);
      return { event };
    },
    async clear(list) {
      const items = await ticked(list);
      if (!items.length) return { items };
      const [event] = await ledger.write(dataPath, [{ op: "clear", l: list }]);
      return { event, items };
    },
    async undo(events) {
      await ledger.write(dataPath, [{ op: "undo", ev: events }]);
    },
  };
}
