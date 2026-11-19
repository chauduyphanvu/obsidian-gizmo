import { fillLine, runActions, type ActionDeps } from "./actions.ts";
import type { Actor, LogStore } from "./activity.ts";
import { splitByWindow } from "./compare.ts";
import { compileWhere, matches, parseDuration, rowsOf, stampParts, toTime, type Row } from "./data.ts";
import type { DataLayer } from "./datalayer.ts";
import { fileDep, nameDep } from "./deps.ts";
import { stableJson } from "./hash.ts";
import type { NoteReader } from "./expand.ts";
import { thisValues } from "./sources/this.ts";
import {
  panelIds, readSpec, resolvePanel, startingValues, type AppSpec, type Panel, type PanelSpec, type Then,
} from "./spec.ts";
import { permissionsOf } from "./permissions.ts";
import { basename, dataPathOf, resolveList, storeTarget } from "./store.ts";
import { InputRef, THIS, valueProblem } from "./template.ts";
import type { AlertFeed, AlertItem } from "./views/alerts.ts";
import { startOf } from "./keys.ts";
import { sourceOf } from "./views/registry.ts";
import { panelValue } from "./views/value.ts";

/** The plugin's one timer ticks this often; an app without `refresh` is checked this often. */
export const TICK_MS = 60_000;
export const DEFAULT_REFRESH_MS = 10 * 60_000;
/** The shortest `record` interval; shorter ones are treated as this. */
export const MIN_RECORD_MS = 60_000;
/** A recorded list keeps this many rows, the newest. */
export const MAX_SAMPLES = 10_000;
/** How many shortcuts one action may run through `then`, one app after another. */
export const MAX_CHAIN = 4;
/** How many times one `then` may run in an hour; more is a loop going through data. */
export const MAX_RUNS_PER_HOUR = 20;

/** One status bar item: `<panel title>: <value>`, and the name of the app a click opens. */
export interface StatusItem {
  appPath: string;
  text: string;
  title: string;
}

/** What the background shows and does in Obsidian: notices, commands, the status bar, opening an app. */
export interface BackgroundSink {
  notify(message: string): void;
  setCommands(list: { id: string; name: string }[]): void;
  setStatus(items: StatusItem[]): void;
  openApp(path: string): void;
}

/** What the background needs from Obsidian; the glue passes the real thing, tests fakes. */
export interface BackgroundEnv {
  data: DataLayer;
  frontmatter(path: string): Record<string, unknown> | undefined;
  notes: NoteReader;
  /** Notes whose frontmatter has `app`, from the metadata cache. */
  appPaths(): string[];
  /** Whether the app was opened in its own tab and is allowed exactly `wanted`, even when that is nothing. */
  isGranted(path: string, wanted: string[]): boolean;
  storePath(store: string, fromPath: string): string;
  /** What running an app's actions writes with; with an actor, what they change is kept in the activity log. */
  actionDeps(appPath: string, dataPath: string, actor?: Actor): ActionDeps;
  now(): Date;
  sink: BackgroundSink;
  /** Where the alerts that run a `then` keep what they already ran for, across restarts. */
  triggers?: LogStore;
}

/** What an alert with `then` ran for: whether its value condition held, or which rows matched. */
type Fired = { on: boolean } | { rows: string[] };

/**
 * A panel worked out without drawing it: its value, that value as its view shows it (`shown`, unit
 * included) and its rows, or why not. A compare panel's value and rows are its current window's.
 */
