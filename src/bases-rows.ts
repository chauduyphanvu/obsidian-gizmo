import type { Row } from "./data.ts";
import { noteRow } from "./datalayer.ts";
import { editErrors } from "./edit.ts";
import { checkPanel, type Panel } from "./spec.ts";

/** One note a base shows: its file, and any property's value already made plain (text, number, true/false, list, null). */
export interface BaseEntry {
  file: { path: string; basename: string; stat: { mtime: number; ctime: number } };
  getValue(id: string): unknown;
}

/** What a row reads of a note besides its entry. */
export interface NoteReads {
  frontmatter(path: string): Record<string, unknown> | undefined;
  tags(path: string): string[];
}

/** File properties a note's row already has, under the names `source: notes` gives them. */
const FILE_FIELDS: Record<string, string> = {
  "file.name": "name",
  "file.basename": "name",
  "file.path": "path",
  "file.mtime": "mtime",
  "file.ctime": "ctime",
  "file.tags": "tags",
};

/**
 * The row field a Bases property id stands for: a note property by its own name, a file property
 * as a notes row names it, anything else (a formula, another file property) under its whole id.
 */
export function fieldOf(id: string): string {
  if (id.startsWith("note.")) return id.slice("note.".length);
  return FILE_FIELDS[id] ?? id;
}

/** The ids whose values a row takes from its entry rather than its note: formulas, and file properties a notes row lacks. */
export function entryIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => id.startsWith("formula.") || (id.startsWith("file.") && !Object.hasOwn(FILE_FIELDS, id))))];
}

/** A base's note as the row `source: notes` gives, plus the values of `ids` (see entryIds) under their ids. */
export function entryRow(entry: BaseEntry, ids: readonly string[], reads: NoteReads): Row {
  const { path, basename, stat } = entry.file;
  const row = noteRow({ path, basename, mtime: stat.mtime, ctime: stat.ctime }, reads.frontmatter(path), reads.tags(path));
  for (const id of ids) row[id] = entry.getValue(id);
  return row;
}

export type BasesKind = "board" | "calendar" | "timeline" | "chart" | "number";

/** Reads one option of a view as the builder uses it: a field name, text, or a dropdown's choice. */
export type OptionValue = (key: string) => string | undefined;

/** One setting in a Gizmo view's options in Bases. */
export interface OptionDef {
  key: string;
  displayName: string;
  type: "property" | "text" | "dropdown";
  /** A dropdown's choices, value → label; the first is the default. */
  choices?: Record<string, string>;
  placeholder?: string;
  /** Whether the other options make this one meaningless, so Bases hides it. */
  hidden?(value: OptionValue): boolean;
}

const AGGS = { count: "Count", sum: "Sum", avg: "Average", min: "Min", max: "Max" };

/** Counting reads no field, so the option naming one is hidden. */
const counting = (value: OptionValue) => value("agg") === "count";

/** The Gizmo views a base can switch to: their names and icons in Bases' views menu, and their options. */
export const BASES_VIEWS: Record<BasesKind, { name: string; icon: string; options: OptionDef[] }> = {
  board: {
    name: "Gizmo board",
    icon: "kanban-square",
    options: [
      { key: "group", displayName: "Group by", type: "property" },
      { key: "item", displayName: "Card text", type: "text", placeholder: "{name} · {due}" },
    ],
  },
  calendar: {
    name: "Gizmo calendar",
    icon: "calendar",
    options: [
      { key: "date", displayName: "Date", type: "property" },
      { key: "layout", displayName: "Layout", type: "dropdown", choices: { month: "Month", year: "Year" } },
      { key: "agg", displayName: "Aggregate", type: "dropdown", choices: AGGS },
      { key: "value", displayName: "Value", type: "property", hidden: counting },
    ],
  },
  timeline: {
    name: "Gizmo timeline",
    icon: "gantt-chart",
    options: [
      { key: "start", displayName: "Start", type: "property" },
      { key: "end", displayName: "End", type: "property" },
      { key: "item", displayName: "Row text", type: "text", placeholder: "{name}" },
    ],
  },
  chart: {
    name: "Gizmo chart",
    icon: "line-chart",
    options: [
      { key: "chart", displayName: "Type", type: "dropdown", choices: { bar: "Bar", line: "Line", pie: "Pie", scatter: "Scatter" } },
      { key: "x", displayName: "X axis", type: "property" },
      { key: "agg", displayName: "Aggregate", type: "dropdown", choices: { ...AGGS, none: "None (a point per note)" }, hidden: (v) => v("chart") === "scatter" },
      {
        key: "per", displayName: "Per", type: "dropdown",
        choices: { none: "None", day: "Day", week: "Week", month: "Month", year: "Year" },
        hidden: (v) => v("chart") === "scatter" || v("agg") === "none",
      },
      { key: "y", displayName: "Y axis", type: "property", hidden: (v) => v("chart") !== "scatter" && v("agg") === "count" },
      { key: "goal", displayName: "Goal", type: "text", placeholder: "A number", hidden: (v) => v("chart") !== "line" && v("chart") !== "bar" },
    ],
  },
  number: {
    name: "Gizmo number",
    icon: "hash",
    options: [
      { key: "agg", displayName: "Aggregate", type: "dropdown", choices: { ...AGGS, last: "Last" } },
      { key: "field", displayName: "Property", type: "property", hidden: counting },
      { key: "label", displayName: "Label", type: "text" },
    ],
  },
};

