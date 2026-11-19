import { periodStart, shiftPeriod } from "../data.ts";

/** Round tick values from `min` to `max`, about `count` of them (as the line and bar charts pick theirs). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export interface TimeTick { at: number; label: string }

type Unit = "hour" | "day" | "month";
/** Steps from fine to coarse; day steps of 7 and 14 start on a Monday, month steps of 12 and up are years. */
const STEPS: readonly [Unit, number][] = [
  ["hour", 1], ["hour", 2], ["hour", 3], ["hour", 6], ["hour", 12],
  ["day", 1], ["day", 2], ["day", 7], ["day", 14],
  ["month", 1], ["month", 2], ["month", 3], ["month", 6], ["month", 12], ["month", 24], ["month", 60], ["month", 120],
];

/** The first tick on or before `t` for this step: a multiple of the step within its hour, month or year. */
function floorTo(t: number, unit: Unit, n: number): number {
  const d = new Date(t);
  if (unit === "hour") return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(d.getHours() / n) * n).getTime();
  if (unit === "day") return periodStart(t, n % 7 === 0 ? "week" : "day");
  if (n >= 12) return new Date(Math.floor(d.getFullYear() / (n / 12)) * (n / 12), 0, 1).getTime();
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / n) * n, 1).getTime();
}

function advance(t: number, unit: Unit, n: number): number {
  if (unit === "day") return shiftPeriod(t, "day", n);
  if (unit === "month") return shiftPeriod(t, "month", n);
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + n).getTime();
}

function labelOf(t: number, unit: Unit, n: number, first: boolean): string {
  const d = new Date(t);
  if (unit === "hour") {
    return d.getHours() === 0 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (unit === "day") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (n >= 12) return String(d.getFullYear());
  return d.toLocaleDateString(undefined, first || d.getMonth() === 0 ? { month: "short", year: "numeric" } : { month: "short" });
}

/**
 * Ticks on a time axis from `from` to `to`: hours, days or months, the finest step that needs no
 * more than `max` of them.
 */
export function timeTicks(from: number, to: number, max: number): TimeTick[] {
  let ticks: number[] = [];
  let step = STEPS[0];
  for (step of STEPS) {
    ticks = [];
    for (let t = floorTo(from, step[0], step[1]); t <= to && ticks.length <= max; t = advance(t, step[0], step[1])) if (t >= from) ticks.push(t);
    if (ticks.length <= max) break;
  }
  return ticks.slice(0, max).map((at, i) => ({ at, label: labelOf(at, step[0], step[1], i === 0) }));
}
