import { daysInMonth, stampOf, stampParts, toTime } from "./time.ts";
import type { PanelSpec } from "./spec.ts";
import { nearMiss } from "./template.ts";
import { asField, convert, quantityIn, typedAs, unitDef, unitOf, type FieldUnit, type UnitBy, type UnitDef } from "./units.ts";
import { typedFields } from "./panel.ts";
import { GIZMO_LINK } from "./links.ts";

/** A shortcut a capture line can run: a form, button or checklist with a name to type. */
export interface CaptureTarget {
  /** The name typed first on the line, in lowercase: the panel's alias (which may be several words), else its shortcut. */
  name: string;
  path: string;
  app: string;
  shortcut: string;
  label: string;
  view: "form" | "button" | "checklist";
  /** A form's fields in the order they are declared, each with its type; a checklist's items. */
  fields: [string, string | string[]][];
  items: string[];
  /** It saves to a kind, where a time still to come plans a row (see readWhen). */
  ahead?: boolean;
  /** The form's number fields that say their unit, each with it (see units.ts). */
  units?: FieldUnits;
}

/** Each number field with a unit: its one unit, or the unit that another field of the row gives it. */
export type FieldUnits = Record<string, FieldUnit | UnitBy>;

/** The fields of a form that have a unit, from what its fields say besides their types; undefined when none has. */
export function unitsOf(info: Record<string, { unit?: string; rates?: Record<string, number>; unitBy?: { field: string; units: Record<string, string> } }> | undefined, fields: readonly (readonly [string, string | string[]])[]): FieldUnits | undefined {
  const out: FieldUnits = {};
  for (const [name] of fields) {
    const i = info?.[name];
    if (i?.unit !== undefined) out[name] = { unit: i.unit, ...(i.rates && { rates: i.rates }) };
    else if (i?.unitBy) out[name] = { by: i.unitBy.field, units: i.unitBy.units };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Every name a capture line can start with, and the names that point at more than one shortcut. */
export interface CaptureIndex {
  names: Map<string, CaptureTarget>;
  clashes: Map<string, CaptureTarget[]>;
}

/** An app as the capture line sees it: its note, its name and its shortcuts' checked panels. */
export interface CaptureApp {
  path: string;
  name: string;
  shortcuts: ReadonlyMap<string, PanelSpec>;
}

const VIEWS = new Set(["form", "button", "checklist"]);

/**
 * The names a capture line can start with. A panel's alias is its name, and so is its shortcut
 * when no other shortcut in the vault has that name. A name that would point at two shortcuts
 * points at neither; the line says which apps share it.
 */
export function captureTargets(apps: Iterable<CaptureApp>): CaptureIndex {
  const byName = new Map<string, CaptureTarget[]>();
  const shortcutCount = new Map<string, number>();
  const all: { target: CaptureTarget; alias?: string }[] = [];
  for (const app of apps) {
    for (const [shortcut, ps] of app.shortcuts) {
      const p = ps.panel;
      if (!VIEWS.has(p.view)) continue;
      const fields = Object.entries(typedFields(p));
      const units = unitsOf(p.fieldInfo, fields);
      const target: CaptureTarget = {
        name: (p.alias ?? shortcut).toLowerCase(), path: app.path, app: app.name, shortcut,
        // A form's title says what it's for better than its button's label, as the activity log names it.
        label: p.title ?? p.label ?? shortcut, view: p.view as CaptureTarget["view"],
        fields, items: (p.items ?? []).map(String),
        ...(p.target?.kind === "list" && p.target.at !== undefined && { ahead: true }),
        ...(units && { units }),
      };
      all.push({ target, alias: p.alias });
      shortcutCount.set(shortcut, (shortcutCount.get(shortcut) ?? 0) + 1);
    }
  }
  const add = (name: string, target: CaptureTarget) => {
    const list = byName.get(name) ?? [];
    if (!list.includes(target)) list.push(target);
    byName.set(name, list);
  };
  for (const { target, alias } of all) {
    if (alias !== undefined) add(alias.toLowerCase(), target);
    // A shortcut's own name only reaches it while no other app has a shortcut by that name.
    if (shortcutCount.get(target.shortcut) === 1 || alias === undefined) add(target.shortcut, target);
  }
  const names = new Map<string, CaptureTarget>();
  const clashes = new Map<string, CaptureTarget[]>();
  for (const [name, list] of byName) {
    if (list.length === 1) names.set(name, list[0].name === name ? list[0] : { ...list[0], name });
    else clashes.set(name, list);
  }
  return { names, clashes };
}

/**
 * What a capture line would run, or why it can't, with what could come next. `params` are what a
 * link would carry, `at=` included for a line that ends in `@when`; `at` is that time, to show, and
 * `plan` every time an `@every` plans a row for.
 */
export type Parsed =
  | { ok: true; target: CaptureTarget; params?: Record<string, string>; at?: Date; plan?: Date[]; next?: string; rest?: string }
  | { ok: false; error: string; target?: CaptureTarget; completions: string[]; next?: string };

/** One word of a line, or one `"…"` value. */
export interface Token {
  text: string;
  /** `name=` before the value, for a value given by its field's name. */
  name?: string;
  quoted: boolean;
}

/** The words of a line; `"…"` keeps spaces in one value, also after `name=`. */
export function tokenize(line: string): Token[] | { error: string } {
  const out: Token[] = [];
  const re = /\s*(?:([a-z0-9_-]+)=)?(?:"([^"]*)("?)|(\S+))/giy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < line.length && (m = re.exec(line))) {
    if (m[2] !== undefined && m[3] !== '"') return { error: "a quote isn't closed" };
    if (m[2] === undefined && m[4] === undefined) break;
    out.push({ text: m[2] ?? m[4], name: m[1]?.toLowerCase(), quoted: m[2] !== undefined });
    if (!/\S/.test(line.slice(re.lastIndex))) break;
  }
  return out;
}

const WEEKDAYS: [string, string[]][] = [
  ["sun", ["sun", "sunday"]], ["mon", ["mon", "monday"]], ["tue", ["tue", "tues", "tuesday"]],
  ["wed", ["wed", "wednesday"]], ["thu", ["thu", "thur", "thurs", "thursday"]], ["fri", ["fri", "friday"]],
  ["sat", ["sat", "saturday"]],
];

function weekday(word: string): number | undefined {
  const i = WEEKDAYS.findIndex(([, names]) => names.includes(word));
  return i < 0 ? undefined : i;
}

function shifted(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
}

/** A real calendar day as `YYYY-MM-DD`, or undefined for one like 02-30. */
function day(y: number, m: number, d: number): string | undefined {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? stampParts(date).date : undefined;
}

/**
 * A date typed on a capture line, as `YYYY-MM-DD`: today, yesterday (yday), tomorrow, +3d or -2d,
 * a weekday (the next one after today), `last` and a weekday (the one before today), MM-DD in
 * this year, or YYYY-MM-DD. `following` is the word after it, read for `last <weekday>`; `used`
 * says how many words it took.
 */
export function captureDate(word: string, following: string | undefined, now: Date): { value: string; used: number } | undefined {
  const w = word.toLowerCase();
  const rel: Record<string, number> = { today: 0, yesterday: -1, yday: -1, tomorrow: 1 };
  if (Object.hasOwn(rel, w)) return { value: stampParts(shifted(now, rel[w])).date, used: 1 };
  const offset = w.match(/^([+-])(\d{1,4})d$/);
  if (offset) return { value: stampParts(shifted(now, (offset[1] === "-" ? -1 : 1) * Number(offset[2]))).date, used: 1 };
  const wd = weekday(w);
  if (wd !== undefined) return { value: stampParts(shifted(now, ((wd - now.getDay() + 6) % 7) + 1)).date, used: 1 };
  if (w === "last" && following !== undefined) {
    const back = weekday(following.toLowerCase());
    if (back !== undefined) return { value: stampParts(shifted(now, -(((now.getDay() - back + 6) % 7) + 1))).date, used: 2 };
  }
  const md = w.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    const value = day(now.getFullYear(), Number(md[1]), Number(md[2]));
    return value ? { value, used: 1 } : undefined;
  }
  const ymd = w.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const value = day(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    return value ? { value, used: 1 } : undefined;
  }
  return undefined;
}

