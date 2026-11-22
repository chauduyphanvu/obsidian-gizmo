import type { Row } from "./data.ts";
import { IDS_KEY, rowIdOf, type Ledger } from "./ledger-store.ts";
import { baseIds, type Op } from "./ledger.ts";
import { resolveList } from "./store.ts";
import { ROW_INDEX } from "./sources/list.ts";

/** A row as shown, to find again where it is kept: by its id in the ledger, by its place in a note's list. */
export interface RowRef {
  id?: string;
  index?: number;
  shown: Row;
}

/** What changing a field did: the row as it is now and the event that did it, or why nothing was written. */
export type SetResult = { row: Row; event?: string } | { refused: "changed" | "gone" };

/**
 * What deleting a row did: the row as it was kept, the event that took it out (or, in a note's
 * list, the place it had there), or why nothing was written.
 */
export type DeleteResult = { row: Row; event?: string; index?: number } | { refused: "changed" | "gone" };

/**
 * One of the changes `batch` writes together; a `set` to undefined takes the field out. An `add`
 * with an `id` adds that row once, wherever it runs (an import read twice adds nothing more).
 */
export type Edit =
  | { op: "add"; list: string; row: Row; id?: string }
  | { op: "set"; list: string; ref: RowRef; field: string; value: unknown }
  | { op: "delete"; list: string; ref: RowRef };

/**
 * What each edit of a batch did, in order: the row as it left it (for a delete, as it was kept), the
 * event, and for a delete from a note's list the place the row had there just before. An add with
 * an id that wrote nothing says why: the row is there already, or it was added before and then
 * undone or deleted, which keeps it out.
 */
export type BatchDone = { row: Row; event?: string; index?: number; already?: "there" | "gone" };

/**
 * What adding a row did: its id and the event, when the store keeps ids and events. With a given id
 * that wrote nothing, `already`; `gone` when that row was added before and then undone or deleted.
 */
export type AddResult = { id?: string; event?: string; already?: boolean; gone?: boolean };

/**
 * Where an app's lists are written: rows added, edited and deleted, checklist items ticked, unticked
 * and cleared. Each write gives the event it made, when the store keeps events, so the activity log
 * can undo exactly that later, from any device.
 */
export interface DataStore {
  readonly dataPath: string;
  /** A list's rows as they are now. */
  rows(list: string): Promise<Row[]>;
  /** Adds a row; `id` makes two runs that add the same row (two devices sampling, a then run twice) add it once. */
  add(list: string, row: Row, opts?: { id?: string; cap?: number }): Promise<AddResult>;
  set(list: string, ref: RowRef, field: string, value: unknown): Promise<SetResult>;
  /** Takes a row out; from a note's list only while its place still holds what was shown. */
  delete(list: string, ref: RowRef): Promise<DeleteResult>;
  /**
   * Writes several edits at once, in order: one write to the ledger, or one rewrite of the note. When
   * a row one of them names has changed or gone, none is written.
   */
  batch(edits: Edit[]): Promise<BatchDone[] | { refused: "changed" | "gone" }>;
  /** Ticks an item; undefined when it was already ticked. */
  tick(list: string, item: string): Promise<{ event?: string } | undefined>;
  /** Unticks an item; undefined when it wasn't ticked. */
  untick(list: string, item: string): Promise<{ event?: string } | undefined>;
  /** Unticks every item; the items it unticked. */
  clear(list: string): Promise<{ event?: string; items: string[] }>;
  /** Takes back events this or another device made. */
  undo(events: string[]): Promise<void>;
}

/** Whether a stored list row still holds what was shown for it, apart from the field being changed, if one is. */
function holds(stored: unknown, shown: Row, field?: string): stored is Row {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return false;
  return Object.entries(stored).every(([k, v]) => k === field || JSON.stringify(v) === JSON.stringify(shown[k]));
}

const itemsOf = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function withField(row: Row, field: string, value: unknown): Row {
  const next = { ...row, [field]: value };
  if (value === undefined) delete next[field];
  return next;
}

/**
 * The ids of a list kept in a note's properties: those the ledger's snapshot wrote beside it when
 * they still line up with its rows, else ids from what the rows hold (see baseIds).
 */
