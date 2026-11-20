/**
 * What an app expects of its data, under `expect:`, a list of rules:
 * - a rhythm: a row by a time each day, week or month (`every`, `by`), told when it's missed;
 * - a value rule: every row written must hold (`check`), or the write is refused;
 * - a state rule: no row may come to match (`none`), told when one does, as an alert is.
 * Periods are calendar days, Monday weeks and months in local time. A rhythm's window runs from
 * its period's start to the next period's start, and it is met by a row in it before the deadline.
 */
import { compileWhere, getPath, periodStart, shiftPeriod, toTime, type Row } from "./data.ts";
import type { Then } from "./spec.ts";

export type Every = "day" | "week" | "month";

interface Base {
  id: string;
  source: string;
}

export interface Rhythm extends Base {
  kind: "rhythm";
  every: Every;
  /** The deadline after the period starts: a weekday (0 = Monday) or a day of the month, and minutes past midnight. */
  by: { day: number; minutes: number };
  byText: string;
  where?: Record<string, string | number | boolean>;
  say?: string;
  then?: Then;
}

export interface ValueRule extends Base {
  kind: "value";
  check: Record<string, string | number | boolean>;
}

export interface StateRule extends Base {
  kind: "state";
  none: Record<string, string | number | boolean>;
  say?: string;
  then?: Then;
}

export type Expectation = Rhythm | ValueRule | StateRule;

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ID = /^[a-z0-9][a-z0-9-]*$/;

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const conditions = (v: unknown): v is Record<string, string | number | boolean> => isMap(v) && Object.values(v).every((x) => ["string", "number", "boolean"].includes(typeof x));

/** `10:00`, `fri 18:00`, `15 09:30`: the deadline in a period, or why it can't be read for `every`. */
export function readBy(text: string, every: Every): { day: number; minutes: number } | string {
  const parts = text.trim().toLowerCase().split(/\s+/);
  const time = parts.at(-1)!.match(/^(\d{1,2}):(\d{2})$/);
  const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : NaN;
  const example = every === "day" ? "by: \"10:00\"" : every === "week" ? "by: \"fri 18:00\"" : "by: \"1 09:00\"";
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return `by must end with a time, e.g. ${example}`;
  if (every === "day") return parts.length === 1 ? { day: 0, minutes } : `by for every day is a time, e.g. ${example}`;
  if (parts.length !== 2) return `by for every ${every} needs a ${every === "week" ? "weekday" : "day of the month"} and a time, e.g. ${example}`;
  if (every === "week") {
    const day = WEEKDAYS.indexOf(parts[0].slice(0, 3));
    return day >= 0 ? { day, minutes } : `by's weekday must be mon to sun, e.g. ${example}`;
  }
  const day = Number(parts[0]);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? { day: day - 1, minutes } : `by's day must be 1 to 31, e.g. ${example}`;
}

/** The rules under `expect:`, checked; each problem goes in `errors` as `expect <n>: …`. */
export function readExpect(raw: unknown, errors: string[]): Expectation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("expect must be a list of rules, e.g. expect: [{every: day, by: \"10:00\", source: doses}]");
    return [];
  }
  const out: Expectation[] = [];
  const ids = new Set<string>();
  raw.forEach((r, i) => {
    const at = `expect ${i + 1}`;
    const bad = (m: string) => void errors.push(`${at}: ${m}`);
    if (!isMap(r)) return bad("must be a map, e.g. {every: day, by: \"10:00\", source: doses}");
    const id = r.id === undefined ? `expect-${i + 1}` : String(r.id);
    if (!ID.test(id)) return bad("id must be lowercase letters, digits and -");
    if (ids.has(id)) return bad(`another rule is already called ${id}`);
    ids.add(id);
    if (typeof r.source !== "string" || !r.source) return bad("needs source: the list it's about");
    const kinds = ["every", "check", "none"].filter((k) => r[k] !== undefined);
    if (kinds.length !== 1) return bad("needs one of every (a rhythm), check (what each row must hold) or none (what no row may match)");
    const known = { every: ["id", "source", "every", "by", "where", "say", "then"], check: ["id", "source", "check"], none: ["id", "source", "none", "say", "then"] }[kinds[0] as "every" | "check" | "none"];
    const extra = Object.keys(r).filter((k) => !known.includes(k));
    if (extra.length) return bad(`${kinds[0] === "every" ? "a rhythm" : kinds[0] === "check" ? "a value rule" : "a state rule"} doesn't take ${extra.join(", ")}`);
    if (r.say !== undefined && typeof r.say !== "string") return bad("say must be text");
    if (r.then !== undefined && !isMap(r.then)) return bad("then must be a map, e.g. then: {app: \"[[Task inbox]]\", do: add}");
    if (kinds[0] === "every") {
      if (!["day", "week", "month"].includes(String(r.every))) return bad("every must be day, week or month");
      const every = r.every as Every;
      if (typeof r.by !== "string") return bad("a rhythm needs by: the time it's due, e.g. by: \"10:00\"");
      const by = readBy(r.by, every);
      if (typeof by === "string") return bad(by);
      if (r.where !== undefined && !conditions(r.where)) return bad("where must be a map of conditions");
      out.push({ kind: "rhythm", id, source: r.source, every, by, byText: r.by, ...(r.where !== undefined && { where: r.where as Rhythm["where"] }), ...(r.say !== undefined && { say: r.say as string }), ...(r.then !== undefined && { then: r.then as unknown as Then }) });
    } else if (kinds[0] === "check") {
      if (!conditions(r.check) || !Object.keys(r.check).length) return bad("check must be a map of conditions each row must hold, e.g. check: {weight: between 30 and 250}");
      out.push({ kind: "value", id, source: r.source, check: r.check });
    } else {
      if (!conditions(r.none) || !Object.keys(r.none).length) return bad("none must be a map of conditions no row may match, e.g. none: {due: past}");
      out.push({ kind: "state", id, source: r.source, none: r.none, ...(r.say !== undefined && { say: r.say as string }), ...(r.then !== undefined && { then: r.then as unknown as Then }) });
    }
  });
  return out;
}