/** A time typed on a capture line as `HH:MM`: 8:15, 08:15, 8am, 8:15pm, 12am is midnight. */
export function captureTime(word: string): string | undefined {
  const m = word.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m || (m[2] === undefined && m[3] === undefined)) return undefined;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return undefined;
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 23) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Why a form with a field of its own called at can't be told, with `how` (`@`, `at=`), when its row is logged for. */
export const ownAt = (name: string, how: string) => `${name} has a field called at, so ${how} can't give the time it's logged for`;

/** Why a row can't be logged for a time still to come: rows record what happened. */
export const NOT_YET = "can't log for a time that hasn't come yet";

/** The most rows one `@every` plans: a year of days. */
export const MAX_PLANNED = 366;

/** What `@every` repeats by, also written as a plural after a count (`every 3 months`). */
const EVERY = ["day", "week", "month", "year"] as const;

/**
 * A day a row is logged for, as `YYYY-MM-DD`: the words captureDate reads, except that a weekday
 * or a month and day is the latest one, today included, since what is logged has happened, and
 * `last` and a weekday is the one a week before that.
 */
export function pastDate(word: string, following: string | undefined, now: Date): { value: string; used: number } | undefined {
  const w = word.toLowerCase();
  const back = (wd: number) => (now.getDay() - wd + 7) % 7;
  const wd = weekday(w);
  if (wd !== undefined) return { value: stampParts(shifted(now, -back(wd))).date, used: 1 };
  const lastWd = w === "last" && following !== undefined ? weekday(following.toLowerCase()) : undefined;
  if (lastWd !== undefined) return { value: stampParts(shifted(now, -back(lastWd) - 7)).date, used: 2 };
  const md = w.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    const [m, d] = [Number(md[1]), Number(md[2])];
    const value = day(now.getFullYear(), m, d);
    if (value === undefined) return undefined;
    return { value: value > stampParts(now).date ? day(now.getFullYear() - 1, m, d) ?? value : value, used: 1 };
  }
  return captureDate(word, following, now);
}

/** When a row is logged or planned for: one time, or with `plan` every time an `@every` gives, the first of them in `at`. */
export type When = { at: Date; plan?: Date[] };

const MONTH_WORD = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/;

/**
 * A day `from` or `until` names, as `YYYY-MM-DD`: the words a date field takes (see captureDate), or
 * a month and a day (`dec 5`, `december 5`). A month and a day with no year, either way (`12-05`
 * too), is the next one, today included, since a plan looks ahead.
 */
function dayAhead(words: readonly string[], now: Date): { value: string; used: number } | undefined {
  const [first, second] = words.map((w) => w.toLowerCase());
  if (first === undefined) return undefined;
  return nextMonthDay(words, now) ?? captureDate(first, second, now);
}

