import { stampParts } from "./time.ts";
import { checkFormat } from "./format.ts";
import { unitDef, unitFormat, unitOf, unitProblem } from "./units.ts";
import type { Panel } from "./spec.ts";

/**
 * `names` is one field name or a list of them (several chart series); `json` is text or any set of
 * keys; `format` is text or field → text; `valueMap` is field → (value → text); `alert` is a
 * condition or a `where`-style map; `compute` is name → formula; `textMap` is name → text.
 */
export type KeyType =
  | "string" | "number" | "strings" | "names" | "stringMap" | "fieldMap" | "where"
  | "boolean" | "json" | "format" | "valueMap" | "alert" | "compute" | "textMap" | "edit" | "then";

/** Keys expansion adds to a panel. They have no YAML type, so typing one is an unknown key. */
export const INTERNAL_KEYS = ["upstream", "schema", "vars", "rowVars", "target", "targetFields", "secrets", "kept", "fieldInfo", "kind"] as const;
export type InternalKey = (typeof INTERNAL_KEYS)[number];
/** A key that can be typed on a panel. */
export type PanelKey = Exclude<keyof Panel, InternalKey>;

/** Every panel key and the YAML shape it takes. Which views accept which keys is in each ViewDef. */
export const KEY_TYPES: Record<PanelKey, KeyType> = {
  view: "string", title: "string", source: "string", headers: "stringMap", pick: "string",
  from: "string", where: "where", sort: "string", limit: "number", group: "string", per: "string",
  x: "string", y: "names",
  field: "string", agg: "string", label: "string", unit: "string", decimals: "number",
  tab: "string", span: "number", text: "string", item: "string", columns: "strings", max: "number", to: "string",
  minutes: "number", fields: "fieldMap", items: "strings", save: "string", append: "string",
  line: "string", notify: "string",
  compute: "compute", select: "string", action: "string", row: "textMap", name: "string", template: "string",
  open: "string", edit: "edit", format: "format", labels: "textMap", values: "valueMap", cells: "textMap",
  layout: "string", compare: "string", goal: "number", stack: "boolean", body: "json", start: "string",
  end: "string", shortcut: "string", alias: "string", pin: "string", alert: "alert", detail: "string", of: "where",
  then: "then", empty: "string", lines: "names",
};

/** What a wrong value should have been, for the types whose names don't say it plainly. */
const EXPECTED: Partial<Record<KeyType, string>> = {
  boolean: "true or false",
  json: "text or a set of keys",
  format: "text, or a set of field: format",
  valueMap: "a set of field: {value: text}",
  alert: "a condition, or a set of field: condition",
  compute: "a set of name: formula",
  textMap: "a set of name: text",
  fieldMap: "a set of name: type, or a list of field names",
  edit: "a list of fields, or true",
  then: 'a set like {app: "[[Task inbox]]", do: add, fill: {task: "Renew {what}"}}',
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
const isText = (v: unknown) => typeof v === "string" || typeof v === "number";
const isMap = (v: unknown): v is Record<string, unknown> => isPlainObject(v) && !(v instanceof Date);
const scalarMap = (v: unknown): v is Record<string, unknown> => isMap(v) && Object.values(v).every(scalar);
const textOf = (map: Record<string, unknown>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)]));

function checkType(value: unknown, type: KeyType): boolean {
  switch (type) {
    case "string": return isText(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "strings": return Array.isArray(value) && value.every(scalar);
    case "names":
      return isText(value) || (Array.isArray(value) && value.length > 0 && value.every(isText));
    case "stringMap":
    case "where":
      return isPlainObject(value) && Object.values(value).every(scalar);
    case "fieldMap":
      // A list of names picks fields of the block a form saves to.
      if (Array.isArray(value)) return value.length > 0 && value.every(isText);
      return isPlainObject(value) && Object.values(value).every(
        (v) => typeof v === "string" || (Array.isArray(v) && v.every(scalar)) || isMap(v),
      );
    case "json": return isText(value) || isMap(value);
    case "format":
    case "alert":
      return isText(value) || scalarMap(value);
    case "textMap": return scalarMap(value);
    case "valueMap": return isMap(value) && Object.values(value).every(scalarMap);
    case "compute": return isMap(value) && Object.values(value).every(isText);
    case "edit": return value === true || (Array.isArray(value) && value.every(scalar));
    case "then":
      return isMap(value) && typeof value.app === "string" && isText(value.do)
        && (value.fill === undefined || scalarMap(value.fill)) && Object.keys(value).every((k) => ["app", "do", "fill"].includes(k));
  }
}

/** Checks one known key's value against its type; text keys take numbers and dates as text. */
export function readValue(key: PanelKey, value: unknown): { value: unknown } | { error: string } {
  const type = KEY_TYPES[key];
  if (value instanceof Date && type === "string") return { value: value.toISOString().slice(0, 10) };
  if (!checkType(value, type)) return { error: `"${key}" has the wrong type (expected ${EXPECTED[type] ?? type})` };
  switch (type) {
    case "names": return { value: Array.isArray(value) ? value.map(String) : String(value) };
    case "string": return { value: String(value) };
    case "json":
    case "alert":
      return { value: isText(value) ? String(value) : value };
    case "format": return { value: isText(value) ? String(value) : textOf(value as Record<string, unknown>) };
    case "textMap": return { value: textOf(value as Record<string, unknown>) };
    case "then": {
      const t = value as Record<string, unknown>;
      return { value: { app: String(t.app), do: String(t.do), ...(t.fill ? { fill: textOf(t.fill as Record<string, unknown>) } : {}) } };
    }
    case "valueMap":
      return { value: Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([k, v]) => [k, textOf(v)])) };
    default: return { value };
  }
}

