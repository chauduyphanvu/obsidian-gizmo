/**
 * Gizmo's runtime: everything a program that runs Gizmo does the same way, whether it is Obsidian,
 * gizmod or Gizmo outside Obsidian. It keeps the settings every device shares (data.json), decides
 * what is allowed, keeps the activity log and undoes it, follows the vault's changes, says this
 * device is there, runs the background work when this device is the one to, and seals sealed kinds
 * once a day there. What only one program has (tabs, a status bar, a push to a phone) comes in
 * through its RuntimeHost, so nothing here imports Obsidian.
 */
import { actionDepsOf, type ActionIO } from "./actions.ts";
import { ActivityLog, undoEntry, type Entry, type UndoIO, type UndoResult } from "./activity.ts";
import { Background, TICK_MS, type BackgroundEnv, type BackgroundSink } from "./background.ts";
import type { WriterRecord } from "./background-share.ts";
import { DataLayer, type Host } from "./datalayer.ts";
import { ledgerStore } from "./datastore.ts";
import { DefinitionLog } from "./definitions.ts";
import { DEVICE_FOLDERS, Heartbeat, deviceFile, otherLogs, otherShareStates, otherTriggers, type Device, type HeartbeatIO, type PluginFiles } from "./device.ts";
import type { NoteReader } from "./expand.ts";
import { checkFlows, flowContext, type FlowWhere, type Verdict } from "./flows.ts";
import { grantedOf, isGranted, migrateGrants, sameGrant, setGrant } from "./grants.ts";
import { dropKeys, moveKeys } from "./identity.ts";
import { logFileParts, logFolder } from "./ledger.ts";
import { LensIndex } from "./lens-index.ts";
import { newLinkKey, shortcutId } from "./links.ts";
import { permissionsOf } from "./permissions.ts";
import { POLICY_PATH, isPolicyPath, policyHash, readPolicy, type AppliedPolicy, type Policy } from "./policy.ts";
import { SEAL_EVERY_MS, SEAL_LOOK_MS, lastSealed, sealHostOf, sealNow, sealedKind, type SealHost } from "./seal-run.ts";
import { SNAPSHOT_DELAY_MS, SNAPSHOT_GAP_MS } from "./snapshots.ts";
import { kindDataPaths } from "./sources/kind.ts";
import { readSpec, type AppSpec } from "./spec.ts";
import { defaultDataPath, isApp, isKind, runsAsApp } from "./store.ts";
import { captureNamesOf, destinationsOf, writersOf, type SettingsSource, type StoredData } from "./stored.ts";
import type { VaultWrites } from "./vault-ops.ts";

/** What a program gives the runtime to run Gizmo in it. */
export interface RuntimeHost {
  /** The vault and the web, as the data layer reads them. */
  host: Host;
  /** data.json, opened; a host without `save` never writes it. */
  settings: SettingsSource;
  /** The plugin's folder, where each device keeps files of its own (see device.ts). */
  files: PluginFiles;
  device: Device;
  /** What this device says of itself every few minutes (see Heartbeat). */
  beat: Pick<HeartbeatIO, "mine" | "sayChanges" | "writeFailed">;
  /** The host's writes to notes: one queue, so two writes to one note never cross. */
  writes: VaultWrites;
  /** Linked notes, found as the host finds a link. */
  notes: NoteReader;
  /** The note a `store:` value points at, from the note that names it. */
  storePath(store: string, from: string): string;
  /** What an app's actions run with while its note is closed; undefined when the note is gone. */
  actionIO(appPath: string): ActionIO | undefined;
  /**
   * Moves a file or folder where nothing is yet, making its folder; false, moving nothing, when
   * something is there or nothing is at `from`. Only a host that sees renames as renames has it.
   */
  rename?(from: string, to: string): Promise<boolean>;
  /** What the background tells and asks the person, and shows them. */
  sink: BackgroundSink;
  /** Runs `fn` every `ms` until the cancel it gives is called. */
  every(fn: () => void, ms: number): () => void;
  /** Runs `fn` once after `ms` unless the cancel it gives is called first. */
  later(fn: () => void, ms: number): () => void;
}

