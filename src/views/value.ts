import { compareWindows, splitByWindow, type Windows } from "../compare.ts";
import { AGGS, compileWhere, fillWith, formatValue, matches, rowsOf, toNumber, valueOf, type Row } from "../data.ts";
import { DAY, daysUntil, periodStart, shiftPeriod } from "../time.ts";
import { display, formatErrors, formatFor, formatWith, mapped } from "../format.ts";
import { streak } from "../group.ts";
import type { Panel } from "../spec.ts";
import { dayName, emptyText, heading, whyEmpty, windowName, windowWord } from "./common.ts";
import { DATA_KEYS, GROUP_KEYS } from "../keys.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";
import { CountUp } from "./tween.ts";

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
 * values already speak for it). A text panel with no rows says its `empty` text, when it has one.
 * The views draw this, and the status bar and alerts say it again.
 */
export function panelValue(p: Panel, data: unknown, now: Date): { value: unknown; text: string; unit?: string } {
  if (p.view === "text") {
    if (p.empty !== undefined && noRows(data)) return { value: p.empty, text: p.empty };
    const scope = Array.isArray(data) ? { ...(data[0] as Row), rows: data, count: data.length } : data;
    const text = fillWith(p.text ?? "", scope, (path, v) => display(p, path, v, now, "text"));
    return { value: text, text };
  }
  const found = p.agg === "streak" ? streak(rowsOf(data), p.group!, p.per!, now) : valueOf(p, data, now);
  const value = p.view === "progress" ? toNumber(found) ?? 0 : found;
  const unit = p.unit && formatFor(p, p.field) === undefined && mapped(p, p.field, value) === undefined ? p.unit : undefined;
  return { value, text: display(p, p.field, value, now), unit };
}

const noRows = (data: unknown) => Array.isArray(data) && data.length === 0;

/** What these come to over no rows is a number (0), which says it already. */
const ZERO_OVER_NONE = ["count", "sum", "streak"];

/**
 * The line a number or progress panel with no rows shows under its value: its `empty` text, else,
 * when that leaves it no value (a last, an average…), that nothing is logged. Undefined when it
 * has rows, or its data isn't rows.
 */
function emptyNote(p: Panel, data: unknown, now: Date): string | undefined {
  if (!noRows(data)) return undefined;
  const agg = p.agg ?? (p.field ? "last" : "count");
  return p.empty !== undefined || !ZERO_OVER_NONE.includes(agg) ? emptyText(p, now, "Nothing here yet", true) : undefined;
}

