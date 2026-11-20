import { getPath } from "./data.ts";
import { dateWindow, periodStart, shiftPeriod, stampParts, toTime, wallTime } from "./time.ts";
import type { Panel } from "./spec.ts";

const DAY = 86_400_000;

/** The date condition a `compare` panel measures, and the window just before it. Times are [from, to). */
export interface Windows {
  field: string;
  current: [number, number];
  previous: [number, number];
}

/**
 * The window of the same length just before this one. Whole months or years step back by calendar
 * months, whole weeks by weeks, anything else by days, so `this month` compares with last month
 * whatever their lengths.
 */
function previousWindow(from: number, to: number): [number, number] {
  const [a, b] = [new Date(from), new Date(to)];
  if (periodStart(from, "month") === from && periodStart(to, "month") === to) {
    const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
    return [shiftPeriod(from, "month", -months), from];
  }
  const weeks = Math.round((to - from) / (7 * DAY));
  if (weeks > 0 && periodStart(from, "week") === from && shiftPeriod(from, "week", weeks) === to) return [shiftPeriod(from, "week", -weeks), from];
  return [shiftPeriod(from, "day", -Math.max(1, Math.round((to - from) / DAY))), from];
}

/** The first `where` condition that is a date window with both ends (`this week`, `last 7 days`), if any. */
export function compareWindows(where: Panel["where"], now: Date): Windows | undefined {
  for (const [field, cond] of Object.entries(where ?? {})) {
    const window = typeof cond === "string" ? dateWindow(cond, now) : undefined;
    if (window && Number.isFinite(window[0]) && Number.isFinite(window[1])) {
      return { field, current: window, previous: previousWindow(window[0], window[1]) };
    }
  }
  return undefined;
}

/**
 * The `where` a `compare` panel loads with: its window condition opened up to everything since the
 * previous window began, so one load holds both. The panel's view tells the windows apart again
 * with splitByWindow.
 */
export function widenForCompare(where: NonNullable<Panel["where"]>, compare: string | undefined, now: Date): NonNullable<Panel["where"]> {
  const windows = compare ? compareWindows(where, now) : undefined;
  return windows ? { ...where, [windows.field]: `>= ${stampParts(new Date(windows.previous[0])).date}` } : where;
}

/**
 * A compare panel's rows split into the current window and the one before it. Without `compare`, a
 * window in `where`, or a list of rows, the data is the current rows as they are and there is no
 * previous. Anything that reads a number panel's value outside its view should read `current`.
 */
export function splitByWindow(p: Pick<Panel, "where" | "compare">, data: unknown, now: Date): { current: unknown; previous?: unknown[] } {
  const windows = p.compare && Array.isArray(data) ? compareWindows(p.where, now) : undefined;
  if (!windows || !Array.isArray(data)) return { current: data };
  const within = ([from, to]: [number, number]) => (row: unknown) => {
    const t = wallTime(getPath(row, windows.field));
    return t !== undefined && t >= from && t < to;
  };
  return { current: data.filter(within(windows.current)), previous: data.filter(within(windows.previous)) };
}