/**
 * A view's options as the builder reads them, from what Bases keeps (`stored`: a property option
 * as its property id): a property as its row field, text when there is some, a dropdown's choice
 * or else its default.
 */
export function optionValues(kind: BasesKind, stored: (key: string) => unknown): OptionValue {
  const defs = new Map(BASES_VIEWS[kind].options.map((o) => [o.key, o]));
  return (key) => {
    const def = defs.get(key);
    const raw = stored(key);
    // A goal typed straight into the .base file reads back as a number.
    const text = (typeof raw === "string" || typeof raw === "number") && String(raw).trim() !== "" ? String(raw).trim() : undefined;
    if (def?.type === "property") return text === undefined ? undefined : fieldOf(text);
    if (def?.type === "dropdown") return text !== undefined && Object.hasOwn(def.choices!, text) ? text : Object.keys(def.choices!)[0];
    return text;
  };
}

/** A goal typed as a number is one; anything else is left for checkPanel to refuse. */
function goalOf(text: string | undefined): number | string | undefined {
  return text !== undefined && Number.isFinite(Number(text)) ? Number(text) : text;
}

/** The panel keys one Gizmo view in a base stands for, and problems checkPanel can't see. */
function keysOf(kind: BasesKind, v: OptionValue): { keys: Record<string, unknown>; errors: string[] } {
  const agg = v("agg");
  const aggLabel = BASES_VIEWS[kind].options.find((o) => o.key === "agg")?.choices?.[agg ?? ""];
  const needs = (what: string, field: string | undefined) => (agg !== "count" && field === undefined ? [`${aggLabel} needs ${what}`] : []);
  switch (kind) {
    case "board": {
      // A board must be able to write its group; the board's own check doesn't know Bases' fields.
      const group = v("group");
      return { keys: { view: "board", group, item: v("item") }, errors: group === undefined ? [] : basesFieldErrors(group) };
    }
    case "timeline":
      return { keys: { view: "timeline", start: v("start"), end: v("end"), item: v("item") }, errors: [] };
    case "calendar": {
      const totals = agg === "count" ? {} : { y: v("value"), agg };
      return { keys: { view: "calendar", group: v("date"), layout: v("layout") === "year" ? "year" : undefined, ...totals }, errors: needs("a value", v("value")) };
    }
    case "number":
      return { keys: { view: "number", agg, field: agg === "count" ? undefined : v("field"), label: v("label") }, errors: needs("a property", v("field")) };
    case "chart": {
      const view = v("chart")!;
      const [x, y] = [v("x"), v("y")];
      if (view === "scatter") return { keys: { view, x, y }, errors: [] };
      const goal = view === "line" || view === "bar" ? goalOf(v("goal")) : undefined;
      if (agg === "none") return { keys: { view, x, y, goal }, errors: [] };
      const per = v("per") === "none" ? undefined : v("per");
      return { keys: { view, group: x, per, ...(agg === "count" ? {} : { y, agg }), goal }, errors: needs("y", y) };
    }
  }
}

/**
 * The Gizmo panel a view in a base draws, checked as any app's panel is. `source` names the base
 * (any path ending in .base), which makes the rows notes: cards link to them, and a board can
 * write to them.
 */
export function basesPanel(kind: BasesKind, stored: (key: string) => unknown, source: string): { panel?: Panel; errors: string[] } {
  const { keys, errors } = keysOf(kind, optionValues(kind, stored));
  const raw = Object.fromEntries(Object.entries({ ...keys, source }).filter(([, value]) => value !== undefined));
  const checked = checkPanel(raw, true);
  if (errors.length || !checked.panel) return { errors: [...checked.errors, ...errors] };
  return checked;
}

/** A field Bases works out rather than reads from the note's properties: a formula, a file property. */
function basesFieldErrors(field: string): string[] {
  if (field.startsWith("formula.")) return [`edit: "${field}" is a formula in the base`];
  if (field.startsWith("file.")) return [`edit: "${field}" comes from the note's file, not its properties`];
  return [];
}

/**
 * Why a field of a base's note can't be written from this panel: Bases works it out, or it can't
 * be written from any notes panel (a file field, a property that makes a note an app).
 */
export function writeErrors(p: Panel, field: string): string[] {
  return [...basesFieldErrors(field), ...editErrors(p, [field])];
}
