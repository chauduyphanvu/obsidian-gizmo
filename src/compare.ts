import { getPath } from "./data.ts";
import { dateWindow, daysInMonth, periodStart, shiftPeriod, stampParts, wallTime } from "./time.ts";
import type { Panel } from "./spec.ts";

const DAY = 86_400_000;

/** How a window steps back to the one before it: by `n` calendar months, whole weeks or days. */
export interface Step {
  per: "month" | "week" | "day";
  n: number;
}

/** The date condition a `compare` panel measures, and the window just before it. Times are [from, to). */
export interface Windows {
  field: string;
  current: [number, number];
  previous: [number, number];
  step: Step;
}

/**
 * The step to the window before: whole months or years step back by calendar months, whole weeks
 * by weeks, anything else by days, so `this month` compares with last month whatever their lengths.
 */
function stepOf(from: number, to: number): Step {
  const [a, b] = [new Date(from), new Date(to)];
  if (periodStart(from, "month") === from && periodStart(to, "month") === to) {
    return { per: "month", n: (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() };
  }
  const weeks = Math.round((to - from) / (7 * DAY));
  if (weeks > 0 && periodStart(from, "week") === from && shiftPeriod(from, "week", weeks) === to) return { per: "week", n: weeks };
  return { per: "day", n: Math.max(1, Math.round((to - from) / DAY)) };
}

/**
 * The same clock one step back: that many days or weeks before, or months before on the same day of
 * the month, kept to the last day of a shorter month (Mar 31 steps back to Feb 28 or 29).
 */
function stepBack(t: number, { per, n }: Step): number {
  const d = new Date(t);
  const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  const clock = [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()] as const;
  if (per === "month") return new Date(y, m - n, Math.min(day, daysInMonth(y, m - n)), ...clock).getTime();
  return new Date(y, m, day - (per === "week" ? 7 : 1) * n, ...clock).getTime();
}

/**
 * The first `where` condition that is a date window with both ends (`this week`, `last 7 days`), if
 * any, and the window before it. A window still running at `now` is compared like with like: the
 * window before ends as far into itself as now is into this one, so the 20th of a month is set
 * against the 1st to the 20th of the last, not all of it. A look ahead (`next 3 days`) holds what is
 * coming rather than what has happened, so it is compared whole.
 */
export function compareWindows(where: Panel["where"], now: Date): Windows | undefined {
  const t = now.getTime();
  for (const [field, cond] of Object.entries(where ?? {})) {
    if (typeof cond !== "string") continue;
    const window = dateWindow(cond, now);
    if (window && Number.isFinite(window[0]) && Number.isFinite(window[1])) {
      const step = stepOf(window[0], window[1]);
      const running = window[0] <= t && t < window[1] && !/^next /.test(cond.trim().toLowerCase());
      return { field, current: window, previous: [stepBack(window[0], step), running ? stepBack(t, step) : window[0]], step };
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