/** The input types a field can have, besides a list of choices. */
export const FIELD_TYPES = ["text", "number", "date", "time", "checkbox", "textarea"];

/** Problems with a `fields` map (a form's, or a data block's schema). */
export function checkFields(fields: Record<string, string | string[]>): string[] {
  return Object.entries(fields)
    .filter(([, type]) => typeof type === "string" && !FIELD_TYPES.includes(type))
    .map(([name]) => `field "${name}" type must be one of ${FIELD_TYPES.join(", ")}, a unit (kg, USD…) or a list of choices`);
}

/** What a field written as a map carries besides its type: its display name, its format, and the value it starts with. */
export interface FieldInfo {
  label?: string;
  format?: string;
  default?: unknown;
  /** What a number field measures (see units.ts): `kg`, `USD`, or a word of the note's own. */
  unit?: string;
  /** For a money field: how many of each other currency one of its own is, for a value typed in that currency. */
  rates?: Record<string, number>;
  /** A number field whose unit each row says through another field: that field, and the unit for each of its values. */
  unitBy?: { field: string; units: Record<string, string> };
}

const FIELD_KEYS = ["type", "label", "format", "default", "unit", "rates"];

/**
 * A field's `unit` and `rates` as written, read into `one`; the problems with them. `unit` is a
 * word, or `{<field>: {<value>: <unit>}}` when each row's unit depends on another of its fields.
 */
function readUnit(name: string, written: Record<string, unknown>, one: FieldInfo): string[] {
  const { unit, rates } = written;
  const problems: string[] = [];
  if (isText(unit)) {
    const problem = unitProblem(String(unit));
    if (problem) problems.push(`field "${name}": ${problem}`);
    else one.unit = unitOf(String(unit)).id;
  } else if (isMap(unit)) {
    const [by, map] = Object.entries(unit)[0] ?? [];
    if (Object.keys(unit).length !== 1 || !isMap(map) || !Object.values(map).every(isText)) {
      problems.push(`field "${name}" unit must be a unit, or one field with the unit for each of its values, e.g. unit: {what: {weight: kg, sleep: h}}`);
    } else {
      const units = Object.fromEntries(Object.entries(map).map(([value, u]) => [value, String(u)]));
      const bad = Object.values(units).map(unitProblem).find((p) => p !== undefined);
      if (bad) problems.push(`field "${name}": ${bad}`);
      else one.unitBy = { field: by, units: Object.fromEntries(Object.entries(units).map(([value, u]) => [value, unitOf(u).id])) };
    }
  } else if (unit !== undefined && unit !== null) problems.push(`field "${name}" unit must be text`);
  if (rates === undefined || rates === null) return problems;
  if (one.unit === undefined || unitOf(one.unit).dim !== "money") problems.push(`field "${name}" rates needs a money unit, e.g. unit: USD`);
  else if (!isMap(rates) || !Object.entries(rates).every(([code, r]) => unitDef(code)?.dim === "money" && typeof r === "number" && r > 0)) {
    problems.push(`field "${name}" rates must give a number above 0 for each currency, e.g. rates: {JPY: 150.2}`);
  } else one.rates = Object.fromEntries(Object.entries(rates).map(([code, r]) => [code.toUpperCase(), r as number]));
  return problems;
}

/** A type word that is a unit Gizmo knows: the field is a number in that unit. */
function unitType(type: unknown): string | undefined {
  return typeof type === "string" && !FIELD_TYPES.includes(type) ? unitDef(type)?.id : undefined;
}

