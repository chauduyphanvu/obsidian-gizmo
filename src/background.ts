import type { ActionDeps } from "./actions.ts";
import { panelIds } from "./app.ts";
import { fillTemplate, parseDuration, stampParts, toNumber, toTime, valueOf, type Row } from "./data.ts";
import type { DataLayer } from "./datalayer.ts";
import { basename, type NoteReader } from "./expand.ts";
import { streak } from "./group.ts";
import { sourceDef } from "./sources/registry.ts";
import {
  permissionsOf, readSpec, resolvePanel, startingValues, type AppSpec, type Panel, type PanelSpec,
} from "./spec.ts";
import { defaultDataPath, resolveList } from "./store.ts";
import { rowsOf } from "./views/common.ts";
import { viewDef } from "./views/registry.ts";

/** The plugin's one timer ticks this often; an app without `refresh` is checked this often. */
export const TICK_MS = 60_000;
export const DEFAULT_REFRESH_MS = 10 * 60_000;
/** The shortest `record` interval; shorter ones are treated as this. */
export const MIN_RECORD_MS = 60_000;
/** A recorded list keeps this many rows, the newest. */
export const MAX_SAMPLES = 10_000;

/** What the background shows and does in Obsidian: notices, commands, the status bar, opening an app. */
export interface BackgroundSink {
  notify(message: string): void;
  setCommands(list: { id: string; name: string }[]): void;
  setStatus(items: { appPath: string; text: string; title: string }[]): void;
  openApp(path: string): void;
}

/** What the background needs from Obsidian; the glue passes the real thing, tests fakes. */
export interface BackgroundEnv {
  data: DataLayer;
  frontmatter(path: string): Record<string, unknown> | undefined;
  notes: NoteReader;
  /** Notes whose frontmatter has `app`, from the metadata cache. */
  appPaths(): string[];
  isGranted(path: string, wanted: string[]): boolean;
  storePath(store: string, fromPath: string): string;
  actionDeps(appPath: string, dataPath: string): ActionDeps;
  now(): Date;
  sink: BackgroundSink;
}

/** A panel worked out without drawing it: its value and rows, or why not. */
export type Evaluation = { value: unknown; rows: unknown; panel: Panel } | { waiting: string } | { error: string };

/** A block whose output is appended to a list in the app's data note on an interval. */
interface RecordJob {
  block: string;
  list: string;
  everyMs: number;
}

/** What the background knows about one app note. */
interface AppEntry {
  path: string;
  /** The note's name, as commands and notices call the app. */
  name: string;
  /** The note's keys and the components it read; while they're the same, so is the entry. */
  definition: string;
  spec: AppSpec;
  dataPath: string;
  /** What the app needs allowed; it acts only while exactly this is granted. */
  wanted: string[];
  records: RecordJob[];
  /** Panels by their `shortcut`, the first panel winning. */
  shortcuts: Map<string, PanelSpec>;
  /** Panels with `pin` or `alert`, each with a key unique across the vault. */
  watched: { key: string; ps: PanelSpec }[];
  refreshMs: number;
  stop(): void;
}

/**
 * Knows every app note in the vault and works for the ones whose permissions are granted while
 * their notes are closed: it records blocks, runs shortcuts, keeps status bar values and raises
 * alerts. Panels are evaluated without a DOM, with inputs at their starting values. Nothing here
 * prompts; an app that isn't allowed is skipped. One `tick` (from the glue's timer) runs whatever
 * is due; failures stay with their app.
 */
export class Background {
  private env: BackgroundEnv;
  private apps = new Map<string, AppEntry>();
  private running = false;
  /** Blocks being sampled now (app path and block), so a tick and an open don't both write one. */
  private sampling = new Set<string>();
  /** Problems already told this session. */
  private told = new Set<string>();

  constructor(env: BackgroundEnv) {
    this.env = env;
  }

  /** Reads every app note once (after the layout is ready) and does what is due. */
  start(): Promise<void> {
    this.running = true;
    for (const path of this.env.appPaths()) this.index(path);
    return this.tick();
  }

