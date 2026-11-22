import type { ActionDeps } from "./actions.ts";
import type { Actor, LogStore, NewEntry } from "./activity.ts";
import type { CaptureIndex, Parsed } from "./capture.ts";
import type { DryStep } from "./dryrun.ts";
import { splitByWindow } from "./compare.ts";
import { rowsOf, type Row } from "./data.ts";
import { metIn, type Rhythm } from "./expect.ts";
import type { DataLayer } from "./datalayer.ts";
import { fileDep, folderDep, nameDep } from "./deps.ts";
import { FiredStore, pausedKey } from "./background-fired.ts";
import { MAX_SAMPLES, Recorder, recordJobs, type RecordJob } from "./background-record.ts";
import { RenameMatcher } from "./background-renames.ts";
import { Shortcuts, brokenShortcuts, labelOf, shortcutFields, type DryRun, type ShortcutResult } from "./background-shortcuts.ts";
import { Rhythms } from "./background-rhythms.ts";
import { Pauses } from "./background-pauses.ts";
import { Watch } from "./background-watch.ts";
import { Imports } from "./background-imports.ts";
import { Asks, type AskFeed } from "./background-asks.ts";
import { Shares, type WriterRecord } from "./background-share.ts";
import { askRows, type Ask } from "./asks.ts";
import { askPath, seenValues, type AskKind } from "./ask.ts";
import { logFolder } from "./ledger.ts";
import type { Imported } from "./import.ts";
import { fingerprint } from "./identity.ts";
import type { NoteReader } from "./expand.ts";
import type { ShortcutLink } from "./links.ts";
import { thisValues } from "./sources/this.ts";
import {
  panelIds, readSpec, resolvePanel, startingValues, type AppSpec, type Panel, type PanelSpec, type Then,
} from "./spec.ts";
import type { AppSummary } from "./map.ts";
import { askersOf, permissionsOf } from "./permissions.ts";
import { checkFlows, flowContext, type Verdict } from "./flows.ts";
import type { AppliedPolicy, Label, Policy } from "./policy.ts";
import { appendPath, basename, dataPathOf, devicesFolder, storeTarget } from "./store.ts";
import { THIS } from "./template.ts";
import type { AlertFeed } from "./views/alerts.ts";
import { sourceOf } from "./views/registry.ts";
import { panelValue } from "./views/value.ts";

/** The plugin's one timer ticks this often; an app without `refresh` is checked this often. */
export const TICK_MS = 60_000;
export const DEFAULT_REFRESH_MS = 10 * 60_000;


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
  /** Asks the person whether to go ahead, showing `lines` under `title` and what it would change; true for Run. */
  confirm(title: string, lines: string[], effects?: string[]): Promise<boolean>;
  /** Asks the person to pick one of `choices` (the first is Cancel); the index picked, or undefined when closed. */
  choose(title: string, lines: string[], choices: string[]): Promise<number | undefined>;
  /** Opens a link that goes out of Obsidian: a link's x-success, x-error or x-cancel. */
  openUrl(url: string): void;
  /** The apps paused in the background here, for the status bar; empty when none is. */
  setPaused?(apps: PausedApp[]): void;
  /**
   * An alert that just turned true, for places beyond the notice (gizmod pushes it to a phone):
   * the app and panel, the notice's text, and its label under the data policy when one is applied.
   */
  alert?(notice: AlertNotice): void;
}

/** An app that was allowed and stopped running in the background: it asks for more, or the policy now refuses it. */
export interface PausedApp {
  path: string;
  name: string;
  /** Why, as words that follow "it": "now asks to fetch data from …". */
  reason: string;
  /** Since when (ms). */
  since: number;
}

export interface AlertNotice {
  app: string;
  panel: string;
  text: string;
  label?: Label;
  /** The capture line that answers it (a missed window logged inside the window), when one runs as it stands. */
  answer?: string;
  /** The rhythm's window it is about, by the rule's app and id. */
  window?: { app: string; rule: string; start: number; deadline: number };
}

