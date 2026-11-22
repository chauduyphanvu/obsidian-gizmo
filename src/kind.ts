import type { Row } from "./data.ts";
import { RESERVED, SOURCE_WORDS, kindName } from "./store.ts";
import { NAME } from "./template.ts";
import { textOf } from "./text.ts";
import { toTime } from "./time.ts";

/** Why a kind can't have this name: the end of a message, or undefined when it can. */
export function kindProblem(name: string): string | undefined {
  if (!NAME.test(name)) return `kind: "${name}" can only use letters, digits and _`;
  if (RESERVED.includes(name)) return `kind can't be "${name}", which names part of an app`;
  if (SOURCE_WORDS.includes(name)) return `kind can't be "${name}", which names a kind of source`;
  return undefined;
}

/**
 * The lines a kind's row can be on: what happened and was logged (a row without `line`), what is
 * planned, what an import says happened, and what an import said that was set aside.
 */
export const LINES = ["logged", "planned", "attested", "dismissed"] as const;

/**
 * Fields Gizmo keeps on a kind's rows, which no form sets: the line the row is on, the id of the
 * row it is paired with, for a row that came from another vault the name its writer gives and
 * the writer itself (its signing key's fingerprint), which says whose row it is, and for a row
 * read from a file and accepted the id the import gave it, which says it came from a file.
 */
export const ROW_FIELDS = ["line", "matched", "by", "writer", "imported"];

/** The line a kind's row is on: what its `line` says, else logged. */
export function lineOf(row: Row): string {
  const line = row.line;
  return line === undefined || line === null || line === "" ? "logged" : textOf(line);
}

/** Why a kind's `fields` can't be used: they name a field Gizmo keeps on each row, or the row that settled a planned one. */
export function fieldsProblem(fields: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(fields, "settled")) return `fields can't have "settled": a planned row's settled holds the row that settled it`;
  const taken = Object.keys(fields).find((f) => ROW_FIELDS.includes(f));
  return taken === undefined ? undefined : `fields can't have "${taken}": Gizmo keeps ${ROW_FIELDS.join(", ")} on each row of a kind`;
}

/** Why a `lines` value can't be read, or undefined when it can. */
export function linesProblem(lines: string | string[]): string | undefined {
  const words = Array.isArray(lines) ? lines : [lines];
  if (words.length === 1 && words[0] === "all") return undefined;
  const wrong = words.find((w) => !(LINES as readonly string[]).includes(w));
  return wrong === undefined ? undefined : `lines must be all, or one or more of ${LINES.join(", ")}, not "${wrong}"`;
}

/**
 * The line a kind's row is on at a time shown ahead (`at`, What if…): a planned row nothing settled
 * whose time has come by then has happened, so it is on the logged line, not the planned one. Its
 * own line otherwise, and always when nothing is shown ahead.
 */
export function lineAt(row: Row, at?: number): string {
  const line = lineOf(row);
  if (at === undefined || line !== "planned" || row.matched) return line;
  const t = toTime(row.at);
  return t !== undefined && t <= at ? "logged" : line;
}

/**
 * The lines a panel's `lines` keeps, as one text for a cache key, with a test for a row, which reads
 * a row's line at the time shown ahead when given one (see lineAt); undefined for `all`. Without
 * `lines`, only logged rows.
 */
export function keptLines(lines: string | string[] | undefined): { key: string; keeps: (row: unknown, at?: number) => boolean } | undefined {
  const words = lines === undefined ? ["logged"] : Array.isArray(lines) ? lines : [lines];
  if (words.includes("all")) return undefined;
  const wanted = new Set(words);
  const keeps = (row: unknown, at?: number) => row !== null && typeof row === "object" && wanted.has(lineAt(row as Row, at));
  return { key: [...wanted].sort().join(","), keeps };
}

/**
 * Which rows a data note shows, for the note that owns it: a kind's note holds its logged rows,
 * so what reads the note (a search, a base) sees what happened; undefined for every row.
 */
export function heldInNote(ownerFm: Record<string, unknown> | undefined): ((list: string, row: Row) => boolean) | undefined {
  const name = kindName(ownerFm);
  return name === undefined ? undefined : (list, row) => list !== name || lineOf(row) === "logged";
}

/**
 * A kind note's keys as the app that shows it: its fields on a block named after the kind, a form
 * that adds a row, and a table of the rows, newest first, where each can be changed. `shortcut` is
 * the word that adds a row from a capture line.
 */
export function kindApp(fm: Record<string, unknown>, name: string): Record<string, unknown> {
  const fields = Object.keys(fm.fields as Record<string, unknown>);
  const shortcut = typeof fm.shortcut === "string" || typeof fm.shortcut === "number" ? String(fm.shortcut) : undefined;
  // A shared kind's rows say who wrote them. `edit: true` changes only the kind's fields, never `by`.
  const shared = fm.share !== undefined;
  const columns = ["at", ...fields.filter((f) => f !== "at"), ...(shared ? ["by"] : [])];
  return {
    app: `Every ${name} row, for any app to read and add to`,
    ...(fm.spec !== undefined && { spec: fm.spec }),
    data: { [name]: { source: name, fields: fm.fields } },
    panels: [
      { view: "form", title: `Add to ${name}`, save: name, label: "Add", ...(shortcut !== undefined && { alias: shortcut }) },
      { view: "table", title: "Rows", source: name, sort: "-at", columns, labels: { at: "When", ...(shared && { by: "By" }) }, format: { at: "relative" }, edit: true },
    ],
    ...(fm.expect !== undefined && { expect: fm.expect }),
  };
}