export type Evaluation = { value: unknown; shown: string; rows: unknown; panel: Panel } | { waiting: string } | { error: string };

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
  /** When the watched panels were last evaluated, and the evaluation running now. */
  checkedAt?: number;
  checking?: Promise<void>;
  /** Asked to evaluate again while an evaluation runs. */
  again?: boolean;
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
  /** The command list last published, as JSON. */
  private commands = "";
  /** Status bar items and alerts true now, by watched panel key; the status list last published. */
  private pins = new Map<string, StatusItem>();
  private active = new Map<string, AlertItem>();
  private status = "";
  /** Whether each alert was true when last evaluated this session (unknown at first, so one already true is told). */
  private alertOn = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private alertsShown = "[]";
  /** By watched panel key, what each alert with `then` already ran for; read once from `env.triggers`. */
  private fired: Promise<Record<string, Fired>> | undefined;
  private firedSaved = "{}";
  private firedSaving: Promise<void> = Promise.resolve();
  /** When each `then` ran in the last hour, by source app and target shortcut. */
  private runs = new Map<string, number[]>();

  /** Alerts true now across the vault, for `view: alerts`. */
  readonly alerts: AlertFeed = {
    list: () => this.inOrder(this.active),
    subscribe: (cb) => {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    },
  };

  constructor(env: BackgroundEnv) {
    this.env = env;
  }

  /** Reads every app note once (after the layout is ready) and does what is due. */
  start(): Promise<void> {
    for (const path of this.env.appPaths()) this.index(path);
    this.running = true;
    this.publishCommands();
    return this.tick();
  }

  stop(): void {
    this.running = false;
    for (const entry of this.apps.values()) entry.stop();
    this.apps.clear();
    this.pins.clear();
    this.active.clear();
    this.listeners.clear();
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

  /**
   * An app was opened (or just allowed): what it records is sampled now if due, a problem with it
   * is told again, and its pins and alerts are evaluated if they never were.
   */
  opened(appPath: string): void {
    const entry = this.running ? this.apps.get(appPath) ?? this.index(appPath) : undefined;
    if (!entry || !this.granted(entry)) return;
    for (const job of entry.records) void this.sample(entry, job, true).catch(() => {});
    if (entry.checkedAt === undefined) void this.check(entry);
  }

  private async work(entry: AppEntry): Promise<void> {
    if (!this.granted(entry)) return this.forget(entry.path);
    for (const job of entry.records) await this.sample(entry, job, false).catch(() => {});
    if (entry.checkedAt === undefined || this.env.now().getTime() - entry.checkedAt >= entry.refreshMs) await this.check(entry);
  }

  private granted(entry: AppEntry): boolean {
    return this.env.isGranted(entry.path, entry.wanted);
  }

  /**
   * A panel's value and rows as its app would show them, with every input at its starting value
   * and `$this` the app's own note. A panel that waits for typing or a selection isn't loaded.
   */
  async evaluate(appPath: string, ps: PanelSpec, force = false): Promise<Evaluation> {
    const entry = this.apps.get(appPath);
    if (!entry) return { error: `${basename(appPath)} isn't an app` };
    const now = this.env.now();
    const r = resolvePanel(ps, this.valuesOf(appPath, entry.spec, now));
    if (!r.panel) return r.waiting !== undefined ? { waiting: r.waiting } : { error: r.errors.join("; ") };
    const p = r.panel;
    const source = sourceOf(p);
    try {
      const loaded = await this.env.data.panelData(source, p, { appPath, dataPath: entry.dataPath }, { ttlMs: entry.refreshMs, now, force });
      const rows = splitByWindow(p, loaded, now).current;
      const { value, text, unit } = panelValue(p, rows, now);
      return { value, shown: unit ? `${text} ${unit}` : text, rows, panel: p };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /** What a panel reads while its app is closed: inputs at their starting values, and the app note as `$this`. */
  private valuesOf(appPath: string, spec: AppSpec, now: Date): Record<string, unknown> {
    return { ...startingValues(spec.inputs, now), [THIS]: thisValues(appPath, this.env.frontmatter(appPath), this.env.data.host.tags(appPath)) };
  }

  // ---- Shortcuts ----------------------------------------------------------------------------

  /** Runs the command `<app path>:<shortcut>`. */
  runCommand(id: string): Promise<void> {
    const cut = id.lastIndexOf(":");
    return this.runShortcut(id.slice(0, cut), id.slice(cut + 1), "shortcut");
  }

  /**
   * Answers `obsidian://gizmo?app=…&do=…&field=value…`. Any web page can send one, so it only
   * runs a panel its author marked with `shortcut`, in an app the user already allowed; the other
   * parameters only fill that form's fields, checked against their types.
   */
  async runUri(params: Record<string, string>): Promise<void> {
    const { action: _action, app: name = "", do: shortcut = "", ...fields } = params;
    const found = appsNamed(this.apps, name);
    if (found.length === 0) return this.say(`No app called “${name}”`);
    if (found.length > 1) return this.say(`Several apps are called “${name}”; use its path`);
    return this.runShortcut(found[0].path, shortcut, "link", fields);
  }

  /** Every app's shortcuts with the link that runs each, whether or not the app is allowed yet. */
  shortcutLinks(): ShortcutLink[] {
    return [...this.apps.values()]
      .flatMap((e) => [...e.shortcuts].map(([shortcut, ps]): ShortcutLink => {
        const p = ps.panel;
        const fields = p.view === "form" ? Object.keys(p.fields ?? p.schema ?? {}) : [];
        return {
          path: e.path, app: e.name, shortcut, label: labelOf(p, shortcut), fields,
          link: shortcutLink(this.apps, e.path, shortcut),
          allowed: this.granted(e),
        };
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.shortcut.localeCompare(b.shortcut));
  }

  /**
   * Runs an app's shortcut panel without opening the app: a button's actions, or a form's with the
   * values a link gives (a command has none, so a form opens its app to be filled in). Notifies the
   * result: the panel's own `notify`, else that it's done.
   */
  private async runShortcut(appPath: string, shortcut: string, actor: Actor, params?: Record<string, string>, chain?: string[]): Promise<void> {
    const entry = this.apps.get(appPath);
    const ps = entry?.shortcuts.get(shortcut);
    if (!entry || !ps) return this.say(`${entry?.name ?? basename(appPath)} has no shortcut “${shortcut}”`);
    if (!this.granted(entry)) return this.say(`Open ${entry.name} once to allow it`);
    const now = this.env.now();
    const r = resolvePanel(ps, this.valuesOf(entry.path, entry.spec, now));
    // Another app's trigger never opens an app: what it can't run is told instead.
    const triggered = chain !== undefined;
    if (!r.panel) return triggered ? this.say(`${entry.name}: “${shortcut}” waits for a choice in the app, so it can't run from ${by(actor)}`) : this.env.sink.openApp(entry.path);
    const p = r.panel;
    let input: Row = {};
    if (triggered && p.view !== "form" && params && Object.keys(params).length) {
      return this.say(`${entry.name}: “${shortcut}” is a button and takes no values; take fill out of ${by(actor)}'s then`);
    }
    if (p.view === "form") {
      if (!params && triggered) return this.say(`${entry.name}: “${shortcut}” is a form; give ${by(actor)}'s then a fill with its values`);
      if (!params) {
        this.env.sink.openApp(entry.path);
        return this.say(`${entry.name}: fill in the form`);
      }
      // Rule 0.2: whatever a link carries is refused whole if any of it holds a secret or a line break.
      const problem = Object.entries(params).map(([k, v]) => valueProblem(new InputRef(k), v, true)).find(Boolean);
      if (problem) return this.say(`${entry.name}: ${problem}`);
      const filled = formRow(p.fields ?? p.schema ?? {}, p.fieldInfo, params, now);
      if ("error" in filled) return this.say(`${entry.name}: ${filled.error}`);
      input = filled.row;
    }
    const trail = chain ?? [`${entry.path}#${shortcut}`];
    // Said before what its `then` runs says, in the order they happen.
    let told = false;
    const done = () => {
      if (told || p.notify) return;
      told = true;
      this.say(`${entry.name}: ${labelOf(p, shortcut)} done${triggered ? ` for ${by(actor)}` : ""}`);
    };
    const deps: ActionDeps = {
      ...this.env.actionDeps(entry.path, entry.dataPath, actor),
      then: async (panel, ctx) => {
        done();
        if (panel.then) await this.runThen(entry.path, panel.then, ctx, trail);
      },
    };
    const result = await runActions(p, input, deps);
    if (result.ok) done();
  }

  /**
   * Runs a panel's `then`: the named app's shortcut, as a link would, with `fill` filled from the
   * row the panel ran with. Both apps must be allowed. A shortcut already run in this chain, a
   * chain longer than MAX_CHAIN, or more than MAX_RUNS_PER_HOUR runs of one `then` is a loop, and
   * stops with a notice naming it. Never rejects.
   */
  async runThen(fromPath: string, then: Then, ctx: Row, chain: string[] = []): Promise<void> {
    try {
      const from = this.apps.get(fromPath) ?? (this.running ? this.index(fromPath) : undefined);
      if (!from || !this.granted(from)) return;
      // Found as Obsidian finds the link from the app's note, as `use` links are.
      const name = storeTarget(then.app);
      const path = this.env.notes.resolve(name, from.path);
      if (!path) return this.say(`${from.name}: no app called “${name}” to run “${then.do}” in`);
      const target = this.apps.get(path) ?? (this.running ? this.index(path) : undefined);
      if (!target) return this.say(`${from.name}: “${name}” isn't an app, so it can't run “${then.do}”`);
      const key = `${target.path}#${then.do}`;
      const names = (keys: string[]) => keys.map((k) => basename(k.slice(0, k.lastIndexOf("#")))).join(" → ");
      if (chain.includes(key)) return this.say(`${from.name}: stopped a loop: ${names([...chain, key])}`);
      if (chain.length >= MAX_CHAIN) return this.say(`${from.name}: stopped after ${MAX_CHAIN} apps in a row: ${names([...chain, key])}`);
      const now = this.env.now().getTime();
      const rateKey = `${from.path}\n${key}`;
      const recent = (this.runs.get(rateKey) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= MAX_RUNS_PER_HOUR) {
        this.runs.set(rateKey, recent);
        return this.say(`${from.name}: stopped running “${then.do}” in ${target.name}: it ran ${MAX_RUNS_PER_HOUR} times this hour`);
      }
      this.runs.set(rateKey, [...recent, now]);
      const params = Object.fromEntries(Object.entries(then.fill ?? {}).map(([k, v]) => [k, fillLine(v, ctx)]));
      await this.runShortcut(target.path, then.do, `trigger:${from.name}`, then.fill ? params : undefined, [...chain, key]);
    } catch (e) {
      this.say(`${basename(fromPath)}: couldn't run “${then.do}”: ${(e as Error).message}`);
    }
  }

  private say(message: string): void {
    this.env.sink.notify(message);
  }

  /** Every app's shortcuts as commands, published when that list changes. */
  private publishCommands(): void {
    const list = [...this.apps.values()]
      .flatMap((e) => [...e.shortcuts].map(([id, ps]) => ({ id: `${e.path}:${id}`, name: `${e.name}: ${labelOf(ps.panel, id)}` })))
      .sort((a, b) => a.id.localeCompare(b.id));
    const json = JSON.stringify(list);
    if (json === this.commands) return;
    this.commands = json;
    this.env.sink.setCommands(list);
  }

  // ---- Status bar and alerts ----------------------------------------------------------------

  /** Evaluates an app's pinned and alerting panels; asked again meanwhile, it runs once more after. */
  private check(entry: AppEntry): Promise<void> {
    if (entry.checking) {
      entry.again = true;
      return entry.checking;
    }
    entry.checking = (async () => {
      try {
        do {
          entry.again = false;
          await this.checkOnce(entry);
        } while (entry.again && this.apps.get(entry.path) === entry);
      } finally {
        entry.checking = undefined;
      }
    })();
    return entry.checking;
  }

  /** A panel that can't be evaluated now (a failed fetch) keeps what it showed last. */
  private async checkOnce(entry: AppEntry): Promise<void> {
    if (entry.watched.length === 0) return;
    if (!this.granted(entry)) return this.forget(entry.path);
    const now = this.env.now();
    entry.checkedAt = now.getTime();
    for (const { key, ps } of entry.watched) {
      const r = await this.evaluate(entry.path, ps);
      if (this.apps.get(entry.path) !== entry) return;
      if (!("panel" in r)) continue;
      const p = r.panel;
      const title = p.title ?? p.label ?? entry.name;
      const { shown } = r;
      if (p.pin === "status") this.pins.set(key, { appPath: entry.path, text: `${title}: ${shown}`, title: entry.name });
      if (p.alert === undefined) continue;
      const rows = typeof p.alert === "string" ? undefined : rowsOf(r.rows).filter(compileWhere(p.alert, now));
      const matching = rows?.length;
      const on = matching === undefined ? matches(r.value, p.alert as string, now) : matching > 0;
      const was = this.alertOn.get(key);
      this.alertOn.set(key, on);
      if (p.then) await this.alertThen(entry, key, p.then, r.value, on, rows);
      if (this.apps.get(entry.path) !== entry) return;
      if (!on) {
        this.active.delete(key);
        continue;
      }
      const text = matching === undefined ? shown : `${matching} ${matching === 1 ? "row" : "rows"}`;
      this.active.set(key, { appPath: entry.path, app: entry.name, title, text });
      // Told when it turns true, not again until it has been false.
      if (was !== true) this.say(`${entry.name}: ${title} ${matching === undefined ? text : `(${text})`}`);
    }
    this.publish();
  }

  /**
   * Runs an alert's `then` for what is new since it last ran: once when a condition on its value
   * turns true, and once for each row that newly matches a condition on rows. With nothing kept for
   * the alert yet (the app was just allowed, the panel is new or was edited), it only notes what is
   * true now, so already-true alerts don't all run at once.
   */
  private async alertThen(entry: AppEntry, key: string, then: Then, value: unknown, on: boolean, rows: Row[] | undefined): Promise<void> {
    const fired = await this.firedState();
    const before = fired[key];
    if (rows === undefined) {
      fired[key] = { on };
      this.saveFired();
      if (before && "on" in before && !before.on && on) await this.runThen(entry.path, then, { value });
      return;
    }
    const ids = rows.map(rowId);
    fired[key] = { rows: [...new Set(ids)] };
    this.saveFired();
    if (!before || !("rows" in before)) return;
    const seen = new Set(before.rows);
    for (const [i, row] of rows.entries()) if (!seen.has(ids[i])) await this.runThen(entry.path, then, { ...row, value });
  }

  private firedState(): Promise<Record<string, Fired>> {
    this.fired ??= (async () => {
      try {
        const text = await this.env.triggers?.read();
        const parsed = text ? JSON.parse(text) as unknown : {};
        this.firedSaved = text ?? "{}";
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Fired> : {};
      } catch {
        return {};
      }
    })();
    return this.fired;
  }

  /** Writes what alerts ran for when it changed, one write after another. */
  private saveFired(): void {
    void this.fired?.then((fired) => {
      const text = JSON.stringify(fired);
      if (text === this.firedSaved) return;
      this.firedSaved = text;
      this.firedSaving = this.firedSaving.then(() => this.env.triggers?.write(text)).catch(() => {});
    });
  }

  /** Drops an app's status items and alerts (it's gone, or no longer allowed); `keep` are panels it still watches. */
  private forget(path: string, keep: ReadonlySet<string> = new Set()): void {
    let dropped = false;
    for (const map of [this.pins, this.active, this.alertOn]) {
      for (const key of map.keys()) {
        if (!key.startsWith(`${path}\n`) || keep.has(key)) continue;
        map.delete(key);
        dropped = true;
      }
    }
    // An alert's `then` that is dropped starts over, noting what is true when it's back.
    void this.fired?.then((fired) => {
      let gone = false;
      for (const key of Object.keys(fired)) {
        if (!key.startsWith(`${path}\n`) || keep.has(key)) continue;
        delete fired[key];
        gone = true;
      }
      if (gone) this.saveFired();
    });
    if (dropped) this.publish();
  }

  /** Tells the status bar and the alert views what changed. */
  private publish(): void {
    const status = this.inOrder(this.pins);
    const json = JSON.stringify(status);
    if (json !== this.status) {
      this.status = json;
      this.env.sink.setStatus(status);
    }
    const alerts = JSON.stringify(this.alerts.list());
    if (alerts === this.alertsShown) return;
    this.alertsShown = alerts;
    for (const cb of [...this.listeners]) cb();
  }

  /** Items by app path, then in the order the app's panels are written. */
  private inOrder<T>(items: Map<string, T>): T[] {
    return [...this.apps.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .flatMap((e) => e.watched.flatMap((w) => (items.has(w.key) ? [items.get(w.key)!] : [])));
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
      const r = await this.evaluate(entry.path, entry.spec.recorded[job.block], true);
      if (!("panel" in r)) return;
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

  /** A problem only data can show: told once a session, and again whenever the app is opened. */
  private problem(entry: AppEntry, message: string, opened: boolean): void {
    const key = `${entry.path}\n${message}`;
    if (!opened && this.told.has(key)) return;
    this.told.add(key);
    this.say(`${entry.name}: ${message}`);
  }

  // ---- Index --------------------------------------------------------------------------------

  /** Reads an app note into the index, or drops it when it's no longer an app; returns what is indexed now. */
  private index(path: string): AppEntry | undefined {
    const old = this.apps.get(path);
    const fm = this.env.frontmatter(path);
    const spec = readSpec(fm, { now: this.env.now(), notes: this.env.notes, path })?.spec;
    // Most notes that change aren't apps and never were.
    if (!old && !spec) return undefined;
    const definition = JSON.stringify([fm, spec?.read ?? null]);
    if (old && spec && old.definition === definition) return old;
    old?.stop();
    this.apps.delete(path);
    const entry = spec && this.entry(path, spec, definition);
    // A panel that is still there keeps its alert's state, so editing the app doesn't tell it again.
    this.forget(path, new Set(entry?.watched.map((w) => w.key)));
    if (!this.running) return entry;
    this.publishCommands();
    if (entry) void this.check(entry);
    return entry;
  }

  /**
   * A new entry for an app, listening for changes to what defines it (its note, the components it
   * links) and to the data its pinned and alerting panels read.
   */
  private entry(path: string, spec: AppSpec, definition: string): AppEntry {
    const ids = panelIds(spec.panels.map((ps) => ps.template));
    const shortcuts = new Map<string, PanelSpec>();
    for (const ps of spec.panels) if (ps.panel.shortcut && !shortcuts.has(ps.panel.shortcut)) shortcuts.set(ps.panel.shortcut, ps);
    const entry: AppEntry = {
      path,
      name: basename(path),
      definition,
      spec,
      dataPath: dataPathOf(spec.store, path, (store, from) => this.env.storePath(store, from)),
      wanted: permissionsOf(spec, path),
      records: recordJobs(spec),
      shortcuts,
      watched: spec.panels.flatMap((ps, i) => (ps.panel.pin || ps.panel.alert !== undefined ? [{ key: `${path}\n${ids[i]}`, ps }] : [])),
      refreshMs: spec.refreshMs ?? DEFAULT_REFRESH_MS,
      stop: () => {},
    };
    const definitionDeps = [fileDep(path), ...spec.links.map(nameDep)];
    const files = { appPath: path, dataPath: entry.dataPath };
    const start = this.valuesOf(path, spec, this.env.now());
    const dataDeps = entry.watched.flatMap(({ ps }) => {
      const p = resolvePanel(ps, start).panel;
      return p ? this.env.data.depsOf(sourceOf(p), p, files) : [];
    });
    entry.stop = this.env.data.subscribe([...definitionDeps, ...dataDeps], (changed) => {
      if (this.apps.get(path) !== entry) return;
      // A new definition makes a new entry, which evaluates itself.
      if (definitionDeps.some((d) => changed.has(d)) && this.index(path) !== entry) return;
      if (this.running && dataDeps.some((d) => changed.has(d))) void this.check(entry);
    });
    this.apps.set(path, entry);
    return entry;
  }
}

/** A shortcut as a link from outside Obsidian (a phone's shortcut, a tag, a bookmark) runs it. */
export interface ShortcutLink {
  path: string;
  app: string;
  shortcut: string;
  label: string;
  /** A form's fields, each filled by `&field=value`; none for a button. */
  fields: string[];
  link: string;
  allowed: boolean;
}

/** A link's own parameters; a form field of one of these names can't be filled from a link. */
export const LINK_PARAMS = ["action", "app", "do"];

/** What copying a shortcut's link tells: which link, how a form's fields are filled, and what stops it. */
export function linkNotice(s: ShortcutLink): string {
  const parts = [`Copied the link to “${s.label}” in ${s.app}.`];
  const fillable = s.fields.filter((f) => !LINK_PARAMS.includes(f));
  if (fillable.length) parts.push(`Add ${fillable.map((f) => `&${f}=…`).join("")} to fill the form.`);
  const stuck = s.fields.filter((f) => LINK_PARAMS.includes(f));
  if (stuck.length) parts.push(`A link can't fill ${stuck.join(", ")}; rename ${stuck.length === 1 ? "that field" : "those fields"} to fill ${stuck.length === 1 ? "it" : "them"}.`);
  if (!s.allowed) parts.push(`Open ${s.app} once to allow it; until then the link is refused.`);
  return parts.join(" ");
}

/** The apps a link's `app=` names: the one at that path (`.md` optional), else every app of that name. */
function appsNamed<T extends { path: string; name: string }>(apps: ReadonlyMap<string, T>, name: string): T[] {
  const exact = apps.get(name) ?? apps.get(`${name}.md`);
  return exact ? [exact] : [...apps.values()].filter((e) => e.name === name);
}

/** The link that runs an app's shortcut: it names the app by name, or by path when another app has that name. */
export function shortcutLink(apps: ReadonlyMap<string, { path: string; name: string }>, path: string, shortcut: string): string {
  const name = basename(path);
  const app = appsNamed(apps, name).length === 1 ? name : path.replace(/\.md$/i, "");
  return `obsidian://gizmo?app=${encodeURIComponent(app)}&do=${encodeURIComponent(shortcut)}`;
}

/** Who ran a shortcut, as a notice names them. */
function by(actor: Actor): string {
  return actor.startsWith("trigger:") ? actor.slice("trigger:".length) : actor === "link" ? "a link" : "a command";
}

/** A row as an alert's `then` remembers it: its note (and task text), else when it was saved, else all of it. */
function rowId(row: Row): string {
  if (typeof row.path === "string") return typeof row.text === "string" ? `${row.path}\n${row.text}` : row.path;
  if (typeof row.at === "string") return `at:${row.at}`;
  return stableJson(row);
}

/** What a command or notice calls a panel. */
function labelOf(p: Panel, fallback: string): string {
  return p.label ?? p.title ?? fallback;
}

/**
 * A form's row from a link's parameters, each read as its field's type; a field the link doesn't
 * give is what an untouched form saves. Parameters that aren't fields are ignored.
 */
function formRow(fields: Record<string, string | string[]>, info: Panel["fieldInfo"], params: Record<string, string>, now: Date): { row: Row } | { error: string } {
  const row: Row = {};
  for (const [name, type] of Object.entries(fields)) {
    if (!Object.hasOwn(params, name)) {
      row[name] = startOf(info?.[name], now) ?? (Array.isArray(type) ? type[0] ?? ""
        : type === "checkbox" ? false : type === "number" ? null : type === "date" ? stampParts(now).date : "");
      continue;
    }
    const value = typedValue(type, params[name]);
    if (value === undefined) return { error: `${name} ${expectedOf(type)}` };
    row[name] = value;
  }
  return { row };
}

/** Link text as a field of this type holds it; undefined when it can't. */
function typedValue(type: string | string[], raw: string): unknown {
  if (Array.isArray(type)) return type.find((o) => String(o) === raw);
  const word = raw.trim().toLowerCase();
  switch (type) {
    case "number": return word !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    case "checkbox": return ["true", "1", "yes"].includes(word) ? true : ["false", "0", "no"].includes(word) ? false : undefined;
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
    case "time": return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : undefined;
    default: return raw;
  }
}

function expectedOf(type: string | string[]): string {
  if (Array.isArray(type)) return `must be one of ${type.join(", ")}`;
  switch (type) {
    case "number": return "must be a number";
    case "checkbox": return "must be true or false";
    case "date": return "must be a date like 2026-11-18";
    default: return "must be a time like 08:30";
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

/** The blocks an app records: root blocks with `record` on a web source that check out as a panel. */
function recordJobs(spec: AppSpec): RecordJob[] {
  return Object.keys(spec.recorded).flatMap((block) => {
    const keys = spec.blocks[block];
    const every = parseDuration(keys.record);
    if (!every) return [];
    return [{ block, list: typeof keys.into === "string" ? keys.into : `${block}_log`, everyMs: Math.max(MIN_RECORD_MS, every) }];
  });
}