/** What the background needs from Obsidian; the glue passes the real thing, tests fakes. */
export interface BackgroundEnv {
  data: DataLayer;
  frontmatter(path: string): Record<string, unknown> | undefined;
  notes: NoteReader;
  /** Notes whose frontmatter has `app`, from the metadata cache. */
  appPaths(): string[];
  /**
   * Whether the app was opened in its own tab and is allowed exactly `wanted`, even when that is
   * nothing; under a data policy, `asked` is what the policy doesn't cover (see isAllowedUnder).
   */
  isGranted(path: string, wanted: string[], asked?: string[]): boolean;
  /** What was allowed under an app's grant key, or undefined when nothing is kept (never allowed, or revoked). */
  granted(path: string): string[] | undefined;
  /** The data policy applied in Obsidian, if any, with its fingerprint. */
  policy?(): AppliedPolicy | undefined;
  storePath(store: string, fromPath: string): string;
  /** What running an app's actions writes with; with an actor, what they change is kept in the activity log. */
  actionDeps(appPath: string, dataPath: string, actor?: Actor): ActionDeps;
  now(): Date;
  sink: BackgroundSink;
  /** Where the alerts that run a `then` keep what they already ran for, across restarts. */
  triggers?: LogStore;
  /** The other devices' `triggers` files, as text: where their rhythms got to, for a device taking over. */
  otherTriggers?(): Promise<string[]>;
  /** Where this device keeps what it read from and sent to the relays of shared kinds; and the other devices' files, for one taking over. */
  shareState?: LogStore;
  otherShareStates?(): Promise<string[]>;
  /** What this vault decided about each writer of a shared kind, by writer (see background-share.ts). */
  writers?(kindPath: string): Record<string, WriterRecord>;
  /** Keeps a decision about a writer; undefined where none may be made (gizmod reads data.json, never writes it). */
  setWriter?(kindPath: string, writer: string, record: WriterRecord | undefined): void;
  /** An app note renamed on another device, seen here as a delete and a create: what this device keeps elsewhere (its activity) follows. */
  renamed?(from: string, to: string): void;
  /** An app note gone for good (PENDING_MS with no create to match): what is kept for it elsewhere (data.json) can go. */
  dropped?(path: string): void;
  /** The key a shortcut's copied link carries; with `create`, made and kept when there is none yet. */
  linkKey(path: string, shortcut: string, create: boolean): string | undefined;
  /** What a capture link's key may run without asking: name → `<app path>#<shortcut>`; undefined for a key Gizmo never made. */
  captureKey(key: string): Record<string, string> | undefined;
  /** The apps (`scheme://host`) a shortcut's keyed link may send to without asking. */
  destinations(path: string, shortcut: string): string[];
  allowDestination(path: string, shortcut: string, to: string): void;
  /** Keeps what an app sent out of Obsidian, answering a link, in the activity log. */
  logSent(entry: NewEntry): void;
  /** Whether this device runs background work: records, and what alerts run. Other devices may run it instead. */
  runsBackground(): boolean;
  /** Whether alert notices are left to another program on this computer (gizmod), so none is told twice. */
  quietAlerts?(): boolean;
  /**
   * The zone a rhythm's "by 10:00" means: where the person is, from the zone of the phone or desktop
   * they used last; this device's own when undefined.
   */
  zone?(): string | undefined;
}

/**
 * A panel worked out without drawing it: its value, that value as its view shows it (`shown`, unit
 * included) and its rows, or why not. A compare panel's value and rows are its current window's.
 */
export type Evaluation = { value: unknown; shown: string; rows: unknown; panel: Panel } | { waiting: string } | { error: string };