/** One period of a rhythm: when it starts, when it's due, and when the next starts (ms). */
export interface Window {
  start: number;
  deadline: number;
  end: number;
}

function deadlineIn(start: number, rule: Rhythm): number {
  const d = new Date(start);
  const day = rule.every === "month"
    ? Math.min(rule.by.day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - 1)
    : rule.every === "week" ? rule.by.day : 0;
  // Counted in calendar days and clock time, so a clock change on the way doesn't move it.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, Math.floor(rule.by.minutes / 60), rule.by.minutes % 60).getTime();
}

export function windowAt(t: number, rule: Rhythm): Window {
  const start = periodStart(t, rule.every);
  return { start, deadline: deadlineIn(start, rule), end: shiftPeriod(start, rule.every, 1) };
}

/** The windows whose deadline passed after `from` and by `to`, oldest first. */
export function windowsDue(rule: Rhythm, from: number, to: number): Window[] {
  const out: Window[] = [];
  let w = windowAt(from, rule);
  for (let i = 0; i < 1000 && w.start <= to; i++) {
    if (w.deadline > from && w.deadline <= to) out.push(w);
    w = windowAt(w.end, rule);
  }
  return out;
}

/** Whether a row in the window (and matching the rule's where) came by its deadline; rows of later windows never count. */
export function metIn(rows: readonly unknown[], rule: Rhythm, w: Window, now: Date): boolean {
  const keep = rule.where ? compileWhere(rule.where, now) : () => true;
  return rows.some((r) => {
    const t = toTime(getPath(r, "at"));
    return t !== undefined && t >= w.start && t <= w.deadline && keep(r);
  });
}

/** Why a row may not be written to `list`: the first value rule it breaks, in words. */
export function refusal(rules: readonly Expectation[], list: string, row: Row, now: Date): string | undefined {
  for (const r of rules) {
    if (r.kind !== "value" || r.source !== list) continue;
    for (const [field, cond] of Object.entries(r.check)) {
      if (!compileWhere({ [field]: cond }, now)(row)) {
        const v = getPath(row, field);
        return v === undefined || v === "" ? `${field} is empty, and must be ${String(cond)}` : `${field} ${String(v)} isn't ${String(cond)}`;
      }
    }
  }
  return undefined;
}

/** Each rhythm's windows from `from` to now, met or not, as rows: what `source: expect` reads. */
export function expectRows(rules: readonly Expectation[], rowsOf: (list: string) => readonly unknown[], from: number, now: Date): Row[] {
  const out: Row[] = [];
  for (const rule of rules) {
    if (rule.kind !== "rhythm") continue;
    const rows = rowsOf(rule.source);
    let w = windowAt(from, rule);
    for (let i = 0; i < 1000 && w.start <= now.getTime(); i++) {
      // The window still running counts once it's met or its deadline passed.
      const met = metIn(rows, rule, w, now);
      if (met || w.deadline <= now.getTime()) out.push({ rule: rule.id, window: stampDay(w.start), at: stampDay(w.start), met, due: stampTime(w.deadline) });
      w = windowAt(w.end, rule);
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
function stampDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function stampTime(t: number): string {
  const d = new Date(t);
  return `${stampDay(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
