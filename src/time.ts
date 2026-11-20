/**
 * Time, in one place. A stamp an app saves is the clock where it was saved, with that place's
 * offset: `2026-11-19T08:14-08:00`. Stamps from before (and dates people type) have no offset and
 * are local time. A stamp is read two ways:
 * - toTime, the moment: for order, elapsed time, `between`, `<` and `>`, deadlines;
 * - wallTime, the clock as lived: for dates, days, weeks and what is shown, so a dose logged at
 *   08:00 abroad is 08:00 on the day it was lived, wherever it is read.
 * Without an offset the two agree. Periods are local unless a zone is given: rhythms' deadlines are
 * worked out in the zone of the device the person used last (see device.ts).
 */

export const DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** The two digits at i as a number, or -1. */
function twoDigits(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48, b = s.charCodeAt(i + 1) - 48;
  return a >= 0 && a <= 9 && b >= 0 && b <= 9 ? a * 10 + b : -1;
}

/**
 * `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` and that with `±HH:MM`, the forms saving writes, read without
 * Date.parse's general parser: the clock they show as local time (`wall`) and the moment. A day past
 * the month's end rolls over, as Date.parse reads it. Undefined for any other text, and for years
 * below 100 or an hour of 24, which Date.parse is left to read.
 */
function readStamp(v: string): { wall: number; moment: number } | undefined {
  if (v.length !== 10 && v.length !== 16 && v.length !== 22) return undefined;
  const century = twoDigits(v, 0), year = twoDigits(v, 2), month = twoDigits(v, 5), day = twoDigits(v, 8);
  if (century < 1 || year < 0 || v.charCodeAt(4) !== 45 || v.charCodeAt(7) !== 45 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const y = century * 100 + year;
  if (v.length === 10) {
    const t = new Date(y, month - 1, day).getTime();
    return { wall: t, moment: t };
  }
  const hour = twoDigits(v, 11), minute = twoDigits(v, 14);
  if (v.charCodeAt(10) !== 84 || v.charCodeAt(13) !== 58 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const wall = new Date(y, month - 1, day, hour, minute).getTime();
  if (v.length === 16) return { wall, moment: wall };
  const sign = v.charCodeAt(16) === 43 ? 1 : v.charCodeAt(16) === 45 ? -1 : 0;
  const oh = twoDigits(v, 17), om = twoDigits(v, 20);
  if (!sign || oh < 0 || oh > 14 || v.charCodeAt(19) !== 58 || om < 0 || om > 59) return undefined;
  return { wall, moment: Date.UTC(y, month - 1, day, hour, minute) - sign * (oh * 60 + om) * 60_000 };
}

/** Epoch seconds, epoch ms, or a date string, as the moment it names; anything else is not a time. */
export function toTime(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") {
    if (v > 1e11) return v;
    if (v > 1e8) return v * 1000;
    return undefined;
  }
  if (typeof v === "string") {
    const read = readStamp(v);
    if (read) return read.moment;
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return undefined;
    const t = Date.parse(v.length === 10 ? `${v}T00:00` : v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * A time as the clock read where it was saved, as local time here: what a saved stamp's date and
 * hour are. Anything that isn't a saved stamp (an epoch, a web site's ISO time) is its moment.
 */
export function wallTime(v: unknown): number | undefined {
  if (typeof v === "string") {
    const read = readStamp(v);
    if (read) return read.wall;
  }
  return toTime(v);
}

/** A saved stamp as people read it, the clock where it was saved without its offset; other text as it is. */
export function shownStamp(v: string): string {
  return v.length === 22 && readStamp(v) ? v.slice(0, 16) : v;
}

/** Whether text is shaped like a saved stamp, whatever its numbers. */
function stampShape(v: string): boolean {
  if (v.length !== 10 && v.length !== 16 && v.length !== 22) return false;
  if (twoDigits(v, 0) < 0 || twoDigits(v, 2) < 0 || v.charCodeAt(4) !== 45 || twoDigits(v, 5) < 0 || v.charCodeAt(7) !== 45 || twoDigits(v, 8) < 0) return false;
  return v.length === 10 || (v.charCodeAt(10) === 84 && twoDigits(v, 11) >= 0 && v.charCodeAt(13) === 58 && twoDigits(v, 14) >= 0);
}

/** The UTC date of a time as YYYY-MM-DD; undefined outside years 0 to 9999, which that can't write. */
function utcDay(t: number): string | undefined {
  if (!(Math.abs(t) <= 8.64e15)) return undefined;
  const iso = new Date(t).toISOString();
  return iso.length === 24 ? iso.slice(0, 10) : undefined;
}

/**
 * A test for values in [from, to): their clock as lived, or with `byMoment` their moment (for `past`
 * and `upcoming`, which are about now, not a date). A stamp dated a week or more outside can't be in
 * it (an offset is under a day; a day past the month's end, day 00 or hour 24 moves it three days at
 * most), so most rows of a long list are ruled out by their text, without being read as a time.
 */
export function inWindow([from, to]: readonly [number, number], byMoment = false): (v: unknown) => boolean {
  const before = utcDay(from - 7 * DAY) ?? "";
  const after = `${utcDay(to + 7 * DAY) ?? "~"}T~`;
  const read = byMoment ? toTime : wallTime;
  return (v) => {
    if (typeof v === "string" && (v < before || v > after) && stampShape(v)) return false;
    const t = read(v);
    return t !== undefined && t >= from && t < to;
  };
}

/** A local time's date, minute and both, as typed into notes: `2026-11-19`, `08:14`, `2026-11-19T08:14`. */
export function stampParts(d: Date): { at: string; date: string; time: string } {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { at: `${date}T${time}`, date, time };
}

/** What a save stamps a row with: the local clock and its offset, `2026-11-19T08:14-08:00`. */
export function stampOf(d: Date): string {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${stampParts(d).at}${off < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---- Calendars ----------------------------------------------------------------------------------

/** A clock reading: month from 0, weekday from 0 = Sunday, as Date gives them. */
interface Fields { y: number; m: number; d: number; h: number; mi: number; wd: number }

/** Reading and setting the clock in local time, or in a named zone (an IANA name, e.g. Asia/Ho_Chi_Minh). */
interface Calendar {
  fields(t: number): Fields;
  /** The moment the clock shows this; days, hours and minutes past their range roll over, as Date does. */
  at(y: number, m: number, d: number, h?: number, mi?: number): number;
}

const local: Calendar = {
  fields(t) {
    const x = new Date(t);
    return { y: x.getFullYear(), m: x.getMonth(), d: x.getDate(), h: x.getHours(), mi: x.getMinutes(), wd: x.getDay() };
  },
  at: (y, m, d, h = 0, mi = 0) => new Date(y, m, d, h, mi).getTime(),
};

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formats = new Map<string, Intl.DateTimeFormat>();

function zoned(zone: string): Calendar {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formats.set(zone, f);
  }
  const format = f;
  const fields = (t: number): Fields => {
    const p = Object.fromEntries(format.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd: WEEKDAY[p.weekday] ?? 0 };
  };
  /** How far the zone's clock is ahead of UTC at t (ms). */
  const offset = (t: number) => {
    const x = fields(t);
    return Date.UTC(x.y, x.m, x.d, x.h, x.mi) - Math.floor(t / 60_000) * 60_000;
  };
  return {
    fields,
    at(y, m, d, h = 0, mi = 0) {
      // The clock as if UTC, less the zone's offset: the offset a day before and a day after, which
      // differ only around a clock change. A time that happens twice is the first; one skipped over
      // moves on by the change, as Date does in local time.
      const wall = Date.UTC(y, m, d, h, mi);
      const before = wall - offset(wall - DAY), after = wall - offset(wall + DAY);
      if (before === after) return before;
      const shows = (t: number) => { const x = fields(t); return Date.UTC(x.y, x.m, x.d, x.h, x.mi) === wall; };
      const [a, b] = [shows(before), shows(after)];
      return a && b ? Math.min(before, after) : b && !a ? after : before;
    },
  };
}

/** The calendar of a zone; local time when none is given, or the zone is this device's own. */
export function calendarOf(zone?: string): Calendar {
  if (!zone || zone === localZone()) return local;
  try {
    return zoned(zone);
  } catch {
    // A zone this device doesn't know: its own clock is the nearest there is.
    return local;
  }
}

/** This device's time zone, as an IANA name. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const PERIODS = ["day", "week", "month", "year"] as const;
export type Per = (typeof PERIODS)[number];

/** Start of the day, week (from Monday), month or year containing t, locally or in a zone. */
export function periodStart(t: number, per: Per, zone?: string): number {
  const cal = calendarOf(zone);
  const { y, m, d, wd } = cal.fields(t);
  switch (per) {
    case "day": return cal.at(y, m, d);
    case "week": return cal.at(y, m, d - ((wd + 6) % 7));
    case "month": return cal.at(y, m, 1);
    case "year": return cal.at(y, 0, 1);
  }
}

/** The start of the period n periods away, counted in calendar units so clock changes don't matter. */
export function shiftPeriod(start: number, per: Per, n: number, zone?: string): number {
  const cal = calendarOf(zone);
  const { y, m, d } = cal.fields(start);
  switch (per) {
    case "day": return cal.at(y, m, d + n);
    case "week": return cal.at(y, m, d + 7 * n);
    case "month": return cal.at(y, m + n, 1);
    case "year": return cal.at(y + n, 0, 1);
  }
}

/** Days in a month (month from 0): calendar arithmetic, the same in every zone. */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** A moment's date, `YYYY-MM-DD`, locally or in a zone. */
export function dayIn(t: number, zone?: string): string {
  const x = calendarOf(zone).fields(t);
  return `${x.y}-${pad(x.m + 1)}-${pad(x.d)}`;
}

/** A moment's date and minute, `YYYY-MM-DDTHH:MM`, locally or in a zone. */
export function minuteIn(t: number, zone?: string): string {
  const x = calendarOf(zone).fields(t);
  return `${x.y}-${pad(x.m + 1)}-${pad(x.d)}T${pad(x.h)}:${pad(x.mi)}`;
}

/** The [from, to) times a date condition covers (`today`, `this week`, `last 7 days`, a date…), or undefined when it isn't one. */
export function dateWindow(cond: string, now: Date): [number, number] | undefined {
  const c = cond.trim().toLowerCase();
  const t = now.getTime();
  const today = periodStart(t, "day");
  const span = (per: Per, back: number): [number, number] => {
    const current = periodStart(t, per);
    return [shiftPeriod(current, per, -back), shiftPeriod(current, per, 1)];
  };
  if (c === "today") return span("day", 0);
  if (c === "yesterday") return [shiftPeriod(today, "day", -1), today];
  let m = c.match(/^this (week|month|year)$/);
  if (m) return span(m[1] as Per, 0);
  m = c.match(/^last (\d+) (day|week|month|year)s?$/);
  if (m) return span(m[2] as Per, Number(m[1]) - 1);
  m = c.match(/^next (\d+) days?$/);
  if (m) return [today, shiftPeriod(today, "day", Number(m[1]) + 1)];
  // A bare date is that whole day, so it matches timestamps on it.
  m = c.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return [day, shiftPeriod(day, "day", 1)];
  }
  if (c === "past") return [-Infinity, t];
  if (c === "upcoming") return [today, Infinity];
  return undefined;
}

/** Whole calendar days from now until the date (negative when past), counting the date as lived. */
export function daysUntil(to: string, now: Date): number {
  const t = wallTime(to) ?? Date.parse(to);
  return Math.round((periodStart(t, "day") - periodStart(now.getTime(), "day")) / DAY);
}
