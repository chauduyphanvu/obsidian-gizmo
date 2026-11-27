import type { Change } from "./activity.ts";
import { compileWhere, parseBody, rowsOf, toNumber, type Row } from "./data.ts";
import type { DataStore, Edit } from "./datastore.ts";
import { stableJson } from "./hash.ts";
import { compileFormula, rowFormula } from "./formula.ts";
import { isPlainObject } from "./keys.ts";
import { rowId } from "./ledger.ts";
import { basename } from "./store.ts";
import { parseICS } from "./sources/ics.ts";
import { stampFrom } from "./time.ts";
import type { GizmoRuntime } from "./runtime.ts";

/**
 * One way to read a file of rows into a kind, named under its `import:`: for each field, the
 * column it comes from (`negate` for a leading `-`, which turns a number's sign), the folder
 * whose new files are read this way, if one is given, and which of the file's rows it reads, by
 * their columns, as `where` reads a panel's rows.
 */
export interface ImportMap {
  name: string;
  folder?: string;
  where?: Record<string, string | number | boolean>;
  /** A value that starts with `=` is a formula over the file's columns (`formula`), as `row:` takes one over a row's fields. */
  columns: Record<string, { column: string; negate: boolean; formula?: string }>;
}

/** The files an import reads, by their extension, as the file source reads them. */
const IMPORT_TYPES: Record<string, string> = { csv: "text/csv", json: "application/json", ics: "text/calendar" };

export const importable = (path: string) => /\.(csv|json|ics)$/i.test(path);

/**
 * A kind's `import:` against its fields: each name a map of field → column (`at` among them, for
 * when each row happened), an optional `folder`, and an optional `where` on the file's columns. A
 * `-` before a column is for number fields.
 */
export function readImports(value: unknown, fields: Record<string, string | string[]>): { maps: ImportMap[]; errors: string[] } {
  const maps: ImportMap[] = [];
  const errors: string[] = [];
  if (value === undefined || value === null) return { maps, errors };
  if (!isPlainObject(value)) return { maps, errors: ['import must be a set of named maps, e.g. import: {bank: {at: Date, amount: "-Amount"}}'] };
  for (const [name, raw] of Object.entries(value)) {
    const at = `import.${name}`;
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be a set of field: column, e.g. {at: Date, amount: Amount}`);
      continue;
    }
    const map: ImportMap = { name, columns: {} };
    const problems: string[] = [];
    for (const [field, v] of Object.entries(raw)) {
      if (field === "folder") {
        const folder = typeof v === "string" ? v.trim().replace(/^\/+|\/+$/g, "") : "";
        if (folder) map.folder = folder;
        else problems.push(`${at}: folder must name a folder of the vault, e.g. folder: Inbox/Bank`);
        continue;
      }
      if (field === "where") {
        if (isPlainObject(v) && Object.keys(v).length && Object.values(v).every((c) => ["string", "number", "boolean"].includes(typeof c))) map.where = v as ImportMap["where"];
        else problems.push(`${at}: where must be a set of column: condition, e.g. where: {Amount: "< 0"}`);
        continue;
      }
      const type = field === "at" ? "at" : fields[field];
      if (type === undefined) {
        problems.push(`${at}: "${field}" isn't a field of the kind; its fields are ${["at", ...Object.keys(fields)].join(", ")}`);
        continue;
      }
      const text = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
      const formula = rowFormula(text);
      if (formula !== undefined) {
        const f = compileFormula(formula, new Set(), true);
        if ("error" in f) problems.push(`${at}: ${field}: ${f.error.replace(/^(\$\S+) isn't an input or param$/, "an import's formula reads the file's columns, not $1")}`);
        else map.columns[field] = { column: text, negate: false, formula };
        continue;
      }
      const negate = text.startsWith("-");
      const column = negate ? text.slice(1).trim() : text;
      if (!column) problems.push(`${at}: ${field} must name a column of the file`);
      else if (negate && type !== "number") problems.push(`${at}: a - before a column turns a number's sign, and ${field} isn't a number`);
      else map.columns[field] = { column, negate };
    }
    if (!problems.length && !map.columns.at) problems.push(`${at} needs at: the column that says when each row happened`);
    if (problems.length) errors.push(...problems);
    else maps.push(map);
  }
  return { maps, errors };
}

/** An import map's formula worked out on one record of the file, its columns read as a row's fields. */
function runFormula(text: string, record: Record<string, unknown>, now: Date): unknown {
  const f = compileFormula(text, new Set(), true);
  return "run" in f ? f.run(record, { prev: undefined, vars: {}, now }) : undefined;
}

