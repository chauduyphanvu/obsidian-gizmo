import { parseFeed } from "./sources/feed.ts";
import { parseICS } from "./sources/ics.ts";
import type { Panel } from "./spec.ts";

export const AGGS = ["count", "sum", "avg", "min", "max", "first", "last", "streak", "share"] as const;
export type Agg = (typeof AGGS)[number];

export type Row = Record<string, unknown>;

/**
 * A shallow copy of a row, symbol-keyed properties included (enumerable or not), since a row's
 * identity may ride on one through the pipeline.
 */
export function copyRow(row: Row): Row {
  const out: Row = { ...row };
  for (const s of Object.getOwnPropertySymbols(row)) Object.defineProperty(out, s, Object.getOwnPropertyDescriptor(row, s)!);
  return out;
}

export function getPath(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
  // A key that itself contains dots ("Adj. Close", or a total stored under its field's path) wins.
  if (data !== null && typeof data === "object" && !Array.isArray(data) && Object.hasOwn(data, path)) {
    return (data as Row)[path];
  }
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^-?\d+$/.test(part)) {
      const i = Number(part);
      cur = cur[i < 0 ? cur.length + i : i];
    } else if (typeof cur === "object") {
      cur = (cur as Row)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined;
}

/** Epoch seconds, epoch ms, or a date string; anything else is not a time. */
export function toTime(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") {
    if (v > 1e11) return v;
    if (v > 1e8) return v * 1000;
    return undefined;
  }
  if (typeof v === "string") {
    const local = localStamp(v);
    if (local !== undefined) return local;
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return undefined;
    const t = Date.parse(v.length === 10 ? `${v}T00:00` : v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** The UTC date of a time as YYYY-MM-DD; undefined outside years 0 to 9999, which that can't write. */
function utcDay(t: number): string | undefined {
  if (!(Math.abs(t) <= 8.64e15)) return undefined;
  const iso = new Date(t).toISOString();
  return iso.length === 24 ? iso.slice(0, 10) : undefined;
}

/** Whether text is shaped like a stamp, YYYY-MM-DD or YYYY-MM-DDTHH:MM, whatever its numbers. */
function stampShape(v: string): boolean {
  if (v.length !== 10 && v.length !== 16) return false;
  if (twoDigits(v, 0) < 0 || twoDigits(v, 2) < 0 || v.charCodeAt(4) !== 45 || twoDigits(v, 5) < 0 || v.charCodeAt(7) !== 45 || twoDigits(v, 8) < 0) return false;
  return v.length === 10 || (v.charCodeAt(10) === 84 && twoDigits(v, 11) >= 0 && v.charCodeAt(13) === 58 && twoDigits(v, 14) >= 0);
}

/** The two digits at i as a number, or -1. */
function twoDigits(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48, b = s.charCodeAt(i + 1) - 48;
  return a >= 0 && a <= 9 && b >= 0 && b <= 9 ? a * 10 + b : -1;
}

/**
 * `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM`, the forms saving writes, read as Date.parse reads them (local
 * time, a day past the month's end rolling over) without its general parser. Undefined for any
 * other text, and for years below 100 or an hour of 24, which Date.parse is left to read.
 */
function localStamp(v: string): number | undefined {
  if (v.length !== 10 && v.length !== 16) return undefined;
  const century = twoDigits(v, 0), year = twoDigits(v, 2), month = twoDigits(v, 5), day = twoDigits(v, 8);
  if (century < 1 || year < 0 || v.charCodeAt(4) !== 45 || v.charCodeAt(7) !== 45 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (v.length === 10) return new Date(century * 100 + year, month - 1, day).getTime();
  const hour = twoDigits(v, 11), minute = twoDigits(v, 14);
  if (v.charCodeAt(10) !== 84 || v.charCodeAt(13) !== 58 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return new Date(century * 100 + year, month - 1, day, hour, minute).getTime();
}

/** Milliseconds in `30s`, `5m`, `1h`, `1d`; a bare number is minutes. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value * 60_000;
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "s"];
  return Number(m[1]) * unit;
}

export interface Point { x: unknown; y: number }

/** Builds chart points from either parallel arrays (x and y paths) or rows (x and y fields). */
export function seriesOf(data: unknown, x: string, y: string): Point[] {
  const xs = getPath(data, x);
  const ys = getPath(data, y);
  let points: { x: unknown; y: unknown }[];
  if (Array.isArray(xs) && Array.isArray(ys)) {
    points = xs.map((xv, i) => ({ x: xv, y: ys[i] }));
  } else if (Array.isArray(data)) {
    points = data.map((row) => ({ x: getPath(row, x), y: getPath(row, y) }));
  } else {
    points = [];
  }
  const out: Point[] = [];
  for (const p of points) {
    const n = toNumber(p.y);
    if (n !== undefined) out.push({ x: p.x, y: n });
  }
  return out;
}

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export const PERIODS = ["day", "week", "month", "year"] as const;
export type Per = (typeof PERIODS)[number];

/** Start of the local day, week (from Monday), month or year containing t. */
export function periodStart(t: number, per: Per): number {
  const d = new Date(t);
  const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  switch (per) {
    case "day": return new Date(y, m, day).getTime();
    case "week": return new Date(y, m, day - ((d.getDay() + 6) % 7)).getTime();
    case "month": return new Date(y, m, 1).getTime();
    case "year": return new Date(y, 0, 1).getTime();
  }
}

/** The start of the period n periods away, counted in calendar units so clock changes don't matter. */
export function shiftPeriod(start: number, per: Per, n: number): number {
  const d = new Date(start);
  const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  switch (per) {
    case "day": return new Date(y, m, day + n).getTime();
    case "week": return new Date(y, m, day + 7 * n).getTime();
    case "month": return new Date(y, m + n, 1).getTime();
    case "year": return new Date(y + n, 0, 1).getTime();
  }
}

/** The [from, to) times a date condition covers, or undefined when it isn't one. */
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

type Test = (value: unknown) => boolean;

/** Turns one `where` condition into a test, parsing its date window or comparison once. */
function compileCondition(cond: string | number | boolean, now: Date): Test {
  if (typeof cond !== "string") {
    const text = String(cond);
    return (v) => v === cond || String(v) === text;
  }
  const window = dateWindow(cond, now);
  if (window) {
    const [from, to] = window;
    // A stamp dated a week or more outside the window can't be in it in any time zone (an offset is
    // under a day; a day past the month's end, day 00 or hour 24 moves it three days at most), so
    // most rows of a long list are ruled out by their text, without being read as a time.
    const before = utcDay(from - 7 * DAY) ?? "";
    const after = `${utcDay(to + 7 * DAY) ?? "~"}T~`;
    return (v) => {
      if (typeof v === "string" && (v < before || v > after) && stampShape(v)) return false;
      const t = toTime(v);
      return t !== undefined && t >= from && t < to;
    };
  }
  const m = cond.match(/^\s*(>=|<=|!=|>|<)\s*(.+)$/);
  if (m) {
    const [, op, rhs] = m;
    if (op === "!=") return (v) => String(v ?? "") !== rhs;
    const b = toNumber(rhs) ?? toTime(rhs);
    if (b === undefined) return () => false;
    const holds = op === ">" ? (a: number) => a > b
      : op === "<" ? (a: number) => a < b
      : op === ">=" ? (a: number) => a >= b
      : (a: number) => a <= b;
    return (v) => {
      const a = toNumber(v) ?? toTime(v);
      return a !== undefined && holds(a);
    };
  }
  return (v) => (Array.isArray(v) ? v.some((x) => String(x) === cond) : String(v ?? "") === cond);
}

export function matches(value: unknown, cond: string | number | boolean, now: Date): boolean {
  return compileCondition(cond, now)(value);
}

export function compileWhere(where: NonNullable<Panel["where"]>, now: Date): (row: unknown) => boolean {
  const tests = Object.entries(where).map(([path, cond]) => [path, compileCondition(cond, now)] as const);
  return (row) => tests.every(([path, test]) => test(getPath(row, path)));
}

export function filterRows(rows: unknown[], where: Panel["where"], now: Date): unknown[] {
  return where ? rows.filter(compileWhere(where, now)) : rows;
}

function sortKey(v: unknown): number | string {
  return toTime(v) ?? toNumber(v) ?? (v === undefined || v === null ? "" : String(v).toLowerCase());
}

/** Sorts on keys worked out once per row, not once per comparison. */
export function sortRows(rows: unknown[], sort: string | undefined): unknown[] {
  if (!sort) return rows;
  const desc = sort.startsWith("-");
  const path = desc ? sort.slice(1) : sort;
  const keyed = rows.map((row) => ({ row, key: sortKey(getPath(row, path)) }));
  keyed.sort((a, b) => {
    const cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return desc ? -cmp : cmp;
  });
  return keyed.map((k) => k.row);
}

/** One value from rows: `share` is the fraction of them that `of` keeps (none of nothing). */
export function aggregate(rows: unknown[], field: string | undefined, agg: Agg, of?: (row: unknown) => boolean): unknown {
  if (agg === "count") return rows.length;
  if (agg === "share") return rows.length ? rows.filter(of ?? (() => false)).length / rows.length : undefined;
  const values = rows.map((r) => getPath(r, field));
  if (agg === "first") return values[0];
  if (agg === "last") return values[values.length - 1];
  const nums = values.map(toNumber).filter((n): n is number => n !== undefined);
  if (nums.length === 0) return undefined;
  if (agg === "sum") return nums.reduce((a, b) => a + b, 0);
  if (agg === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
  const [min, max] = extent(nums);
  return agg === "min" ? min : max;
}

/** Min and max without spreading, which overflows the call stack on very long arrays. */
export function extent(nums: number[]): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return [min, max];
}

/** The single value a number or progress panel shows. */
export function valueOf(p: Panel, data: unknown, now = new Date()): unknown {
  if (Array.isArray(data)) return aggregate(data, p.field, p.agg ?? (p.field ? "last" : "count"), p.of && compileWhere(p.of, now));
  if (data !== null && typeof data === "object") return p.field ? getPath(data, p.field) : undefined;
  return data;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * `n.toLocaleString(undefined, …)` with that many decimals: the same text, but the formatter is made
 * once per set of options, since toLocaleString makes a new one on every call.
 */
export function localeNumber(n: number, decimals: number, group: boolean): string {
  const key = `${decimals}|${group}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: group });
    numberFormats.set(key, format);
  }
  return format.format(n);
}

/** A value as text. Numbers get thousands separators unless `group` is false (inside a sentence, a year stays 1965). */
export function formatValue(v: unknown, decimals?: number, group = true): string {
  if (v === undefined || v === null) return "—";
  const n = typeof v === "number" ? v : undefined;
  if (n !== undefined) {
    const d = decimals ?? (Number.isInteger(n) ? 0 : Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 1 : 2);
    return localeNumber(n, d, group);
  }
  if (Array.isArray(v)) return v.map((x) => formatValue(x, decimals, group)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The names a template's {placeholders} read, by their first part ({row.amount} reads row). */
export function namesInTemplate(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].trim().split(".")[0]))];
}

/** Fills {path} placeholders from ctx, each value shown by `show`. Unknown paths become empty strings. */
export function fillWith(template: string, ctx: unknown, show: (path: string, value: unknown) => string): string {
  return template.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    const path = raw.trim();
    const v = getPath(ctx, path);
    return v === undefined || v === null ? "" : show(path, v);
  });
}

/** Fills {path} placeholders from ctx. Numbers stay free of thousands separators. */
export function fillTemplate(template: string, ctx: unknown, decimals?: number): string {
  return fillWith(template, ctx, (_, v) => formatValue(v, decimals, false));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function stampParts(d: Date): { at: string; date: string; time: string } {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { at: `${date}T${time}`, date, time };
}

/** Whole calendar days from now until the date (negative when past). */
export function daysUntil(to: string, now: Date): number {
  const t = toTime(to) ?? Date.parse(to);
  return Math.round((startOfDay(new Date(t)) - startOfDay(now)) / DAY);
}

export function parseCSV(text: string): Row[] {
  const lines: string[][] = [];
  let field = "", row: string[] = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c !== "")) lines.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) lines.push(row);
  const [header, ...body] = lines;
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((h, i) => {
    const raw = cells[i] ?? "";
    const n = toNumber(raw);
    return [h.trim(), n ?? raw];
  })));
}

/** The XML declaration, other processing instructions, comments and a doctype that may come before a feed's root. */
const PROLOG = /\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)/iy;

function isFeed(text: string): boolean {
  let at = 0;
  for (;;) {
    PROLOG.lastIndex = at;
    const m = PROLOG.exec(text);
    if (!m) break;
    at += m[0].length;
  }
  return /^\s*<(?:rss|feed|rdf:RDF)[\s>]/i.test(text.slice(at, at + 200));
}

/** Whether text has a line break and a comma before it. Found by searching, not a regex, which took minutes on a long line. */
function firstLineHasComma(text: string): boolean {
  const nl = text.indexOf("\n");
  return nl !== -1 && text.lastIndexOf(",", nl) !== -1;
}

/**
 * Parses an API response body: a calendar or a feed into rows, else JSON, then CSV, else the raw
 * text. `now` is the moment a calendar's repeating events are expanded around.
 */
export function parseBody(text: string, contentType: string, now: Date = new Date()): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("BEGIN:VCALENDAR") || (contentType.includes("calendar") && !contentType.includes("json"))) {
    return parseICS(text, now);
  }
  if (trimmed.startsWith("<") && isFeed(trimmed)) return parseFeed(text);
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(text);
  }
  if (contentType.includes("csv") || firstLineHasComma(trimmed)) return parseCSV(text);
  return text;
}

export function rowsOf(data: unknown): Row[] {
  if (Array.isArray(data)) return data.map((r) => (r !== null && typeof r === "object" ? (r as Row) : { value: r }));
  if (data !== null && typeof data === "object") return [data as Row];
  return data === undefined ? [] : [{ value: data }];
}
