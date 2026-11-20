import { compareWindows, splitByWindow } from "../compare.ts";
import { AGGS, daysUntil, fillWith, formatValue, rowsOf, toNumber, valueOf, type Row } from "../data.ts";
import { display, formatErrors, formatFor, mapped } from "../format.ts";
import { streak } from "../group.ts";
import type { Panel } from "../spec.ts";
import { heading, redraw } from "./common.ts";
import { DATA_KEYS, GROUP_KEYS } from "../keys.ts";
import type { ViewDef } from "./registry.ts";

function checkAgg(p: Panel): string[] {
  if (p.agg && !AGGS.includes(p.agg)) return [`agg must be one of ${AGGS.join(", ")}`];
  if (p.agg === "streak") return p.group && p.per ? [] : ["agg: streak needs group (a date field) and per"];
  if (p.group) return [`${p.view} can't group rows; for one period use where (e.g. where: {at: this week}) with agg`];
  return [];
}

/**
 * What a number, progress or text panel shows for its data: its value (a progress panel's is a
 * number, 0 when there is none; a text panel's is its text), that value as text under the panel's
 * `values`, `format` and `decimals`, and the `unit` that goes beside it (none when a format or
 * values already speak for it). The views draw this, and the status bar and alerts say it again.
 */
export function panelValue(p: Panel, data: unknown, now: Date): { value: unknown; text: string; unit?: string } {
  if (p.view === "text") {
    const scope = Array.isArray(data) ? { ...(data[0] as Row), rows: data, count: data.length } : data;
    const text = fillWith(p.text ?? "", scope, (path, v) => display(p, path, v, now, "text"));
    return { value: text, text };
  }
  const found = p.agg === "streak" ? streak(rowsOf(data), p.group!, p.per!, now) : valueOf(p, data, now);
  const value = p.view === "progress" ? toNumber(found) ?? 0 : found;
  const unit = p.unit && formatFor(p, p.field) === undefined && mapped(p, p.field, value) === undefined ? p.unit : undefined;
  return { value, text: display(p, p.field, value, now), unit };
}

function checkCompare(p: Panel): string[] {
  if (p.compare === undefined) return [];
  if (p.compare !== "previous") return ["compare must be previous"];
  if (p.agg === "streak") return ["compare doesn't work with streak"];
  const now = new Date();
  if (compareWindows(p.where, now)) return [];
  // Only the panel's own where is opened up to the window before, so one in a block above can't be compared.
  return (p.upstream ?? []).some((stage) => compareWindows(stage.where, now))
    ? ["compare needs the date window in this panel's own where"]
    : ["compare needs a date window in where, e.g. where: {at: this week}"];
}

/**
 * `▲ 12 (8%) vs previous`: how the value differs from the one over the window before. Neutral in
 * colour on purpose, since up is not good or bad; a screen reader gets the same in words.
 */
function drawChange(el: HTMLElement, p: Panel, now: Date, value: unknown, previous: unknown[]): void {
  const before = previous.length ? toNumber(valueOf(p, previous, now)) : undefined;
  if (before === undefined) {
    el.createDiv({ cls: "gz-compare", text: "no previous data" });
    return;
  }
  const after = toNumber(value);
  if (after === undefined) return;
  const diff = after - before;
  if (diff === 0) {
    el.createDiv({ cls: "gz-compare", text: "no change vs previous", attr: { role: "img", "aria-label": "no change, versus previous" } });
    return;
  }
  const size = formatFor(p, p.field) !== undefined
    ? display(p, p.field, Math.abs(diff), now)
    : `${formatValue(Math.abs(diff), p.decimals)}${p.unit ? ` ${p.unit}` : ""}`;
  // A change from nothing has no percent.
  const percent = before === 0 ? undefined : (Math.abs(diff) / Math.abs(before)) * 100;
  const small = percent !== undefined && percent < 1;
  const shown = percent === undefined ? "" : small ? " (<1%)" : ` (${Math.round(percent)}%)`;
  const spoken = percent === undefined ? "" : `, ${small ? "less than 1" : Math.round(percent)} percent`;
  el.createDiv({
    cls: "gz-compare",
    text: `${diff > 0 ? "▲" : "▼"} ${size}${shown} vs previous`,
    attr: { role: "img", "aria-label": `${diff > 0 ? "up" : "down"} ${size}${spoken}, versus previous` },
  });
}

