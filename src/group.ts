import { aggregate, compileWhere, getPath, sortRows, type Agg, type Row } from "./data.ts";
import { dateWindow, type Per, periodStart, shiftPeriod, stampParts, toTime, wallTime } from "./time.ts";
import type { Panel } from "./spec.ts";

/** The key for rows whose group field is empty. */
export const NONE = "(none)";
/** Beyond this many periods, empty ones aren't filled in. */
const FILL_LIMIT = 2000;

type GroupKeys = Pick<Panel, "group" | "per" | "y" | "columns" | "agg" | "where" | "of">;

/** The fields a grouped panel totals per group: its y series or table columns, less the key and count. */
export function totalFields(p: Pick<Panel, "group" | "y" | "columns">): string[] {
  const ys = Array.isArray(p.y) ? p.y : p.y ? [p.y] : [];
  return [...new Set([...ys, ...(p.columns ?? [])])].filter((f) => f !== p.group && f !== "count");
}

/** Rows from an object of parallel arrays ({time: [...], temp: [...]}), the shape many APIs return. */
export function rowsFromArrays(data: unknown, fields: string[]): Row[] | undefined {
  const columns = fields.map((f) => getPath(data, f));
  if (!columns.every(Array.isArray)) return undefined;
  const length = Math.max(...columns.map((c) => (c as unknown[]).length));
  return Array.from({ length }, (_, i) => Object.fromEntries(fields.map((f, j) => [f, (columns[j] as unknown[])[i]])));
}

/**
 * Rows from an object whose every key holds an array, all of one length (Open-Meteo's `hourly`,
 * a quote's `close`/`volume`). An object with other keys is one row as it is, so a stray list in
 * it (`tags`, `validRanges`) doesn't turn it into rows of that list.
 */
export function rowsFromEqualArrays(data: unknown): Row[] | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const columns = Object.entries(data);
  if (columns.length === 0 || !columns.every(([, c]) => Array.isArray(c))) return undefined;
  const length = (columns[0][1] as unknown[]).length;
  if (columns.some(([, c]) => (c as unknown[]).length !== length)) return undefined;
  return Array.from({ length }, (_, i) => Object.fromEntries(columns.map(([k, c]) => [k, (c as unknown[])[i]])));
}

/**
 * One row per group: { <group>: key, count, <each total field>: agg of its values }. With `per`, the
 * key is the period's first day (YYYY-MM-DD) and empty periods are filled in between the first and
 * last period with rows, or across the whole window when `where` bounds the date field.
 */
export function groupRows(rows: unknown[], p: GroupKeys, now: Date): Row[] {
  const field = p.group!;
  const totals = totalFields(p);
  const agg = (p.agg ?? "count") as Agg;
  const of = p.of && compileWhere(p.of, now);
  const groups = new Map<unknown, unknown[]>();
  const add = (key: unknown, row: unknown) => {
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  };
  for (const row of rows) {
    const v = getPath(row, field);
    if (p.per) {
      // The day, week or month it was lived in, wherever it was saved.
      const t = wallTime(v);
      if (t !== undefined) add(periodStart(t, p.per), row);
    } else if (Array.isArray(v)) {
      for (const item of v) add(item ?? NONE, row);
    } else {
      add(v ?? NONE, row);
    }
  }
  const total = (g: unknown[]): Row => {
    const out: Row = { count: g.length };
    for (const f of totals) out[f] = g.length ? aggregate(g, f, agg, of) ?? null : agg === "sum" ? 0 : null;
    return out;
  };
  if (!p.per) {
    return sortRows([...groups].map(([key, g]) => ({ [field]: key, ...total(g) })), field) as Row[];
  }
  const keys = periodKeys([...groups.keys()] as number[], p.per, p.where?.[field], now);
  return keys.map((k) => ({ [field]: stampParts(new Date(k)).date, ...total(groups.get(k) ?? []) }));
}

function periodKeys(found: number[], per: Per, cond: unknown, now: Date): number[] {
  const window = typeof cond === "string" ? dateWindow(cond, now) : undefined;
  const bounded = window && Number.isFinite(window[0]) && Number.isFinite(window[1]);
  const sorted = [...found].sort((a, b) => a - b);
  if (!bounded && sorted.length === 0) return [];
  const from = bounded ? periodStart(window[0], per) : sorted[0];
  const to = bounded ? periodStart(window[1] - 1, per) : sorted[sorted.length - 1];
  const keys: number[] = [];
  for (let k = from; k <= to; k = shiftPeriod(k, per, 1)) {
    if (keys.length === FILL_LIMIT) return sorted;
    keys.push(k);
  }
  return keys;
}

/**
 * Consecutive periods with at least one row, ending with the current period; if nothing is in the
 * current period yet, the run may end with the one before (not having done it yet today doesn't
 * break the streak). Rows in the future don't count.
 */
export function streak(rows: unknown[], field: string, per: Per, now: Date): number {
  const current = periodStart(now.getTime(), per);
  const seen = new Set<number>();
  for (const row of rows) {
    const t = wallTime(getPath(row, field));
    if (t === undefined) continue;
    const start = periodStart(t, per);
    if (start <= current) seen.add(start);
  }
  let at = seen.has(current) ? current : shiftPeriod(current, per, -1);
  let n = 0;
  while (seen.has(at)) {
    n++;
    at = shiftPeriod(at, per, -1);
  }
  return n;
}
