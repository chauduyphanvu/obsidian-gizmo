import type { Row } from "../data.ts";
import { minuteIn } from "../time.ts";

const DAY = 86_400_000;
/** Rows one repeating event may add, and how many candidate dates are tried to find them. */
const MAX_ROWS = 2_000;
const MAX_STEPS = 100_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * A moment as the calendar wrote it: a day number (days since 1970-01-01 on the calendar, not
 * in any zone), a minute of that day, and the zone the clock was read in. No zone is the reader's own.
 */
interface When {
  allday: boolean;
  day: number;
  minutes: number;
  zone?: string;
}

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: When;
  /** Weekdays, Monday = 0; WEEKLY only. */
  byday: number[];
  /** The weekday weeks start on, Monday = 0. */
  wkst: number;
}

interface Ev {
  uid: string;
  summary: string;
  location: string;
  description: string;
  start: When;
  /** Timed events: milliseconds from start to end. All-day events: days covered. */
  length: number;
  rule?: Rule;
  excluded: Set<string>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Reads the events of an iCalendar file as rows `{summary, start, end, allday, location,
 * description, uid}` with local times. Repeating events become one row per occurrence from a year
 * before `now` to a year after; a rule this reader doesn't understand leaves the event as one row.
 * Events that can't be read are left out.
 */
export function parseICS(text: string, now: Date): Row[] {
  const events = eventsOf(text);
  // An edited occurrence of a repeating event comes as its own event; the original is dropped.
  const replaced = new Map<string, Set<string>>();
  for (const props of events) {
    const id = props.find((p) => p.name === "RECURRENCE-ID");
    const when = id && whenOf(id);
    if (!when) continue;
    const uid = textOf(props, "UID");
    if (!replaced.has(uid)) replaced.set(uid, new Set());
    for (const k of keysOf(when)) replaced.get(uid)!.add(k);
  }
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date(now);
  to.setFullYear(to.getFullYear() + 1);

  const rows: Row[] = [];
  for (const props of events) {
    try {
      if (/^cancelled$/i.test(textOf(props, "STATUS"))) continue;
      const ev = readEvent(props);
      if (!ev) continue;
      for (const k of replaced.get(ev.uid) ?? []) ev.excluded.add(k);
      const isOverride = props.some((p) => p.name === "RECURRENCE-ID");
      if (ev.rule && !isOverride) rows.push(...occurrences(ev, ev.rule, from.getTime(), to.getTime()));
      else rows.push(rowOf(ev, ev.start));
    } catch {
      // One bad event doesn't spoil the calendar.
    }
  }
  return rows.sort((a, b) => (String(a.start) < String(b.start) ? -1 : String(a.start) > String(b.start) ? 1 : 0));
}

// ---- Lines ------------------------------------------------------------------------------------

/** The VEVENTs of a file, each as its own content lines; alarms and other parts inside one are left out. */
function eventsOf(text: string): Prop[][] {
  const lines = text.replace(/\r\n?|\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: Prop[][] = [];
  let current: Prop[] | undefined;
  let nested = 0;
  for (const line of lines) {
    const prop = propOf(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      if (current) nested++;
      else if (prop.value.toUpperCase() === "VEVENT") current = [];
    } else if (prop.name === "END") {
      if (current && nested) nested--;
      else if (current && prop.value.toUpperCase() === "VEVENT") {
        events.push(current);
        current = undefined;
      }
    } else if (current && !nested) {
      current.push(prop);
    }
  }
  return events;
}

/** Splits at `sep` outside double quotes. */
function splitUnquoted(text: string, sep: string): string[] {
  const parts: string[] = [];
  let quoted = false, from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === sep && !quoted) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** `NAME;PARAM=a;PARAM2="b":value` */
function propOf(line: string): Prop | undefined {
  const [head, ...rest] = splitUnquoted(line, ":");
  if (!head || rest.length === 0) return undefined;
  const [name, ...params] = splitUnquoted(head, ";");
  const out: Record<string, string> = {};
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq > 0) out[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params: out, value: rest.join(":") };
}

const unescape = (v: string) => v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

function textOf(props: Prop[], name: string): string {
  const p = props.find((q) => q.name === name);
  return p ? unescape(p.value) : "";
}

// ---- Times ------------------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat | null>();

/** The formatter that reads a clock in a zone; null for a zone this runtime doesn't know. */
function formatIn(zone: string): Intl.DateTimeFormat | null {
  let f = formats.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      });
    } catch {
      f = null;
    }
    formats.set(zone, f);
  }
  return f;
}