/** What the background knows about one app note. */
export interface AppEntry {
  /** Its rhythms' deadlines are being decided. */
  deciding?: boolean;
  path: string;
  /** The note's name, as commands and notices call the app. */
  name: string;
  /** The note's keys and the components it read; while they're the same, so is the entry. */
  definition: string;
  spec: AppSpec;
  dataPath: string;
  /** With `devices: split`, the folder of device notes from before the ledger, read in as the app's rows. */
  devices?: string;
  /** What the app needs allowed; it acts only while exactly this is granted. */
  wanted: string[];
  /** What the data policy says of it, when there is one: flows it refuses, permissions it covers, the rest asked. */
  verdict?: Verdict;
  records: RecordJob[];
  /** Panels by their `shortcut`, the first panel winning. */
  shortcuts: Map<string, PanelSpec>;
  /** Shortcuts whose panel has a problem that stops it, each with that problem (see brokenShortcuts). */
  broken: Map<string, string>;
  /** Panels with `pin` or `alert`, each with a key unique across the vault. */
  watched: { key: string; ps: PanelSpec }[];
  refreshMs: number;
  /** When the watched panels were last evaluated, and the evaluation running now. */
  checkedAt?: number;
  checking?: Promise<void>;
  /** Asked to evaluate again while an evaluation runs. */
  again?: boolean;
  /** Set when the app is allowed again after a pause: since when it was paused, until its rhythms decide the gap. */
  pausedSince?: number;
  /** Its note's keys as a short text, for telling a sync's rename (a delete and a create) from two apps. */
  fingerprint: string;
  /** When it took over what another path kept (a rename): until its grant arrives too, that is kept rather than forgotten. */
  carried?: number;
  /** A kind whose import folders were read since it was indexed. */
  imported?: boolean;
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
  private recorder: Recorder;
  private rhythms: Rhythms;
  private renames = new RenameMatcher();
  private shortcuts: Shortcuts;
  private watch: Watch;
  private pauses: Pauses;
  private imports: Imports;
  private askQueue: Asks;
  private shares: Shares;
  /** Told when the apps it knows, or what one of them is, change. */
  private indexListeners = new Set<() => void>();
  /** By watched panel key, what each alert with `then` already ran for; read once from `env.triggers`. */
  private fired: FiredStore;

  /** Alerts true now across the vault, for `view: alerts`. */
  readonly alerts: AlertFeed;
  /** What the allowed apps ask of the person, oldest first: for Next, the status bar and `source: asks`. */
  readonly asks: AskFeed;

  constructor(env: BackgroundEnv) {
    this.env = env;
    this.fired = new FiredStore(env);
    this.recorder = new Recorder(env, (appPath, ps, force) => this.evaluate(appPath, ps, force), (message) => this.say(message));
    this.rhythms = new Rhythms(env, this.fired, (appPath, ps, force) => this.evaluate(appPath, ps, force),
      (fromPath, then, ctx, chain, dry, seed) => this.runThen(fromPath, then, ctx, chain, dry, seed), (message) => this.say(message),
      (entry, rule, w) => this.askQueue.lineFor(entry, rule, w));
    this.shortcuts = new Shortcuts(env, {
      apps: this.apps,
      lookup: (path) => this.apps.get(path) ?? (this.running ? this.index(path) : undefined),
      granted: (entry) => this.granted(entry),
      valuesOf: (appPath, spec, now) => this.valuesOf(appPath, spec, now),
      evaluate: (appPath, ps, force) => this.evaluate(appPath, ps, force),
      verdictNow: (entry) => this.verdictNow(entry),
      say: (message) => this.say(message),
    });
    this.watch = new Watch(env, {
      apps: this.apps,
      fired: this.fired,
      granted: (entry) => this.granted(entry),
      verdictNow: (entry) => this.verdictNow(entry),
      evaluate: (appPath, ps, force) => this.evaluate(appPath, ps, force),
      runThen: (fromPath, then, ctx, chain, dry, seed) => this.runThen(fromPath, then, ctx, chain, dry, seed),
      pauseOrForget: (entry) => this.pauses.pauseOrForget(entry),
      say: (message) => this.say(message),
    });
    this.alerts = this.watch.alerts;
    this.imports = new Imports(env, { granted: (entry) => this.granted(entry), say: (message) => this.say(message) });
    this.shares = new Shares(env, { granted: (entry) => this.granted(entry), say: (message) => this.say(message) });
    this.askQueue = new Asks(env, {
      apps: this.apps,
      fired: this.fired,
      granted: (entry) => this.granted(entry),
      evaluate: (appPath, ps, force) => this.evaluate(appPath, ps, force),
      captureIndex: () => this.captureIndex(),
    });
    this.asks = this.askQueue.feed;
    env.data.asks = () => askRows(this.asks.list());
    this.pauses = new Pauses(env, {
      fired: this.fired,
      verdictNow: (entry) => this.verdictNow(entry),
      hide: (path) => {
        this.watch.hide(path);
        this.askQueue.drop(path);
      },
      forget: (path) => this.forget(path),
      say: (message) => this.say(message),
    });
  }