/** A month and a day with no year (`dec 5`, `december 5`, `12-05`), as the next one, today included; undefined for other words. */
function nextMonthDay(words: readonly string[], now: Date): { value: string; used: number } | undefined {
  const [first, second] = words.map((w) => w.toLowerCase());
  if (first === undefined) return undefined;
  const named = MONTH_WORD.test(first) && second !== undefined && /^\d{1,2}$/.test(second) ? [MONTHS.findIndex((m) => first.startsWith(m.toLowerCase())) + 1, Number(second), 2] : undefined;
  const dashed = /^(\d{1,2})-(\d{1,2})$/.exec(first);
  const md = named ?? (dashed ? [Number(dashed[1]), Number(dashed[2]), 1] : undefined);
  if (!md) return undefined;
  const [m, d, used] = md;
  const value = day(now.getFullYear(), m, d);
  if (value === undefined) return undefined;
  return { value: value < stampParts(now).date ? day(now.getFullYear() + 1, m, d) ?? value : value, used };
}

const EVERY_HELP = "say every day, week, month or year, or a count of them, until a date, e.g. @every month until 2027-06-01, @every day 08:00 until dec 5 or @every 3 months from 2026-12-12 until 2028-01-01";

/**
 * The times `every [<n>] <day|week|month|year> [from <day>] [<time>] until <day>` gives: from that
 * day (today when no `from`), at that time of day (the time now when none), then one each n periods
 * to the end of the `until` day, only those still to come, at most MAX_PLANNED. With neither `from`
 * nor a time, that makes the first one n periods from now, as it always has. A month or a year keeps
 * the first one's day, or the month's last day when it has fewer.
 */
function readEvery(words: readonly string[], now: Date): When | { error: string } | undefined {
  const [, ...after] = words;
  const count = /^\d+$/.test(after[0] ?? "") ? Number(after.shift()) : 1;
  const [per, ...rest] = after;
  const word = per?.toLowerCase();
  const period = (EVERY as readonly string[]).find((p) => word === p || word === `${p}s`);
  if (period === undefined) return per === undefined && words.length === 1 ? undefined : { error: EVERY_HELP };
  if (count < 1) return { error: "the count after every must be 1 or more, e.g. every 3 months" };
  let i = 0;
  let from = stampParts(now).date;
  if (rest[i]?.toLowerCase() === "from") {
    const d = dayAhead(rest.slice(i + 1, i + 3), now);
    if (!d) return { error: `from must be a day (2026-12-01, dec 1, mon, tomorrow), not “${rest.slice(i + 1).join(" ")}”` };
    from = d.value;
    i += 1 + d.used;
  }
  const time = rest[i] === undefined ? undefined : captureTime(rest[i]);
  if (time !== undefined) i++;
  if (rest[i]?.toLowerCase() !== "until" || i + 1 >= rest.length) return { error: EVERY_HELP };
  const date = rest.slice(i + 1);
  const end = dayAhead(date, now);
  if (!end || end.used !== date.length) return { error: `until must be a date (2027-06-01, dec 5, 06-01, +30d), not “${date.join(" ")}”` };
  const [y, m, d] = end.value.split("-").map(Number);
  const last = new Date(y, m - 1, d, 23, 59, 59).getTime();
  const [fy, fm, fd] = from.split("-").map(Number);
  const [h, mi] = time ? time.split(":").map(Number) : [now.getHours(), now.getMinutes()];
  const start = new Date(fy, fm - 1, fd, h, mi);
  const plan: Date[] = [];
  for (let k = 0; ; k++) {
    const n = k * count;
    const t = period === "day" ? new Date(fy, fm - 1, fd + n, h, mi) : period === "week" ? new Date(fy, fm - 1, fd + 7 * n, h, mi) : monthOn(start, period === "year" ? 12 * n : n);
    if (t.getTime() > last) break;
    if (t.getTime() <= now.getTime()) continue;
    if (plan.length === MAX_PLANNED) return { error: `that plans more than ${MAX_PLANNED} rows; pick a nearer date or a longer period` };
    plan.push(t);
  }
  return plan.length ? { at: plan[0], plan } : { error: `until ${end.value} comes before the first ${count > 1 ? "time" : period} still to come` };
}

/** The same day of the month `k` months after `start`, at its time of day; a month's last day when it has fewer days. */
function monthOn(start: Date, k: number): Date {
  const y = start.getFullYear() + Math.floor((start.getMonth() + k) / 12);
  const m = (start.getMonth() + k) % 12;
  return new Date(y, m, Math.min(start.getDate(), daysInMonth(y, m)), start.getHours(), start.getMinutes());
}

/**
 * The time the words after `@` give, every word used: a time (today), a day (at this time of day),
 * or a day and a time. Undefined when they aren't one; why not, for a time still to come. With
 * `ahead` (a line that saves to a kind), a time still to come plans a row, and so does each time of
 * `every <day|week|month> until <date>`.
 */
function readWhen(words: readonly string[], now: Date, ahead = false): When | { error: string } | undefined {
  const [first, ...more] = words;
  if (!first) return undefined;
  if (ahead && first.toLowerCase() === "every") return readEvery(words, now);
  let date = stampParts(now).date;
  let time = more.length ? undefined : captureTime(first);
  if (time === undefined) {
    // A line that plans looks ahead: a month and a day with no year is the next one there.
    const d = (ahead ? nextMonthDay(words, now) : undefined) ?? pastDate(first, more[0], now);
    const rest = d ? more.slice(d.used - 1) : [];
    if (!d || rest.length > 1) return undefined;
    date = d.value;
    time = rest.length ? captureTime(rest[0]) : stampParts(now).time;
    if (time === undefined) return undefined;
  }
  const [y, m, dd] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const at = new Date(y, m - 1, dd, h, mi);
  return at.getTime() > now.getTime() && !ahead ? { error: NOT_YET } : { at };
}

