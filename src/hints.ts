import { AGGS } from "./data.ts";
import { PERIODS } from "./time.ts";
import { BLOCK_KEYS } from "./expand.ts";
import { APP_KEYS, COMPONENT_KEYS } from "./store.ts";
import { COMMON_KEYS, FIELD_TYPES } from "./keys.ts";
import { VIEW_DEFS, viewDef } from "./views/registry.ts";
import { contextAt, noteKind, type Context, type Position } from "./yamlpos.ts";

/** One plain-language line for every key a note can hold: the note's own, a panel's, a data block's. */
export const KEY_HINTS: Record<string, string> = {
  // The note
  app: "Makes this note an app; the text is its one-line description",
  spec: "Language version; leave it at 1",
  refresh: "How often web data reloads, e.g. 30s, 5m, 1h (at least 10s)",
  store: "The note that keeps this app's saved lists, e.g. [[Weight log]]",
  data: "Named sources panels share: data: {name: {source: https://…}}",
  inputs: "Controls above the panels: a list of choices, date, or text for a search box",
  panels: "The panels this app shows, one list item each",
  tabs: "Panels grouped in tabs: tabs: {Score: [ …panels… ], Waiting: [ … ]}",
  use: "Use a component note here, e.g. use: \"[[Ticker]]\"",
  with: "Give the component its params, e.g. with: {symbol: AAPL}",
  expect: "What this app's data should do: a row by a time (every, by), what each row holds (check), what no row matches (none)",
  component: "Makes this note a reusable component; the text says what it is",
  params: "Names this component takes, each with an optional default",
  for: "Show this component on every note in a folder or tag, e.g. Books/ or \"#book\"",
  // Every panel
  view: "What kind of panel this is: number, line, bar, table, list, …",
  title: "The panel's heading",
  tab: "Put this panel in a tab with this name",
  span: "With layout: grid, how many of the 4 columns wide this panel is: 1 to 4",
  // Where the rows come from
  source: "Where the data comes from: a web address, a vault file, notes, tasks, this, a saved list or a data block",
  headers: "Request headers for a web source, e.g. {authorization: \"Bearer {secret:key}\"}",
  pick: "Dig into the response with a path, e.g. features or hourly.time",
  from: "Which notes to read, for notes or tasks: a folder (Books) or a #tag, commas for several",
  where: "Keep only matching rows, e.g. {status: done, rating: \"> 3\"}",
  sort: "Order rows by a field; a leading - sorts high to low",
  limit: "Keep only the first N rows",
  compute: "Add a column to each row: name: formula, e.g. change: round(close - prev(close), 2)",
  body: "Send this as a POST body: text, or a set of keys sent as JSON",
  group: "One row per value of this field; a date field groups by period",
  per: "With group on a date: day, week, month or year",
  // What a panel shows
  x: "The field along the bottom of a chart, or the first field of a scatter",
  y: "The field (or list of fields) a chart draws",
  field: "The field a number or progress panel reads",
  agg: "How rows become one value: count, sum, avg, min, max, first, last, streak, share",
  label: "A small caption under the panel",
  unit: "Text after the value, e.g. °F or km/s",
  decimals: "How many decimal places to show",
  text: "The sentence to show; {field} fills from the row, $name from an input",
  item: "How each row reads, e.g. \"{title} · {author}\"",
  columns: "Which fields a table shows, in order",
  max: "The value that counts as full, e.g. 9 for a progress bar",
  to: "The date a countdown counts down to",
  minutes: "How long a timer runs",
  items: "The things a checklist holds",
  format: "How values read: \"0.0 °F\", \"$0,0.00\", \"0%\", date, relative, duration, bytes",
  labels: "Display names for fields: labels: {temperature_2m_max: High}",
  values: "Display text for a field's values: values: {weathercode: {0: Clear}}",
  cells: "How a table column is drawn: progress, sparkline, link, image or check",
  layout: "cards shows table rows as cards; year draws a calendar as a year",
  compare: "previous: show the change against the window just before (needs a date window in where)",
  goal: "A target line across a line or bar chart",
  stack: "true stacks the bars of several y fields",
  start: "The field a timeline bar starts at",
  end: "The field a timeline bar ends at",
  // Acting
  fields: "A form's inputs or a block's schema: name: type (or a list of choices), or name: {type, label, format, default}",
  save: "Where a click saves its row: a list name, or a folder ending in /",
  append: "A note to add a line to",
  line: "The line to add with append; {fields} and {date} fill in",
  notify: "A message to show once it's done",
  select: "Name the clicked row so other panels can read $name.field",
  action: "Give each row a button with this label; it runs save, append or open",
  row: "What to save, one {field} per name: row: {title: \"{title}\"}",
  name: "The new note's file name, e.g. \"{title}\"",
  template: "A note whose text becomes the body of each new note",
  open: "Open this note afterwards, e.g. \"{path}\"",
  edit: "Table columns to change in place: edit: [status, done], or true for every field of the block shown",
  detail: "A sentence about the row you pick, shown under the rows: \"{name}: due {due}\"",
  of: "With agg: share, the rows to count, e.g. of: {outcome: right}",
  shortcut: "Gives this button, form or checklist a command and link; letters, digits and -",
  alias: "A short name to type this shortcut on a capture line (Gizmo: Do…, or ;; in a note), e.g. weight",
  // Background
  pin: "status shows this panel's value in the status bar",
  alert: "Tell me when this is true, e.g. \">= 5\" or {kp: \">= 5\"}",
  then: "Then run another app's shortcut: {app: \"[[Task inbox]]\", do: add, fill: {task: \"Renew {what}\"}}",
  // Data blocks only
  record: "Save a sample of this source on a timer: 10m, 1h, 1d",
  into: "The saved list a record writes to; default is <block>_log",
};