/** How far ahead of UTC the zone's clock is at that moment. */
function offsetAt(t: number, f: Intl.DateTimeFormat): number {
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(t)) if (p.type !== "literal") v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - t;
}

/** The moment a clock reading (as if it were UTC) was in a zone; the second pass settles clock changes. */
function inZone(clock: number, zone: string): number {
  if (zone === "UTC") return clock;
  const f = formatIn(zone)!;
  const first = offsetAt(clock, f);
  const t = clock - first;
  const second = offsetAt(t, f);
  return second === first ? t : clock - second;
}

function instant(w: When): number {
  const d = new Date(w.day * DAY);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  const [h, mi] = [Math.floor(w.minutes / 60), w.minutes % 60];
  return w.zone ? inZone(Date.UTC(y, m, day, h, mi), w.zone) : new Date(y, m, day, h, mi).getTime();
}

function dateText(day: number): string {
  const d = new Date(day * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `20261224`, `20261224T180000`, `20261224T180000Z`, with TZID and VALUE=DATE as parameters. */
function parseWhen(value: string, params: Record<string, string>): When | undefined {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!m) return undefined;
  const day = Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY;
  const check = new Date(day * DAY);
  if (check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]) return undefined;
  if (m[4] === undefined || params.VALUE?.toUpperCase() === "DATE") return { allday: true, day, minutes: 0 };
  const zone = m[7] ? "UTC" : params.TZID && formatIn(params.TZID) ? params.TZID : undefined;
  return { allday: false, day, minutes: +m[4] * 60 + +m[5], zone };
}

const whenOf = (p: Prop) => parseWhen(p.value, p.params);

/** What a moment is called when another says it is the same one: a day, or an exact time. */
function keysOf(w: When): string[] {
  return w.allday ? [`d${w.day}`] : [`t${instant(w)}`];
}

/** `P1D`, `PT1H30M`, `P2W`, as milliseconds. */
function durationMs(value: string): number | undefined {
  const m = value.trim().match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m || !m.slice(1).some(Boolean)) return undefined;
  const [w, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  return (((w * 7 + d) * 24 + h) * 60 + mi) * 60_000 + s * 1000;
}

// ---- Events -----------------------------------------------------------------------------------

function readEvent(props: Prop[]): Ev | undefined {
  const startProp = props.find((p) => p.name === "DTSTART");
  const start = startProp && whenOf(startProp);
  if (!start) return undefined;
  const endProp = props.find((p) => p.name === "DTEND");
  const end = endProp && whenOf(endProp);
  const dur = props.find((p) => p.name === "DURATION");
  const span = dur && durationMs(dur.value);

  let length: number;
  if (start.allday) {
    const days = end ? end.day - start.day : span !== undefined ? Math.round(span / DAY) : 1;
    length = Math.max(1, days);
  } else {
    length = Math.max(0, end ? instant(end) - instant(start) : span ?? 0);
  }

  const excluded = new Set<string>();
  for (const p of props) {
    if (p.name !== "EXDATE") continue;
    for (const v of p.value.split(",")) {
      const w = parseWhen(v, p.params);
      if (w) for (const k of keysOf(w)) excluded.add(k);
    }
  }
  const rrule = props.find((p) => p.name === "RRULE");
  return {
    uid: textOf(props, "UID"),
    summary: textOf(props, "SUMMARY"),
    location: textOf(props, "LOCATION"),
    description: textOf(props, "DESCRIPTION"),
    start,
    length,
    rule: rrule && ruleOf(rrule.value),
    excluded,
  };
}