  /** Reads every app note once (after the layout is ready) and does what is due. */
  start(): Promise<void> {
    for (const path of this.env.appPaths()) this.index(path);
    this.running = true;
    this.shortcuts.publishCommands();
    return this.tick();
  }

  stop(): void {
    this.running = false;
    for (const entry of this.apps.values()) entry.stop();
    this.apps.clear();
    this.watch.clear();
    this.askQueue.clear();
    this.indexListeners.clear();
  }

  /** A note changed, appeared or was renamed to this path: index it if it became an app. Known apps follow their own changes. */
  noteChanged(path: string): void {
    if (this.running && !this.apps.has(path)) this.index(path);
  }

  /** The checked keys of an indexed app. */
  spec(appPath: string): AppSpec | undefined {
    return this.apps.get(appPath)?.spec;
  }

  /** Every app it knows, with what each may do and what makes it act, for the automation map. */
  list(): AppSummary[] {
    return [...this.apps.values()].map((e): AppSummary => {
      const resolved = (then: Then) => ({ app: then.app, do: then.do, path: this.env.notes.resolve(storeTarget(then.app), e.path) });
      const panels = e.spec.panels.map((ps) => ps.panel);
      return {
        path: e.path,
        name: e.name,
        description: e.spec.description,
        dataPath: e.dataPath,
        wanted: e.wanted,
        verdict: this.verdictNow(e),
        askers: askersOf(e.spec, e.path),
        shortcuts: [...e.shortcuts].map(([id, ps]) => ({
          id, label: labelOf(ps.panel, id), view: ps.panel.view,
          fields: shortcutFields(ps.panel),
        })),
        records: e.records.map((r) => ({ ...r })),
        alerts: panels.filter((p) => p.alert !== undefined).map((p) => ({
          title: p.title ?? p.label ?? e.name, then: p.then ? resolved(p.then) : undefined,
        })),
        thens: panels.filter((p) => p.then && p.alert === undefined).map((p) => ({ from: labelOf(p, p.view), ...resolved(p.then!) })),
        writesSelf: panels.some((p) => p.append !== undefined && appendPath(p.append) === e.path),
        ...(e.spec.kind?.share && { shared: { host: e.spec.kind.share.host } }),
      };
    });
  }

  /** Calls `cb` whenever the apps it knows, or one's keys, change; returns how to stop. */
  onIndexChange(cb: () => void): () => void {
    this.indexListeners.add(cb);
    return () => this.indexListeners.delete(cb);
  }

  /** An app's permission was taken back: it stops at once, its pins and alerts go, and its `then`s start over when allowed again. */
  revoked(path: string): void {
    this.forget(path);
    // Allowed again, it is evaluated when it opens rather than at its next refresh.
    const entry = this.apps.get(path);
    if (entry) entry.checkedAt = undefined;
  }

  /** Runs whatever is due for every allowed app. Never rejects; one app's failure doesn't stop the others. */
  async tick(): Promise<void> {
    if (!this.running) return;
    this.expire();
    await Promise.all([...this.apps.values()].map((entry) => this.work(entry).catch(() => {})));
  }

  /**
   * An app was opened (or just allowed): what it records is sampled now if due, a problem with it
   * is told again, its pins and alerts are evaluated if they never were, and a kind reads its
   * import folders if it never has.
   */
  opened(appPath: string): void {
    const entry = this.running ? this.apps.get(appPath) ?? this.index(appPath) : undefined;
    if (!entry || !this.granted(entry)) return;
    for (const job of entry.records) void this.recorder.sample(entry, job, true).catch(() => {});
    if (entry.checkedAt === undefined) void this.watch.check(entry);
    if (!entry.imported) void this.imports.folders(entry);
  }