export class GizmoRuntime {
  readonly host: RuntimeHost;
  /** Shared by every open app: web cache, notes index, change notifications. */
  readonly dataLayer: DataLayer;
  /** What every app changed in the vault, kept in the plugin's folder so it can be shown and undone. */
  readonly activity: ActivityLog;
  /** What each app's panels said each time it was opened here with different keys, for Explain. */
  readonly definitions: DefinitionLog;
  /** Which lenses show on which notes. */
  readonly lenses: LensIndex;
  /** This device: kept on it alone, never in a file a sync copies. */
  readonly device: Device;
  /** This device's word to the others, and which of them runs background work. */
  readonly beat: Heartbeat;
  /** Works for allowed apps while their notes are closed: records, shortcuts, alerts, asks. */
  readonly background: Background;
  /** Each open app's headline, as its own tab shows it now (see AppController.reportHeadline), for the sidebar. */
  readonly headlines = new Map<string, string>();
  private grantListeners = new Set<() => void>();
  private revokeListeners = new Set<(key: string, asksNothing: boolean) => void>();
  private headlineListeners = new Set<() => void>();
  private timers: (() => void)[] = [];
  private stopped = false;

  constructor(host: RuntimeHost) {
    this.host = host;
    this.device = host.device;
    const id = host.device.id;
    const now = () => host.host.now();
    this.dataLayer = new DataLayer(host.host);
    this.activity = new ActivityLog(host.files.file(deviceFile(DEVICE_FOLDERS.activity, id)), now, () => this.otherActivity());
    this.definitions = new DefinitionLog(host.files.file(deviceFile(DEVICE_FOLDERS.definitions, id)), now);
    this.lenses = new LensIndex(this.dataLayer);
    this.beat = new Heartbeat({ id, files: host.files, now, ...host.beat });
    this.background = new Background(this.backgroundEnv());
    this.beat.onStartOver = () => this.background.startOver();
    // The device that runs background work keeps each data note's snapshot current, a few seconds
    // after a change and at most every five minutes; what's waiting is written as the program quits.
    this.dataLayer.setSnapshots({
      isRunner: () => this.beat.isRunner(),
      delayMs: SNAPSHOT_DELAY_MS,
      gapMs: SNAPSHOT_GAP_MS,
      later: (fn, ms) => host.later(fn, ms),
      writeNote: (path, fn) => host.writes.writeFrontmatter(path, fn),
    });
  }

  /** The settings in use. */
  get store(): StoredData {
    return this.host.settings.data;
  }

  /** Whether this program writes data.json; gizmod only reads it. */
  get writesSettings(): boolean {
    return this.host.settings.save !== undefined;
  }

  /** Readies the settings: a permission a later Gizmo words differently is kept in both wordings, so nothing allowed asks again. */
  async open(): Promise<void> {
    if (migrateGrants(this.store.grants) && this.writesSettings) await this.saveSettings();
  }

  /**
   * Says this device is there, then starts the background work and keeps both going: a beat and
   * a tick every minute, and a look for sealed kinds due a seal every half hour.
   */
  async start(): Promise<void> {
    await this.beat.beat().catch(() => {});
    if (this.stopped) return;
    await this.background.start();
    if (this.stopped) return;
    this.timers.push(
      this.host.every(() => void this.tick(), TICK_MS),
      this.host.every(() => void this.sealDue().catch(() => {}), SEAL_LOOK_MS),
    );
  }

  /** One beat, then whatever background work is due. */
  async tick(): Promise<void> {
    await this.beat.beat().catch(() => {});
    await this.background.tick();
  }

  /** As the program quits: what's waiting is written, and this device says it's leaving, so another takes over now. */
  async quit(): Promise<void> {
    await this.dataLayer.flushSnapshots();
    await this.beat.leave();
  }

  /** Stops everything it runs. Saying this device left is the caller's (see quit). */
  stop(): void {
    this.stopped = true;
    for (const cancel of this.timers.splice(0)) cancel();
    this.background.stop();
    this.dataLayer.dispose();
  }

  // ---- data.json -------------------------------------------------------------------------------