const BAD_FORMAT = 'format "$0.0.0" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes';

export const number: ViewDef = {
  id: "number",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "field", "agg", "of", "label", "unit", "decimals", "format", "values", "compare", "pin", "alert", "then", "shortcut"],
  span: 1,
  needsSource: true,
  validate: (p) => [...checkAgg(p), ...formatErrors(p), ...checkCompare(p)],
  examples: [
    { panel: { view: "number", source: "weights", field: "weight", agg: "avg", unit: "kg" } },
    { panel: { view: "number", source: "spending", field: "amount", agg: "sum", format: "$0,0.00" } },
    { panel: { view: "number", source: "renewals", where: { due: "upcoming" }, sort: "due", field: "due", agg: "first", format: "until" } },
    { panel: { view: "number", source: "spending", field: "amount", agg: "sum", format: "$0.0.0" }, errors: [BAD_FORMAT] },
    { panel: { view: "number", source: "spending", field: "amount", agg: "sum", where: { at: "this week" }, compare: "previous", format: "$0,0.00" } },
    { panel: { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", shortcut: "doses-today" } },
    { panel: { view: "number", source: "spending", agg: "count", where: { at: "last 7 days" }, compare: "last" }, errors: ["compare must be previous"] },
    { panel: { view: "number", source: "spending", field: "amount", agg: "sum", compare: "previous" }, errors: ["compare needs a date window in where, e.g. where: {at: this week}"] },
    { panel: { view: "number", source: "spending", agg: "count", where: { category: "food" }, compare: "previous" }, errors: ["compare needs a date window in where, e.g. where: {at: this week}"] },
    { panel: { view: "number", source: "stretches", group: "at", per: "day", agg: "streak", compare: "previous" }, errors: ["compare doesn't work with streak"] },
    { panel: { view: "number", source: "https://api.example.com/now", pick: "current", field: "weathercode", values: { weathercode: { 0: "Clear", 1: "Mostly clear" } } } },
    { panel: { view: "number", source: "https://api.example.com/now", pick: "current", field: "weathercode", values: { weathercode: "Clear" } }, errors: ['"values" has the wrong type (expected a set of field: {value: text})'] },
    { panel: { view: "number", source: "weights", agg: "median" }, errors: ["agg must be one of count, sum, avg, min, max, first, last, streak, share"] },
    { panel: { view: "number", title: "Right so far", source: "decisions", where: { outcome: "!= open" }, agg: "share", of: { outcome: "right" } } },
    { panel: { view: "number", source: "decisions", agg: "share" }, errors: ["agg: share needs of, e.g. of: {outcome: right}"] },
    { panel: { view: "number", source: "decisions", agg: "avg", field: "hit", of: { outcome: "right" } }, errors: ['"of" needs agg: share'] },
    { panel: { view: "number", source: "stretches", group: "at", per: "day", agg: "streak", unit: "days" } },
    { panel: { view: "number", source: "stretches", agg: "streak" }, errors: ["agg: streak needs group (a date field) and per"] },
    { panel: { view: "number", source: "sessions", group: "at", per: "week", agg: "sum", field: "minutes" }, errors: ["number can't group rows; for one period use where (e.g. where: {at: this week}) with agg"] },
    { panel: { view: "number", field: "weight" }, errors: ["number needs a source"] },
    { panel: { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", pin: "status" } },
    { panel: { view: "number", source: "doses", pin: "sidebar" }, errors: ["pin must be status"] },
    { panel: { view: "number", source: "https://services.swpc.noaa.gov/kp.json", field: "kp_index", alert: ">= 5" } },
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p);
    // With compare, the data holds the window before too; the value is the current window's.
    const { current, previous } = splitByWindow(p, data, ctx.now);
    const { value, text, unit } = panelValue(p, current, ctx.now);
    const row = el.createDiv({ cls: "gz-big" });
    row.createSpan({ text });
    if (unit) row.createSpan({ cls: "gz-unit", text: unit });
    if (previous) drawChange(el, p, ctx.now, value, previous);
    if (p.label) el.createDiv({ cls: "gz-label", text: p.label });
  }),
};

export const text: ViewDef = {
  id: "text",
  keys: [...DATA_KEYS, "text", "label", "decimals", "format", "values", "pin", "alert", "then"],
  span: 1,
  validate: (p) => [...(p.text ? [] : ["text needs a text template"]), ...formatErrors(p)],
  examples: [
    { panel: { view: "text", source: "https://api.example.com/now", pick: "current", text: "{temp}°C" } },
    { panel: { view: "text", source: "spending", text: "{count} entries, {amount} in all", format: { amount: "$0,0.00" } } },
    { panel: { view: "text", source: "https://api.example.com/now", pick: "current", text: "{temp}°C, {weathercode}", values: { weathercode: { 0: "clear" } } } },
    { panel: { view: "text", source: "https://api.example.com/now", text: "{weathercode}", values: { weathercode: "clear" } }, errors: ['"values" has the wrong type (expected a set of field: {value: text})'] },
    { panel: { view: "text", text: "Plain words work too" } },
    { panel: { view: "text", source: "weights" }, errors: ["text needs a text template"] },
    { panel: { view: "text", source: "spending", text: "{amount}", format: "money" }, errors: ['format "money" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
    { panel: { view: "text", source: "https://api.example.com/now", pick: "current", text: "{temp}°C", pin: "status" } },
    { panel: { view: "text", text: "Plain", alert: { temp: "> 30" } }, errors: ["alert needs a source"] },
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p);
    el.createDiv({ cls: "gz-text", text: panelValue(p, data, ctx.now).text });
    if (p.label) el.createDiv({ cls: "gz-label", text: p.label });
  }),
};

export const progress: ViewDef = {
  id: "progress",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "field", "agg", "of", "max", "label", "unit", "decimals", "format", "alert", "then", "shortcut"],
  span: 1,
  needsSource: true,
  validate: (p) => [...checkAgg(p), ...formatErrors(p)],
  examples: [
    { panel: { view: "progress", source: "notes", from: "Books", max: 24, unit: "books" } },
    { panel: { view: "progress", source: "spending", field: "amount", agg: "sum", max: 500, format: "$0" } },
    { panel: { view: "progress", max: 8 }, errors: ["progress needs a source"] },
    { panel: { view: "progress", source: "notes", from: "Books", max: 24, alert: ">= 24" } },
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p);
    const { value, text, unit } = panelValue(p, data, ctx.now);
    const max = p.max ?? 100;
    const big = el.createDiv({ cls: "gz-big" });
    big.createSpan({ text });
    big.createSpan({ cls: "gz-unit", text: `/ ${display(p, p.field, max, ctx.now)}${unit ? ` ${unit}` : ""}` });
    const bar = el.createDiv({ cls: "gz-progress" }).createDiv({ cls: "gz-progress-fill" });
    bar.style.width = `${Math.max(0, Math.min(100, ((value as number) / max) * 100))}%`;
    if (p.label) el.createDiv({ cls: "gz-label", text: p.label });
  }),
};

