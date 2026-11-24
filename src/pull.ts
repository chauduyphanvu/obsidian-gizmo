/**
 * Pull the answer: given the figure a panel should show, the value one thing it reads would need
 * for that. A knob is a number the person owns and hasn't happened yet: a field of a planned or
 * what-if row behind the figure, or a number property of the note that the panel's formulas read.
 * The panel's own steps are run again with each value tried, so the answer is whatever they say.
 */
import { copyRow, getPath, toNumber, type Row } from "./data.ts";
import { explain } from "./explain.ts";
import { formulaReads } from "./formula.ts";
import { lineOf } from "./kind.ts";
import { rowIdOf } from "./ledger-store.ts";
import { isWhatIf } from "./row-marks.ts";
import type { Panel } from "./spec.ts";
import { THIS } from "./template.ts";
import { isPlainObject } from "./keys.ts";

export type Knob =
  /** A number field of a planned or what-if row behind the figure. */
  | { kind: "row"; id: string; field: string; row: Row; value: number; whatIf: boolean }
  /** A number property of the note, read by a formula as `$this.<name>`. */
  | { kind: "property"; name: string; value: number };

/** The most knobs offered for one figure; each is solved for when a target is typed. */
export const MAX_KNOBS = 12;


/** The `$this` properties the formulas of a panel and of the blocks above it read. */
function propertiesRead(p: Panel): string[] {
  const out = new Set<string>();
  for (const stage of [...(p.upstream ?? []), p]) {
    for (const text of Object.values(stage.compute ?? {})) {
      for (const v of formulaReads(String(text))?.vars ?? []) if (v.name === THIS && v.path) out.add(v.path);
    }
  }
  return [...out];
}

/** The panel reading `value` where a knob is. */
function turned(p: Panel, raw: unknown, knob: Knob, value: number): { p: Panel; raw: unknown } {
  if (knob.kind === "row") {
    if (!Array.isArray(raw)) return { p, raw };
    const rows: unknown[] = raw;
    return { p, raw: rows.map((r): unknown => (isPlainObject(r) && rowIdOf(r) === knob.id ? Object.assign(copyRow(r), { [knob.field]: value }) : r)) };
  }
  const set = <T extends { vars?: Record<string, unknown> }>(stage: T): T => {
    const note = stage.vars?.[THIS];
    return isPlainObject(note) ? { ...stage, vars: { ...stage.vars, [THIS]: { ...note, [knob.name]: value } } } : stage;
  };
  return { p: { ...set(p), ...(p.upstream && { upstream: p.upstream.map(set) }) }, raw };
}

/** The figure as a number with a knob at `value`; undefined when the panel then shows no number. */
export function figureWith(p: Panel, raw: unknown, now: Date, knob: Knob, value: number): number | undefined {
  const t = turned(p, raw, knob, value);
  return toNumber(explain(t.p, t.raw, now)?.value);
}

/**
 * What a figure could be pulled by: each number field of a planned or what-if row behind it that
 * moves it, then each number property of the note its formulas read that moves it.
 */
export function knobsOf(p: Panel, raw: unknown, now: Date): Knob[] {
  const found = explain(p, raw, now);
  const base = toNumber(found?.value);
  if (!found || base === undefined) return [];
  const moves = (k: Knob) => {
    const other = figureWith(p, raw, now, k, k.value + (Math.abs(k.value) || 1));
    return other !== undefined && other !== base;
  };
  const out: Knob[] = [];
  const source = new Map((Array.isArray(raw) ? raw : []).filter(isPlainObject).map((r) => [rowIdOf(r), r] as const));
  for (const part of found.parts) {
    // The row as its source gave it: a computed column can't be set, only what it is computed from.
    const row = part.id === undefined ? undefined : source.get(part.id);
    if (!row || part.id === undefined || !(isWhatIf(row) || lineOf(row) === "planned")) continue;
    for (const [field, v] of Object.entries(row)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const knob: Knob = { kind: "row", id: part.id, field, row, value: v, whatIf: isWhatIf(row) };
      if (moves(knob)) out.push(knob);
    }
  }
  const note = [p, ...(p.upstream ?? [])].map((s) => s.vars?.[THIS]).find(isPlainObject);
  for (const name of note ? propertiesRead(p) : []) {
    const v = toNumber(getPath(note, name));
    if (v === undefined || name.includes(".")) continue;
    const knob: Knob = { kind: "property", name, value: v };
    if (moves(knob)) out.push(knob);
  }
  return out.slice(0, MAX_KNOBS);
}