function rowOf(ev: Ev, w: When): Row {
  const base = { summary: ev.summary };
  const rest = { location: ev.location, description: ev.description, uid: ev.uid };
  if (w.allday) return { ...base, start: dateText(w.day), end: dateText(w.day + ev.length - 1), allday: true, ...rest };
  const t = instant(w);
  return { ...base, start: minuteIn(t), end: minuteIn(t + ev.length), allday: false, ...rest };
}

// ---- Recurrence -------------------------------------------------------------------------------

/** The rule, or undefined when it holds anything beyond what is expanded here. */
function ruleOf(text: string): Rule | undefined {
  const parts = new Map<string, string>();
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) return undefined;
    parts.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  if ([...parts.keys()].some((k) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"].includes(k))) return undefined;
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return undefined;
  const number = (key: string, fallback: number | undefined) => {
    const v = parts.get(key);
    return v === undefined ? fallback : /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  };
  const interval = number("INTERVAL", 1)!;
  const count = number("COUNT", undefined);
  if (Number.isNaN(interval) || Number.isNaN(count)) return undefined;

  let until: When | undefined;
  if (parts.has("UNTIL")) {
    until = parseWhen(parts.get("UNTIL")!, {});
    if (!until) return undefined;
  }
  const byday: number[] = [];
  if (parts.has("BYDAY")) {
    if (freq !== "WEEKLY") return undefined;
    for (const d of parts.get("BYDAY")!.toUpperCase().split(",")) {
      const i = WEEKDAYS.indexOf(d);
      if (i < 0) return undefined;
      byday.push(i);
    }
  }
  const wkst = WEEKDAYS.indexOf((parts.get("WKST") ?? "MO").toUpperCase());
  if (wkst < 0) return undefined;
  return { freq, interval, count, until, byday, wkst };
}

/** Monday = 0; day 0 (1970-01-01) was a Thursday. */
const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The days a rule falls on, in order and without end; dates a month or year doesn't have are skipped. */
function* days(rule: Rule, start: number): Generator<number> {
  const first = new Date(start * DAY);
  const [y, m, d] = [first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()];
  for (let n = 0; n < MAX_STEPS; n++) {
    const step = n * rule.interval;
    if (rule.freq === "DAILY") {
      yield start + step;
    } else if (rule.freq === "WEEKLY") {
      const offsets = (rule.byday.length ? rule.byday : [weekdayOf(start)]).map((w) => (w - rule.wkst + 7) % 7).sort((a, b) => a - b);
      const weekStart = start - ((weekdayOf(start) - rule.wkst + 7) % 7);
      for (const o of offsets) if (weekStart + 7 * step + o >= start) yield weekStart + 7 * step + o;
    } else if (rule.freq === "MONTHLY") {
      const month = m + step;
      const [yy, mm] = [y + Math.floor(month / 12), month % 12];
      if (d <= daysIn(yy, mm)) yield Date.UTC(yy, mm, d) / DAY;
    } else if (d <= daysIn(y + step, m)) {
      yield Date.UTC(y + step, m, d) / DAY;
    }
  }
}

function occurrences(ev: Ev, rule: Rule, from: number, to: number): Row[] {
  const rows: Row[] = [];
  const allday = ev.start.allday;
  // A date-only UNTIL ends at the end of that day, as the event's clock reads it.
  const until = rule.until && (allday ? rule.until.day : instant(rule.until.allday ? { ...rule.until, allday: false, minutes: 1439, zone: ev.start.zone } : rule.until));
  let counted = 0, steps = 0;
  for (const day of days(rule, ev.start.day)) {
    if (++steps > MAX_STEPS) break;
    const w: When = { ...ev.start, day };
    const t = instant(w);
    if (until !== undefined && (allday ? day : t) > until) break;
    if (rule.count !== undefined && ++counted > rule.count) break;
    if (t > to) break;
    if (t < from) continue;
    if (keysOf(w).some((k) => ev.excluded.has(k)) || (!allday && ev.excluded.has(`d${day}`))) continue;
    rows.push(rowOf(ev, w));
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}
