import { metIn, refusal, windowDay, windowsDue, type Rhythm, type Window } from "./expect.ts";
import { panelKey, violationText } from "./flows.ts";
import { rowId as ledgerRowId } from "./ledger.ts";
import { rowIdOf } from "./ledger-store.ts";
import { fillLine, runActions, storeOf, tickItem, type ActionDeps, type ActionResult } from "./actions.ts";
import { describeAhead, type Actor, type LogStore, type NewEntry } from "./activity.ts";
import { captureTargets, parseLine, type CaptureIndex, type Parsed } from "./capture.ts";
import { Overlay, recordingDeps, type DryStep } from "./dryrun.ts";
import { splitByWindow } from "./compare.ts";
import { compileWhere, matches, parseDuration, rowsOf, type Row } from "./data.ts";
import { stampOf, toTime } from "./time.ts";
import type { DataLayer } from "./datalayer.ts";
import { fileDep, nameDep } from "./deps.ts";
import { stableJson } from "./hash.ts";
import { PENDING_MS, RENAME_MS, fingerprint } from "./identity.ts";
import type { NoteReader } from "./expand.ts";
import {
  answerParams, appOfShortcut, appsNamed, captureCovers, formRow, pickItem, readCallbacks, readLink, shortcutId, shortcutLink, withParams,
  type Callbacks, type ShortcutLink,
} from "./links.ts";
import { thisValues } from "./sources/this.ts";
import {
  panelIds, readSpec, resolvePanel, startingValues, type AppSpec, type Panel, type PanelSpec, type Then,
} from "./spec.ts";
import type { AppSummary } from "./map.ts";
import { askersOf, describePermission, permissionsOf } from "./permissions.ts";
import { checkFlows, flowContext, type Verdict } from "./flows.ts";
import { clearance, rank, released, type AppliedPolicy, type Label, type Policy } from "./policy.ts";
import { basename, dataPathOf, devicesFolder, notePath, resolveList, storeTarget } from "./store.ts";
import { InputRef, THIS, valueProblem } from "./template.ts";
import type { AlertFeed, AlertItem } from "./views/alerts.ts";
import { sourceOf } from "./views/registry.ts";
import { panelValue } from "./views/value.ts";

/** The plugin's one timer ticks this often; an app without `refresh` is checked this often. */
export const TICK_MS = 60_000;
export const DEFAULT_REFRESH_MS = 10 * 60_000;
/** The shortest `record` interval; shorter ones are treated as this. */
export const MIN_RECORD_MS = 60_000;
/** Where a rhythm's misses are kept, in the app's data note. */
export const EXPECT_MISSED = "expect_missed";

/**
 * How long an app is paused before it is told: two beats, so a component edit that syncs here before
 * the data.json allowing it doesn't tell of a pause that ends a minute later.
 */
export const PAUSE_TELL_MS = 10 * 60_000;

/** A recorded list keeps this many rows, the newest. */
/** A week of samples at the shortest interval, so a late copy of a sample can't fall past the cap. */
export const MAX_SAMPLES = 10_080;
/** The version of what alerts ran for, as kept on disk. */
const FIRED_VERSION = 2;
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

/** How running a shortcut went: whether it ran, why not (as the notice told it), and the activity log's entry for what it changed. */
export interface ShortcutResult {
  ok: boolean;
  error?: string;
  entryId?: string;
  /** What a shortcut that answers answered: its value, and as shown. */
  value?: unknown;
  shown?: string;
}

/** A shortcut that answers: whether it had a value, or why not. */
function answered(r: Evaluation): ShortcutResult {
  return "shown" in r ? { ok: true, value: r.value, shown: r.shown } : { ok: false, error: "waiting" in r ? `it waits for ${r.waiting}` : r.error };
}

/** What a link brings besides a form's values: the key it carries and where it wants word back. */
export interface LinkCall {
  key?: string;
  callbacks: Callbacks;
  /** Where an answer goes besides the link's own callback (gizmod's HTTP), checked against the data policy. */
  sink?: "gizmod";
  /** A capture link whose key covers this shortcut's name: it runs as a keyed link does. */
  captureKeyed?: boolean;
}

/** A dry run in progress: the copies of the notes it touched, and what each app would do. */
interface DryRun {
  overlay: Overlay;
  steps: DryStep[];
}

/** A dry run as lines to read: each change, the apps a `then` reaches named, and what each would tell. */
export function dryLines(steps: DryStep[]): string[] {
  const lines = steps.flatMap((step, i) => {
    const of = i > 0 ? `${step.app}: ` : "";
    return [
      ...step.changes.map((c) => `${of}${describeAhead(c)}`),
      ...step.remarks.map((r) => `${of}${r}`),
      // A notice is said to be one, so one that refuses isn't read as something the run does.
      ...step.notices.map((n) => `Tell you: ${i > 0 && !n.startsWith(`${step.app}:`) ? `${step.app}: ${n}` : n}`),
    ];
  });
  return lines.length ? lines : ["Nothing would change"];
}

/** A shortcut on a panel that shows one value answers with it instead of acting. */
function answers(p: Panel): boolean {
  return p.view === "number" || p.view === "progress";
}

/** What an alert with `then` ran for: whether its value condition held, or which rows matched. */
type Fired = { on: boolean } | { rows: string[] } | { decided: number } | { paused: number; reason: string; told?: true };

/** Where an app's pause is kept in `fired`: beside its rhythms' `expect:<rule>`, never a panel's key. */
const pausedKey = (path: string) => `${path}\npaused:`;