/**
 * A trailing `@when` taken off a line's values: `@yday`, `@8am`, `@fri 13:00`, `@last mon 8:15`.
 * Only when what follows the last `@` reads as a time to the line's end; anything else (an
 * address, `lunch @ cafe`, a quoted or named value) stays a value.
 */
export function takeWhen(tokens: readonly Token[], now: Date, ahead = false): { tokens: Token[]; at?: Date; plan?: Date[]; error?: string } {
  const plain = (t: Token) => !t.quoted && t.name === undefined;
  let i = tokens.length - 1;
  while (i >= 0 && plain(tokens[i]) && !tokens[i].text.startsWith("@")) i--;
  const head = tokens[i];
  if (!head || !plain(head) || head.text.length < 2) return { tokens: [...tokens] };
  const when = readWhen([head.text.slice(1), ...tokens.slice(i + 1).map((t) => t.text)], now, ahead);
  if (!when) return { tokens: [...tokens] };
  if ("error" in when) return { tokens: tokens.slice(0, i), error: when.error };
  return { tokens: tokens.slice(0, i), at: when.at, ...(when.plan && { plan: when.plan }) };
}


/**
 * A time to log a row for, as a link's `at=` gives it: the words a line takes after `@` (yday,
 * fri 13:00, 8am), or a stamp (`2026-11-19T08:14-08:00`); never one still to come.
 */
export function logTime(text: string, now: Date, ahead = false): When | { error: string } {
  const typed = text.trim().replace(/^@/, "");
  const read = readWhen(typed.split(/\s+/), now, ahead);
  if (read) return read;
  const t = /^\d{4}-\d{2}-\d{2}T/.test(typed) ? toTime(typed) : undefined;
  if (t === undefined) return { error: `at must be a time (yday, fri 13:00, 8am, 2026-11-19T08:14), not “${text}”` };
  return t > now.getTime() && !ahead ? { error: NOT_YET } : { at: new Date(t) };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as a preview says it: `Thu Nov 19`, with its year when not this one's. */
export function dayText(at: Date, now: Date): string {
  const year = at.getFullYear() === now.getFullYear() ? "" : ` ${at.getFullYear()}`;
  return `${DAYS[at.getDay()]} ${MONTHS[at.getMonth()]} ${at.getDate()}${year}`;
}

/** A time a row is logged for, as a preview says it: `Thu Nov 19, 13:00`, with its year when not this one's. */
export function whenText(at: Date, now: Date): string {
  return `${dayText(at, now)}, ${stampParts(at).time}`;
}

/** When a row saved to a kind is for, as a preview says it: planned for a time still to come, or each time of an `@every`. */
export function plannedText(when: When, now: Date): string | undefined {
  const plan = when.plan;
  if (plan && plan.length > 1) return `planned ${plan.length} times, ${whenText(plan[0], now)} to ${whenText(plan[plan.length - 1], now)}`;
  return when.at.getTime() > now.getTime() ? `planned for ${whenText(when.at, now)}` : undefined;
}

/** A number as a capture line takes it: digits, a point, a sign; no thousands separators. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const YES = ["yes", "y", "true"];
const NO = ["no", "n", "false"];

/** A choice from the list: the one written so, else the only one starting with what was typed, case aside. */
function choiceOf(options: string[], word: string): { value: string } | { error: string } {
  const w = word.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === w);
  if (exact !== undefined) return { value: exact };
  const starting = options.filter((o) => o.toLowerCase().startsWith(w));
  if (starting.length === 1) return { value: starting[0] };
  return { error: starting.length ? `“${word}” could be ${starting.join(" or ")}` : `must be one of ${options.join(", ")}` };
}

/** What a field takes, as the line's hint says it. */
function describe(name: string, type: string | string[]): string {
  if (Array.isArray(type)) return `${name}: ${type.map(String).join(", ")}`;
  const words: Record<string, string> = {
    number: "a number", date: "a date (today, yday, fri, 11-03)", time: "a time (8:15, 8am)",
    checkbox: "yes or no", text: "text", textarea: "text",
  };
  return `${name}: ${words[type] ?? type}`;
}

/** Completions for a field from what has been typed of its value. */
function completionsFor(type: string | string[], typed: string): string[] {
  const w = typed.toLowerCase();
  const pool = Array.isArray(type) ? type.map(String) : type === "checkbox" ? ["yes", "no"] : type === "date" ? ["today", "yesterday", "tomorrow"] : [];
  return pool.filter((o) => o.toLowerCase().startsWith(w));
}