  private async work(entry: AppEntry): Promise<void> {
    if (!this.granted(entry)) return this.pauses.pauseOrForget(entry);
    await this.pauses.resume(entry);
    for (const job of entry.records) await this.recorder.sample(entry, job, false).catch(() => {});
    if (entry.checkedAt === undefined || this.env.now().getTime() - entry.checkedAt >= entry.refreshMs) await this.watch.check(entry);
    await this.rhythms.run(entry).catch(() => {});
    if (!entry.imported) await this.imports.folders(entry);
    if (entry.spec.kind?.share) await this.shares.run(entry);
    await this.askQueue.check(entry);
  }

  /** Reads a shared kind's relay and sends what waits now, rather than on the next tick. */
  share(kindPath: string): Promise<void> {
    const entry = this.apps.get(kindPath);
    return entry ? this.shares.run(entry) : Promise.resolve();
  }

  /** Keeps an ask out of the queue on this device until tomorrow. */
  skipAsk(id: string): Promise<void> {
    return this.askQueue.skip(id);
  }

  /** Answers an ask that changes a row, or dismisses one for good; what it did, as the Next window tells it. */
  settleAsk(ask: Ask, how: "answer" | "dismiss"): Promise<{ ok: boolean; error?: string; entryId?: string; what?: string }> {
    return this.askQueue.settle(ask, how);
  }

  /** Reads a file into a kind under one of its `import:` maps, as a person asked; what it did, or why not. */
  async importFile(kindPath: string, map: string, path: string, actor: Actor): Promise<Imported | { error: string }> {
    const entry = this.apps.get(kindPath) ?? this.index(kindPath);
    if (!entry?.spec.kind) return { error: `${basename(kindPath)} isn't a kind` };
    return this.imports.file(entry, map, path, actor);
  }

  private granted(entry: AppEntry): boolean {
    const verdict = this.verdictNow(entry);
    if (verdict?.violations.length) return false;
    return this.env.isGranted(entry.path, entry.wanted, verdict?.asked);
  }

  /**
   * What the policy says of an app now. Worked out each time it's asked: a label can change with a
   * note the app's keys don't name (a tag on its data note, a note moved into a labelled folder).
   */
  private verdictNow(entry: AppEntry): Verdict | undefined {
    const policy = this.env.policy?.();
    entry.verdict = policy ? this.verdictOf(policy.rules, entry.spec, entry.wanted, entry.path, entry.dataPath) : undefined;
    return entry.verdict;
  }

  private verdictOf(policy: Policy, spec: AppSpec, wanted: string[], path: string, dataPath: string): Verdict {
    const where = { appPath: path, dataPath, hostPath: path };
    return checkFlows(spec, wanted, flowContext(policy, where, this.env.notes, (store, from) => this.env.storePath(store, from), (p) => this.env.data.host.tags(p)));
  }

