import { widenForCompare } from "./compare.ts";
import { compileWhere, getPath, sortRows } from "./data.ts";
import { compileCompute, computesRowByRow } from "./formula.ts";
import { groupRows, rowsFromArrays, rowsFromEqualArrays, totalFields } from "./group.ts";
import type { Panel } from "./spec.ts";
import { viewDef } from "./views/registry.ts";

/** The keys that turn a source's data into what a panel draws; a chained block is one such stage. */
export type PipelineKeys = Pick<Panel, "pick" | "compute" | "vars" | "where" | "compare" | "sort" | "limit" | "group" | "per" | "agg" | "of" | "y" | "columns">;

/**
 * A panel's data steps as one function, with its conditions parsed up front: the stages of the
 * blocks above the one it names, root first, then its own keys.
 */
export function compilePipeline(p: PipelineKeys & Pick<Panel, "upstream"> & Partial<Pick<Panel, "view">>, now: Date): (input: unknown) => unknown {
  const own = { ...p, ...(p.view ? viewDef(p.view)?.pipeline : undefined) };
  const stages = [...(p.upstream ?? []), own].map((s) => compileStage(s, now));
  return (input) => stages.reduce((data, run) => run(data), input);
}

/**
 * One stage: pick → (parallel arrays to rows, when computing or grouping) → compute → where →
 * group → sort → limit. A streak counts raw rows, so it skips grouping.
 */
function compileStage(p: PipelineKeys, now: Date): (input: unknown) => unknown {
  const compute = p.compute ? compileCompute(p.compute, p.vars ?? {}, now) : undefined;
  const where = p.where && widenForCompare(p.where, p.compare, now);
  const keep = where ? compileWhere(where, now) : undefined;
  // The rows `where` drops needn't be computed when it reads no computed column and each row is
  // computed from itself alone; the rows kept come out the same.
  const keepFirst = !!compute && !!where && computesRowByRow(p.compute!) && !Object.keys(where).some((path) => (
    Object.keys(p.compute!).some((name) => path === name || path.startsWith(`${name}.`))
  ));
  const grouping = !!p.group && p.agg !== "streak";
  return (input) => {
    let data = getPath(input, p.pick);
    if (compute && !Array.isArray(data)) data = rowsFromEqualArrays(data) ?? data;
    if (p.group && !Array.isArray(data)) data = rowsFromArrays(data, [p.group, ...totalFields(p)]) ?? data;
    if (keepFirst && Array.isArray(data)) data = data.filter(keep!);
    if (compute) data = compute(data);
    if (!Array.isArray(data)) return data;
    if (keep && !keepFirst) data = data.filter(keep);
    if (grouping) data = groupRows(data as unknown[], p, now);
    data = sortRows(data as unknown[], p.sort);
    return p.limit ? (data as unknown[]).slice(0, p.limit) : data;
  };
}