function idsIn(fm: Record<string, unknown>, list: string): string[] {
  const rows = Array.isArray(fm[list]) ? (fm[list] as unknown[]) : [];
  const kept = fm[IDS_KEY];
  const ids = kept !== null && typeof kept === "object" && !Array.isArray(kept) ? (kept as Record<string, unknown>)[list] : undefined;
  return Array.isArray(ids) && ids.length === rows.length ? ids.map(String) : baseIds(rows);
}

function keepIds(fm: Record<string, unknown>, list: string, ids: string[]): void {
  const kept = fm[IDS_KEY];
  fm[IDS_KEY] = { ...(kept !== null && typeof kept === "object" && !Array.isArray(kept) ? kept : {}), [list]: ids };
}

/**
 * Lists kept in a note's properties, rewritten on each change: what a dry run or a try writes into
 * its copies of the notes. A row added with an id keeps it in the note's ids, so it is added once.
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
      // Each row keeps its place among all the list's entries, which an edit finds it by.
      return Array.isArray(rows)
        ? rows.flatMap((r, i) => (r !== null && typeof r === "object" && !Array.isArray(r) ? [Object.defineProperty({ ...r }, ROW_INDEX, { value: i }) as Row] : []))
        : [];
    },
    async add(list, row, opts) {
      let already = false;
      await write(dataPath, (fm) => {
        const had = Array.isArray(fm[list]) ? (fm[list] as unknown[]) : [];
        const ids = opts?.id !== undefined ? idsIn(fm, list) : undefined;
        if (ids?.includes(opts!.id!)) {
          already = true;
          return;
        }
        const next = [...had, row];
        const cut = opts?.cap !== undefined && next.length > opts.cap ? next.length - opts.cap : 0;
        fm[list] = next.slice(cut);
        if (ids) keepIds(fm, list, [...ids, opts!.id!].slice(cut));
      });
      return already ? { already: true, id: opts!.id } : opts?.id !== undefined ? { id: opts.id } : {};
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
    async delete(list, ref) {
      let result: DeleteResult = { refused: "changed" };
      await write(dataPath, (fm) => {
        const rows = resolveList(list, fm, appFm());
        const stored: unknown = Array.isArray(rows) && ref.index !== undefined ? rows[ref.index] : undefined;
        if (!Array.isArray(rows) || !holds(stored, ref.shown)) return;
        fm[list] = (rows as unknown[]).filter((_, i) => i !== ref.index);
        result = { row: stored, index: ref.index };
      });
      return result;
    },
    async batch(edits) {
      let result: BatchDone[] | { refused: "changed" } = { refused: "changed" };
      await write(dataPath, (fm) => {
        // Each list's rows by the place they had before the batch (undefined once deleted), and the rows it adds.
        const lists = new Map<string, { places: unknown[]; added: Row[] }>();
        const listOf = (name: string) => {
          let l = lists.get(name);
          if (!l) {
            const rows = resolveList(name, fm, appFm());
            l = { places: Array.isArray(rows) ? [...(rows as unknown[])] : [], added: [] };
            lists.set(name, l);
          }
          return l;
        };
        const touched = new Set<string>();
        const done: BatchDone[] = [];
        // The ids of each list's rows, as they stand once the batch's adds with ids are in.
        const seeded = new Map<string, string[]>();
        for (const e of edits) {
          const l = listOf(e.list);
          if (e.op === "add") {
            if (e.id !== undefined) {
              const ids = seeded.get(e.list) ?? idsIn(fm, e.list);
              seeded.set(e.list, ids);
              if (ids.includes(e.id)) {
                done.push({ row: e.row, already: "there" });
                continue;
              }
              ids.push(e.id);
            }
            l.added.push(e.row);
            done.push({ row: e.row });
            continue;
          }
          const at = e.ref.index;
          const stored = at === undefined ? undefined : l.places[at];
          // A row is checked against what was shown before the batch first changes it.
          const key = `${e.list}\n${at}`;
          if (!touched.has(key) && !holds(stored, e.ref.shown, e.op === "set" ? e.field : undefined)) return;
          if (stored === undefined || stored === null || typeof stored !== "object") return;
          touched.add(key);
          if (e.op === "set") {
            l.places[at!] = withField(stored as Row, e.field, e.value);
            done.push({ row: l.places[at!] as Row });
          } else {
            // Its place as the list reads at this point of the batch, which putting it back needs.
            done.push({ row: stored as Row, index: l.places.slice(0, at).filter((r) => r !== undefined).length });
            l.places[at!] = undefined;
          }
        }
        for (const [name, l] of lists) fm[name] = [...l.places.filter((r) => r !== undefined), ...l.added];
        for (const [name, ids] of seeded) keepIds(fm, name, ids);
        result = done;
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
      if (opts?.id) {
        const state = await ledger.state(dataPath, appFm());
        // A row another run already added under this id stays as it is.
        if (state.lists.get(list)?.rows.some((r) => rowIdOf(r) === id)) return { already: true, id };
        // One added before and then undone or deleted stays out: another add of it would change nothing.
        if (state.gone(list, id)) return { already: true, gone: true, id };
      }
      const [event] = await ledger.write(dataPath, [{ op: "add", l: list, row: id, v: row }]);
      return { event, id };
    },
    async set(list, ref, field, value) {
      const rows = (await ledger.state(dataPath, appFm())).lists.get(list)?.rows ?? [];
      const row = rows.find((r) => rowIdOf(r) === ref.id);
      if (!ref.id || !row) return { refused: "gone" };
      // Written from what was shown: when another device changed it meanwhile, both are kept as a conflict.
      const [event] = await ledger.write(dataPath, [{ op: "set", l: list, row: ref.id, f: field, v: value, from: ref.shown[field] }]);
      return { row: { ...row, [field]: value }, event };
    },
    async delete(list, ref) {
      const rows = (await ledger.state(dataPath, appFm())).lists.get(list)?.rows ?? [];
      const row = rows.find((r) => rowIdOf(r) === ref.id);
      if (!ref.id || !row) return { refused: "gone" };
      // Undoing this event puts the row back under its id, so edits made elsewhere still find it.
      const [event] = await ledger.write(dataPath, [{ op: "del", l: list, row: ref.id }]);
      return { row: { ...row }, event };
    },
    async batch(edits) {
      const state = await ledger.state(dataPath, appFm());
      const lists = state.lists;
      // Each list's rows by id, as the batch leaves them so far: an edit after another of the same row starts from it.
      const byId = new Map<string, Map<string, Row>>();
      const rowsOf = (list: string) => {
        let rows = byId.get(list);
        if (!rows) byId.set(list, (rows = new Map((lists.get(list)?.rows ?? []).map((r) => [rowIdOf(r)!, r]))));
        return rows;
      };
      const ops: Op[] = [];
      const done: BatchDone[] = [];
      // Which op each edit wrote, if it wrote one.
      const wrote: (number | undefined)[] = [];
      for (const e of edits) {
        if (e.op === "add") {
          if (e.id !== undefined) {
            const rows = rowsOf(e.list);
            const already = rows.has(e.id) ? "there" : state.gone(e.list, e.id) ? "gone" : undefined;
            if (already) {
              done.push({ row: e.row, already });
              wrote.push(undefined);
              continue;
            }
            rows.set(e.id, e.row);
          }
          // Without an id, a new one each time: an add that was undone keeps its id out of the list for good.
          wrote.push(ops.length);
          ops.push({ op: "add", l: e.list, row: e.id ?? ledger.newRowId(), v: e.row });
          done.push({ row: e.row });
          continue;
        }
        const rows = rowsOf(e.list);
        const id = e.ref.id;
        const row = id === undefined ? undefined : rows.get(id);
        if (id === undefined || !row) return { refused: "gone" };
        wrote.push(ops.length);
        if (e.op === "set") {
          const next = withField(row, e.field, e.value);
          ops.push({ op: "set", l: e.list, row: id, f: e.field, v: e.value, from: row[e.field] });
          rows.set(id, next);
          done.push({ row: next });
        } else {
          ops.push({ op: "del", l: e.list, row: id });
          rows.delete(id);
          done.push({ row: { ...row } });
        }
      }
      const events = await ledger.write(dataPath, ops);
      return done.map((d, i) => {
        const at = wrote[i];
        return at === undefined ? d : { ...d, event: events[at] };
      });
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
