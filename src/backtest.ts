/**
 * A backtest: an app's alerts, state rules and rhythms run over its own past, step by step, under
 * the definition from before an edit and the one after, to see which fires an edit adds or loses.
 * Each step moves one replay data layer to that time, so lists come from the ledger's events up to
 * it and web answers from the response history at or before it. Nothing is written or told: a
 * `then` is only named.
 */
import { splitByWindow } from "./compare.ts";
import { compileWhere, matches, rowsOf } from "./data.ts";
import { cacheKey, type DataLayer } from "./datalayer.ts";
import { metIn, windowsDue, type Rhythm, type Window } from "./expect.ts";
import { stableJson } from "./hash.ts";
import { resolvePanel, startingValues, type AppSpec, type PanelSpec, type Then } from "./spec.ts";
import { thisValues } from "./sources/this.ts";
import { basename } from "./store.ts";
import { THIS } from "./template.ts";
import { sourceOf } from "./views/registry.ts";
import { panelValue } from "./views/value.ts";

export const MAX_STEPS = 20_000;
/** How far back a backtest looks at most. */
export const SPAN_MS = 365 * 86_400_000;

export interface Fire {
  at: number;
  /** Which alert or rule, the same across the two definitions: where the panel is written, or `expect:<id>`. */
  key: string;
  what: string;
  /** What its `then` would have run. */
  then?: string;
}

export interface BacktestResult {
  from: number;
  to: number;
  steps: number;
  /** More than MAX_STEPS: the oldest were left out, and the backtest starts at `from`. */
  cut: boolean;
  before?: Fire[];
  after: Fire[];
  /** Fires the edit adds, and those it loses; empty when there's no before. */
  added: Fire[];
  lost: Fire[];
  /** What couldn't be read at some step (a request with nothing kept by then), once each. */
  errors: string[];
}

export interface BacktestJob {
  /** A replay layer (made with `at`); the backtest moves its time. */
  layer: DataLayer;
  appPath: string;
  dataPath: string;
  devices?: string;
  before?: AppSpec;
  after: AppSpec;
  /** The latest time looked at; the earliest is the first kept data, at most SPAN_MS before. */
  to: number;
  progress?(done: number, total: number): void;
  cancelled?(): boolean;
}

interface Watched { key: string; ps: PanelSpec; what: string; then?: Then }

/**
 * A spec's alerts and state rules, as the background watches them. An alert is known across the two
 * definitions by its title, or its view and source, not by where it's written: a panel added above
 * it moves it without changing what it does.
 */
function alertsOf(spec: AppSpec): Watched[] {
  const out: Watched[] = [];
  const seen = new Map<string, number>();
  for (const ps of spec.panels) {
    const p = ps.panel;
    if (p.alert === undefined) continue;
    const name = p.title ?? `${p.view} of ${p.source ?? "nothing"}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    out.push({ key: n ? `${name} #${n + 1}` : name, ps, what: p.title ?? p.label ?? (ps.label || "the app"), then: p.then });
  }
  for (const r of spec.expect) {
    const ps = spec.expected[r.id];
    if (r.kind !== "state" || !ps) continue;
    out.push({ key: `expect:${r.id}`, ps, what: r.say ?? `a row matches ${r.id}`, then: r.then });
  }
  return out;
}

const rhythmsOf = (spec: AppSpec) => spec.expect.filter((r): r is Rhythm => r.kind === "rhythm");

export function thenText(then: Then | undefined): string | undefined {
  return then && `${then.do} in ${basename(then.app.replace(/^\[\[|\]\]$/g, ""))}`;
}