  /**
   * Writes the settings to data.json: what changed here since they were last read or written, laid
   * over what is on disk now, entry by entry, so what another device saved meanwhile isn't lost.
   */
  saveSettings(): Promise<void> {
    const settings = this.host.settings;
    return settings.save ? settings.save() : Promise.reject(new Error("Gizmo here reads data.json but never writes it"));
  }

  /** data.json changed on disk (a sync from another device): what was allowed there holds here too, and what changed here and isn't saved yet stays. */
  async settingsChanged(): Promise<void> {
    const before = this.store.policy?.hash;
    await this.host.settings.reload();
    if (this.store.policy?.hash !== before) this.background.policyChanged();
    this.grantsChanged();
  }

  // ---- What is allowed -------------------------------------------------------------------------

  /** `opened`: the app must also have been opened in its own tab (see isAllowed); `asked`: under a policy, what it doesn't cover. */
  isGranted(path: string, wanted: string[], opened = false, asked?: string[]): boolean {
    return isGranted(this.store.grants, path, wanted, opened, asked);
  }

  granted(path: string): string[] | undefined {
    return grantedOf(this.store.grants, path);
  }

  async grant(path: string, wanted: string[]): Promise<void> {
    // An app that asks for nothing is granted that each time it draws; only a change is news.
    if (sameGrant(this.store.grants, path, wanted)) return;
    setGrant(this.store.grants, path, wanted);
    await this.saveSettings();
    this.grantsChanged();
  }

  /**
   * Takes back what an app, a block or a lens was allowed: it stops now and asks again when next
   * shown. An app that asks for nothing would be allowed again as its tab draws, so whoever shows it
   * hears so (onRevoke) before anyone hears of the change.
   */
  async revoke(key: string): Promise<void> {
    if (!Object.hasOwn(this.store.grants, key)) return;
    delete this.store.grants[key];
    await this.saveSettings();
    this.background.revoked(key);
    const spec = this.background.spec(key);
    const asksNothing = !!spec && permissionsOf(spec, key).length === 0;
    for (const cb of [...this.revokeListeners]) cb(key, asksNothing);
    this.grantsChanged();
  }

  /** Calls `cb` as something is taken back, before onGrantsChange's; returns how to stop. */
  onRevoke(cb: (key: string, asksNothing: boolean) => void): () => void {
    this.revokeListeners.add(cb);
    return () => this.revokeListeners.delete(cb);
  }

  /** Calls `cb` whenever something is allowed or taken back; returns how to stop. */
  onGrantsChange(cb: () => void): () => void {
    this.grantListeners.add(cb);
    return () => this.grantListeners.delete(cb);
  }

  grantsChanged(): void {
    // A revoked app's figure goes. One paused stays, unshown (see sidebarModel), and every other
    // app's stays: an open tab tells its figure only when it changes, so a cleared one would not return.
    for (const path of [...this.headlines.keys()]) if (grantedOf(this.store.grants, path) === undefined) this.headlines.delete(path);
    for (const cb of [...this.grantListeners]) cb();
  }

  // ---- The data policy -------------------------------------------------------------------------

  /** What the applied data policy says of an app running here; undefined with no policy applied. */
  verdict(
    spec: AppSpec, wanted: string[], where: FlowWhere, policy: Policy | undefined = this.store.policy?.rules,
    notes: NoteReader = this.host.notes, storePath: (store: string, from: string) => string = (s, from) => this.host.storePath(s, from),
  ): Verdict | undefined {
    if (!policy) return undefined;
    return checkFlows(spec, wanted, flowContext(policy, where, notes, storePath, (p) => this.dataLayer.host.tags(p)));
  }

  /** The policy note as it reads now: no note, its errors, or its rules with their fingerprint. */
  readPolicyNote(): { none: true } | { errors: string[] } | { applied: AppliedPolicy } {
    if (!this.host.host.fileInfo(POLICY_PATH)) return { none: true };
    const read = readPolicy(this.host.host.frontmatter(POLICY_PATH));
    return read.policy ? { applied: { hash: policyHash(read.policy), rules: read.policy } } : { errors: read.errors };
  }