  stop(): void {
    this.running = false;
    for (const entry of this.apps.values()) entry.stop();
    this.apps.clear();
  }

  /** A note changed, appeared or was renamed to this path: index it if it became an app. Known apps follow their own changes. */
  noteChanged(path: string): void {
    if (this.running && !this.apps.has(path)) this.index(path);
  }

  /** The checked keys of an indexed app. */
  spec(appPath: string): AppSpec | undefined {
    return this.apps.get(appPath)?.spec;
  }

  /** Runs whatever is due for every allowed app. Never rejects; one app's failure doesn't stop the others. */
  async tick(): Promise<void> {
    if (!this.running) return;
    await Promise.all([...this.apps.values()].map((entry) => this.work(entry).catch(() => {})));
  }

  /** An app was opened: what it records is sampled now if due, and a problem with it is told again. */
  opened(appPath: string): void {
    const entry = this.running ? this.apps.get(appPath) ?? this.index(appPath) : undefined;
    if (!entry || !this.granted(entry)) return;
    for (const job of entry.records) void this.sample(entry, job, true).catch(() => {});
  }

  private async work(entry: AppEntry): Promise<void> {
    if (!this.granted(entry)) return;
    for (const job of entry.records) await this.sample(entry, job, false).catch(() => {});
  }

  private granted(entry: AppEntry): boolean {
    return this.env.isGranted(entry.path, entry.wanted);
  }