/** A rhythm missed while nothing ran (Obsidian closed, no gizmod): told for at most this many of its latest windows. */
const MAX_CATCH_UP = 3;

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
  /** Told when the apps it knows, or what one of them is, change. */
  private indexListeners = new Set<() => void>();
  private alertsShown = "[]";
  /** By watched panel key, what each alert with `then` already ran for; read once from `env.triggers`. */
  private fired: Promise<Record<string, Fired>> | undefined;
  private firedSaved = "{}";
  private firedSaving: Promise<void> = Promise.resolve();
  /** When each `then` ran in the last hour, by source app and target shortcut; and each shortcut's link runs. */
  private runs = new Map<string, number[]>();
  /** A link without its key is waiting for the person's answer. */
  private asking = false;
  /** Apps paused here, by path; the list last published. */
  private pausedNow = new Map<string, PausedApp>();
  /** App notes deleted lately, and app notes made lately, by path: a pair of the same keys is a rename another device made. */
  private gone = new Map<string, { fingerprint: string; at: number }>();
  private appeared = new Map<string, { fingerprint: string; at: number }>();
  private pausedShown = "[]";

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
        writesSelf: panels.some((p) => p.append !== undefined && notePath(p.append) === e.path),
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
   * is told again, and its pins and alerts are evaluated if they never were.
   */
  opened(appPath: string): void {
    const entry = this.running ? this.apps.get(appPath) ?? this.index(appPath) : undefined;
    if (!entry || !this.granted(entry)) return;
    for (const job of entry.records) void this.sample(entry, job, true).catch(() => {});
    if (entry.checkedAt === undefined) void this.check(entry);
  }

  private async work(entry: AppEntry): Promise<void> {
    if (!this.granted(entry)) return this.pauseOrForget(entry);
    await this.resume(entry);
    for (const job of entry.records) await this.sample(entry, job, false).catch(() => {});
    if (entry.checkedAt === undefined || this.env.now().getTime() - entry.checkedAt >= entry.refreshMs) await this.check(entry);
    await this.rhythms(entry).catch(() => {});
  }

  // ---- Expect -------------------------------------------------------------------------------

  /**
   * Decides each rhythm's deadlines that passed since it last decided, once: a window with no row
   * by its deadline is a miss, kept in the data note's `expect_missed` under an id made from the
   * rule and window (so two runners keep it once and only the first tells it), told, and its then
   * run. A rule seen for the first time starts from now; one that can't be read now waits a tick.
   */
  private async rhythms(entry: AppEntry): Promise<void> {
    if (!this.env.runsBackground()) {
      entry.pausedSince = undefined;
      return;
    }
    const rules = entry.spec.expect.filter((r): r is Rhythm => r.kind === "rhythm");
    // A tick that comes while the last is still deciding leaves it to that one.
    if (!rules.length || entry.deciding) return;
    entry.deciding = true;
    try {
      await this.decide(entry, rules);
    } finally {
      entry.deciding = false;
    }
  }

  private async decide(entry: AppEntry, rules: Rhythm[]): Promise<void> {
    const fired = await this.firedState();
    const now = this.env.now();
    const zone = this.env.zone?.();
    for (const rule of rules) {
      const key = `${entry.path}\nexpect:${rule.id}`;
      const before = fired[key];
      if (!before || !("decided" in before)) {
        fired[key] = { decided: now.getTime() };
        this.saveFired();
        continue;
      }
      const due = windowsDue(rule, before.decided, now.getTime(), zone);
      if (!due.length) continue;
      const ps = entry.spec.expected[rule.id];
      const r = ps && (await this.evaluate(entry.path, ps, true));
      if (!r || !("panel" in r)) continue;
      const rows = rowsOf(r.rows);
      // Every window missed is kept; only the newest few are told, the rest were long ago.
      const misses = due.filter((w) => !metIn(rows, rule, w, now));
      for (const [i, w] of misses.entries()) {
        const whilePaused = entry.pausedSince !== undefined && w.deadline >= entry.pausedSince;
        await this.missed(entry, rule, w, zone, i >= misses.length - MAX_CATCH_UP, whilePaused);
      }
      fired[key] = { decided: due.at(-1)!.deadline };
      this.saveFired();
    }
    entry.pausedSince = undefined;
  }

  private async missed(entry: AppEntry, rule: Rhythm, w: Window, zone: string | undefined, tell: boolean, whilePaused: boolean): Promise<void> {
    // Named by its date where the person is, so two devices, or one that moved zone, keep it once.
    const window = windowDay(w, zone);
    const seed = `miss\n${entry.path}\n${rule.id}\n${window}`;
    const deps = this.env.actionDeps(entry.path, entry.dataPath);
    const { already } = await storeOf(deps).add(EXPECT_MISSED, { rule: rule.id, window, at: stampOf(this.env.now()) }, { id: ledgerRowId(seed) });
    if (already || !tell) return;
    const text = `${entry.name}: ${rule.say ?? `${rule.id} wasn't done by ${rule.byText}`}${whilePaused ? ` (${window}, missed while paused)` : ""}`;
    this.say(text);
    this.env.sink.alert?.({ app: entry.name, panel: rule.say ?? rule.id, text });
    if (rule.then) await this.runThen(entry.path, rule.then, { rule: rule.id, window }, [], undefined, seed);
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

  // ---- Shortcuts ----------------------------------------------------------------------------

  /** The names a capture line can start with, from every app's shortcuts. */
  captureIndex(): CaptureIndex {
    return captureTargets(this.apps.values());
  }

  /** What a capture line would run and, worked out by a dry run, what that would change and tell. */
  async previewLine(line: string): Promise<{ parsed: Parsed; effects?: string[] }> {
    const parsed = parseLine(line, this.captureIndex(), this.env.now());
    if (!parsed.ok) return { parsed };
    return { parsed, effects: dryLines(await this.dryRun(parsed.target.path, parsed.target.shortcut, parsed.params)) };
  }

  /**
   * Runs a capture line (`spend 14.5 food lunch`): the shortcut it names, with the values it types,
   * as that shortcut's command would with a link's values. A line that can't be read runs nothing
   * and says why only in its result, for the place it was typed to show.
   */
  async capture(line: string, actor: Actor = "shortcut"): Promise<ShortcutResult & { parsed: Parsed }> {
    const parsed = parseLine(line, this.captureIndex(), this.env.now());
    if (!parsed.ok) return { ok: false, error: parsed.error, parsed };
    return { ...(await this.runShortcut(parsed.target.path, parsed.target.shortcut, actor, parsed.params)), parsed };
  }

  /**
   * Answers `obsidian://gizmo?key=…&line=…`: a capture line sent from outside Obsidian (a phone's
   * shortcut, a launcher). A key copied with "Copy capture link" runs the names it was made for
   * unattended, as a shortcut's keyed link does; any other line asks first, showing what it would
   * do. As for any link, a line that can't run is told only in Obsidian.
   */
  async runCaptureLink(params: Record<string, string>): Promise<void> {
    const line = (params.line ?? "").trim();
    const callbacks = readCallbacks(params);
    if ("problem" in callbacks) return this.say(`Refused a capture link: ${callbacks.problem}`);
    const parsed = parseLine(line, this.captureIndex(), this.env.now());
    if (!parsed.ok) return this.say(`A capture link couldn't run “${line}”: ${parsed.error}`);
    const granted = params.key !== undefined ? this.env.captureKey(params.key) : undefined;
    const { path, shortcut } = parsed.target;
    // A name that now reaches another shortcut than the one it was copied for asks again.
    const captureKeyed = captureCovers(granted, parsed.target);
    await this.runShortcut(path, shortcut, "link", parsed.params, undefined, { callbacks, captureKeyed });
  }

  /**
   * Runs a shortcut asked for from outside Obsidian (gizmod's HTTP): with `key`, as its copied link
   * runs, which only the key it carries lets run unattended; with `captureKeyed`, a capture key's
   * name; `trusted` (the computer's own user) as its command. Gives what it answered, if it answers.
   */
  runFrom(appPath: string, shortcut: string, opts: { params?: Record<string, string>; key?: string; captureKeyed?: boolean; trusted?: boolean }): Promise<ShortcutResult> {
    if (opts.trusted) return this.runShortcut(appPath, shortcut, "shortcut", opts.params);
    return this.runShortcut(appPath, shortcut, "link", opts.params ?? {}, undefined, { key: opts.key, callbacks: {}, captureKeyed: opts.captureKeyed, sink: "gizmod" });
  }

  /** The app a name or path finds, as a link names it; undefined, with why, when none or several. */
  appFor(name: string): { path: string } | { error: string } {
    const found = appsNamed(this.apps, name);
    if (found.length === 0) return { error: `No app called “${name}”` };
    if (found.length > 1) return { error: `Several apps are called “${name}”; use its path` };
    return { path: found[0].path };
  }

  /** Runs the command `<app path>:<shortcut>`. */
  runCommand(id: string): Promise<ShortcutResult> {
    const cut = id.lastIndexOf(":");
    return this.runShortcut(id.slice(0, cut), id.slice(cut + 1), "shortcut");
  }

  /**
   * Answers `obsidian://gizmo?app=…&do=…&field=value…`. Any web page can send one, so it only
   * runs a panel its author marked with `shortcut`, in an app the user already allowed; the other
   * parameters only fill that form's fields, checked against their types.
   */
  async runUri(params: Record<string, string>): Promise<void> {
    const { app: name, shortcut, key, fields } = readLink(params);
    const callbacks = readCallbacks(params);
    if ("problem" in callbacks) return this.say(`Refused a link to “${shortcut}” in ${name}: ${callbacks.problem}`);
    // Nothing goes back to the caller until the link is allowed, so a page can't find out which apps there are.
    const found = appsNamed(this.apps, name);
    if (found.length === 0) return this.say(`No app called “${name}”`);
    if (found.length > 1) return this.say(`Several apps are called “${name}”; use its path`);
    await this.runShortcut(found[0].path, shortcut, "link", fields, undefined, { key, callbacks });
  }

  /** Every app's shortcuts with the link that runs each, whether or not the app is allowed yet. */
  shortcutLinks(): ShortcutLink[] {
    return [...this.apps.values()]
      .flatMap((e) => [...e.shortcuts].map(([shortcut, ps]): ShortcutLink => {
        const p = ps.panel;
        const apps = this.apps;
        const env = this.env;
        const full = shortcutLink(apps, e.path, shortcut, "");
        return {
          path: e.path, app: e.name, shortcut, label: labelOf(p, shortcut), view: p.view, fields: shortcutFields(p),
          // A key is made, and data.json written, only when a link is copied, not each time the list is drawn.
          get link() { return shortcutLink(apps, e.path, shortcut, env.linkKey(e.path, shortcut, true)!); },
          address: full.slice(0, full.indexOf("&key=")),
          allowed: this.granted(e),
          answers: answers(p),
        };
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.shortcut.localeCompare(b.shortcut));
  }

  /**
   * Runs an app's shortcut panel without opening the app: a button's actions, or a form's with the
   * values a link gives (a command has none, so a form opens its app to be filled in). Notifies the
   * result: the panel's own `notify`, else that it's done.
   */
  /** `seed` makes the rows it saves the same rows wherever it runs: an alert's then on two runners at once saves one. */
  private async runShortcut(appPath: string, shortcut: string, actor: Actor, params?: Record<string, string>, chain?: string[], link?: LinkCall, dry?: DryRun, seed?: string): Promise<ShortcutResult> {
    const entry = this.apps.get(appPath);
    const ps = entry?.shortcuts.get(shortcut);
    // In a dry run, what it would tell is kept with what it would change, and nothing is shown or opened.
    const step: DryStep = { app: entry?.name ?? basename(appPath), what: shortcut, changes: [], notices: [], remarks: [] };
    dry?.steps.push(step);
    const say = (message: string) => (dry ? void step.notices.push(message) : this.say(message));
    const fail = (message: string): ShortcutResult => {
      say(message);
      return { ok: false, error: message };
    };
    const openApp = (path: string) => (dry ? void step.remarks.push(`Open ${basename(path)} for you to fill in`) : this.env.sink.openApp(path));
    if (!entry || !ps) return fail(`${entry?.name ?? basename(appPath)} has no shortcut “${shortcut}”`);
    if (!this.granted(entry)) return fail(`Open ${entry.name} once to allow it`);
    const now = this.env.now();
    const r = resolvePanel(ps, this.valuesOf(entry.path, entry.spec, now));
    // Another app's trigger never opens an app: what it can't run is told instead.
    const triggered = chain !== undefined;
    if (!r.panel) {
      if (triggered) return fail(`${entry.name}: “${shortcut}” waits for a choice in the app, so it can't run from ${by(actor)}`);
      openApp(entry.path);
      return { ok: false, error: `“${shortcut}” waits for a choice in ${entry.name}` };
    }
    const p = r.panel;
    const label = labelOf(p, shortcut);
    step.what = label;
    if (answers(p)) {
      if (!dry) return this.answer(entry, ps, p, shortcut, actor, link);
      step.remarks.push(`Answer with the value of “${label}”, changing nothing`);
      return { ok: true };
    }
    let input: Row = {};
    if (triggered && p.view === "button" && params && Object.keys(params).length) {
      return fail(`${entry.name}: “${shortcut}” is a button and takes no values; take fill out of ${by(actor)}'s then`);
    }
    if (p.view === "form" || p.view === "checklist") {
      const form = p.view === "form";
      if (!params && triggered) return fail(`${entry.name}: “${shortcut}” is a ${p.view}; give ${by(actor)}'s then a fill with ${form ? "its values" : "item"}`);
      if (!params) {
        openApp(entry.path);
        say(`${entry.name}: ${form ? "fill in the form" : "tick an item"}`);
        return { ok: false, error: form ? "the form needs its values" : "say which item to tick" };
      }
      const read = readParams(p, params, now);
      if ("error" in read) return fail(`${entry.name}: ${read.error}`);
      input = read.row;
    }
    const cb = link?.callbacks ?? {};
    let allowed: "keyed" | "asked" | false = false;
    if (actor === "link" && !dry) {
      const given = params ?? {};
      const lines = Object.keys(input).filter((k) => Object.hasOwn(given, k)).map((k) => `${k}: ${String(input[k])}`);
      if (cb.to) lines.push(`Then it tells ${cb.to} it ran`);
      const effects = async () => dryLines(await this.dryRun(entry.path, shortcut, params));
      allowed = await this.linkMayRun(entry, p, shortcut, link, lines, `A link asks to run “${label}” in ${entry.name}`, effects);
      if (!allowed) return { ok: false, error: "the link wasn't allowed to run" };
    }
    const trail = chain ?? [shortcutId(entry.path, shortcut)];
    // Said before what its `then` runs says, in the order they happen.
    let told = false;
    const done = () => {
      if (told || p.notify || dry) return;
      told = true;
      say(`${entry.name}: ${label} done${triggered ? ` for ${by(actor)}` : ""}`);
    };
    let result: ActionResult;
    if (p.view === "checklist") {
      const base = this.env.actionDeps(entry.path, entry.dataPath, dry ? undefined : actor);
      result = await tickItem(p, String(input.item), dry ? recordingDeps(dry.overlay, base, step) : base);
      if (result.ok) say(`${entry.name}: ${result.already ? `${String(input.item)} was already ticked` : `ticked ${String(input.item)}`}${triggered ? ` for ${by(actor)}` : ""}`);
    } else {
      const base: ActionDeps = this.env.actionDeps(entry.path, entry.dataPath, dry ? undefined : actor);
      const deps: ActionDeps = {
        ...(dry ? recordingDeps(dry.overlay, base, step) : base),
        expect: entry.spec.expect,
        ...(seed && { rowId: ledgerRowId(`then\n${seed}`) }),
        then: async (panel, ctx) => {
          done();
          if (panel.then) await this.runThen(entry.path, panel.then, ctx, trail, dry, seed);
        },
      };
      result = await runActions(p, input, deps);
      if (result.ok) done();
    }
    if (dry) return { ok: result.ok };
    if (allowed && result.ok && cb.success) this.env.sink.openUrl(withParams(cb.success, { result: "done" }));
    // Only a link with its key hears why it failed; any other could be a page finding out what's there.
    const failed = `“${label}” didn't run${result.error ? `: ${result.error}` : ""}`;
    if (allowed === "keyed" && !result.ok && cb.error) this.env.sink.openUrl(withParams(cb.error, { errorMessage: failed }));
    const entryId = await result.logged?.catch(() => undefined);
    return result.ok ? { ok: true, entryId } : { ok: false, error: failed, entryId };
  }

  /**
   * A form shortcut's fields, with their types and the values a link that names none of them would
   * save, for a dry run to show and start from; undefined for a button or a shortcut that isn't there.
   */
  formStart(appPath: string, shortcut: string): { fields: Record<string, string | string[]>; row: Row } | undefined {
    const entry = this.apps.get(appPath);
    const ps = entry?.shortcuts.get(shortcut);
    if (!entry || !ps) return undefined;
    const now = this.env.now();
    const p = resolvePanel(ps, this.valuesOf(entry.path, entry.spec, now)).panel;
    if (p?.view === "checklist") {
      const items = (p.items ?? []).map(String);
      return { fields: { item: items }, row: { item: items[0] ?? "" } };
    }
    if (p?.view !== "form") return undefined;
    const fields = p.fields ?? p.schema ?? {};
    const filled = formRow(fields, p.fieldInfo, {}, now);
    return "row" in filled ? { fields, row: filled.row } : undefined;
  }

  /**
   * What running a shortcut would change and tell, app by app through its `then`s, worked out by
   * the same checks and writes as a real run against copies of the notes it touches. Nothing is
   * written, shown or opened, and the hourly limits are neither counted nor read.
   */
  async dryRun(appPath: string, shortcut: string, params?: Record<string, string>): Promise<DryStep[]> {
    const host = this.env.data.host;
    const overlay = new Overlay({
      frontmatter: (path) => this.env.frontmatter(path),
      text: (path) => host.readFile(path).catch(() => undefined),
      exists: (path) => host.fileInfo(path) !== undefined,
    });
    const steps: DryStep[] = [];
    await this.runShortcut(appPath, shortcut, params ? "link" : "shortcut", params, undefined, undefined, { overlay, steps });
    return steps;
  }

  /**
   * A number or progress panel's shortcut: its command tells its value in a notice, its link sends
   * the value back to the app that opened it (x-success). It is worked out only once the link may
   * run, so a link without its key fetches nothing until the person says so.
   */
  private async answer(entry: AppEntry, ps: PanelSpec, p: Panel, shortcut: string, actor: Actor, link: LinkCall | undefined): Promise<ShortcutResult> {
    const label = labelOf(p, shortcut);
    if (actor.startsWith("trigger:")) return this.failed(`${entry.name}: “${shortcut}” answers links with a value; a then can't run it`);
    const tell = (r: Evaluation): ShortcutResult => {
      this.say(`${entry.name}: ${label}: ${"shown" in r ? r.shown : "waiting" in r ? `waits for ${r.waiting}` : r.error}`);
      return answered(r);
    };
    if (actor !== "link") return tell(await this.evaluate(entry.path, ps));
    const cb = link?.callbacks ?? {};
    const lines = cb.to ? [`Its value goes to ${cb.to}`] : [];
    const allowed = await this.linkMayRun(entry, p, shortcut, link, lines, `A link asks for “${label}” from ${entry.name}`);
    if (!allowed) return { ok: false, error: "the link wasn't allowed to run" };
    if (link?.sink && !this.mayAnswerTo(entry, ps, p.title ?? p.label ?? entry.name, link.sink)) {
      return this.failed(`${entry.name}: your data policy keeps “${label}” from ${link.sink}'s answers`);
    }
    const r = await this.evaluate(entry.path, ps);
    if (!("shown" in r)) {
      const why = "waiting" in r ? `it waits for ${r.waiting}` : r.error;
      if (allowed === "keyed" && cb.error) this.env.sink.openUrl(withParams(cb.error, { errorMessage: why }));
      return this.failed(`${entry.name}: couldn't answer “${label}”: ${why}`);
    }
    if (!cb.success) return tell(r);
    this.env.sink.openUrl(withParams(cb.success, answerParams(r.shown, r.value)));
    this.env.logSent({ app: entry.path, actor, what: label, changes: [], sent: { to: cb.to!, shown: r.shown } });
    return answered(r);
  }

  /** Whether the applied data policy lets an answer's value go to `sink`: released there, or labelled no higher than it clears. */
  private mayAnswerTo(entry: AppEntry, ps: PanelSpec, title: string, sink: "gizmod"): boolean {
    const policy = this.env.policy?.()?.rules;
    if (!policy) return true;
    if (released(policy, entry.path, title, sink)) return true;
    // A value whose label can't be found isn't taken for public.
    const label = this.verdictNow(entry)?.answerLabels[panelKey(ps)];
    const cleared = clearance(policy, sink);
    return label !== undefined && cleared !== undefined && rank(label) <= rank(cleared);
  }

  /**
   * Whether a link may run a shortcut. Any web page, email or chat message can send one, so: at most
   * MAX_RUNS_PER_HOUR an hour, and without the key its copied link carries, only once the person
   * says Run in a window showing `lines` (the values it gives, where word goes back) and what it
   * would change (`effects`, from a dry run). A keyed link
   * that sends word back asks the first time it would go to an app, and remembers that app with
   * the key when told Always; Cancel there opens its x-cancel. One window at a time; links that
   * come meanwhile are dropped. Says "keyed" or "asked" when it may run.
   */
  private async linkMayRun(
    entry: AppEntry, p: Panel, shortcut: string, link: LinkCall | undefined, lines: string[], title: string, effects?: () => Promise<string[]>,
  ): Promise<"keyed" | "asked" | false> {
    const label = labelOf(p, shortcut);
    const rateKey = `link\n${shortcutId(entry.path, shortcut)}`;
    const recent = () => (this.runs.get(rateKey) ?? []).filter((t) => this.env.now().getTime() - t < 3_600_000);
    if (recent().length >= MAX_RUNS_PER_HOUR) {
      this.runs.set(rateKey, recent());
      this.say(`${entry.name}: stopped running “${label}” from links: it ran ${MAX_RUNS_PER_HOUR} times this hour`);
      return false;
    }
    const expected = this.env.linkKey(entry.path, shortcut, false);
    const keyed = link?.captureKeyed === true || (expected !== undefined && link?.key === expected);
    const cb = link?.callbacks ?? {};
    const asks = !keyed || (cb.to !== undefined && !this.env.destinations(entry.path, shortcut).includes(cb.to));
    if (asks && this.asking) {
      this.say(`Ignored a link to “${label}” in ${entry.name} while another link waits for an answer`);
      return false;
    }
    if (!keyed) {
      this.asking = true;
      try {
        // What it would do is worked out only now, once the window may open: a dropped link costs nothing.
        if (!(await this.env.sink.confirm(title, lines, await effects?.()))) return false;
      } finally {
        this.asking = false;
      }
    } else if (asks) {
      this.asking = true;
      let choice: number | undefined;
      try {
        const what = answers(p) ? `its value (${label})` : `word that “${label}” ran`;
        choice = await this.env.sink.choose(`${entry.name} would send ${what} to ${cb.to}`, lines, ["Cancel", "Once", "Always"]);
      } finally {
        this.asking = false;
      }
      if (choice !== 1 && choice !== 2) {
        if (cb.cancel) this.env.sink.openUrl(cb.cancel);
        return false;
      }
      if (choice === 2) this.env.allowDestination(entry.path, shortcut, cb.to!);
    }
    this.runs.set(rateKey, [...recent(), this.env.now().getTime()]);
    return keyed ? "keyed" : "asked";
  }

  /**
   * Runs a panel's `then`: the named app's shortcut, as a link would, with `fill` filled from the
   * row the panel ran with. Both apps must be allowed. A shortcut already run in this chain, a
   * chain longer than MAX_CHAIN, or more than MAX_RUNS_PER_HOUR runs of one `then` is a loop, and
   * stops with a notice naming it. Never rejects.
   */
  async runThen(fromPath: string, then: Then, ctx: Row, chain: string[] = [], dry?: DryRun, seed?: string): Promise<void> {
    const say = (message: string) => (dry ? void dry.steps.at(-1)?.notices.push(message) : this.say(message));
    try {
      const from = this.apps.get(fromPath) ?? (this.running ? this.index(fromPath) : undefined);
      if (!from || !this.granted(from)) return;
      // Found as Obsidian finds the link from the app's note, as `use` links are.
      const name = storeTarget(then.app);
      const path = this.env.notes.resolve(name, from.path);
      if (!path) return say(`${from.name}: no app called “${name}” to run “${then.do}” in`);
      const target = this.apps.get(path) ?? (this.running ? this.index(path) : undefined);
      if (!target) return say(`${from.name}: “${name}” isn't an app, so it can't run “${then.do}”`);
      const key = shortcutId(target.path, then.do);
      const names = (keys: string[]) => keys.map((k) => basename(appOfShortcut(k))).join(" → ");
      if (chain.includes(key)) return say(`${from.name}: stopped a loop: ${names([...chain, key])}`);
      if (chain.length >= MAX_CHAIN) return say(`${from.name}: stopped after ${MAX_CHAIN} apps in a row: ${names([...chain, key])}`);
      if (!dry) {
        const now = this.env.now().getTime();
        const rateKey = `${from.path}\n${key}`;
        const recent = (this.runs.get(rateKey) ?? []).filter((t) => now - t < 3_600_000);
        if (recent.length >= MAX_RUNS_PER_HOUR) {
          this.runs.set(rateKey, recent);
          return say(`${from.name}: stopped running “${then.do}” in ${target.name}: it ran ${MAX_RUNS_PER_HOUR} times this hour`);
        }
        this.runs.set(rateKey, [...recent, now]);
      }
      const params = Object.fromEntries(Object.entries(then.fill ?? {}).map(([k, v]) => [k, fillLine(v, ctx)]));
      await this.runShortcut(target.path, then.do, `trigger:${from.name}`, then.fill ? params : undefined, [...chain, key], undefined, dry, seed && `${seed}\n${key}`);
    } catch (e) {
      say(`${basename(fromPath)}: couldn't run “${then.do}”: ${(e as Error).message}`);
    }
  }

  private say(message: string): void {
    this.env.sink.notify(message);
  }

  /** Tells why something didn't run, and gives that as a run's result. */
  private failed(message: string): ShortcutResult {
    this.say(message);
    return { ok: false, error: message };
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
    if (!this.granted(entry)) return this.pauseOrForget(entry);
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
      // Whether it was told is kept with what alerts ran for, so a restart doesn't tell it again.
      const fired = await this.firedState();
      const toldKey = `${key}\ntold`;
      const kept = fired[toldKey];
      const was = this.alertOn.get(key) ?? (kept && "on" in kept ? kept.on : undefined);
      this.alertOn.set(key, on);
      if (on !== was) {
        if (on) fired[toldKey] = { on: true };
        else delete fired[toldKey];
        this.saveFired();
      }
      if (p.then) await this.alertThen(entry, key, p.then, r.value, on, rows);
      if (this.apps.get(entry.path) !== entry) return;
      if (!on) {
        this.active.delete(key);
        continue;
      }
      const text = matching === undefined ? shown : `${matching} ${matching === 1 ? "row" : "rows"}`;
      this.active.set(key, { appPath: entry.path, app: entry.name, title, text });
      // Told when it turns true, not again until it has been false, a restart between included.
      if (was !== true) {
        const told = `${entry.name}: ${title} ${matching === undefined ? text : `(${text})`}`;
        if (!this.env.quietAlerts?.()) this.say(told);
        if (this.env.runsBackground()) this.env.sink.alert?.({ app: entry.name, panel: title, text: told, label: this.verdictNow(entry)?.alertLabels[panelKey(ps)] });
      }
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
    if (!this.env.runsBackground()) return;
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
    // A row's then saves under an id from the alert and the row as it is now, the same on any runner;
    // a value turning true has no such row, and its then saves as a save does.
    for (const [i, row] of rows.entries()) {
      if (!seen.has(ids[i])) await this.runThen(entry.path, then, { ...row, value }, [], undefined, `${key}\n${ids[i]}\n${stableJson(row)}`);
    }
  }

  /**
   * Background work was just turned on here: alerts note what is true now and run their `then`
   * only for what turns true after, never for everything that changed while another device ran them.
   */
  startOver(): void {
    const before = this.firedState();
    this.fired = (async () => carryOver(await before, await this.otherFired()))();
    this.saveFired();
  }

  /** What the other devices kept of their alerts and rhythms, in a version this one knows. */
  private async otherFired(): Promise<Record<string, Fired>[]> {
    const texts = await this.env.otherTriggers?.().catch(() => []) ?? [];
    return texts.flatMap((text) => {
      try {
        const parsed = JSON.parse(text) as { v?: unknown; fired?: unknown };
        return parsed.v === FIRED_VERSION && parsed.fired && typeof parsed.fired === "object" && !Array.isArray(parsed.fired) ? [parsed.fired as Record<string, Fired>] : [];
      } catch {
        return [];
      }
    });
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
      this.hide(from);
    }
    this.gone.delete(from);
    this.appeared.delete(to);
    this.carry(from, to);
    if (!this.running) return;
    const entry = this.apps.get(to) ?? this.index(to);
    if (entry) entry.carried = this.env.now().getTime();
    this.publishCommands();
  }

  /**
   * An app note that is gone: half of a rename when a note with the same keys arrived lately (a sync
   * may bring the create first); else what was kept for it waits PENDING_MS for its other half.
   */
  private disappeared(old: AppEntry): undefined {
    old.stop();
    this.apps.delete(old.path);
    this.hide(old.path);
    if (this.pausedNow.delete(old.path)) this.publishPaused();
    const now = this.env.now().getTime();
    const twin = this.twinOf(this.appeared, old.fingerprint, now);
    if (twin) {
      this.appeared.delete(twin);
      this.carried(old.path, twin);
    } else this.gone.set(old.path, { fingerprint: old.fingerprint, at: now });
    for (const cb of [...this.indexListeners]) cb();
    if (this.running) this.publishCommands();
    return undefined;
  }

  /** A new app note: the other half of a rename when a note with the same keys went lately. */
  private arrived(entry: AppEntry): void {
    // The apps read at start-up weren't made lately.
    if (!this.running) return;
    const now = this.env.now().getTime();
    const twin = this.twinOf(this.gone, entry.fingerprint, now);
    if (twin) {
      this.gone.delete(twin);
      this.carried(twin, entry.path);
    } else this.appeared.set(entry.path, { fingerprint: entry.fingerprint, at: now });
  }

  /** The one note with these keys that went or came within RENAME_MS; none when there are two (two copies aren't a rename). */
  private twinOf(notes: Map<string, { fingerprint: string; at: number }>, print: string, now: number): string | undefined {
    const near = [...notes].filter(([, n]) => n.fingerprint === print && now - n.at <= RENAME_MS);
    return near.length === 1 ? near[0][0] : undefined;
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
    const prefix = `${from}\n`;
    for (const [key, on] of [...this.alertOn]) {
      if (!key.startsWith(prefix)) continue;
      this.alertOn.delete(key);
      this.alertOn.set(to + key.slice(from.length), on);
    }
    void this.firedState().then((fired) => {
      let moved = false;
      for (const key of Object.keys(fired)) {
        if (!key.startsWith(prefix)) continue;
        fired[to + key.slice(from.length)] = fired[key];
        delete fired[key];
        moved = true;
      }
      if (moved) this.saveFired();
    });
  }

  /** Notes gone for PENDING_MS with nothing to match are gone for good; notes made long enough ago match nothing. */
  private expire(): void {
    const now = this.env.now().getTime();
    for (const [path, n] of this.appeared) if (now - n.at > RENAME_MS) this.appeared.delete(path);
    for (const [path, n] of this.gone) {
      if (now - n.at <= PENDING_MS) continue;
      this.gone.delete(path);
      this.forget(path);
      this.env.dropped?.(path);
    }
  }

  // ---- Pause --------------------------------------------------------------------------------

  /**
   * An app that isn't allowed now. Paused when it was allowed and now asks for more, or the policy
   * refuses it: it keeps where its rhythms and alerts got to, and the device running background work
   * tells of it once it has lasted PAUSE_TELL_MS. Otherwise (revoked, never allowed) it is forgotten,
   * and starts over when allowed.
   */
  private async pauseOrForget(entry: AppEntry): Promise<void> {
    const why = this.pauseReason(entry);
    if (!why) {
      // Renamed elsewhere, its grant still on its way here by sync: what it carried waits for it.
      if (entry.carried !== undefined && this.env.now().getTime() - entry.carried < PENDING_MS && this.env.granted(entry.path) === undefined) return this.hide(entry.path);
      return this.forget(entry.path);
    }
    this.hide(entry.path);
    const fired = await this.firedState();
    const key = pausedKey(entry.path);
    const was = fired[key];
    const now = this.env.now().getTime();
    const since = was && "paused" in was ? was.paused : now;
    this.pausedNow.set(entry.path, { path: entry.path, name: entry.name, reason: why.reason, since });
    this.publishPaused();
    if (!was || !("paused" in was) || was.reason !== why.reason) {
      fired[key] = { paused: since, reason: why.reason };
      this.saveFired();
      if (now - since < PAUSE_TELL_MS) return;
    } else if (was.told || now - since < PAUSE_TELL_MS) return;
    if (!this.env.runsBackground()) return;
    fired[key] = { paused: since, reason: why.reason, told: true };
    this.saveFired();
    const text = `${entry.name} is paused in the background: it ${why.reason}. ${why.next}`;
    if (!this.env.quietAlerts?.()) this.say(text);
    this.env.sink.alert?.({ app: entry.name, panel: "paused in the background", text });
  }

  /** Why an app that was allowed doesn't run now, and what to do; undefined when it was never allowed or was revoked. */
  private pauseReason(entry: AppEntry): { reason: string; next: string } | undefined {
    const before = this.env.granted(entry.path);
    if (before === undefined) return undefined;
    const verdict = this.verdictNow(entry);
    if (verdict?.violations.length) return { reason: `breaks your data policy (${violationText(verdict.violations[0])})`, next: "Open it to see why." };
    const missing = (verdict?.asked ?? entry.wanted).filter((p) => !before.includes(p));
    if (!missing.length) return undefined;
    const asks = missing.map((p) => describePermission(p)).map((d) => d.charAt(0).toLowerCase() + d.slice(1));
    return { reason: `now asks to ${asks.join("; ")}`, next: "Open it to allow it." };
  }

  /** An app allowed again after a pause: its rhythms decide what they missed meanwhile, on this tick. */
  private async resume(entry: AppEntry): Promise<void> {
    if (this.pausedNow.delete(entry.path)) this.publishPaused();
    const fired = await this.firedState();
    const was = fired[pausedKey(entry.path)];
    if (!was || !("paused" in was)) return;
    delete fired[pausedKey(entry.path)];
    this.saveFired();
    entry.pausedSince = was.paused;
  }

  /** Apps paused here, by name. */
  paused(): PausedApp[] {
    return [...this.pausedNow.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private publishPaused(): void {
    const list = this.paused();
    const json = JSON.stringify(list.map((p) => [p.path, p.reason]));
    if (json === this.pausedShown) return;
    this.pausedShown = json;
    this.env.sink.setPaused?.(list);
  }

  /**
   * What alerts ran for, as kept. Kept in a version it knows, or not at all: rows were once told
   * apart by when they were saved and now by their id, and reading the old keys would run every
   * matching row's then again; an unknown version starts over, as a new runner does.
   */
  private firedState(): Promise<Record<string, Fired>> {
    this.fired ??= (async () => {
      try {
        const text = await this.env.triggers?.read();
        const parsed = text ? JSON.parse(text) as { v?: unknown; fired?: unknown } : undefined;
        this.firedSaved = text ?? "";
        const fired = parsed?.v === FIRED_VERSION ? parsed.fired : undefined;
        return fired && typeof fired === "object" && !Array.isArray(fired) ? fired as Record<string, Fired> : {};
      } catch {
        return {};
      }
    })();
    return this.fired;
  }

  /** Writes what alerts ran for when it changed, one write after another. */
  private saveFired(): void {
    void this.fired?.then((fired) => {
      const text = JSON.stringify({ v: FIRED_VERSION, fired });
      if (text === this.firedSaved) return;
      this.firedSaved = text;
      this.firedSaving = this.firedSaving.then(() => this.env.triggers?.write(text)).catch(() => {});
    });
  }

  /** Takes an app's status items and alerts off the screen; what it was doing is kept. */
  private hide(path: string): void {
    let dropped = false;
    for (const map of [this.pins, this.active]) {
      for (const key of map.keys()) {
        if (!key.startsWith(`${path}\n`)) continue;
        map.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.publish();
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
    if (this.pausedNow.delete(path)) this.publishPaused();
    // An alert's `then` that is dropped starts over, noting what is true when it's back.
    void this.fired?.then((fired) => {
      let gone = false;
      for (const key of Object.keys(fired)) {
        if (!key.startsWith(`${path}\n`) || keep.has(key.replace(/\ntold$/, ""))) continue;
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

  // ---- Index --------------------------------------------------------------------------------

  /** Reads an app note into the index, or drops it when it's no longer an app; returns what is indexed now. */
  private index(path: string): AppEntry | undefined {
    const old = this.apps.get(path);
    const fm = this.env.frontmatter(path);
    const spec = readSpec(fm, { now: this.env.now(), notes: this.env.notes, path })?.spec;
    // Most notes that change aren't apps and never were.
    if (!old && !spec) return undefined;
    if (old && fm === undefined) return this.disappeared(old);
    const definition = JSON.stringify([fm, spec?.read ?? null, this.env.policy?.()?.hash ?? null]);
    if (old && spec && old.definition === definition) return old;
    old?.stop();
    this.apps.delete(path);
    const entry = spec && this.entry(path, spec, definition, fingerprint(fm!));
    if (entry && !old) this.arrived(entry);
    // A panel that is still there keeps its alert's state, so editing the app doesn't tell it again.
    // A rule still there keeps where its rhythm got to, so editing the app doesn't skip a deadline.
    const rhythms = entry?.spec.expect.filter((r) => r.kind === "rhythm").map((r) => `${path}\nexpect:${r.id}`) ?? [];
    // A pause stays with an app that is still there: what it asks for decides it on the next tick.
    this.forget(path, new Set([...(entry?.watched.map((w) => w.key) ?? []), ...rhythms, ...(entry ? [pausedKey(path)] : [])]));
    for (const cb of [...this.indexListeners]) cb();
    if (!this.running) return entry;
    this.publishCommands();
    if (entry) void this.check(entry);
    return entry;
  }

  /**
   * A new entry for an app, listening for changes to what defines it (its note, the components it
   * links) and to the data its pinned and alerting panels read.
   */
  private entry(path: string, spec: AppSpec, definition: string, print: string): AppEntry {
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
    const files = { appPath: path, dataPath: entry.dataPath, devices: entry.devices };
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

/**
 * The row a link, a `then` or a capture line gives a form or checklist shortcut, or why not. What
 * they carry is refused whole if any of it holds a secret or a line break (rule 0.2); a form reads
 * each value as its field's type, a checklist takes the item to tick.
 */
function readParams(p: Panel, params: Record<string, string>, now: Date): { row: Row } | { error: string } {
  const problem = Object.entries(params).map(([k, v]) => valueProblem(new InputRef(k), v, true)).find(Boolean);
  if (problem) return { error: problem };
  if (p.view === "checklist") return pickItem((p.items ?? []).map(String), params);
  return formRow(p.fields ?? p.schema ?? {}, p.fieldInfo, params, now);
}

/** The values a shortcut takes from a link: a form's fields, a checklist's item; a button takes none. */
function shortcutFields(p: Panel): string[] {
  if (p.view === "checklist") return ["item"];
  return p.view === "form" ? Object.keys(p.fields ?? p.schema ?? {}) : [];
}

/** Who ran a shortcut, as a notice names them. */
function by(actor: Actor): string {
  return actor.startsWith("trigger:") ? actor.slice("trigger:".length) : actor === "link" ? "a link" : "a command";
}

/**
 * A row as an alert's `then` remembers it: its note (and task text), else its id in the app's
 * ledger, else when it was saved, else all of it.
 */
function rowId(row: Row): string {
  if (typeof row.path === "string") return typeof row.text === "string" ? `${row.path}\n${row.text}` : row.path;
  const id = rowIdOf(row);
  if (id) return `id:${id}`;
  if (typeof row.at === "string") return `at:${row.at}`;
  return stableJson(row);
}

/** What a command or notice calls a panel. */
function labelOf(p: Panel, fallback: string): string {
  return p.label ?? p.title ?? fallback;
}

/** When a list's last row was saved, from its `at`. */
/**
 * What a device taking over background work keeps: alerts start over (they note what is true now and
 * run their `then` only for what turns true after), while rhythms and pauses carry on. Each rhythm
 * goes on from the latest point any device decided it to, so a window nobody decided while devices
 * changed over is still decided, and one already decided elsewhere isn't decided again.
 */
export function carryOver(mine: Record<string, Fired>, others: readonly Record<string, Fired>[]): Record<string, Fired> {
  const out: Record<string, Fired> = {};
  for (const [key, value] of Object.entries(mine)) if ("paused" in value || "decided" in value) out[key] = value;
  for (const fired of others) {
    for (const [key, value] of Object.entries(fired)) {
      if (!("decided" in value) || typeof value.decided !== "number") continue;
      const had = out[key];
      if (!had || !("decided" in had) || had.decided < value.decided) out[key] = { decided: value.decided };
    }
  }
  return out;
}

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