  /** Whether the policy note says something other than what was applied. */
  policyPending(): boolean {
    const now = this.readPolicyNote();
    if ("none" in now) return this.store.policy !== undefined;
    return "errors" in now || now.applied.hash !== this.store.policy?.hash;
  }

  /** Uses these rules from now on, or no policy: every app is checked again, here and on devices that sync this. */
  async applyPolicy(applied: AppliedPolicy | undefined): Promise<void> {
    if (applied) this.store.policy = applied;
    else delete this.store.policy;
    await this.saveSettings();
    this.background.policyChanged();
    this.grantsChanged();
  }

  // ---- Keys and other settings -----------------------------------------------------------------

  /** The key a shortcut's copied link carries; with `create`, made and kept when there is none yet (where data.json is written). */
  linkKey(path: string, shortcut: string, create: boolean): string | undefined {
    const keys = (this.store.linkKeys ??= {});
    const id = shortcutId(path, shortcut);
    if (!Object.hasOwn(keys, id) && create && this.writesSettings) {
      keys[id] = newLinkKey();
      void this.saveSettings();
    }
    return Object.hasOwn(keys, id) ? keys[id] : undefined;
  }

  /** A new key for a shortcut's link: links copied before it ask before they run, and send word back nowhere until allowed again. */
  async resetLinkKey(path: string, shortcut: string): Promise<void> {
    (this.store.linkKeys ??= {})[shortcutId(path, shortcut)] = newLinkKey();
    // Where the old key's link was allowed to send word back goes with it.
    delete this.store.answerTo?.[shortcutId(path, shortcut)];
    await this.saveSettings();
  }

  /**
   * A new key for a capture link that runs these names without asking, each only while it still
   * names the same shortcut; kept until revoked.
   */
  async newCaptureKey(targets: { name: string; path: string; shortcut: string }[]): Promise<string> {
    const key = newLinkKey();
    (this.store.captureKeys ??= {})[key] = Object.fromEntries(targets.map((t) => [t.name, shortcutId(t.path, t.shortcut)]));
    await this.saveSettings();
    this.grantsChanged();
    return key;
  }

  /** Takes back a capture link's key: lines it sends ask before they run. */
  async revokeCaptureKey(key: string): Promise<void> {
    if (!this.store.captureKeys || !Object.hasOwn(this.store.captureKeys, key)) return;
    delete this.store.captureKeys[key];
    await this.saveSettings();
    this.grantsChanged();
  }

  /** Keeps what this vault decided about a writer of a shared kind; undefined forgets it. */
  setWriter(kindPath: string, writer: string, record: WriterRecord | undefined): void {
    const all = (this.store.writers ??= {});
    if (record) all[`${kindPath}\n${writer}`] = record;
    else delete all[`${kindPath}\n${writer}`];
    void this.saveSettings();
  }

  /** Lets a shortcut's keyed link send word back to `to` without asking again. */
  allowDestination(path: string, shortcut: string, to: string): void {
    const id = shortcutId(path, shortcut);
    const all = (this.store.answerTo ??= {});
    all[id] = [...new Set([...(all[id] ?? []), to])];
    void this.saveSettings();
  }

  /** Whether the person chose to leave a rename in an app's keys as it is (see renameKey). */
  leftAlone(key: string): boolean {
    return this.store.leftAlone?.[key] === true;
  }

  leaveAlone(key: string): void {
    (this.store.leftAlone ??= {})[key] = true;
    void this.saveSettings();
  }

  /** Whether a lens component is folded away. */
  folded(component: string): boolean {
    return this.store.folded?.[component] === true;
  }

  setFolded(component: string, folded: boolean): void {
    const store = (this.store.folded ??= {});
    if (folded) store[component] = true;
    else delete store[component];
    void this.saveSettings();
  }

  // ---- Activity, headlines and what apps share --------------------------------------------------

  /** Undoes what's left of an entry's changes, newest first, and keeps how far it got. */
  async undo(entry: Entry): Promise<UndoResult> {
    const result = await undoEntry(entry, this.undoIO());
    await this.activity.setUndone(entry.id, result.undone);
    return result;
  }

