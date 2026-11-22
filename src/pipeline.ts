import { widenForCompare } from "./compare.ts";
import { compileWhere, getPath, sortRows } from "./data.ts";
import { compileCompute, computesRowByRow } from "./formula.ts";
import { groupRows, rowsFromArrays, rowsFromEqualArrays, totalFields } from "./group.ts";
import type { Panel } from "./spec.ts";
import { viewDef } from "./views/registry.ts";

/** The keys that turn a source's data into what a panel draws; a chained block is one such stage. */
export type PipelineKeys = Pick<Panel, "pick" | "compute" | "vars" | "where" | "compare" | "sort" | "limit" | "group" | "per" | "agg" | "of" | "y" | "columns">;

type PanelPipeline = PipelineKeys & Pick<Panel, "upstream"> & Partial<Pick<Panel, "view">>;

/** A step of a stage that can change how many rows there are. */
export type StepName = "pick" | "compute" | "where" | "group" | "limit";

/** What one step of a panel's stages had to work on and what came out, when its steps are traced. */
export interface TracedStep {
  /** Which stage it is a step of: 0 is the first block's, the last the panel's own. */
  stage: number;
  step: StepName;
  /** The keys of that stage, as checked. */
  keys: PipelineKeys;
  before: unknown;
  after: unknown;
}

/** What a panel's source gave, and each step its stages took over it, in order. */
export interface Trace {
  input: unknown;
  steps: TracedStep[];
}

/** Told each step as it is taken; gives back what comes out of it. */
type Seen = (step: StepName, before: unknown, after: unknown) => unknown;

const untraced: Seen = (_step, _before, after) => after;

/** The stages of the blocks above the one the panel names, root first, then its own keys with what its view fixes. */
function stagesOf(p: PanelPipeline): PipelineKeys[] {
  return [...(p.upstream ?? []), { ...p, ...(p.view ? viewDef(p.view)?.pipeline : undefined) }];
}

/**
 * A panel's data steps as one function, with its conditions parsed up front: the stages of the
 * blocks above the one it names, root first, then its own keys.
 */
export function compilePipeline(p: PanelPipeline, now: Date): (input: unknown) => unknown {
  const stages = stagesOf(p).map((s) => compileStage(s, now));
  return (input) => stages.reduce((data, run) => run(data), input);
}

/**
 * The same steps as compilePipeline, run once over `input`, telling what each step had and kept,
 * to explain a panel that shows nothing.
 */
export function tracePipeline(p: PanelPipeline, now: Date, input: unknown): Trace {
  const steps: TracedStep[] = [];
  stagesOf(p).reduce((data, keys, stage) => compileStage(keys, now)(data, (step, before, after) => {
    steps.push({ stage, step, keys, before, after });
    return after;
  }), input);
  return { input, steps };
}

/**
 * One stage: pick → (parallel arrays to rows, when computing or grouping) → compute → where →
 * group → sort → limit. A streak counts raw rows, so it skips grouping. `seen` is told each step
 * that can change the rows; the pick's includes making rows of a source's parallel lists.
 */
function compileStage(p: PipelineKeys, now: Date): (input: unknown, seen?: Seen) => unknown {
  const compute = p.compute ? compileCompute(p.compute, p.vars ?? {}, now) : undefined;
  const where = p.where && widenForCompare(p.where, p.compare, now);
  const keep = where ? compileWhere(where, now) : undefined;
  // The rows `where` drops needn't be computed when it reads no computed column and each row is
  // computed from itself alone; the rows kept come out the same.
  const keepFirst = !!compute && !!where && computesRowByRow(p.compute!) && !Object.keys(where).some((path) => (
    Object.keys(p.compute!).some((name) => path === name || path.startsWith(`${name}.`))
  ));
  const grouping = !!p.group && p.agg !== "streak";
  return (input, seen = untraced) => {
    let data = getPath(input, p.pick);
    if (compute && !Array.isArray(data)) data = rowsFromEqualArrays(data) ?? data;
    if (p.group && !Array.isArray(data)) data = rowsFromArrays(data, [p.group, ...totalFields(p)]) ?? data;
    data = seen("pick", input, data);
    if (keepFirst && Array.isArray(data)) data = seen("where", data, data.filter(keep!));
    if (compute) data = seen("compute", data, compute(data));
    if (!Array.isArray(data)) return data;
    if (keep && !keepFirst) data = seen("where", data, data.filter(keep));
    if (grouping) data = seen("group", data, groupRows(data as unknown[], p, now));
    data = sortRows(data as unknown[], p.sort);
    return p.limit ? seen("limit", data, (data as unknown[]).slice(0, p.limit)) : data;
  };
}