function checkCompare(p: Panel): string[] {
  if (p.compare === undefined) return [];
  if (p.compare !== "previous") return ["compare must be previous"];
  if (p.agg === "streak") return ["compare doesn't work with streak"];
  // Whether a where is a date window is in its words, not in when it's read.
  const now = new Date(0);
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
  const size = amountOf(p, Math.abs(diff), now);
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

/** A number as the panel shows its value: in its format, else with its decimals and unit. */
function amountOf(p: Panel, n: number, now: Date): string {
  return formatFor(p, p.field) !== undefined ? display(p, p.field, n, now) : `${formatValue(n, p.decimals)}${p.unit ? ` ${p.unit}` : ""}`;
}

// ---- The answer band --------------------------------------------------------------------------------

/** Where an answer view draws in the composed layout: as the headline, a fact, or a number's meter; undefined on the grid. */
type AnswerSlot = "headline" | "fact" | "meter";

function answerSlot(ctx: PanelCtx): AnswerSlot | undefined {
  const slot = ctx.place?.()?.slot;
  return slot === "headline" || slot === "fact" || slot === "meter" ? slot : undefined;
}

/** A compare line: what is shown, a faint ending, and the same in words for a screen reader. */
interface Change {
  text: string;
  faint?: string;
  spoken?: string;
}

/**
 * How the value differs from the one over the window before, never in colour: in full,
 * `↑ 12% more than Oct 1–20 · $1,146.90`, or by the amount when the window before is under three
 * days (or was nothing); short, for a fact, `↓ 0.7 kg vs last week`. Undefined when this window has
 * no value to compare.
 */
function changeOf(p: Panel, now: Date, value: unknown, previous: unknown[], w: Windows, short: boolean): Change | undefined {
  const before = previous.length ? toNumber(valueOf(p, previous, now)) : undefined;
  if (before === undefined) return { text: "Nothing to compare with yet" };
  const after = toNumber(value);
  if (after === undefined) return undefined;
  const diff = after - before;
  const named = short ? windowWord(w, now) : windowName(w.previous, now);
  if (diff === 0) return { text: `Same as ${named}` };
  const [arrow, more] = diff > 0 ? ["↑", "more"] : ["↓", "less"];
  const size = amountOf(p, Math.abs(diff), now);
  if (short) return { text: `${arrow} ${size} vs ${named}`, spoken: `${diff > 0 ? "up" : "down"} ${size}, versus ${named}` };
  const percent = (Math.abs(diff) / Math.abs(before)) * 100;
  const [shown, said] = before === 0 || w.previous[1] - w.previous[0] < 3 * DAY ? [size, size]
    : percent < 1 ? ["<1%", "less than 1 percent"]
    : [`${Math.round(percent)}%`, `${Math.round(percent)} percent`];
  const was = amountOf(p, before, now);
  return { text: `${arrow} ${shown} ${more} than ${named}`, faint: ` · ${was}`, spoken: `${said} ${more} than ${named}, which was ${was}` };
}

function drawChangeLine(el: HTMLElement, change: Change, cls: string): void {
  const line = el.createDiv({ cls: `gz-compare ${cls}`, text: change.text });
  if (change.faint) line.createSpan({ cls: "gz-faint", text: change.faint });
  if (!change.spoken) return;
  line.setAttr("role", "img");
  line.setAttr("aria-label", change.spoken);
}

/** The title in the answer band: a small eyebrow over the headline, or a fact's name. */
function answerTitle(el: HTMLElement, p: Panel, slot: AnswerSlot): void {
  if (p.title) el.createDiv({ cls: `gz-title ${slot === "headline" ? "gz-eyebrow" : "gz-fact-title"}`, text: p.title });
}

/**
 * The figure: large in a row with its caption for the headline, smaller for a fact, whose caption
 * goes on a line under it. `.gz-big` holds the value and its unit only; a missing value is a faint
 * dash with no unit. Returns the value's element.
 */
function drawFigure(el: HTMLElement, slot: AnswerSlot, text: string, unit: string | undefined, caption: string | undefined): HTMLElement {
  const headline = slot === "headline";
  const row = headline ? el.createDiv({ cls: "gz-fig-row" }) : el;
  const big = row.createDiv({ cls: `gz-big ${headline ? "gz-fig" : "gz-fact-fig"}` });
  const fig = big.createSpan({ text });
  if (text === "—") fig.addClass("gz-none");
  else if (unit) big.createSpan({ cls: "gz-unit", text: unit });
  if (caption && headline) row.createSpan({ cls: "gz-label gz-fig-cap", text: caption });
  else if (caption) el.createDiv({ cls: "gz-label gz-fact-note", text: caption });
  return fig;
}

const DATE_WORDS = ["date", "time", "datetime", "relative", "until"];

/**
 * The number a figure counts up to: its value, when it's a number shown as one; not words from
 * `values`, nor a date.
 */
function countable(p: Panel, value: unknown): number | undefined {
  if (typeof value === "boolean" || (p.field !== undefined && p.values && Object.hasOwn(p.values, p.field))) return undefined;
  const format = formatFor(p, p.field);
  return format !== undefined && DATE_WORDS.includes(format) ? undefined : toNumber(value);
}

/** Whether a count between whole numbers keeps to whole numbers: with no format or decimals, the figure would show the fractions on the way. */
const wholeSteps = (p: Panel) => p.decimals === undefined && formatFor(p, p.field) === undefined;

/** A view that draws on the grid as it always has, and in the answer band in `answer`, counting its figure up there. */
function answerView(
  el: HTMLElement, ctx: PanelCtx, grid: (data: unknown) => void,
  answer: (slot: AnswerSlot, data: unknown, count: CountUp) => void, slots: readonly AnswerSlot[] = ["headline", "fact"],
): PanelHandle {
  const count = new CountUp();
  return {
    update(data) {
      count.stop();
      el.empty();
      const slot = answerSlot(ctx);
      if (slot && slots.includes(slot)) answer(slot, data, count);
      else grid(data);
    },
    destroy: () => count.stop(),
  };
}

function drawNumber(el: HTMLElement, p: Panel, ctx: PanelCtx, slot: AnswerSlot, data: unknown, count: CountUp): void {
  const now = ctx.now;
  answerTitle(el, p, slot);
  const { current, previous } = splitByWindow(p, data, now);
  const { value, text, unit } = panelValue(p, current, now);
  const fact = slot === "fact";
  // An empty window's note takes the place of the change.
  const note = emptyNote(p, current, now);
  const windows = note === undefined && previous && compareWindows(p.where, now);
  const change = windows ? changeOf(p, now, value, previous, windows, fact) : undefined;
  // A fact has one line under its figure: the note or the change when there is one, else the label.
  const fig = drawFigure(el, slot, text, unit, fact ? note ?? (change ? undefined : p.label) : p.label);
  // A fact's note is the line drawFigure put last.
  let noteLine = fact && note ? el.lastElementChild as HTMLElement : undefined;
  if (change) drawChangeLine(el, change, fact ? "gz-fact-note" : "gz-ans-sub");
  else if (note && !fact) noteLine = el.createDiv({ cls: "gz-label gz-ans-label", text: note });
  if (note || text === "—") whyEmpty(el, p, ctx, noteLine);
  const alert = alertOn(p, value, current, now);
  if (alert) drawStatus(el, sentence(alert));
  count.to(el, countable(p, value), (n) => fig.setText(display(p, p.field, n, now)), wholeSteps(p));
}

/**
 * `the alert is on`, or `the alert is on for 2 rows` for an alert on rows, when the panel's alert
 * holds for what it shows now (as the background decides it); undefined when it doesn't, or it has none.
 */
function alertOn(p: Panel, value: unknown, data: unknown, now: Date): string | undefined {
  if (p.alert === undefined) return undefined;
  if (typeof p.alert === "string") return matches(value, p.alert, now) ? "the alert is on" : undefined;
  const n = rowsOf(data).filter(compileWhere(p.alert, now)).length;
  return n ? `the alert is on for ${n} ${n === 1 ? "row" : "rows"}` : undefined;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A line under an answer that says a declared line was crossed, in the error colour with a warning icon. */
function drawStatus(el: HTMLElement, text: string): void {
  const status = el.createDiv({ cls: "gz-ans-status" });
  warningIcon(status);
  status.append(text);
}

/**
 * A progress in the answer band. As a number's meter it is only the bar and its legend; on its own
 * it has its title and figure (`$1,284 / $2,000`) over them. Inside a date window that holds now, a
 * tick marks even pace and the legend says what is left a day; past `max` the fill turns to the
 * error colour and a line says by how much. Amounts of money left and over read in the field's own
 * format, which may be finer than the panel's.
 */
function drawProgress(el: HTMLElement, p: Panel, ctx: PanelCtx, slot: AnswerSlot, data: unknown, count: CountUp): void {
  const now = ctx.now, t = now.getTime();
  const { value, text, unit } = panelValue(p, data, now);
  const n = value as number;
  const max = p.max ?? 100;
  const of = `${display(p, p.field, max, now)}${unit ? ` ${unit}` : ""}`;
  let fig: HTMLElement | undefined;
  // As a meter, the number above it says what an empty window has.
  if (slot !== "meter") {
    answerTitle(el, p, slot);
    const note = emptyNote(p, data, now);
    fig = drawFigure(el, slot, text, `/ ${of}`, slot === "fact" ? note ?? p.label : p.label);
    if (note) whyEmpty(el, p, ctx, slot === "headline" ? el.createDiv({ cls: "gz-label gz-ans-label", text: note }) : el.lastElementChild as HTMLElement);
  }
  const fieldFormat = p.field === undefined ? undefined : p.fieldInfo?.[p.field]?.format;
  const exact = (x: number) => (fieldFormat ? formatWith(x, fieldFormat, now) : amountOf(p, x, now));
  const over = n > max;
  const track = el.createDiv({ cls: "gz-meter-track" });
  const fill = track.createDiv({ cls: over ? "gz-meter-fill gz-over" : "gz-meter-fill" });
  const width = (x: number) => `${Math.max(0, Math.min(100, (x / max) * 100))}%`;
  const window = compareWindows(p.where, now)?.current;
  const running = window && window[0] <= t && t < window[1] ? window : undefined;
  if (running) {
    const pace = (t - running[0]) / (running[1] - running[0]);
    const tick = track.createDiv({ cls: `gz-meter-pace${pace < 0.12 ? " gz-pace-start" : pace > 0.88 ? " gz-pace-end" : ""}` });
    tick.style.left = `${pace * 100}%`;
    tick.createSpan({ cls: "gz-meter-pace-label", text: `Even pace ${amountOf(p, max * pace, now)}` });
  }
  const legend = el.createDiv({ cls: "gz-meter-legend" });
  const part = (parent: HTMLElement, bold: string, rest: string) => {
    parent.createEl("b", { text: bold });
    parent.append(rest);
  };
  part(legend.createSpan(), `${Math.round((n * 100) / max)}%`, ` of ${of}`);
  const right = legend.createSpan();
  if (over) part(right, exact(n - max), " over");
  else {
    part(right, exact(max - n), " left");
    // Whole days left in the window after today: on Nov 20 in a 30-day month, 10.
    const days = running ? Math.round((running[1] - shiftPeriod(periodStart(t, "day"), "day", 1)) / DAY) : 0;
    if (n < max && days >= 1) {
      right.append(" · ");
      part(right, exact((max - n) / days), ` a day for ${days} ${days === 1 ? "day" : "days"}`);
    }
  }
  const alert = alertOn(p, n, data, now);
  if (over) drawStatus(el, `Over the limit by ${exact(n - max)}${alert ? ` · ${alert}` : ""}`);
  else if (alert) drawStatus(el, sentence(alert));
  const before = count.shown;
  fill.style.width = width(n);
  if (count.to(el, countable(p, n), (x) => fig?.setText(display(p, p.field, x, now)), wholeSteps(p))) {
    // The fill is new on every draw: it starts at the old width, laid out, so moving to the new one transitions.
    fill.style.width = width(before!);
    void fill.offsetWidth;
    fill.style.width = width(n);
  }
}

/** Lucide's alert-triangle, drawn in the text's colour. */
function warningIcon(parent: HTMLElement): void {
  const ns = "http://www.w3.org/2000/svg";
  const doc = parent.ownerDocument;
  const icon = doc.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "gz-ans-icon" })) icon.setAttribute(k, v);
  for (const d of ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"]) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    icon.appendChild(path);
  }
  parent.appendChild(icon);
}

