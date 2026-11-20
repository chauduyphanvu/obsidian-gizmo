import { parseFeed } from "./sources/feed.ts";
import { parseICS } from "./sources/ics.ts";
import type { Panel } from "./spec.ts";
import { dateWindow, inWindow, shownStamp, toTime } from "./time.ts";

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

type Test = (value: unknown) => boolean;

/** Turns one `where` condition into a test, parsing its date window or comparison once. */
function compileCondition(cond: string | number | boolean, now: Date): Test {
  if (typeof cond !== "string") {
    const text = String(cond);
    return (v) => v === cond || String(v) === text;
  }
  const window = dateWindow(cond, now);
  if (window) {
    const c = cond.trim().toLowerCase();
    return inWindow(window, c === "past" || c === "upcoming");
  }
  const range = cond.match(/^\s*between\s+(.+?)\s+and\s+(.+?)\s*$/i);
  const [lo, hi] = range ? [range[1], range[2]].map((x) => toNumber(x) ?? toTime(x)) : [];
  // Ends that aren't numbers or dates ("between friends and family") leave the text to match as it is.
  if (range && lo !== undefined && hi !== undefined) {
    // A last day given as a date takes in the whole day, as date windows do.
    const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(range[2].trim());
    const end = dayOnly ? new Date(new Date(hi).getFullYear(), new Date(hi).getMonth(), new Date(hi).getDate() + 1).getTime() : hi;
    return (v) => {
      const a = toNumber(v) ?? toTime(v);
      return a !== undefined && a >= lo && (dayOnly ? a < end : a <= end);
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
export function valueOf(p: Panel, data: unknown, now: Date): unknown {
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
  return typeof v === "string" ? shownStamp(v) : String(v);
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
export function parseBody(text: string, contentType: string, now: Date): unknown {
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