/** What a key means at the top of an app note, where that differs from what it means in a panel. */
const TOP_HINTS: Record<string, string> = {
  layout: "How the app is laid out: composed (default) or grid",
};

/** What each view is for, first line only. */
export const VIEW_HINTS: Record<string, string> = {
  number: "One big number: a field, or a count, sum or average",
  text: "A sentence filled in from the data",
  line: "A line chart over time or along any ordered field",
  bar: "A bar chart, one bar per group or period",
  pie: "A pie of the largest shares",
  table: "Rows in a table; columns can be edited in place",
  list: "Rows as a list, each written with item",
  button: "A button that saves a line, adds to a note or opens one",
  form: "A small form that saves what you type",
  checklist: "Items you tick off",
  countdown: "Days until a date",
  progress: "A bar that fills toward a max",
  timer: "A countdown timer that can save when it ends",
  calendar: "A month of days shaded by count, or a year with layout: year",
  board: "Columns of cards by status; drag a card to change its status",
  scatter: "A dot per row, x against y",
  timeline: "A bar per row from its start to its end",
  alerts: "Every alert that is true right now, across the vault",
};

const AGG_HINTS: Record<(typeof AGGS)[number], string> = {
  count: "How many rows",
  sum: "Add the field up",
  avg: "The average of the field",
  min: "The smallest value",
  max: "The largest value",
  first: "The first row's value",
  last: "The last row's value",
  streak: "Days in a row, up to the latest",
  share: "The fraction of rows that match of, as a percent",
};

const PER_HINTS: Record<(typeof PERIODS)[number], string> = {
  day: "One row per day",
  week: "One row per week",
  month: "One row per month",
  year: "One row per year",
};

const FIELD_HINTS: Record<string, string> = {
  text: "A line of text",
  number: "A number",
  date: "A date picker",
  time: "A time of day",
  checkbox: "A tick box",
  textarea: "Several lines of text",
};

/**
 * The words a value can be, each with what it does, by the key it follows. `fields` holds the
 * types a field can have, for the values directly under a `fields:` map; `source` the kinds of
 * source that are one word (the others are an address, a file, or a name).
 */
export const VALUE_HINTS: Record<string, Record<string, string>> = {
  view: Object.fromEntries(VIEW_DEFS.map((d) => [d.id, VIEW_HINTS[d.id] ?? ""])),
  agg: AGG_HINTS,
  per: PER_HINTS,
  layout: { cards: "Each table row as a card", year: "A calendar drawn as a whole year" },
  compare: { previous: "The change against the window just before" },
  pin: { status: "Show the value in the status bar" },
  source: {
    notes: "One row per note in from: a folder or #tag",
    tasks: "One row per checkbox task in the notes in from",
    this: "One row: the properties of the note this app sits in",
    expect: "One row per window of each rhythm under expect: rule, window, met",
  },
  fields: Object.fromEntries(FIELD_TYPES.map((t) => [t, FIELD_HINTS[t] ?? ""])),
};