  /** Undoing: each write re-reads the note as it writes, in line with the apps' own writes to it. */
  private undoIO(): UndoIO {
    const w = this.host.writes;
    return {
      frontmatter: (path) => this.host.host.frontmatter(path),
      updateFrontmatter: (path, fn) => w.updateFrontmatter(path, fn),
      setTaskDone: (path, line, text, done) => w.setTaskDone(path, line, text, done),
      undoEvents: async (dataPath, events) => {
        const ledger = this.dataLayer.ledger;
        if (ledger) await ledgerStore(ledger, dataPath).undo(events);
      },
      processText: (path, fn) => w.processText(path, fn),
      trashIf: (path, unchanged) => w.trashIf(path, unchanged),
    };
  }

  setHeadline(path: string, text: string | undefined): void {
    if (text === this.headlines.get(path)) return;
    if (text === undefined) this.headlines.delete(path);
    else this.headlines.set(path, text);
    for (const cb of [...this.headlineListeners]) cb();
  }

  onHeadline(cb: () => void): () => void {
    this.headlineListeners.add(cb);
    return () => this.headlineListeners.delete(cb);
  }

  /**
   * The data notes an app shares with others: those of the kinds it reads or saves to, and a kind's
   * own. What any app changed there belongs in its activity.
   */
  sharedData(path: string): string[] {
    const fm = this.host.host.frontmatter(path);
    const spec = readSpec(fm, { notes: this.host.notes, path })?.spec;
    return [...(isKind(fm) ? [defaultDataPath(path)] : []), ...(spec ? kindDataPaths(spec.panels) : [])];
  }

  /** The other devices' activity logs, and an old shared one no device took, each named for its device. */
  private async otherActivity(): Promise<{ device: string; text: string }[]> {
    const logs = await otherLogs(this.host.files, this.device.id);
    const old = await this.host.files.file("activity.json").read().catch(() => undefined);
    return old ? [...logs, { device: "another device", text: old }] : logs;
  }

  // ---- The vault changing ----------------------------------------------------------------------

  /** A file changed or appeared. */
  fileChanged(path: string): void {
    this.dataLayer.fileChanged(path);
    // The map says when the policy note no longer matches what was applied.
    if (isPolicyPath(path)) this.grantsChanged();
    this.background.noteChanged(path);
  }

  /**
   * A file went. It may be half of a rename another device made, arriving by sync: what is kept for
   * the app waits (see identity.ts), and data.json isn't written for what another device did.
   */
  fileDeleted(path: string): void {
    this.dataLayer.fileDeleted(path);
    if (isPolicyPath(path)) this.grantsChanged();
  }

  /** A rename made here: everything kept for the app follows it, its data note, its logs and data.json included. */
  fileRenamed(path: string, oldPath: string): void {
    this.dataLayer.fileRenamed(path, oldPath);
    if (isPolicyPath(path) || isPolicyPath(oldPath)) this.grantsChanged();
    if (this.host.host.fileInfo(path)) void this.moveDataNote(path, oldPath).catch(() => {});
    if (this.writesSettings && moveKeys(this.store, oldPath, path)) void this.saveSettings();
    void this.activity.rename(oldPath, path);
    void this.definitions.renamed(oldPath, path);
    this.background.renamed(oldPath, path);
    this.background.noteChanged(path);
  }

  /**
   * A renamed or moved app takes its default data note along; a renamed data note (or store) takes
   * the log its rows are kept in, so the app's data stays attached.
   */
  private async moveDataNote(path: string, oldPath: string): Promise<void> {
    const host = this.host;
    if (!host.rename) return;
    const files = host.host;
    if (runsAsApp(files.frontmatter(path))) {
      const data = defaultDataPath(oldPath);
      if (data !== path && files.fileInfo(data)) await host.rename(data, defaultDataPath(path));
    }
    // Only a folder of log files: a folder of that name may be the person's own.
    const log = logFolder(oldPath);
    if ((files.filesIn?.(log) ?? []).some((p) => logFileParts(p) !== undefined)) await host.rename(log, logFolder(path));
  }

  // ---- Sealed kinds ----------------------------------------------------------------------------

