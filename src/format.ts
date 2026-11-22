import { textOf } from "./text.ts";
import { fillWith, formatValue, getPath, localeNumber, namesInTemplate, toNumber, type Row } from "./data.ts";
import { periodStart, toTime, wallTime } from "./time.ts";
import type { Panel } from "./spec.ts";

const DAY = 86_400_000;
const WORDS = ["date", "time", "datetime", "relative", "until", "duration", "duration:ms", "duration:min", "bytes"];

interface NumberPattern {
  prefix: string;
  suffix: string;
  group: boolean;
  decimals: number;
  percent: boolean;
}

/**
 * `$0,0.00`, `0.0 °F`, `0%`: the first run of `0`, `0,0`, `0.0…` (and `%`) is the pattern, the text
 * around it a prefix and suffix. A second `0` outside the run means it isn't one pattern.
 */
function numberPattern(format: string): NumberPattern | undefined {
  const m = format.match(/0(,0)?(\.0+)?%?/);
  if (!m) return undefined;
  const prefix = format.slice(0, m.index);
  const suffix = format.slice(m.index! + m[0].length);
  if (prefix.includes("0") || suffix.includes("0")) return undefined;
  return { prefix, suffix, group: !!m[1], decimals: m[2] ? m[2].length - 1 : 0, percent: m[0].endsWith("%") };
}

/** A sentence saying what is wrong with a `format` value, or undefined when it can be used. */
export function checkFormat(format: string): string | undefined {
  if (WORDS.includes(format) || numberPattern(format)) return undefined;
  return `format "${format}" isn't a number pattern or one of date, time, datetime, relative, until, duration, bytes`;
}

/** Problems with a panel's `format`: the text, or each value of the field → format map. */
export function formatErrors(p: Pick<Panel, "format">): string[] {
  const formats = typeof p.format === "string" ? [p.format] : Object.values(p.format ?? {});
  return [...new Set(formats.flatMap((f) => checkFormat(f) ?? []))];
}

/** A finite number, or a string holding one; nothing else counts as a number to format. */
function numeric(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  return typeof v === "string" ? toNumber(v) : undefined;
}

