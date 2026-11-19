import type { Agg, Panel } from "./spec.ts";

export type Row = Record<string, unknown>;

export function getPath(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
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
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v.length === 10 ? `${v}T00:00` : v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
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

function dateWindow(cond: string, now: Date): [number, number] | undefined {
  const c = cond.trim().toLowerCase();
  const today = startOfDay(now);
  if (c === "today") return [today, today + DAY];
  if (c === "yesterday") return [today - DAY, today];
  if (c === "this week") {
    const monday = today - ((now.getDay() + 6) % 7) * DAY;
    return [monday, monday + 7 * DAY];
  }
  if (c === "this month") {
    return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()];
  }
  if (c === "this year") {
    return [new Date(now.getFullYear(), 0, 1).getTime(), new Date(now.getFullYear() + 1, 0, 1).getTime()];
  }
  let m = c.match(/^last (\d+) days?$/);
  if (m) return [today - (Number(m[1]) - 1) * DAY, today + DAY];
  m = c.match(/^next (\d+) days?$/);
  if (m) return [today, today + (Number(m[1]) + 1) * DAY];
  if (c === "past") return [-Infinity, now.getTime()];
  if (c === "upcoming") return [today, Infinity];
  return undefined;
}

export function matches(value: unknown, cond: string | number | boolean, now: Date): boolean {
  if (typeof cond !== "string") return value === cond || String(value) === String(cond);
  const window = dateWindow(cond, now);
  if (window) {
    const t = toTime(value);
    return t !== undefined && t >= window[0] && t < window[1];
  }
  const m = cond.match(/^\s*(>=|<=|!=|>|<)\s*(.+)$/);
  if (m) {
    const [, op, rhs] = m;
    if (op === "!=") return String(value ?? "") !== rhs;
    const a = toNumber(value) ?? toTime(value);
    const b = toNumber(rhs) ?? toTime(rhs);
    if (a === undefined || b === undefined) return false;
    return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
  }
  if (Array.isArray(value)) return value.some((v) => String(v) === cond);
  return String(value ?? "") === cond;
}

export function filterRows(rows: unknown[], where: Panel["where"], now: Date): unknown[] {
  if (!where) return rows;
  return rows.filter((row) => Object.entries(where).every(([k, c]) => matches(getPath(row, k), c, now)));
}

export function sortRows(rows: unknown[], sort: string | undefined): unknown[] {
  if (!sort) return rows;
  const desc = sort.startsWith("-");
  const key = desc ? sort.slice(1) : sort;
  const val = (r: unknown) => {
    const v = getPath(r, key);
    return toTime(v) ?? toNumber(v) ?? (v === undefined || v === null ? "" : String(v).toLowerCase());
  };
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return desc ? -cmp : cmp;
  });
}

export function aggregate(rows: unknown[], field: string | undefined, agg: Agg): unknown {
  if (agg === "count") return rows.length;
  const values = rows.map((r) => getPath(r, field));
  if (agg === "first") return values[0];
  if (agg === "last") return values[values.length - 1];
  const nums = values.map(toNumber).filter((n): n is number => n !== undefined);
  if (nums.length === 0) return undefined;
  if (agg === "sum") return nums.reduce((a, b) => a + b, 0);
  if (agg === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === "min") return Math.min(...nums);
  return Math.max(...nums);
}

/** The single value a number or progress panel shows. */
export function valueOf(p: Panel, data: unknown): unknown {
  if (Array.isArray(data)) return aggregate(data, p.field, p.agg ?? (p.field ? "last" : "count"));
  if (data !== null && typeof data === "object") return p.field ? getPath(data, p.field) : undefined;
  return data;
}

export function formatValue(v: unknown, decimals?: number): string {
  if (v === undefined || v === null) return "—";
  const n = typeof v === "number" ? v : undefined;
  if (n !== undefined) {
    const d = decimals ?? (Number.isInteger(n) ? 0 : Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 1 : 2);
    return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  if (Array.isArray(v)) return v.map((x) => formatValue(x, decimals)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Fills {path} placeholders from ctx. Unknown paths become empty strings. */
export function fillTemplate(template: string, ctx: unknown, decimals?: number): string {
  return template.replace(/\{([^{}]+)\}/g, (_, path: string) => {
    const v = getPath(ctx, path.trim());
    return v === undefined || v === null ? "" : formatValue(v, decimals);
  });
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

/** Parses an API response body: JSON first, then CSV, else the raw text. */
export function parseBody(text: string, contentType: string): unknown {
  const trimmed = text.trimStart();
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(text);
  }
  if (contentType.includes("csv") || /^[^\n]*,[^\n]*\n/.test(trimmed)) return parseCSV(text);
  return text;
}