/** One value typed for a field, as the link text its type reads; or why it doesn't fit. */
function readValue(name: string, type: string | string[], words: string[], now: Date): { value: string; used: number } | { error: string } {
  const word = words[0];
  if (Array.isArray(type)) {
    const c = choiceOf(type.map(String), word);
    return "value" in c ? { value: c.value, used: 1 } : { error: `${name} ${c.error}` };
  }
  switch (type) {
    case "number":
      return NUMBER.test(word) ? { value: String(Number(word)), used: 1 } : { error: `${name} must be a number, not “${word}”` };
    case "date": {
      const d = captureDate(word, words[1], now);
      return d ?? { error: `${name} must be a date (today, yday, fri, last mon, 11-03, 2026-11-03), not “${word}”` };
    }
    case "time": {
      const t = captureTime(word);
      return t ? { value: t, used: 1 } : { error: `${name} must be a time (8:15, 8am, 8:15pm), not “${word}”` };
    }
    case "checkbox": {
      const w = word.toLowerCase();
      return YES.includes(w) ? { value: "true", used: 1 } : NO.includes(w) ? { value: "false", used: 1 } : { error: `${name} must be yes or no, not “${word}”` };
    }
    default:
      return { value: word, used: 1 };
  }
}

/**
 * Reads a capture line: the name of a shortcut, then its values. A form's values fill its fields
 * in the order they are declared, each read as its type; a text field takes one word, or the rest
 * of the line when it is the last field left or what follows can't be the next field's value
 * (see strictValues); `name=value` fills a field by its name and `"…"` keeps spaces in a value. A
 * checklist takes the item to tick, a button nothing. Nothing is guessed: anything unclear is an
 * error, with what could be typed instead.
 */