function withPattern(n: number, p: NumberPattern): string {
  const scaled = p.percent ? n * 100 : n;
  const body = localeNumber(Math.abs(scaled), p.decimals, p.group);
  // A value that rounds to zero has no sign.
  const sign = scaled < 0 && Number(Math.abs(scaled).toFixed(p.decimals)) !== 0 ? "-" : "";
  return `${sign}${p.prefix}${body}${p.percent ? "%" : ""}${p.suffix}`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const calendarDays = (t: number, now: Date) => Math.round((periodStart(t, "day") - periodStart(now.getTime(), "day")) / DAY);

/** A date, time or both in the reader's locale. */
function clock(t: number, word: "date" | "time" | "datetime"): string {
  const d = new Date(t);
  const date = () => d.toLocaleDateString();
  const time = () => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return word === "date" ? date() : word === "time" ? time() : `${date()}, ${time()}`;
}

/** Calendar days for a date; a moment less than a day away reads in minutes or hours. */
function relative(t: number, dateOnly: boolean, now: Date): string {
  const delta = t - now.getTime();
  if (!dateOnly && Math.abs(delta) < DAY) {
    const minutes = Math.floor(Math.abs(delta) / 60_000);
    if (minutes < 1) return "just now";
    const span = minutes < 60 ? plural(minutes, "minute") : plural(Math.floor(minutes / 60), "hour");
    return delta < 0 ? `${span} ago` : `in ${span}`;
  }
  const days = calendarDays(t, now);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  return days < 0 ? `${-days} days ago` : `in ${days} days`;
}

function until(t: number, now: Date): string {
  const days = calendarDays(t, now);
  return days === 0 ? "today" : days > 0 ? plural(days, "day") : `${plural(-days, "day")} ago`;
}

/** `1h 05m`, `4m 10s`, `8s`. */
function duration(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const text = h ? `${h}h ${pad(m)}m` : m ? `${m}m ${pad(s)}s` : `${s}s`;
  return seconds < 0 && total > 0 ? `-${text}` : text;
}

/** `512 B`, `1.2 MB`: steps of 1024, one decimal below 10. */
function bytes(n: number): string {
  let [size, i] = [Math.abs(n), 0];
  const text = () => (i > 0 && size < 10 ? size.toFixed(1) : String(Math.round(size)));
  while (i < 4 && (size >= 1024 || Number(text()) >= 1024)) {
    size /= 1024;
    i++;
  }
  return `${n < 0 ? "-" : ""}${text()} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}

function apply(value: unknown, format: string, now: Date): string | undefined {
  switch (format) {
    case "date": case "time": case "datetime": {
      // The clock where it was saved, as it was lived.
      const t = wallTime(value);
      return t === undefined ? undefined : clock(t, format);
    }
    case "relative": case "until": {
      const t = toTime(value);
      if (t === undefined) return undefined;
      return format === "until" ? until(t, now) : relative(t, typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), now);
    }
    case "duration": case "duration:ms": case "duration:min": {
      const n = numeric(value);
      if (n === undefined) return undefined;
      if (format === "duration:ms") return Math.round(Math.abs(n)) < 1000 ? `${Math.round(n)}ms` : duration(n / 1000);
      return duration(format === "duration" ? n : n * 60);
    }
    case "bytes": {
      const n = numeric(value);
      return n === undefined ? undefined : bytes(n);
    }
  }
  const pattern = numberPattern(format);
  const n = pattern && numeric(value);
  return pattern && n !== undefined ? withPattern(n, pattern) : undefined;
}

/**
 * A value in the given format: a number pattern (`$0,0.00`, `0.0 °F`, `0%`) or a word (`date`,
 * `time`, `datetime`, `relative`, `until`, `duration`, `duration:ms`, `duration:min`, `bytes`). A
 * value the format can't apply to shows as it would without a format; a missing one as `—`.
 */
export function formatWith(value: unknown, format: string, now: Date): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) return value.map((v) => formatWith(v, format, now)).join(", ");
  return apply(value, format, now) ?? formatValue(value);
}

/** The format a field is shown in: a text `format` is for every field, a map names fields. */
export function formatFor(p: Pick<Panel, "format">, field: string | undefined): string | undefined {
  if (typeof p.format === "string") return p.format;
  return field !== undefined && p.format && Object.hasOwn(p.format, field) ? p.format[field] : undefined;
}

/** What the panel's `values` says to show for a field's value (looked up by its text), if anything. */
export function mapped(p: Pick<Panel, "values">, field: string | undefined, value: unknown): string | undefined {
  if (field === undefined || value === undefined || value === null || !p.values || !Object.hasOwn(p.values, field)) return undefined;
  const map = p.values[field];
  const key = textOf(value);
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The display name the panel's `labels` gives a field, if any. */
export function labelFor(p: Pick<Panel, "labels">, field: string): string | undefined {
  return p.labels && Object.hasOwn(p.labels, field) ? p.labels[field] : undefined;
}

/** A field's display name: its label, else the field itself. */
export function labelOf(p: Pick<Panel, "labels">, field: string): string {
  return labelFor(p, field) ?? field;
}

/**
 * How a view shows a value of one field: the panel's `values` first, then its `format`, else the
 * plain form (with `decimals`). `value` mode is one number or date on its own (numbers typed as
 * text count as numbers); `cell` is a table cell (a text `format` is for numbers only); `text` is
 * a `{placeholder}` inside a sentence, where numbers get no thousands separators.
 */
export function display(
  p: Pick<Panel, "format" | "values" | "decimals">, field: string | undefined, value: unknown, now: Date, mode: "value" | "cell" | "text" = "value",
): string {
  if (Array.isArray(value)) return value.map((v) => display(p, field, v, now, mode)).join(", ");
  const named = mapped(p, field, value);
  if (named !== undefined) return named;
  const format = formatFor(p, field);
  if (format !== undefined && (mode !== "cell" || typeof p.format !== "string" || typeof value === "number")) {
    return formatWith(value, format, now);
  }
  return formatValue(mode === "value" ? toNumber(value) ?? value : value, p.decimals, mode !== "text");
}

/**
 * The fields an alert on rows names in its notice: a number's own field, as the panel shows it;
 * those a text or list panel's own words fill; else the row's name (the first column shown that isn't `at` or a field the alert reads) and each
 * field the alert's condition reads, but a yes-or-no one, which the panel's title already says.
 */
export function alertRowFields(p: Pick<Panel, "view" | "text" | "item" | "columns" | "alert" | "field">): string[] {
  if ((p.view === "number" || p.view === "progress") && p.field !== undefined) return [p.field];
  const own = p.view === "text" ? p.text : p.view === "list" ? p.item : undefined;
  if (own) return namesInTemplate(own);
  const read = p.alert !== null && typeof p.alert === "object" ? Object.entries(p.alert).filter(([, c]) => typeof c !== "boolean").map(([f]) => f) : [];
  const name = p.columns?.find((c) => c !== "at" && !read.includes(c));
  return [...(name === undefined ? [] : [name]), ...read];
}

/** The rows an alert matched, as its notice says them: the first in a few words (see alertRowFields), and how many more. */
export function alertRowsText(p: Panel, rows: readonly Row[], now: Date): string {
  const [row] = rows;
  const own = p.view === "text" ? p.text : p.view === "list" ? p.item : undefined;
  const shown = (field: string, v: unknown) => display(p, field, v, now, "text");
  let words = "";
  if (row && own) words = fillWith(own, row, shown).trim();
  else if (row) {
    const fields = alertRowFields(p);
    const named = p.columns?.find((c) => c !== "at") === fields[0] || ((p.view === "number" || p.view === "progress") && p.field !== undefined);
    words = fields.flatMap((f, i) => {
      const v = getPath(row, f);
      if (v === undefined || v === null || v === "") return [];
      return [i === 0 && named ? shown(f, v) : `${labelOf(p, f)} ${shown(f, v)}`];
    }).join(", ");
  }
  if (!words) return `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  return rows.length > 1 ? `${words}, and ${rows.length - 1} more` : words;
}