  /** What a policy would say of every app, before it is applied. */
  judge(policy: Policy): { path: string; name: string; wanted: string[]; verdict: Verdict }[] {
    return [...this.apps.values()]
      .map((e) => ({ path: e.path, name: e.name, wanted: e.wanted, verdict: this.verdictOf(policy, e.spec, e.wanted, e.path, e.dataPath) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  /** The data policy changed: every app is checked against it again, and stops or starts as it now says. */
  policyChanged(): void {
    for (const path of [...this.apps.keys()]) this.index(path);
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
      const loaded = await this.env.data.panelData(source, p, { appPath, dataPath: entry.dataPath, devices: entry.devices }, { ttlMs: entry.refreshMs, now, force });
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

  // ---- Shortcuts (see background-shortcuts.ts) ---------------------------------------------

  captureIndex(): CaptureIndex {
    return this.shortcuts.captureIndex();
  }

  previewLine(line: string): Promise<{ parsed: Parsed; effects?: string[] }> {
    return this.shortcuts.previewLine(line);
  }

  /**
   * The vault's kinds as the ask line reads them: each one's name, shortcut and fields, the values
   * its rows hold (on every line), and how a panel beside it links to it.
   */
  async askKinds(): Promise<AskKind[]> {
    const now = this.env.now();
    const out: AskKind[] = [];
    for (const entry of this.apps.values()) {
      const kind = entry.spec.kind;
      if (!kind) continue;
      const files = { appPath: entry.path, dataPath: entry.dataPath, devices: entry.devices };
      let rows: Row[] = [];
      try {
        rows = rowsOf(await this.env.data.rawData(kind.name, { view: "table", source: kind.name, lines: "all" }, files, { ttlMs: 0, now }));
      } catch {
        // Its rows can't be read now: its choices are still known.
      }
      const shortcut = entry.spec.panels.find((ps) => ps.panel.view === "form")?.panel.alias;
      const ask: AskKind = { path: entry.path, name: kind.name, ...(shortcut !== undefined && { shortcut }), fields: kind.fields, seen: seenValues(kind.fields, rows) };
      // `[[Spend]]` finds the note by name from beside it; when another note of that name is nearer, its path does.
      if (this.env.notes.resolve(basename(entry.path), askPath(ask)) !== entry.path) ask.link = `[[${entry.path.replace(/\.md$/i, "")}]]`;
      out.push(ask);
    }
    return out;
  }

  capture(line: string, actor?: Actor, quiet?: boolean): Promise<ShortcutResult & { parsed: Parsed }> {
    return this.shortcuts.capture(line, actor, quiet);
  }

  runCaptureLink(params: Record<string, string>): Promise<void> {
    return this.shortcuts.runCaptureLink(params);
  }

  runFrom(appPath: string, shortcut: string, opts: { params?: Record<string, string>; key?: string; captureKeyed?: boolean; trusted?: boolean }): Promise<ShortcutResult> {
    return this.shortcuts.runFrom(appPath, shortcut, opts);
  }

  /** Whether an app may run now: one there is, allowed, and not stopped by the data policy. */
  mayRun(appPath: string): boolean {
    const entry = this.apps.get(appPath) ?? (this.running ? this.index(appPath) : undefined);
    return !!entry && this.granted(entry);
  }

  /** Whether a row met a rhythm's window by its deadline, as the rule reads its rows now; undefined when the rule isn't there to read. */
  async rhythmMet(appPath: string, ruleId: string, w: { start: number; deadline: number }): Promise<boolean | undefined> {
    const entry = this.apps.get(appPath);
    const rule = entry?.spec.expect.find((r): r is Rhythm => r.kind === "rhythm" && r.id === ruleId);
    const ps = rule && entry!.spec.expected[rule.id];
    const r = ps && (await this.evaluate(appPath, ps, true));
    if (!rule || !r || !("panel" in r)) return undefined;
    return metIn(rowsOf(r.rows), rule, { ...w, end: w.deadline }, this.env.now());
  }

  appFor(name: string): { path: string } | { error: string } {
    return this.shortcuts.appFor(name);
  }

  runCommand(id: string): Promise<ShortcutResult> {
    return this.shortcuts.runCommand(id);
  }

  runUri(params: Record<string, string>): Promise<void> {
    return this.shortcuts.runUri(params);
  }

  shortcutLinks(): ShortcutLink[] {
    return this.shortcuts.shortcutLinks();
  }

  formStart(appPath: string, shortcut: string): { fields: Record<string, string | string[]>; row: Row } | undefined {
    return this.shortcuts.formStart(appPath, shortcut);
  }

  dryRun(appPath: string, shortcut: string, params?: Record<string, string>): Promise<DryStep[]> {
    return this.shortcuts.dryRun(appPath, shortcut, params);
  }

  runThen(fromPath: string, then: Then, ctx: Row, chain?: string[], dry?: DryRun, seed?: string): Promise<void> {
    return this.shortcuts.runThen(fromPath, then, ctx, chain, dry, seed);
  }

  private say(message: string): void {
    this.env.sink.notify(message);
  }

  /**
   * Background work was just turned on here: alerts note what is true now and run their `then`
   * only for what turns true after, never for everything that changed while another device ran them.
   */
  startOver(): void {
    this.fired.startOver();
  }

  /** Apps paused here, by name. */
  paused(): PausedApp[] {
    return this.pauses.paused();
  }

  // ---- Renames ------------------------------------------------------------------------------

  /**
   * An app note renamed here (Obsidian's own rename): what this device kept for it follows at once.
   * The caller moves the rest (data.json, the data note, the activity log); see identity.ts.
   */
  renamed(from: string, to: string): void {
    const old = this.apps.get(from);
    if (old) {
      old.stop();
      this.apps.delete(from);
      this.watch.hide(from);
      this.askQueue.drop(from);
    }
    this.renames.renamed(from, to);
    this.carry(from, to);
    if (!this.running) return;
    const entry = this.apps.get(to) ?? this.index(to);
    if (entry) entry.carried = this.env.now().getTime();
    this.shortcuts.publishCommands();
  }

  /**
   * An app note that is gone: half of a rename when a note with the same keys arrived lately (a sync
   * may bring the create first); else what was kept for it waits PENDING_MS for its other half.
   */
  private disappeared(old: AppEntry): undefined {
    old.stop();
    this.apps.delete(old.path);
    this.watch.hide(old.path);
    this.askQueue.drop(old.path);
    this.pauses.drop(old.path);
    const twin = this.renames.went(old.path, old.fingerprint, this.env.now().getTime());
    if (twin) this.carried(old.path, twin);
    for (const cb of [...this.indexListeners]) cb();
    if (this.running) this.shortcuts.publishCommands();
    return undefined;
  }

  /** A new app note: the other half of a rename when a note with the same keys went lately. */
  private arrived(entry: AppEntry): void {
    // The apps read at start-up weren't made lately.
    if (!this.running) return;
    const twin = this.renames.came(entry.path, entry.fingerprint, this.env.now().getTime());
    if (twin) this.carried(twin, entry.path);
  }

  /** A rename another device made, matched here: this device's own files follow. */
  private carried(from: string, to: string): void {
    this.carry(from, to);
    const entry = this.apps.get(to);
    if (entry) entry.carried = this.env.now().getTime();
    this.env.renamed?.(from, to);
  }

  /** Moves what alerts, rhythms and a pause kept under one path to another; what was kept there is replaced. */
  private carry(from: string, to: string): void {
    this.watch.move(from, to);
    this.fired.move(from, to);
  }

  /** Notes gone for PENDING_MS with nothing to match are gone for good; notes made long enough ago match nothing. */
  private expire(): void {
    this.renames.expire(this.env.now().getTime(), (path) => {
      this.forget(path);
      this.env.dropped?.(path);
    });
  }

  /** Drops an app's status items and alerts (it's gone, or no longer allowed); `keep` are panels it still watches. */
  private forget(path: string, keep: ReadonlySet<string> = new Set()): void {
    const dropped = this.watch.drop(path, keep);
    this.pauses.drop(path);
    // An alert's `then` that is dropped starts over, noting what is true when it's back.
    this.fired.drop(path, keep);
    // An app read again, keeping some of what it watches, works out its asks again instead.
    if (!keep.size) this.askQueue.drop(path);
    if (dropped) this.watch.publish();
  }

  // ---- Index --------------------------------------------------------------------------------

  /** Reads an app note into the index, or drops it when it's no longer an app; returns what is indexed now. */
  private index(path: string): AppEntry | undefined {
    const old = this.apps.get(path);
    const fm = this.env.frontmatter(path);
    const read = readSpec(fm, { now: this.env.now(), notes: this.env.notes, path });
    const spec = read?.spec;
    // Most notes that change aren't apps and never were.
    if (!old && !spec) return undefined;
    if (old && fm === undefined) return this.disappeared(old);
    const definition = JSON.stringify([fm, spec?.read ?? null, this.env.policy?.()?.hash ?? null]);
    if (old && spec && old.definition === definition) return old;
    old?.stop();
    this.apps.delete(path);
    const entry = spec && this.entry(path, spec, definition, fingerprint(fm!), brokenShortcuts(fm!, spec, read.errors));
    if (entry && !old) this.arrived(entry);
    // A panel that is still there keeps its alert's state, so editing the app doesn't tell it again.
    // A rule still there keeps where its rhythm got to, so editing the app doesn't skip a deadline.
    const rhythms = entry?.spec.expect.filter((r) => r.kind === "rhythm").map((r) => `${path}\nexpect:${r.id}`) ?? [];
    // A pause stays with an app that is still there: what it asks for decides it on the next tick.
    this.forget(path, new Set([...(entry?.watched.map((w) => w.key) ?? []), ...rhythms, ...(entry ? [pausedKey(path)] : [])]));
    for (const cb of [...this.indexListeners]) cb();
    if (!this.running) return entry;
    this.shortcuts.publishCommands();
    if (entry) {
      void this.watch.check(entry);
      void this.askQueue.check(entry);
    } else this.askQueue.drop(path);
    return entry;
  }

  /**
   * A new entry for an app, listening for changes to what defines it (its note, the components it
   * links) and to the data its pinned and alerting panels read.
   */
  private entry(path: string, spec: AppSpec, definition: string, print: string, broken: Map<string, string>): AppEntry {
    const ids = panelIds(spec.panels.map((ps) => ps.template));
    const shortcuts = new Map<string, PanelSpec>();
    for (const ps of spec.panels) if (ps.panel.shortcut && !shortcuts.has(ps.panel.shortcut)) shortcuts.set(ps.panel.shortcut, ps);
    const dataPath = dataPathOf(spec.store, path, (store, from) => this.env.storePath(store, from));
    const entry: AppEntry = {
      path,
      name: basename(path),
      definition,
      fingerprint: print,
      spec,
      dataPath,
      ...(spec.split && { devices: devicesFolder(dataPath) }),
      wanted: permissionsOf(spec, path),
      records: recordJobs(spec),
      shortcuts,
      broken,
      watched: [
        ...spec.panels.flatMap((ps, i) => (ps.panel.pin || ps.panel.alert !== undefined ? [{ key: `${path}\n${ids[i]}`, ps }] : [])),
        // A state rule is watched as an alert is: told, listed in Attention and its then run when a row comes to match.
        ...Object.entries(spec.expected).flatMap(([id, ps]) => (ps.panel.alert !== undefined ? [{ key: `${path}\nexpect:${id}`, ps }] : [])),
      ],
      refreshMs: spec.refreshMs ?? DEFAULT_REFRESH_MS,
      stop: () => {},
    };
    // What an app records keeps only its newest rows, in its ledger as in its snapshot.
    this.env.data.ledger?.setCaps(dataPath, Object.fromEntries(entry.records.map((j) => [j.list, MAX_SAMPLES])));
    this.env.data.noteApp(dataPath, path, entry.devices);
    const definitionDeps = [fileDep(path), ...spec.links.map(nameDep)];
    const importDeps = Imports.foldersOf(entry).map(folderDep);
    const files = { appPath: path, dataPath: entry.dataPath, devices: entry.devices };
    const start = this.valuesOf(path, spec, this.env.now());
    const depsOf = (ps: PanelSpec) => {
      const p = resolvePanel(ps, start).panel;
      return p ? this.env.data.depsOf(sourceOf(p), p, files) : [];
    };
    const dataDeps = entry.watched.flatMap(({ ps }) => depsOf(ps));
    // What its asks come from: the rows its rhythms count, its misses, and a kind's own rows.
    const rhythms = spec.expect.filter((r) => r.kind === "rhythm" && spec.expected[r.id]);
    const askDeps = [
      ...rhythms.flatMap((r) => depsOf(spec.expected[r.id])),
      ...(rhythms.length || spec.kind ? [fileDep(dataPath), folderDep(logFolder(dataPath))] : []),
    ];
    entry.stop = this.env.data.subscribe([...definitionDeps, ...dataDeps, ...importDeps, ...askDeps], (changed) => {
      if (this.apps.get(path) !== entry) return;
      // A new definition makes a new entry, which evaluates itself.
      if (definitionDeps.some((d) => changed.has(d)) && this.index(path) !== entry) return;
      if (this.running && dataDeps.some((d) => changed.has(d))) void this.watch.check(entry);
      if (this.running && importDeps.some((d) => changed.has(d))) void this.imports.folders(entry);
      if (this.running && askDeps.some((d) => changed.has(d))) void this.askQueue.check(entry);
      // A row saved to a shared kind goes out now; the relay is read on the tick.
      if (this.running && spec.kind?.share && askDeps.some((d) => changed.has(d))) void this.shares.run(entry, false);
    });
    this.apps.set(path, entry);
    return entry;
  }
}