/** The number a person typed as a target: `2500`, `$2,500.50`, `-5`. Undefined for anything else, rather than digits picked out of it. */
export function readTarget(text: string): number | undefined {
  const m = /^\s*([-−]?)\s*[$€£¥]?\s*([-−]?)\s*(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*$/.exec(text);
  if (!m || (m[3] === undefined && m[4] === undefined) || (m[1] && m[2])) return undefined;
  const n = Number(`${(m[3] ?? "0").replace(/,/g, "")}${m[4] ?? ""}`);
  return m[1] || m[2] ? -n : n;
}

/** The panel reading a note's property at a value just written, before the app has drawn it again. */
export function withProperty(p: Panel, name: string, value: number): Panel {
  return turned(p, undefined, { kind: "property", name, value }, value).p;
}

/** A knob's value for a target: found, or why there is none. */
export type Solved = { value: number } | { none: string };

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

/**
 * The value of `knob` at which the panel shows `target`. A figure that moves in a straight line with
 * the knob (a sum, an average) is solved in one step; any other by closing in between two values that
 * land on either side of the target. The answer is rounded to cents when that still gives the target
 * as the panel would show it (to half a cent).
 */
export function solve(p: Panel, raw: unknown, now: Date, knob: Knob, target: number): Solved {
  const f = (x: number) => figureWith(p, raw, now, knob, x);
  const x0 = knob.value;
  const f0 = f(x0);
  if (f0 === undefined) return { none: "the panel shows no number" };
  if (close(f0, target)) return { value: x0 };
  const step = Math.abs(x0) || 1;
  const up = f(x0 + step);
  const [x1, f1] = up !== undefined && up !== f0 ? [x0 + step, up] : [x0 - step, f(x0 - step)];
  const tidy = (x: number): Solved => {
    const cents = Math.round(x * 100) / 100;
    const at = f(cents);
    return { value: at !== undefined && Math.abs(at - target) < 0.005 ? cents : x };
  };
  if (f1 !== undefined && f1 !== f0) {
    const line = x0 + ((target - f0) * (x1 - x0)) / (f1 - f0);
    const onLine = Number.isFinite(line) ? f(line) : undefined;
    if (onLine !== undefined && Math.abs(onLine - target) < 0.005) return tidy(line);
  }
  // Not a straight line: values nearer and further on both sides, then closing in between each two
  // neighbours that land on either side of the target, the pair nearest the knob first.
  const xs = [x0];
  for (let i = -12; i <= 30; i++) xs.push(x0 + step * 2 ** i, x0 - step * 2 ** i);
  const points = xs.sort((m, n) => m - n).map((x) => ({ x, y: f(x) })).filter((pt): pt is { x: number; y: number } => pt.y !== undefined);
  if (points.every((pt) => pt.y === f0)) return { none: "changing it doesn't move the figure" };
  const pairs: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    if ((points[i - 1].y - target) * (points[i].y - target) <= 0) pairs.push([points[i - 1].x, points[i].x]);
  }
  pairs.sort((m, n) => Math.min(Math.abs(m[0] - x0), Math.abs(m[1] - x0)) - Math.min(Math.abs(n[0] - x0), Math.abs(n[1] - x0)));
  for (let [lo, hi] of pairs) {
    const rising = (f(hi) ?? 0) >= (f(lo) ?? 0);
    for (let i = 0; i < 80 && hi - lo > 1e-9; i++) {
      const mid: number = (lo + hi) / 2;
      const fm = f(mid);
      if (fm === undefined) break;
      if ((fm < target) === rising) lo = mid;
      else hi = mid;
    }
    // A figure that jumps over the target (a count, a least, a division near nothing) never lands on it.
    for (const x of [hi, lo]) {
      const at = f(x);
      if (at !== undefined && Math.abs(at - target) < 0.005) return tidy(x);
    }
  }
  return { none: pairs.length ? "no value gets the figure there exactly" : "no value gets the figure there" };
}