/** A number as a bank writes it: digits with a sign, thousands commas, a currency sign. */
function numberOf(v: unknown): number | undefined {
  return toNumber(v) ?? (typeof v === "string" ? toNumber(v.replace(/[$€£¥\s]/g, "")) : undefined);
}

/** A record as a map's `where` reads it: a column it tests that holds money (`-$14.50`) is that number, as a field reads it. */
function asWhereReads(record: Record<string, unknown>, where: Record<string, unknown>): Record<string, unknown> {
  let out = record;
  for (const column of Object.keys(where)) {
    const v = record[column];
    if (typeof v !== "string" || toNumber(v) !== undefined) continue;
    const n = numberOf(v);
    if (n !== undefined) out = { ...out, [column]: n };
  }
  return out;
}

/**
 * A date or time as a file writes it, as a row keeps it: `2026-11-19`, a stamp as written, a US
 * date (`11/19/2026`) as `2026-11-19`, or an ISO time as a stamp with the clock and offset it was
 * written with (see stampFrom). Never moved to this device's zone, so every device reads a file
 * into the same rows, with the same ids, and pairs them on the same days.
 */
function dateOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = v.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) {
    const [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${us[3]}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : undefined;
  }
  return stampFrom(text);
}

/** One cell as the field's type keeps it; why not, when it can't be. */
function cellOf(raw: unknown, type: string | string[], negate: boolean, column: string): { value: unknown } | { error: string } {
  if (type === "at" || type === "date") {
    const d = dateOf(raw);
    return d === undefined ? { error: `${column} isn't a date` } : { value: d };
  }
  if (type === "number") {
    const n = numberOf(raw);
    return n === undefined ? { error: `${column} isn't a number` } : { value: negate ? -n : n };
  }
  if (Array.isArray(type)) return { value: type.find((c) => String(c).toLowerCase() === String(raw).trim().toLowerCase()) ?? String(raw).trim() };
  if (type === "checkbox") return { value: ["true", "yes", "y", "1"].includes(String(raw).trim().toLowerCase()) };
  return { value: String(raw).trim() };
}

/**
 * The rows a file's records make under a map, each on the attested line, with an id made from the
 * kind, the map (two accounts can hold the same charge on one day), what the row holds and which
 * copy of it this is in the file: the same file read again, or a later export that overlaps it,
 * gives the same ids, so it adds nothing. A record the map's `where` leaves out is counted in
 * `left`; one that can't be read is skipped, and why is told.
 */
export function importRows(
  kind: string, map: ImportMap, fields: Record<string, string | string[]>, records: readonly unknown[], now = new Date(),
): { rows: { id: string; row: Row }[]; skipped: string[]; left: number } {
  const rows: { id: string; row: Row }[] = [];
  const skipped: string[] = [];
  const copies = new Map<string, number>();
  const keep = map.where ? compileWhere(map.where, now) : () => true;
  let left = 0;
  records.forEach((record, i) => {
    if (!isPlainObject(record)) return void skipped.push(`row ${i + 1} isn't a set of columns`);
    if (!keep(map.where ? asWhereReads(record, map.where) : record)) return void left++;
    const row: Row = {};
    for (const [field, { column, negate, formula }] of Object.entries(map.columns)) {
      const raw = formula === undefined ? record[column] : runFormula(formula, record, now);
      if (raw === undefined || raw === null || raw === "") {
        if (field === "at") return void skipped.push(`row ${i + 1} has no ${column}`);
        continue;
      }
      const cell = cellOf(raw, field === "at" ? "at" : fields[field], negate, column);
      if ("error" in cell) return void skipped.push(`row ${i + 1}: ${cell.error}`);
      row[field] = cell.value;
    }
    const content = stableJson(row);
    const n = copies.get(content) ?? 0;
    copies.set(content, n + 1);
    rows.push({ id: rowId(`attest\n${kind}\n${map.name}\n${content}\n${n}`), row: { ...row, line: "attested" } });
  });
  return { rows, skipped, left };
}

/** The records in a file's text, by its extension: a table's rows, a JSON list, a calendar's events (their times the same text on every device). */
function recordsOf(path: string, text: string, now: Date): unknown[] {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
  if (ext === "ics") return parseICS(text, now, true);
  // Spreadsheet exports often start with a byte order mark, which would stick to the first column's name.
  const data = parseBody(text.replace(/^\uFEFF/, ""), IMPORT_TYPES[ext] ?? "", now);
  return typeof data === "string" ? [] : rowsOf(data);
}