function nextMidnight(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export async function backtest(job: BacktestJob): Promise<BacktestResult | undefined> {
  const { layer } = job;
  const specs: [string, AppSpec][] = job.before ? [["before", job.before], ["after", job.after]] : [["after", job.after]];
  const files = { appPath: job.appPath, dataPath: job.dataPath, devices: job.devices };
  const values = (spec: AppSpec, now: Date) => ({
    ...startingValues(spec.inputs, now),
    [THIS]: thisValues(job.appPath, layer.host.frontmatter(job.appPath), layer.host.tags(job.appPath)),
  });

  // The moments something it reads changed: its lists' events and the kept answers of its requests.
  const changes = new Set<number>(await layer.ledger?.times(job.dataPath) ?? []);
  for (const [, spec] of specs) {
    for (const ps of [...alertsOf(spec).map((w) => w.ps), ...rhythmsOf(spec).map((r) => spec.expected[r.id]).filter((ps) => ps)]) {
      const p = resolvePanel(ps, values(spec, new Date(job.to))).panel;
      const source = p && sourceOf(p);
      if (!source || !/^https?:\/\//i.test(source)) continue;
      for (const t of await layer.host.responses?.times(cacheKey(source, p.headers, p.body)) ?? []) changes.add(t);
    }
  }
  // A loop, not a spread: a year of samples is more arguments than a call takes.
  let earliest = Infinity;
  for (const t of changes) if (t < earliest) earliest = t;
  let from = Math.max(job.to - SPAN_MS, Number.isFinite(earliest) ? startOfDay(earliest) : job.to - 30 * 86_400_000);
  const steps = new Set([...changes].filter((t) => t >= from && t <= job.to));
  for (let t = nextMidnight(from); t <= job.to; t = nextMidnight(t)) steps.add(t);
  const deadlines = new Map<string, Map<number, Window>>();
  for (const [which, spec] of specs) {
    for (const rule of rhythmsOf(spec)) {
      const by = new Map(windowsDue(rule, from, job.to).map((w) => [w.deadline, w]));
      deadlines.set(`${which}\n${rule.id}`, by);
      for (const t of by.keys()) steps.add(t);
    }
  }
  let order = [...steps].sort((a, b) => a - b);
  const cut = order.length > MAX_STEPS;
  if (cut) {
    order = order.slice(-MAX_STEPS);
    from = order[0];
  }

  const errors = new Map<string, string>();
  const read = async (spec: AppSpec, ps: PanelSpec, now: Date) => {
    const r = resolvePanel(ps, values(spec, now));
    if (!r.panel) return undefined;
    try {
      const loaded = await layer.panelData(sourceOf(r.panel), r.panel, files, { ttlMs: 0, now });
      return { p: r.panel, rows: splitByWindow(r.panel, loaded, now).current };
    } catch (e) {
      const message = (e as Error).message;
      errors.set(message, message);
      return undefined;
    }
  };

  const fires: Record<string, Fire[]> = { before: [], after: [] };
  const on = new Map<string, boolean>();
  for (const [i, t] of order.entries()) {
    if (job.cancelled?.()) return undefined;
    layer.setAt(t);
    const now = new Date(t);
    for (const [which, spec] of specs) {
      for (const w of alertsOf(spec)) {
        const got = await read(spec, w.ps, now);
        if (!got) continue;
        const { p, rows } = got;
        const alert = p.alert!;
        const isOn = typeof alert === "string" ? matches(panelValue(p, rows, now).value, alert, now) : rowsOf(rows).some(compileWhere(alert, now));
        const k = `${which}\n${w.key}`;
        // What is true at the first step is noted, not counted, as when background work starts.
        if (isOn && on.get(k) === false) fires[which].push({ at: t, key: w.key, what: w.what, then: thenText(w.then) });
        on.set(k, isOn);
      }
      for (const rule of rhythmsOf(spec)) {
        const w = deadlines.get(`${which}\n${rule.id}`)?.get(t);
        const ps = spec.expected[rule.id];
        if (!w || !ps) continue;
        const got = await read(spec, ps, now);
        if (got && !metIn(rowsOf(got.rows), rule, w, now)) {
          fires[which].push({ at: t, key: `expect:${rule.id}`, what: rule.say ?? `${rule.id} wasn't done by ${rule.byText}`, then: thenText(rule.then) });
        }
      }
    }
    job.progress?.(i + 1, order.length);
    // Lets a window draw its progress and a Cancel be pressed.
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, 0));
  }

  const id = (f: Fire) => `${f.at}\n${f.key}`;
  const before = job.before ? fires.before : undefined;
  const had = new Set((before ?? []).map(id));
  const has = new Set(fires.after.map(id));
  return {
    from,
    to: job.to,
    steps: order.length,
    cut,
    before,
    after: fires.after,
    added: before ? fires.after.filter((f) => !had.has(id(f))) : [],
    lost: before ? before.filter((f) => !has.has(id(f))) : [],
    errors: [...errors.values()],
  };
}

/** How long an editing session lasts without a change; the next change starts a new one. */
export const SESSION_GAP_MS = 2 * 60_000;

/**
 * The definition an editing session started from, for "Backtest this change". Obsidian saves as you
 * type, so "before" isn't the last save: it's the definition before the first change after two
 * minutes without one.
 */
export class EditSession {
  before: Record<string, unknown> | undefined;
  private last: { fm: Record<string, unknown>; text: string } | undefined;
  private lastAt = -Infinity;

  /** A note Obsidian hasn't read yet (no frontmatter) isn't a definition to start from. */
  seen(fm: Record<string, unknown> | undefined, now: number): void {
    if (!fm) return;
    const copy = structuredClone(fm);
    const text = stableJson(copy);
    if (this.last && text === this.last.text) return;
    if (this.last && now - this.lastAt > SESSION_GAP_MS) this.before = this.last.fm;
    if (this.last) this.lastAt = now;
    this.last = { fm: copy, text };
  }

  /** Whether the definition now differs from the one the session started from. */
  changed(): boolean {
    return !!this.before && !!this.last && stableJson(this.before) !== this.last.text;
  }
}