export function parseLine(line: string, index: CaptureIndex, now: Date): Parsed {
  // A link or a phone's shortcut could carry more than one line; like any link's value, that is refused whole.
  if (/[\r\n]/.test(line)) return { ok: false, error: "a capture line is one line", completions: [] };
  const text = line.trim();
  const all = [...index.names.keys()].sort();
  if (!text || /^[^\s"=]+=/.test(text)) return { ok: false, error: "type the name of a shortcut", completions: all };
  // The longest name the line starts with, as a whole word or words: an alias may be several.
  const lower = text.toLowerCase();
  const names = [...index.names.keys(), ...index.clashes.keys()].sort((a, b) => b.length - a.length);
  const word = names.find((n) => lower === n || lower.startsWith(`${n} `)) ?? lower.split(/\s/)[0];
  const clash = index.clashes.get(word);
  if (clash) {
    return { ok: false, error: `“${word}” is a shortcut in ${clash.map((t) => t.app).join(" and ")}; give one of them an alias:`, completions: [] };
  }
  const target = index.names.get(word);
  if (!target) {
    // Names are offered while the name is being typed (all of it, as an alias may be several words).
    const completions = all.filter((n) => n.startsWith(lower));
    return { ok: false, error: `no shortcut called “${text.split(/\s/)[0]}”`, completions };
  }
  // The name as typed, in whatever case, is cut off the line's start; the values follow it.
  const typed = new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "iu").exec(text)?.[0] ?? word;
  const tokens = tokenize(text.slice(typed.length));
  if ("error" in tokens) return { ok: false, error: tokens.error, target, completions: [] };
  const rest = tokens;
  if (target.view === "button") {
    const when = takeWhen(rest, now, target.ahead);
    if (when.error) return { ok: false, error: when.error, target, completions: [] };
    if (when.tokens.length) return { ok: false, error: `${word} takes no values`, target, completions: [] };
    return when.at ? { ok: true, target, params: { at: atParam(when, rest) }, at: when.at, ...(when.plan && { plan: when.plan }) } : { ok: true, target };
  }
  if (target.view === "checklist") {
    const named = rest.find((t) => t.name !== undefined);
    if (named && named.name !== "item") return { ok: false, error: `${word} takes only an item to tick`, target, completions: [] };
    const item = (named ? [named] : rest).map((t) => t.text).join(" ");
    if (!item) return { ok: false, error: `say which item to tick`, target, completions: target.items, next: `item: ${target.items.join(", ")}` };
    const c = choiceOf(target.items, item);
    if ("error" in c) return { ok: false, error: `item ${c.error}`, target, completions: completionsFor(target.items, item) };
    return { ok: true, target, params: { item: c.value } };
  }
  return parseForm(target, rest, now);
}

/** What a link's `at=` carries for a line's `@when`: the time, or for an `@every`, its words, read again when it runs. */
function atParam(when: { at?: Date; plan?: Date[] }, tokens: readonly Token[]): string {
  if (!when.plan) return stampOf(when.at!);
  const i = tokens.findLastIndex((t) => !t.quoted && t.name === undefined && t.text.startsWith("@"));
  return [tokens[i].text.slice(1), ...tokens.slice(i + 1).map((t) => t.text)].join(" ");
}

function parseForm(target: CaptureTarget, tokens: Token[], now: Date): Parsed {
  const read = parseFields(tokens, target.fields, now, { name: target.name, ahead: target.ahead, units: target.units });
  const fail = (error: string, completions: string[] = [], next?: string): Parsed => ({ ok: false, error, target, completions, next });
  if (read.errors.length) return fail(read.errors[0], read.completions, read.next);
  // A form saved with nothing typed would be an empty row made by a slip of the Enter key.
  if (!Object.keys(read.params).length && target.fields.length) {
    const [name, type] = target.fields[0];
    return fail(`type what ${target.name} saves, starting with ${name}`, completionsFor(type, ""), describe(name, type));
  }
  // @ is run as a link's at=, which a form with a field of its own called at refuses.
  if (read.at && target.fields.some(([n]) => n === "at")) return fail(ownAt(target.name, "@"));
  const nextField = target.fields.find(([n]) => n === read.missing[0]);
  const next = read.rest !== undefined && read.missing.length ? `${read.missing.map((n) => `${n}=…`).join(" or ")} by name`
    : nextField ? describe(nextField[0], nextField[1]) : undefined;
  const rest = read.rest !== undefined && read.missing.length ? { rest: read.rest } : {};
  if (!read.at) return { ok: true, target, params: read.params, next, ...rest };
  return { ok: true, target, params: { ...read.params, at: atParam(read, tokens) }, at: read.at, ...(read.plan && { plan: read.plan }), next, ...rest };
}

/**
 * Why a line whose text field took the rest of it, while fields after it stay empty, isn't run
 * where nothing shows first what it would save (a keyed capture link, gizmod's keyed /do):
 * undefined when no field had to.
 */
export function swallowed(parsed: Parsed): string | undefined {
  if (!parsed.ok || parsed.rest === undefined) return undefined;
  return `“${parsed.params?.[parsed.rest]}” would all go in ${parsed.rest}; put it in quotes, or give ${parsed.next ?? "the fields after it by name"}`;
}

/** What the values on a line give a form's fields. */
export interface FieldValues {
  /**
   * Each field given a value, as the link text its type reads: a number's digits, `YYYY-MM-DD`,
   * `HH:MM`, `true` or `false`, a choice as the form lists it.
   */
  params: Record<string, string>;
  /** The fields given nothing, in the order they are declared. */
  missing: string[];
  /** Why the line can't be read as it stands; a strict read stops at the first. */
  errors: string[];
  /** What could be typed in place of the word the first error is about. */
  completions: string[];
  /** What the field the first error is about takes. */
  next?: string;
  /** When the row is logged for, from a trailing `@when`; undefined for now. */
  at?: Date;
  /** Every time an `@every` plans a row for, the first of them in `at`. */
  plan?: Date[];
  /** The text field that took the rest of the line though fields come after it, which then go by name. */
  rest?: string;
}

type FieldList = readonly (readonly [string, string | string[]])[];

const isText = (type: string | string[]) => type === "text" || type === "textarea";

/**
 * Reads a line's values into a form's fields; `name` is what the form is called in messages.
 * `name=value` fills a field by its name, in any case, and `"…"` keeps spaces in a value.
 *
 * Strict, as the Do… command reads: the other values fill the fields in the order they are
 * declared, each read as its type; a text field takes one word, or the rest of the line when it is
 * the last field left or the word after it can't be the next field's value. Nothing is guessed.
 *
 * Loose, as an add line reads: each value goes to the first open field it fits, wherever it is on
 * the line. A choice (written in full, or 3 letters or more of only one), a number, a date or a
 * time finds its field; a quoted value goes to the next text field; the words left over go to the
 * first text field, together.
 *
 * Either way, a trailing `@when` (see takeWhen) is the time the row is logged for, not a value.
 */
export function parseFields(input: string | readonly Token[], fields: FieldList, now: Date, how: { name: string; loose?: boolean; ahead?: boolean; units?: FieldUnits; picked?: ReadonlyMap<string, string> }): FieldValues {
  const out: FieldValues = { params: {}, missing: [], errors: [], completions: [] };
  const typed = typeof input === "string" ? tokenize(input) : input;
  if ("error" in typed) {
    out.errors.push(typed.error);
    out.missing = fields.map(([n]) => n);
    return out;
  }
  const types = new Map(fields);
  const params = out.params;
  const fail = (error: string, completions: string[] = [], next?: string) => {
    if (!out.errors.length) Object.assign(out, { completions, next });
    out.errors.push(error);
  };
  const when = takeWhen(typed, now, how.ahead);
  const waiting: Waiting[] = [];
  const tokens = how.units ? takeQuantities(when.tokens, how.units, fields, params, fail, waiting) : when.tokens;
  if (out.errors.length && !how.loose) return done(out, fields);
  if (when.at) out.at = when.at;
  if (when.plan) out.plan = when.plan;
  if (when.error) {
    fail(when.error);
    if (!how.loose) return done(out, fields);
  }
  for (const t of tokens) {
    if (t.name === undefined) continue;
    // Typed in any case; kept as the form spells it.
    const field = fields.find(([n]) => n.toLowerCase() === t.name)?.[0];
    if (field === undefined) fail(`${how.name} has no field “${t.name}”; its fields are ${fields.map(([n]) => n).join(", ")}`);
    else if (Object.hasOwn(params, field)) fail(`${field} is given twice`);
    else {
      const v = readValue(field, types.get(field)!, [t.text], now);
      if ("error" in v) fail(v.error, completionsFor(types.get(field)!, t.text));
      else params[field] = v.value;
    }
    if (out.errors.length && !how.loose) return done(out, fields);
  }
  const words = tokens.filter((t) => t.name === undefined);
  if (how.loose) looseValues(words, fields, now, params, fail);
  else {
    const rest = strictValues(words, fields, now, params, fail);
    if (rest !== undefined) out.rest = rest;
  }
  // A unit that another field gives is known only now, with that field read.
  for (const w of waiting) {
    // A choice picked beside the line (an add line's chip) is what the row will hold.
    const said = how.picked?.get(w.by.by) ?? params[w.by.by];
    const unit = said === undefined ? undefined : w.by.units[said];
    if (unit === undefined) {
      fail(said === undefined ? `${w.field} is typed in ${w.unit.id}; say which ${w.by.by} it is` : `${w.field} has no unit when ${w.by.by} is ${said}; type the number alone`);
      continue;
    }
    const c = convert(w.n, w.unit, { unit });
    if ("error" in c) fail(`${w.field} ${c.error}`);
    else {
      params[w.field] = String(c.value);
      if (w.unit.id !== unitOf(unit).id) params[asField(w.field)] = typedAs(w.n, w.unit, c.rate);
    }
  }
  return done(out, fields);
}

/** A quantity typed for a field whose unit another field gives, until that field is read. */
interface Waiting { field: string; n: number; unit: UnitDef; by: UnitBy }

/** Money codes that are everyday words, so `12 pen` may be a pen; refused all the same, as a silent 12 dollars could be wrong. */
const CODE_WORDS = new Set(["ALL", "BAM", "BOB", "COP", "CUP", "GEL", "MAD", "MOP", "PEN", "RUB", "TOP", "TRY"]);

/**
 * Values typed with their unit, for the fields that have one: `1500 jpy` or `1500jpy` into a dollar
 * field, `180 lb` into kilograms, by position or as `weight=180lb`. Each goes to the first open field
 * whose unit measures the same thing, as that field's own unit holds it; what was typed is kept
 * beside it (see asField) when it was converted. Gives the tokens left for the other fields. A
 * number with no unit is left for the usual reading, so `81.2` still means the field's own unit.
 * A field whose unit another field gives keeps its number as typed and goes to `waiting`.
 */
function takeQuantities(tokens: readonly Token[], units: FieldUnits, fields: FieldList, params: Record<string, string>, fail: Fail, waiting: Waiting[]): Token[] {
  const left: Token[] = [];
  // A plain number in a number field's place is that field's: `weigh 81.2 lifted 10kg` weighs 81.2.
  const spoken = new Set<string>();
  let placed = 0;
  const keep = (t: Token): void => {
    left.push(t);
    if (t.name !== undefined) return;
    const place = fields.filter(([n]) => !Object.hasOwn(params, n))[placed++];
    if (place?.[1] !== "number" || t.quoted || !NUMBER.test(t.text)) return;
    // With a plain number field still open it can go there, and a quantity may take this one: `2 5km`.
    if (!fields.some(([n, type]) => n !== place[0] && type === "number" && !units[n] && !Object.hasOwn(params, n))) spoken.add(place[0]);
  };
  const give = (field: string, n: number, unit: UnitDef, word?: string): void => {
    const to = units[field];
    if ("by" in to) {
      params[field] = String(n);
      return void waiting.push({ field, n, unit, by: to });
    }
    const c = convert(n, unit, to);
    if ("error" in c) return fail(`${field} ${c.error}${word && CODE_WORDS.has(unit.id) ? `, or put the words in quotes if "${word}" isn't money` : ""}`);
    params[field] = String(c.value);
    if (unit.id !== unitOf(to.unit).id) params[asField(field)] = typedAs(n, unit, c.rate);
  };
  const measures = (f: string, unit: UnitDef) => {
    const to = units[f];
    return "by" in to ? Object.values(to.units).some((u) => unitOf(u).dim === unit.dim) : unitOf(to.unit).dim === unit.dim;
  };
  const open = (unit: UnitDef) => Object.keys(units).find((f) => !Object.hasOwn(params, f) && !spoken.has(f) && measures(f, unit));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const joined = t.quoted ? undefined : quantityIn(t.text);
    // "5 in the park": a spaced `in` is inches only as the last word on the line.
    const prose = next?.text.toLowerCase() === "in" && tokens.slice(i + 2).some((later) => later.name === undefined);
    const apart = !t.quoted && NUMBER.test(t.text) && next && !next.quoted && next.name === undefined && !prose ? unitDef(next.text) : undefined;
    const q = joined ?? (apart ? { n: Number(t.text), unit: apart } : undefined);
    if (!q) {
      keep(t);
      continue;
    }
    const named = t.name === undefined ? undefined : Object.keys(units).find((f) => f.toLowerCase() === t.name);
    // A named value for a field with no unit, or a unit no open field measures, is read as it always was.
    const field = t.name === undefined ? open(q.unit) : named;
    if (field === undefined || Object.hasOwn(params, field)) {
      keep(t);
      continue;
    }
    give(field, q.n, q.unit, joined ? undefined : next.text);
    if (!joined) i++;
  }
  return left;
}

function done(out: FieldValues, fields: FieldList): FieldValues {
  out.missing = fields.map(([n]) => n).filter((n) => !Object.hasOwn(out.params, n));
  return out;
}

type Fail = (error: string, completions?: string[], next?: string) => void;

/**
 * Whether a word reads as meant for a field of this type, though it may not be one of its values: a
 * choice, or one a typo away (`Sma` for Sam); a number with a letter for a digit (`13O`) or a comma
 * for a point.
 */
function meantFor(word: string, type: string | string[]): boolean {
  if (Array.isArray(type)) {
    const options = type.map((o) => String(o).toLowerCase());
    const w = word.toLowerCase();
    return options.includes(w) || (w.length >= 3 && nearMiss(w, options.filter((o) => o.length >= 3)) !== undefined);
  }
  return type === "number" && /\d/.test(word) && !NUMBER.test(word) && NUMBER.test(word.replace(/[oO]/g, "0").replace(/[lI]/g, "1").replace(",", "."));
}

/**
 * The words fill the open fields in the order they are declared. A text field takes one word, or
 * the rest of the line when it is the last field left or the word after it can't be the next
 * field's value (`lunch with friends` before a number field); the fields after it then go by name.
 * It doesn't take the rest when a later word reads as meant for a later field (see meantFor), so a
 * typo there is told rather than kept as text.
 */
function strictValues(words: Token[], fields: FieldList, now: Date, params: Record<string, string>, fail: Fail): string | undefined {
  const open = fields.filter(([n]) => !Object.hasOwn(params, n));
  let w = 0;
  for (let f = 0; f < open.length && w < words.length; f++) {
    const [name, type] = open[f];
    const after = open[f + 1];
    const next = words[w + 1];
    const nextDoesNotFit = () => next !== undefined && !next.quoted && "error" in readValue(after[0], after[1], words.slice(w + 1).map((t) => t.text), now);
    const meantLater = () => words.slice(w + 1).some((t) => !t.quoted && open.slice(f + 1).some(([, later]) => meantFor(t.text, later)));
    if (isText(type) && !words[w].quoted && (after === undefined || (nextDoesNotFit() && !meantLater()))) {
      params[name] = words.slice(w).map((t) => t.text).join(" ");
      return after === undefined ? undefined : name;
    }
    const v = readValue(name, type, words.slice(w).map((t) => t.text), now);
    if ("error" in v) return void fail(v.error, completionsFor(type, words[w].text), describe(name, type));
    params[name] = v.value;
    w += v.used;
  }
  if (w < words.length) fail(`too many values: ${words.slice(w).map((t) => t.text).join(" ")}`);
  return undefined;
}

/** Each word goes to the first open field it fits; the rest go to the first text field. */
function looseValues(words: Token[], fields: FieldList, now: Date, params: Record<string, string>, fail: Fail): void {
  const open = (fits: (type: string | string[]) => boolean) => fields.find(([n, type]) => !Object.hasOwn(params, n) && fits(type))?.[0];
  const choice = (word: string, least: number) => {
    const w = word.toLowerCase();
    for (const [n, type] of fields) {
      if (Object.hasOwn(params, n) || !Array.isArray(type)) continue;
      const options = type.map(String);
      const exact = options.find((o) => o.toLowerCase() === w);
      const starting = w.length >= least ? options.filter((o) => o.toLowerCase().startsWith(w)) : [];
      const value = exact ?? (starting.length === 1 ? starting[0] : undefined);
      if (value !== undefined) return { field: n, value };
    }
    return undefined;
  };
  const left: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = words[i];
    const exact = choice(t.text, Infinity);
    if (exact) {
      params[exact.field] = exact.value;
      continue;
    }
    if (t.quoted) {
      const text = open(isText);
      if (text !== undefined) params[text] = t.text;
      else left.push(t);
      continue;
    }
    const number = open((type) => type === "number");
    if (number !== undefined && NUMBER.test(t.text)) {
      params[number] = String(Number(t.text));
      continue;
    }
    const date = open((type) => type === "date");
    const following = words[i + 1]?.quoted === false ? words[i + 1].text : undefined;
    const d = date === undefined ? undefined : captureDate(t.text, following, now);
    if (date !== undefined && d) {
      params[date] = d.value;
      i += d.used - 1;
      continue;
    }
    const time = open((type) => type === "time");
    const at = time === undefined ? undefined : captureTime(t.text);
    if (time !== undefined && at) {
      params[time] = at;
      continue;
    }
    const prefix = choice(t.text, 3);
    if (prefix) {
      params[prefix.field] = prefix.value;
      continue;
    }
    const box = open((type) => type === "checkbox");
    const yes = YES.includes(t.text.toLowerCase()), no = NO.includes(t.text.toLowerCase());
    if (box !== undefined && (yes || no)) {
      params[box] = String(yes);
      continue;
    }
    left.push(t);
  }
  if (!left.length) return;
  const text = open(isText);
  if (text !== undefined) {
    params[text] = left.map((t) => t.text).join(" ");
    return;
  }
  // No text field to take them: each word may still be the short start of a choice.
  for (const [k, t] of left.entries()) {
    const rest = fields.filter(([n]) => !Object.hasOwn(params, n));
    if (!rest.length) return fail(`too many values: ${left.slice(k).map((x) => x.text).join(" ")}`);
    const tries = rest.map(([n, type]) => [n, type, readValue(n, type, [t.text], now)] as const);
    const fits = tries.find(([, , v]) => "value" in v);
    if (fits && "value" in fits[2]) {
      params[fits[0]] = fits[2].value;
      continue;
    }
    const [n, type, v] = tries[0];
    return fail("error" in v ? v.error : `${n} can't take “${t.text}”`, completionsFor(type, t.text), describe(n, type));
  }
}

/**
 * A line with a completion taken, and a space after it to type the next value: a name replaces
 * all that was typed of it (an alias may be several words), a value replaces the last word.
 */
export function completed(line: string, completion: string): string {
  if (completion.toLowerCase().startsWith(line.trim().toLowerCase())) return `${completion} `;
  const at = /\S*$/.exec(line)!.index;
  const word = /\s/.test(completion) ? `"${completion}"` : completion;
  return `${line.slice(0, at)}${word} `;
}

/** A capture line in a note: the text after a leading `;;`, or undefined for any other line. */
export function captureLine(text: string): string | undefined {
  const m = /^\s*;;(.*)$/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * What a capture line becomes once it ran: a tick, the line, the app and the time, and a link to
 * what it changed in the activity log. It no longer starts with `;;`, so it never runs again.
 */
export function receipt(line: string, app: string, now: Date, entryId: string | undefined): string {
  const time = stampParts(now).time;
  const details = entryId ? ` · [details](${GIZMO_LINK}?activity=${encodeURIComponent(entryId)})` : "";
  return `✓ ${line} · ${app} · ${time}${details}`;
}
