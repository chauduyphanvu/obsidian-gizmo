import { refusal } from "./expect.ts";
import { rowId as ledgerRowId } from "./ledger.ts";
import { storeOf } from "./actions.ts";
import type { AppEntry, Background, BackgroundEnv } from "./background.ts";
import { parseDuration, type Row } from "./data.ts";
import { stampOf, toTime } from "./time.ts";
import type { AppSpec } from "./spec.ts";
import { resolveList } from "./store.ts";

/** The shortest `record` interval; shorter ones are treated as this. */
export const MIN_RECORD_MS = 60_000;

/** A recorded list keeps this many rows, the newest. */
/** A week of samples at the shortest interval, so a late copy of a sample can't fall past the cap. */
export const MAX_SAMPLES = 10_080;

/** A block whose output is appended to a list in the app's data note on an interval. */
export interface RecordJob {
  block: string;
  list: string;
  everyMs: number;
}

/** Samples the blocks apps record, on the device that runs background work. */
export class Recorder {
  private env: BackgroundEnv;
  private evaluate: Background["evaluate"];
  private say: (message: string) => void;
  /** Blocks being sampled now (app path and block), so a tick and an open don't both write one. */
  private sampling = new Set<string>();
  /** Problems already told this session. */
  private told = new Set<string>();

  constructor(env: BackgroundEnv, evaluate: Background["evaluate"], say: (message: string) => void) {
    this.env = env;
    this.evaluate = evaluate;
    this.say = say;
  }

  /**
   * Appends one sample of a block's output (`{at, …the row}`) to its list in the data note, unless
   * the list's last row is younger than the interval; that row's `at` is the only state, so it
   * holds across restarts. A failed fetch writes nothing and is tried again on the next tick.
   */
  async sample(entry: AppEntry, job: RecordJob, opened: boolean): Promise<void> {
    if (!this.env.runsBackground()) return;
    const key = `${entry.path}\n${job.block}`;
    if (this.sampling.has(key)) return;
    this.sampling.add(key);
    try {
      const now = this.env.now();
      // The newest sample any device took counts, whichever device took it.
      const deps = this.env.actionDeps(entry.path, entry.dataPath);
      const kept = this.env.data.ledger ? await storeOf(deps).rows(job.list) : resolveList(job.list, this.env.frontmatter(entry.dataPath), this.env.frontmatter(entry.path) ?? {});
      const last = lastSample(kept);
      if (last !== undefined && now.getTime() - last < job.everyMs) return;
      const r = await this.evaluate(entry.path, entry.spec.recorded[job.block], true);
      if (!("panel" in r)) return;
      const row = oneRow(r.rows);
      if (!row) return this.problem(entry, `data.${job.block}: record needs one row; add limit: 1 or pick`, opened);
      const at = stampOf(now);
      const sample: Row = { at, ...row };
      sample.at = at;
      const refused = refusal(entry.spec.expect, job.list, sample, now);
      if (refused) return this.problem(entry, `data.${job.block}: not recorded: ${refused}`, opened);
      // One id per interval: two devices sampling the same interval keep one row.
      await storeOf(deps).add(job.list, sample, { cap: MAX_SAMPLES, id: ledgerRowId(`sample\n${entry.path}\n${job.list}\n${Math.floor(now.getTime() / job.everyMs)}`) });
    } finally {
      this.sampling.delete(key);
    }
  }

  /** A problem only data can show: told once a session, and again whenever the app is opened. */
  private problem(entry: AppEntry, message: string, opened: boolean): void {
    const key = `${entry.path}\n${message}`;
    if (!opened && this.told.has(key)) return;
    this.told.add(key);
    this.say(`${entry.name}: ${message}`);
  }
}

/** When a list's last row was saved, from its `at`. */
function lastSample(list: unknown): number | undefined {
  const last: unknown = Array.isArray(list) ? list[list.length - 1] : undefined;
  return last !== null && typeof last === "object" ? toTime((last as Row).at) : undefined;
}

/** A block's output as one row: an object, or a list holding exactly one. */
function oneRow(data: unknown): Row | undefined {
  const row: unknown = Array.isArray(data) ? (data.length === 1 ? data[0] : undefined) : data;
  return row !== null && typeof row === "object" && !Array.isArray(row) ? { ...(row as Row) } : undefined;
}

/** The blocks an app records: root blocks with `record` on a web source that check out as a panel. */
export function recordJobs(spec: AppSpec): RecordJob[] {
  return Object.keys(spec.recorded).flatMap((block) => {
    const keys = spec.blocks[block];
    const every = parseDuration(keys.record);
    if (!every) return [];
    return [{ block, list: typeof keys.into === "string" ? keys.into : `${block}_log`, everyMs: Math.max(MIN_RECORD_MS, every) }];
  });
}