/** What reading a file into a kind did, for a notice to say. */
export interface Imported {
  added: number;
  /** Rows an earlier import of the same file already added. */
  there: number;
  /** Rows imported before and then undone, which stay out. */
  gone: number;
  /** Rows the map's `where` left out. */
  left: number;
  skipped: string[];
  /** The activity log's entry for the rows added. */
  entry?: string;
}

/**
 * Reads a file into a kind's rows under one of its maps: every new row in one write, kept in the
 * activity log as one entry, which one Undo takes back.
 */
/** The ids a file's rows get under a map, as reading it would add them: a file read before gives ids the kind has. */
export function fileRowIds(kind: { name: string; fields: Record<string, string | string[]> }, map: ImportMap, file: { path: string; text: string }, now: Date): string[] {
  return importRows(kind.name, map, kind.fields, recordsOf(file.path, file.text, now), now).rows.map((r) => r.id);
}

export async function runImport(
  deps: { store: DataStore; now(): Date; log?(what: string, changes: Change[]): Promise<string | undefined> | void },
  kind: { name: string; fields: Record<string, string | string[]> }, map: ImportMap, file: { path: string; text: string },
): Promise<Imported> {
  const { rows, skipped, left } = importRows(kind.name, map, kind.fields, recordsOf(file.path, file.text, deps.now()), deps.now());
  if (!rows.length) return { added: 0, there: 0, gone: 0, left, skipped };
  const edits: Edit[] = rows.map(({ id, row }) => ({ op: "add", list: kind.name, row, id }));
  const done = await deps.store.batch(edits);
  if ("refused" in done) throw new Error("its rows changed meanwhile");
  const changes: Change[] = done.flatMap((d) => (d.already ? [] : [{ kind: "row-added" as const, path: deps.store.dataPath, list: kind.name, row: d.row, ...(d.event && { event: d.event }) }]));
  const n = changes.length;
  const entry = n ? await deps.log?.(`Imported ${n} ${n === 1 ? "row" : "rows"} from ${basename(file.path)}`, changes) : undefined;
  return {
    added: n,
    there: done.filter((d) => d.already === "there").length,
    gone: done.filter((d) => d.already === "gone").length,
    left,
    skipped,
    ...(entry && { entry }),
  };
}

/** What an import did, as a notice says it. */
export function importedText(r: Imported, kind: string, file: string): string {
  const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
  const first = r.added ? `Imported ${rows(r.added)} from ${file} into ${kind}` : `Nothing new in ${file} for ${kind}`;
  const parts = [
    r.left ? `${first}, skipped ${r.left}` : first,
    ...(r.there ? [`${rows(r.there)} already imported`] : []),
    ...(r.gone ? [`${rows(r.gone)} already imported, then undone, so left out`] : []),
    ...(r.skipped.length ? [`${rows(r.skipped.length)} skipped (${r.skipped[0]}${r.skipped.length > 1 ? ", …" : ""})`] : []),
  ];
  return parts.join("; ");
}

/** What's said when no kind can import, or no file of the vault can be imported. */
export const NO_IMPORT_WAYS = "No kind has a way to import yet: give a kind note an import: map, e.g. import: {bank: {at: Date, amount: Amount}}";
export const NO_IMPORT_FILES = "No .csv, .json or .ics file in this vault to import";

/** One way to import: a kind and one of its maps, and the folder that map names, if any. */
export interface ImportWay {
  kind: string;
  name: string;
  map: string;
  folder?: string;
}

/** Every kind's maps under `import:`, as the background service reads them. */
export function importWays(rt: GizmoRuntime): ImportWay[] {
  return rt.background.list().flatMap(({ path, name }) => (rt.background.spec(path)?.kind?.imports ?? [])
    .map((m) => ({ kind: path, name, map: m.name, ...(m.folder !== undefined && { folder: m.folder }) })));
}

/** The files of `paths` a map can read, those in its folder first. */
export function importFiles(paths: string[], way: ImportWay): string[] {
  const all = paths.filter(importable);
  const inFolder = (p: string) => way.folder !== undefined && p.startsWith(`${way.folder}/`);
  return [...all.filter(inFolder).sort(), ...all.filter((p) => !inFolder(p)).sort()];
}

/** Reads a file into a kind under one of its maps: what to tell of it, and the activity entry an Undo takes back. */
export async function importNow(rt: GizmoRuntime, way: ImportWay, path: string): Promise<{ text: string; entry?: string }> {
  const r = await rt.background.importFile(way.kind, way.map, path, "you");
  if ("error" in r) return { text: `Couldn't import ${basename(path)}: ${r.error}` };
  return { text: importedText(r, way.name, basename(path)), ...(r.entry && { entry: r.entry }) };
}
