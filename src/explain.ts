/**
 * Where a figure comes from: the rows behind the one value a number or progress panel shows, each
 * with what it adds, and, between two times, which rows came, went or changed and by how much.
 * Worked out by running the panel's own steps again, so it can never say something the panel doesn't.
 */
import { splitByWindow } from "./compare.ts";
import { compileWhere, getPath, toNumber, valueOf, type Agg, type Row } from "./data.ts";
import { stableJson } from "./hash.ts";
import { ROW_FIELDS } from "./kind.ts";
import { rowIdOf } from "./ledger-store.ts";
import { compilePipeline } from "./pipeline.ts";
import type { Panel } from "./spec.ts";

/** One row behind a figure. */
export interface Part {
  /** What tells this row from the others across two times: its id in the ledger, else what it holds. */
  key: string;
  /** Its id in the ledger, when it is a saved row. */
  id?: string;
  row: Row;
  /** What it adds to the figure: its number for a sum, 1 for a count; undefined when the figure isn't a sum of its rows. */
  adds?: number;
  /** What the figure's field holds in it. */
  value: unknown;
}

/** A figure with the rows it was worked out from. */
export interface Explanation {
  value: unknown;
  agg: Agg;
  field?: string;
  /** The rows that count, in the order the panel's steps gave them. */
  parts: Part[];
  /** Rows the steps kept whose field holds no number, which a sum, an average, a least or a most leaves out. */
  left: number;
  /** The figure is the sum of what its rows add, so a change between two times splits by row. */
  additive: boolean;
  /** Why there are no rows to show: the figure is read from a web answer or a note, not worked out from rows. */
  direct?: string;
}

/** The views whose one figure can be explained. */
export const EXPLAINED = ["number", "progress"];

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);

/** A row with no id is told from the others by what it holds; the nth copy of the same is `…#n`. */
function keysOf(rows: readonly Row[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const id = rowIdOf(r);
    if (id !== undefined) return id;
    const content = stableJson(r);
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    return n ? `${content}#${n}` : content;
  });
}

/**
 * The figure a number or progress panel shows for what its source gave, and the rows behind it.
 * Undefined for a view with no one figure, and for a streak, which counts periods rather than rows.
 */
export function explain(p: Panel, raw: unknown, now: Date): Explanation | undefined {
  if (!EXPLAINED.includes(p.view) || p.agg === "streak") return undefined;
  const data = splitByWindow(p, compilePipeline(p, now)(raw), now).current;
  const agg: Agg = p.agg ?? (p.field ? "last" : "count");
  const value = valueOf(p, data, now);
  if (!Array.isArray(data)) {
    return { value, agg, field: p.field, parts: [], left: 0, additive: false, direct: "This value is read as it is from what the source gave; no rows add up to it." };
  }
  const rows = data.filter(isRow);
  const keys = keysOf(rows);
  const all = rows.map((row, i): Part => ({ key: keys[i], id: rowIdOf(row), row, value: getPath(row, p.field) }));
  const of = p.of && compileWhere(p.of, now);
  switch (agg) {
    case "count":
      return { value, agg, field: p.field, parts: all.map((x) => ({ ...x, adds: 1 })), left: 0, additive: true };
    case "share":
      return { value, agg, field: p.field, parts: all.map((x) => ({ ...x, value: of?.(x.row) ?? false })), left: 0, additive: false };
    case "first":
      return { value, agg, field: p.field, parts: all.slice(0, 1), left: 0, additive: false };
    case "last":
      return { value, agg, field: p.field, parts: all.slice(-1), left: 0, additive: false };
    default: {
      const counted = all.filter((x) => toNumber(x.value) !== undefined);
      const additive = agg === "sum";
      return { value, agg, field: p.field, parts: counted.map((x) => ({ ...x, ...(additive && { adds: toNumber(x.value)! }) })), left: all.length - counted.length, additive };
    }
  }
}

/** A row that came, went or changed between two times, and what that did to the figure. */
export interface Move {
  kind: "added" | "removed" | "changed";
  key: string;
  id?: string;
  /** The row as it is at the later time, or as it was for one that went. */
  row: Row;
  /** The figure's field in it before and after. */
  before?: unknown;
  after?: unknown;
  /** What it did to the figure, when the figure is the sum of its rows. */
  delta?: number;
  /** For a changed row whose own number stayed: the fields that changed. */
  fields?: string[];
}

/** What moved a figure between two times. */
export interface Waterfall {
  before: unknown;
  after: unknown;
  /** After less before, when both are numbers. */
  delta?: number;
  additive: boolean;
  /** How the figure is worked out now: for a first or a last, a row that "went" only stopped being that row. */
  agg: Agg;
  /** Each row that moved the figure, the largest move first; where the figure isn't a sum, in the order added, removed, changed. */
  moves: Move[];
  /** Rows behind the figure at both times that didn't change. */
  same: number;
}

const ORDER = { added: 0, removed: 1, changed: 2 } as const;

/** The fields of a row that a person sees: not the ones Gizmo keeps on a kind's rows. */
function shownFields(row: Row): string[] {
  return Object.keys(row).filter((k) => !ROW_FIELDS.includes(k) && k !== "settled");
}

/** The rows that came into a figure, went out of it or changed between two explanations of it, the earlier first. */
export function waterfall(before: Explanation, after: Explanation): Waterfall {
  const was = new Map(before.parts.map((x) => [x.key, x]));
  const now = new Map(after.parts.map((x) => [x.key, x]));
  const additive = before.additive && after.additive;
  const moves: Move[] = [];
  let same = 0;
  for (const x of after.parts) {
    const old = was.get(x.key);
    if (!old) {
      moves.push({ kind: "added", key: x.key, id: x.id, row: x.row, after: x.value, ...(additive && { delta: x.adds ?? 0 }) });
      continue;
    }
    const fields = [...new Set([...shownFields(old.row), ...shownFields(x.row)])].filter((f) => stableJson(old.row[f] ?? null) !== stableJson(x.row[f] ?? null));
    const delta = (x.adds ?? 0) - (old.adds ?? 0);
    if (fields.length === 0 && (!additive || delta === 0)) same++;
    else moves.push({ kind: "changed", key: x.key, id: x.id, row: x.row, before: old.value, after: x.value, fields, ...(additive && { delta }) });
  }
  for (const x of before.parts) {
    if (!now.has(x.key)) moves.push({ kind: "removed", key: x.key, id: x.id, row: x.row, before: x.value, ...(additive && { delta: -(x.adds ?? 0) }) });
  }
  if (additive) moves.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || ORDER[a.kind] - ORDER[b.kind]);
  else moves.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const [a, b] = [toNumber(before.value), toNumber(after.value)];
  return { before: before.value, after: after.value, ...(a !== undefined && b !== undefined && { delta: b - a }), additive, agg: after.agg, moves, same };
}

/** A row in a few words: its fields in the order given (a schema's), without the one the figure reads, the time last. */
export function rowWords(row: Row, show: (field: string, value: unknown) => string, order: readonly string[] = [], skip?: string): string {
  const fields = [...order.filter((f) => f in row), ...shownFields(row).filter((f) => !order.includes(f))].filter((f) => f !== "at" && f !== skip);
  const words = fields.map((f) => row[f]).flatMap((v, i) => (v === undefined || v === null || v === "" || typeof v === "object" ? [] : [show(fields[i], v)]));
  return words.join(" · ");
}