/** Why a field's `default` can't be used, or undefined; `today` and `now` are words for a date and a time. */
function defaultProblem(name: string, type: string | string[], value: unknown): string | undefined {
  const at = `field "${name}" default`;
  if (Array.isArray(type)) return type.some((c) => String(c) === String(value)) ? undefined : `${at} must be one of its choices: ${type.join(", ")}`;
  if (type === "date") return value === "today" || value instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? undefined : `${at} must be today or a date, e.g. 2026-01-31`;
  if (type === "time") return value === "now" || /^\d{1,2}:\d{2}$/.test(String(value)) ? undefined : `${at} must be now or a time, e.g. 09:30`;
  if (type === "number") return typeof value === "number" ? undefined : `${at} must be a number`;
  if (type === "checkbox") return typeof value === "boolean" ? undefined : `${at} must be true or false`;
  return ["string", "number", "boolean"].includes(typeof value) ? undefined : `${at} must be text`;
}

/**
 * Reads a `fields` map: each field a type word, a list of choices, or a map `{type, label, format,
 * default}` (`type` text when left out). Gives each field's type, what the maps say besides, and
 * the problems with the maps (a map with a problem leaves its field out); type words are checked
 * by checkFields.
 */
export function readFields(fields: Record<string, unknown>): { types: Record<string, string | string[]>; info: Record<string, FieldInfo>; errors: string[] } {
  const types: Record<string, string | string[]> = {};
  const info: Record<string, FieldInfo> = {};
  const errors: string[] = [];
  for (const [name, written] of Object.entries(fields)) {
    if (!isMap(written)) {
      const unit = unitType(written);
      types[name] = unit === undefined ? written as string | string[] : "number";
      if (unit !== undefined) info[name] = { unit, format: unitFormat(unit) };
      continue;
    }
    const unknown = Object.keys(written).filter((k) => !FIELD_KEYS.includes(k));
    if (unknown.length) {
      errors.push(`field "${name}" has no key "${unknown[0]}" (it takes ${FIELD_KEYS.join(", ")})`);
      continue;
    }
    const typedUnit = unitType(written.type);
    const type = typedUnit !== undefined || (written.type === undefined && written.unit !== undefined) ? "number" : written.type ?? "text";
    if (!(typeof type === "string" || (Array.isArray(type) && type.length > 0 && type.every(scalar)))) {
      errors.push(`field "${name}" type must be one of ${FIELD_TYPES.join(", ")}, a unit (kg, USD…) or a list of choices`);
      continue;
    }
    const one: FieldInfo = {};
    const problems: string[] = [];
    if (typedUnit !== undefined && written.unit !== undefined) problems.push(`field "${name}" has a unit as its type and a unit key; give one`);
    else if (written.unit !== undefined && type !== "number") problems.push(`field "${name}" has a unit, so its type must be number`);
    else problems.push(...readUnit(name, typedUnit === undefined ? written : { ...written, unit: typedUnit }, one));
    for (const key of ["label", "format"] as const) {
      const v = written[key];
      if (v === undefined || v === null) continue;
      if (!isText(v)) problems.push(`field "${name}" ${key} must be text`);
      else one[key] = String(v);
    }
    const formatProblem = one.format === undefined ? undefined : checkFormat(one.format);
    if (formatProblem) problems.push(`field "${name}": ${formatProblem}`);
    if (one.format === undefined && one.unit !== undefined) one.format = unitFormat(one.unit);
    if (written.default !== undefined && written.default !== null) {
      const problem = defaultProblem(name, type, written.default);
      if (problem) problems.push(problem);
      // A choice keeps the type it was typed with in the list: `default: 70` is the number 70 there.
      else one.default = Array.isArray(type) ? type.find((c) => String(c) === String(written.default)) : written.default instanceof Date ? written.default.toISOString().slice(0, 10) : written.default;
    }
    if (problems.length) {
      errors.push(...problems);
      continue;
    }
    types[name] = type;
    if (Object.keys(one).length) info[name] = one;
  }
  return { types, info, errors };
}

/** The value a field starts with: its `default`, with `today` and `now` read as the date and time it is. */
export function startOf(info: FieldInfo | undefined, now: Date): unknown {
  const d = info?.default;
  if (d === "today") return stampParts(now).date;
  if (d === "now") return stampParts(now).time;
  return d;
}

/** Keys every view accepts. */
export const COMMON_KEYS = ["view", "title", "tab", "span"] as const;
/** Keys that say where a panel's data comes from and how rows are narrowed. */
export const DATA_KEYS = ["source", "headers", "body", "pick", "from", "lines", "where", "sort", "limit", "compute"] as const;
/** Keys that turn rows into one row per group or period. */
export const GROUP_KEYS = ["group", "per"] as const;
/**
 * Keys that make a panel write, notify or open a note when used; `row` shapes what is saved,
 * `name` and `template` the note a save to a folder creates.
 */
export const ACTION_KEYS = ["save", "append", "line", "notify", "open", "row", "name", "template"] as const;