export const countdown: ViewDef = {
  id: "countdown",
  keys: ["to", "label"],
  span: 1,
  validate: (p) => (!p.to ? ['countdown needs "to" (a date)'] : Number.isNaN(Date.parse(p.to)) ? ['"to" is not a date'] : []),
  examples: [
    { panel: { view: "countdown", to: "2027-10-03", label: "Benefits renewal" } },
    { panel: { view: "countdown", to: "soon" }, errors: ['"to" is not a date'] },
    { panel: { view: "countdown", to: "2027-01-01", unit: "days" }, errors: ['"unit" doesn\'t apply to countdown'] },
  ],
  mount: (el, p, ctx) => redraw(el, () => {
    heading(el, p);
    const days = daysUntil(p.to!, ctx.now);
    const big = el.createDiv({ cls: "gz-big" });
    big.createSpan({ text: String(Math.abs(days)) });
    big.createSpan({ cls: "gz-unit", text: Math.abs(days) === 1 ? "day" : "days" });
    const when = new Date(Date.parse(p.to!.length === 10 ? `${p.to}T00:00` : p.to!));
    const suffix = days < 0 ? "ago" : days === 0 ? "today" : "left";
    el.createDiv({ cls: "gz-label", text: `${p.label ? `${p.label} · ` : ""}${when.toLocaleDateString()} · ${suffix}` });
  }),
};
