import { compileWhere, getPath, sortRows } from "./data.ts";
import { groupRows, rowsFromArrays, totalFields } from "./group.ts";
import type { Panel } from "./spec.ts";

type PipelineKeys = Pick<Panel, "pick" | "where" | "sort" | "limit" | "group" | "per" | "agg" | "y" | "columns">;

/**
 * A panel's data steps as one function, with its conditions parsed up front:
 * pick → (parallel arrays to rows, when grouping) → where → group → sort → limit.
 * A streak counts raw rows, so it skips grouping.
 */
export function compilePipeline(p: PipelineKeys, now: Date): (input: unknown) => unknown {
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