/** A date as the answer band names it: `Oct 3, 2027`. */
const dateName = (d: Date) => `${dayName(d)}, ${d.getFullYear()}`;

/** Days as the figure, and what they count to: `until Oct 3, 2027`, `today`, `ago · Oct 3, 2027`; the label first when there is one. */
function drawCountdown(el: HTMLElement, p: Panel, ctx: PanelCtx, slot: AnswerSlot, count: CountUp): void {
  answerTitle(el, p, slot);
  const days = daysUntil(p.to!, ctx.now);
  const date = dateName(new Date(Date.parse(p.to!.length === 10 ? `${p.to}T00:00` : p.to!)));
  const when = days > 0 ? (p.label ? date : `until ${date}`) : days === 0 ? "today" : `ago · ${date}`;
  const fig = drawFigure(el, slot, String(Math.abs(days)), Math.abs(days) === 1 ? "day" : "days", p.label ? `${p.label} · ${when}` : when);
  count.to(el, Math.abs(days), (n) => fig.setText(String(n)), true);
}

const BAD_FORMAT = 'format "$0.0.0" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes';

export const number: ViewDef = {
  id: "number",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "field", "agg", "of", "label", "unit", "decimals", "format", "values", "compare", "pin", "alert", "then", "shortcut", "empty"],
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
    { panel: { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", empty: "No doses yet today. Tap the button above." } },
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
  mount: (el, p, ctx) => answerView(el, ctx, (data) => {
    heading(el, p);
    // With compare, the data holds the window before too; the value is the current window's.
    const { current, previous } = splitByWindow(p, data, ctx.now);
    const { value, text, unit } = panelValue(p, current, ctx.now);
    const row = el.createDiv({ cls: "gz-big" });
    row.createSpan({ text });
    if (unit) row.createSpan({ cls: "gz-unit", text: unit });
    // The label says what the value is, so it sits under it; the change comes after, or an empty window's note instead.
    if (p.label) el.createDiv({ cls: "gz-label", text: p.label });
    const note = emptyNote(p, current, ctx.now);
    const noteLine = note ? el.createDiv({ cls: "gz-label", text: note }) : undefined;
    if (!note && previous) drawChange(el, p, ctx.now, value, previous);
    if (note || text === "—") whyEmpty(el, p, ctx, noteLine);
  }, (slot, data, count) => drawNumber(el, p, ctx, slot, data, count)),
};

export const text: ViewDef = {
  id: "text",
  keys: [...DATA_KEYS, "text", "label", "decimals", "format", "values", "pin", "alert", "then", "empty"],
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
  mount: (el, p, ctx) => answerView(el, ctx, (data) => {
    heading(el, p);
    el.createDiv({ cls: "gz-text", text: panelValue(p, data, ctx.now).text });
    if (p.label) el.createDiv({ cls: "gz-label", text: p.label });
    if (p.empty !== undefined && noRows(data)) whyEmpty(el, p, ctx);
  }, (slot, data) => {
    answerTitle(el, p, slot);
    const { value, text } = panelValue(p, data, ctx.now);
    el.createDiv({ cls: `gz-text ${slot === "headline" ? "gz-ans-text" : "gz-fact-text"}`, text });
    if (p.label) el.createDiv({ cls: "gz-label gz-ans-label", text: p.label });
    if (p.empty !== undefined && noRows(data)) whyEmpty(el, p, ctx);
    const alert = alertOn(p, value, data, ctx.now);
    if (alert) drawStatus(el, sentence(alert));
  }),
};

export const progress: ViewDef = {
  id: "progress",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "field", "agg", "of", "max", "label", "unit", "decimals", "format", "alert", "then", "shortcut", "empty"],
  span: 1,
  needsSource: true,
  validate: (p) => [...checkAgg(p), ...formatErrors(p)],
  examples: [
    { panel: { view: "progress", source: "notes", from: "Books", max: 24, unit: "books" } },
    { panel: { view: "progress", source: "spending", field: "amount", agg: "sum", max: 500, format: "$0" } },
    { panel: { view: "progress", max: 8 }, errors: ["progress needs a source"] },
    { panel: { view: "progress", source: "notes", from: "Books", max: 24, alert: ">= 24" } },
  ],
  mount: (el, p, ctx) => answerView(el, ctx, (data) => {
    heading(el, p);
    const { value, text, unit } = panelValue(p, data, ctx.now);
    const max = p.max ?? 100;
    const big = el.createDiv({ cls: "gz-big" });
    big.createSpan({ text });
    big.createSpan({ cls: "gz-unit", text: `/ ${display(p, p.field, max, ctx.now)}${unit ? ` ${unit}` : ""}` });
    const bar = el.createDiv({ cls: "gz-progress" }).createDiv({ cls: "gz-progress-fill" });
    bar.style.width = `${Math.max(0, Math.min(100, ((value as number) / max) * 100))}%`;
    if (p.label) el.createDiv({ cls: "gz-label", text: p.label });
    const note = emptyNote(p, data, ctx.now);
    if (note) whyEmpty(el, p, ctx, el.createDiv({ cls: "gz-label", text: note }));
  }, (slot, data, count) => drawProgress(el, p, ctx, slot, data, count), ["headline", "fact", "meter"]),
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
    { panel: { view: "countdown", to: "2027-01-01", empty: "Nothing yet" }, errors: ['"empty" doesn\'t apply to countdown'] },
  ],
  mount: (el, p, ctx) => answerView(el, ctx, () => {
    heading(el, p);
    const days = daysUntil(p.to!, ctx.now);
    const big = el.createDiv({ cls: "gz-big" });
    big.createSpan({ text: String(Math.abs(days)) });
    big.createSpan({ cls: "gz-unit", text: Math.abs(days) === 1 ? "day" : "days" });
    const when = new Date(Date.parse(p.to!.length === 10 ? `${p.to}T00:00` : p.to!));
    const suffix = days < 0 ? "ago" : days === 0 ? "today" : "left";
    el.createDiv({ cls: "gz-label", text: `${p.label ? `${p.label} · ` : ""}${when.toLocaleDateString()} · ${suffix}` });
  }, (slot, _data, count) => drawCountdown(el, p, ctx, slot, count)),
};