/**
 * The values of `layout` at the top of an app. A note that is one panel may also mean that panel's
 * layout there, so VALUE_HINTS.layout is offered beside them.
 */
export const APP_LAYOUTS: Record<string, string> = {
  composed: "Panels placed by what they show, in one column (the default)",
  grid: "Panels on a grid of columns, in the order written; span sets the width",
};

/** Value keys that only mean something in a panel, not in a data block. */
const PANEL_VALUES = ["view", "layout", "compare", "pin"];

export interface Suggestion {
  kind: "key" | "value";
  text: string;
  hint: string;
}

// `layout`, `devices` and `expect` are offered but aren't reserved: a list or a saved field may still be called that.
const TOP_KEYS = { app: [...APP_KEYS, "layout", "devices", "expect"], component: COMPONENT_KEYS };

/** Keys a panel with this view takes. */
function panelKeys(view: string): string[] | undefined {
  const def = viewDef(view);
  return def && [...COMMON_KEYS, ...def.keys];
}

/** What can be typed as a key here, in the order to offer it. */
function keysFor(ctx: Context, isComponent: boolean): readonly string[] {
  switch (ctx.where) {
    case "top": {
      const own = ctx.view && !isComponent ? panelKeys(ctx.view) ?? [] : [];
      return [...new Set([...TOP_KEYS[isComponent ? "component" : "app"], ...own])];
    }
    case "panel": return (ctx.view && panelKeys(ctx.view)) || ["view", "use", "with"];
    case "block": return BLOCK_KEYS;
    default: return [];
  }
}

/** The values the key being typed takes where the cursor is, or none. */
function valuesFor(ctx: Context, isComponent: boolean): Record<string, string> {
  if (ctx.where === "fields") return VALUE_HINTS.fields;
  const key = ctx.key;
  if (!key || key === "fields" || !["top", "panel", "block"].includes(ctx.where)) return {};
  if (ctx.where === "block" && PANEL_VALUES.includes(key)) return {};
  if (key === "layout" && ctx.where === "top" && !isComponent) return ctx.view ? { ...APP_LAYOUTS, ...VALUE_HINTS.layout } : APP_LAYOUTS;
  return Object.hasOwn(VALUE_HINTS, key) ? VALUE_HINTS[key] : {};
}

/** What the typed text starts, then what merely contains it; everything for no text. */
function ranked(words: readonly string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  if (!p) return [...words];
  return [...words.filter((w) => w.startsWith(p)), ...words.filter((w) => !w.startsWith(p) && w.includes(p))];
}

/**
 * The keys or values worth offering at a cursor position, each with its hint: keys valid in the
 * map the cursor is in (minus those already typed there), or the allowed values of the key being
 * typed. Nothing when the position takes free text, or the one thing left is what is already typed.
 */
export function suggestionsFor(ctx: Context, isComponent: boolean): Suggestion[] {
  const values = valuesFor(ctx, isComponent);
  const out: Suggestion[] = ctx.position === "key"
    ? ranked(keysFor(ctx, isComponent).filter((k) => !ctx.present.includes(k)), ctx.prefix)
      .map((text) => ({ kind: "key", text, hint: (ctx.where === "top" && TOP_HINTS[text]) || KEY_HINTS[text] || "" }))
    : ranked(Object.keys(values), ctx.prefix).map((text) => ({ kind: "value", text, hint: values[text] }));
  return out.length === 1 && out[0].text === ctx.prefix ? [] : out;
}

/** What replaces the typed text when a suggestion is picked; a key gets its colon unless one is already there. */
export function completion(s: Suggestion, after: string): string {
  return s.kind === "key" && !after.startsWith(":") ? `${s.text}: ` : s.text;
}

/**
 * What to pop up at a cursor in a note whose lines (up to the end of its frontmatter) are given:
 * only in an app or component, and a key only once a letter of it is typed, since a list on every
 * empty line would take Enter and the arrow keys from someone just moving about. Undefined when
 * there is nothing to offer.
 */
export function suggestionsAt(lines: string[], line: number, ch: number): { from: Position; prefix: string; suggestions: Suggestion[] } | undefined {
  const kind = noteKind(lines);
  const ctx = kind && contextAt(lines, line, ch);
  if (!ctx || (ctx.position === "key" && !ctx.prefix)) return undefined;
  const suggestions = suggestionsFor(ctx, kind === "component");
  return suggestions.length ? { from: ctx.from, prefix: ctx.prefix, suggestions } : undefined;
}
