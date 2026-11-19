import type { ActionDeps } from "./actions.ts";
import { panelIds } from "./app.ts";
import { fillTemplate, parseDuration, toNumber, valueOf, type Row } from "./data.ts";
import type { DataLayer } from "./datalayer.ts";
import { basename, type NoteReader } from "./expand.ts";
import { streak } from "./group.ts";
import { sourceDef } from "./sources/registry.ts";
import {
  permissionsOf, readSpec, resolvePanel, startingValues, type AppSpec, type Panel, type PanelSpec,
} from "./spec.ts";
import { defaultDataPath } from "./store.ts";
import { rowsOf } from "./views/common.ts";
import { viewDef } from "./views/registry.ts";

/** The plugin's one timer ticks this often; an app without `refresh` is checked this often. */
export const TICK_MS = 60_000;
export const DEFAULT_REFRESH_MS = 10 * 60_000;
/** The shortest `record` interval; shorter ones are treated as this. */
export const MIN_RECORD_MS = 60_000;

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

  private async work(entry: AppEntry): Promise<void> {
    if (!this.granted(entry)) return;
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
