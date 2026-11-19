import { compileWhere, getPath, sortRows } from "./data.ts";
import { groupRows, rowsFromArrays, totalFields } from "./group.ts";
import type { Panel } from "./spec.ts";

/** The keys that turn a source's data into what a panel draws; a chained block is one such stage. */
export type PipelineKeys = Pick<Panel, "pick" | "where" | "sort" | "limit" | "group" | "per" | "agg" | "y" | "columns">;

/**
 * A panel's data steps as one function, with its conditions parsed up front: the stages of the
 * blocks above the one it names, root first, then its own keys.
 */
export function compilePipeline(p: PipelineKeys & Pick<Panel, "upstream">, now: Date): (input: unknown) => unknown {
  const stages = [...(p.upstream ?? []), p].map((s) => compileStage(s, now));
  return (input) => stages.reduce((data, run) => run(data), input);
}

/**
 * One stage: pick → (parallel arrays to rows, when grouping) → where → group → sort → limit.
 * A streak counts raw rows, so it skips grouping.
 */
function compileStage(p: PipelineKeys, now: Date): (input: unknown) => unknown {
  const keep = p.where ? compileWhere(p.where, now) : undefined;
  const grouping = !!p.group && p.agg !== "streak";
  return (input) => {
    let data = getPath(input, p.pick);
    if (p.group && !Array.isArray(data)) data = rowsFromArrays(data, [p.group, ...totalFields(p)]) ?? data;
    if (!Array.isArray(data)) return data;
    if (keep) data = data.filter(keep);
    if (grouping) data = groupRows(data as unknown[], p, now);
    data = sortRows(data as unknown[], p.sort);
    return p.limit ? (data as unknown[]).slice(0, p.limit) : data;
  };
}