  /** Sealing a kind; with an authority, its hash goes out only once the kind is allowed to send it. */
  sealHost(path: string, wanted: string[], authority: boolean): SealHost {
    return sealHostOf(this.dataLayer.host, !authority || this.isGranted(path, wanted, false));
  }

  /** On the device that runs background work: a seal of each allowed sealed kind whose last seal here is a day old. */
  async sealDue(): Promise<void> {
    if (!this.beat.isRunner()) return;
    const files = this.host.host;
    for (const f of files.markdownFiles()) {
      const k = sealedKind(f.path, files.frontmatter(f.path), this.host.notes);
      if (!k || "why" in k) continue;
      // A kind runs nothing of its own until it is allowed.
      if (this.granted(f.path) === undefined || !this.isGranted(f.path, k.wanted, false)) continue;
      const host = this.sealHost(f.path, k.wanted, k.kind.seal!.authority !== undefined);
      const dataPath = defaultDataPath(f.path);
      if (files.now() - (await lastSealed(host, dataPath, this.device.id)) < SEAL_EVERY_MS) continue;
      await sealNow(host, dataPath, k.kind.seal!, this.device.id, files.now()).catch(() => undefined);
    }
  }

  // ---- The background's env --------------------------------------------------------------------

  private backgroundEnv(): BackgroundEnv {
    const h = this.host;
    const id = h.device.id;
    const fm = (path: string) => h.host.frontmatter(path);
    const writes = this.writesSettings;
    return {
      data: this.dataLayer,
      frontmatter: fm,
      notes: h.notes,
      appPaths: () => h.host.markdownFiles().filter((f) => isApp(fm(f.path)) || isKind(fm(f.path))).map((f) => f.path),
      // Nothing runs in the background until it was opened and allowed in its own tab.
      isGranted: (path, wanted, asked) => this.isGranted(path, wanted, true, asked),
      granted: (path) => this.granted(path),
      policy: () => this.store.policy,
      storePath: (store, from) => h.storePath(store, from),
      actionDeps: (appPath, dataPath, actor) => {
        const io = h.actionIO(appPath);
        if (!io) throw new Error(`can't find ${appPath}`);
        return {
          ...actionDepsOf(io, appPath, dataPath),
          // The run has already written; a log that can't be kept doesn't make it fail.
          log: actor ? (what, changes) => this.activity.add({ app: appPath, actor, what, changes }).then((e) => e?.id, () => undefined) : undefined,
        };
      },
      now: () => new Date(h.host.now()),
      // What alerts already ran for is this device's own: only the device running them writes it.
      triggers: h.files.file(deviceFile(DEVICE_FOLDERS.triggers, id)),
      // An app renamed on another device: what this device keeps of it follows.
      renamed: (from, to) => {
        void this.activity.rename(from, to);
        void this.definitions.renamed(from, to);
      },
      ...(writes && { dropped: (path: string) => { if (dropKeys(this.store, path)) void this.saveSettings(); } }),
      otherTriggers: () => otherTriggers(h.files, id),
      shareState: h.files.file(deviceFile(DEVICE_FOLDERS.share, id)),
      otherShareStates: () => otherShareStates(h.files, id),
      writers: (kindPath) => writersOf(this.store, kindPath),
      // Where data.json is only read, writers are accepted elsewhere.
      ...(writes && { setWriter: (kindPath: string, writer: string, record: WriterRecord | undefined) => this.setWriter(kindPath, writer, record) }),
      linkKey: (path, shortcut, create) => this.linkKey(path, shortcut, create),
      captureKey: (key) => captureNamesOf(this.store, key),
      destinations: (path, shortcut) => destinationsOf(this.store, path, shortcut),
      allowDestination: (path, shortcut, to) => { if (writes) this.allowDestination(path, shortcut, to); },
      logSent: (entry) => void this.activity.add(entry),
      runsBackground: () => this.beat.isRunner(),
      // Another program on this computer tells of alerts; this one beside it would tell twice.
      quietAlerts: () => this.beat.quietHere(),
      // Deadlines mean where the person is: the zone of the device they used last.
      zone: () => this.beat.whereYouAre(),
      sink: h.sink,
    };
  }
}