  /**
   * A panel's value and rows as its app would show them, with every input at its starting value.
   * A panel that waits for typing or a selection isn't loaded.
   */
  async evaluate(appPath: string, ps: PanelSpec, force = false): Promise<Evaluation> {
    const entry = this.apps.get(appPath);
    if (!entry) return { error: `${basename(appPath)} isn't an app` };
    const now = this.env.now();
    const r = resolvePanel(ps, startingValues(entry.spec.inputs, now));
    if (!r.panel) return r.waiting !== undefined ? { waiting: r.waiting } : { error: r.errors.join("; ") };
    const p = r.panel;
    const source = p.source ?? viewDef(p.view)?.implicitSource?.(p);
    try {
      const rows = await this.env.data.panelData(source, p, { appPath, dataPath: entry.dataPath }, { ttlMs: entry.refreshMs, now, force });
      return { value: valueFor(p, rows, now), rows, panel: p };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  // ---- Record -------------------------------------------------------------------------------

  /**
   * Appends one sample of a block's output (`{at, …the row}`) to its list in the data note, unless
   * the list's last row is younger than the interval; that row's `at` is the only state, so it
   * holds across restarts. A failed fetch writes nothing and is tried again on the next tick.
   */
  private async sample(entry: AppEntry, job: RecordJob, opened: boolean): Promise<void> {
    const key = `${entry.path}\n${job.block}`;
    if (this.sampling.has(key)) return;
    this.sampling.add(key);
    try {
      const now = this.env.now();
      const last = lastSample(resolveList(job.list, this.env.frontmatter(entry.dataPath), this.env.frontmatter(entry.path) ?? {}));
      if (last !== undefined && now.getTime() - last < job.everyMs) return;
      const ps = this.blockPanel(entry, job.block);
      const r = ps && await this.evaluate(entry.path, ps, true);
      if (!r || !("panel" in r)) return;
      const row = oneRow(r.rows);
      if (!row) return this.problem(entry, `data.${job.block}: record needs one row; add limit: 1 or pick`, opened);
      const at = stampParts(now).at;
      const sample: Row = { at, ...row };
      sample.at = at;
      await this.env.actionDeps(entry.path, entry.dataPath).writeFrontmatter(entry.dataPath, (fm) => {
        const list = Array.isArray(fm[job.list]) ? fm[job.list] as unknown[] : [];
        fm[job.list] = [...list, sample].slice(-MAX_SAMPLES);
      });
    } finally {
      this.sampling.delete(key);
    }
  }

  /** The block as a panel naming it gets it: its chain's stages and keys, its `$names` filled when evaluated. */
  private blockPanel(entry: AppEntry, block: string): PanelSpec | undefined {
    const fm = this.env.frontmatter(entry.path) ?? {};
    const app = { app: "", inputs: fm.inputs, data: fm.data, panels: [{ view: "table", source: block }] };
    return readSpec(app, { now: this.env.now(), notes: this.env.notes, path: entry.path })?.spec?.panels[0];
  }

  /** A problem only data can show: told once a session, and again whenever the app is opened. */
  private problem(entry: AppEntry, message: string, opened: boolean): void {
    const key = `${entry.path}\n${message}`;
    if (!opened && this.told.has(key)) return;
    this.told.add(key);
    this.env.sink.notify(`${entry.name}: ${message}`);
  }

  // ---- Index --------------------------------------------------------------------------------

  /** Reads an app note into the index, or drops it when it's no longer an app; returns what is indexed now. */
  private index(path: string): AppEntry | undefined {
    const old = this.apps.get(path);
    const fm = this.env.frontmatter(path);
    const spec = readSpec(fm, { now: this.env.now(), notes: this.env.notes, path })?.spec;
    const definition = JSON.stringify([fm, spec?.read ?? null]);
    if (old && spec && old.definition === definition) return old;
    old?.stop();
    this.apps.delete(path);
    if (!spec) return undefined;
    const ids = panelIds(spec.panels.map((ps) => ps.template));
    const shortcuts = new Map<string, PanelSpec>();
    for (const ps of spec.panels) if (ps.panel.shortcut && !shortcuts.has(ps.panel.shortcut)) shortcuts.set(ps.panel.shortcut, ps);
    const entry: AppEntry = {
      path,
      name: basename(path),
      definition,
      spec,
      dataPath: spec.store ? this.env.storePath(spec.store, path) : defaultDataPath(path),
      wanted: permissionsOf(spec, path),
      records: recordJobs(spec),
      shortcuts,
      watched: spec.panels.flatMap((ps, i) => (ps.panel.pin || ps.panel.alert !== undefined ? [{ key: `${path}\n${ids[i]}`, ps }] : [])),
      refreshMs: spec.refreshMs ?? DEFAULT_REFRESH_MS,
      stop: () => {},
    };
    // The app note and the components it links to define it; a change to any of them reads it again.
    const definitionDeps = [`file:${path}`, ...spec.links.map((l) => `name:${l}`)];
    entry.stop = this.env.data.subscribe(definitionDeps, () => {
      if (this.apps.get(path) === entry) this.index(path);
    });
    this.apps.set(path, entry);
    return entry;
  }
}

/** When a list's last row was saved, from its `at`. */
function lastSample(list: unknown): number | undefined {
  const last = Array.isArray(list) ? list[list.length - 1] : undefined;
  return last !== null && typeof last === "object" ? toTime((last as Row).at) : undefined;
}

/** A block's output as one row: an object, or a list holding exactly one. */
function oneRow(data: unknown): Row | undefined {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : undefined) : data;
  return row !== null && typeof row === "object" && !Array.isArray(row) ? { ...(row as Row) } : undefined;
}

/** The blocks an app records: root blocks with `record` on a web source. */
function recordJobs(spec: AppSpec): RecordJob[] {
  return Object.entries(spec.blocks).flatMap(([block, keys]) => {
    const every = parseDuration(keys.record);
    if (!every || sourceDef(String(keys.source)).id !== "url") return [];
    return [{ block, list: typeof keys.into === "string" ? keys.into : `${block}_log`, everyMs: Math.max(MIN_RECORD_MS, every) }];
  });
}

/** The value a number, progress or text panel shows, worked out as the views do. */
function valueFor(p: Panel, data: unknown, now: Date): unknown {
  if (p.view === "text") {
    const ctx = Array.isArray(data) ? { ...(data[0] as Row), rows: data, count: data.length } : data;
    return fillTemplate(p.text ?? "", ctx, p.decimals);
  }
  const value = p.agg === "streak" ? streak(rowsOf(data), p.group!, p.per!, now) : valueOf(p, data);
  return p.view === "progress" ? toNumber(value) ?? 0 : value;
}
