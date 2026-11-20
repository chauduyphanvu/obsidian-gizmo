import {
  MarkdownView, Platform, Plugin, TFile, WorkspaceLeaf, type ViewState,
} from "obsidian";
import { ActivityLog, undoEntry, type Entry, type UndoResult } from "./activity.ts";
import { registerActivity } from "./activity-view.ts";
import { registerBacktest } from "./past-views.ts";
import { registerBackground } from "./background-glue.ts";
import { registerBases } from "./bases.ts";
import { DataLayer } from "./datalayer.ts";
import { thisDevice, type Device, type DeviceStore } from "./device.ts";
import { registerEmbeds } from "./embed.ts";
import { registerGalleryCommand } from "./gallery-command.ts";
import { checkFlows, flowContext, type FlowWhere, type Verdict } from "./flows.ts";
import { grantedOf, isAllowed, isAllowedUnder, migrateGrants, sameGrant, setGrant } from "./grants.ts";
import { moveKeys } from "./identity.ts";
import { mergeSettings, type StoredData } from "./stored.ts";
import { obsidianHost, obsidianUndoIO, obsidianWrites, pluginFile, vaultFrontmatter, vaultNotes, vaultStorePath } from "./host.ts";
import { POLICY_PATH, isPolicyPath, policyHash, readPolicy, type AppliedPolicy, type Policy } from "./policy.ts";
import { registerPolicyCommand } from "./policy-command.ts";
import type { AppSpec } from "./spec.ts";
import type { NoteReader } from "./expand.ts";
import { registerInsertPanel } from "./insert-command.ts";
import { registerLenses } from "./lens.ts";
import type { LensIndex } from "./lenses.ts";
import { registerCaptureCommand } from "./capture-command.ts";
import { registerLinkCommand } from "./link-command.ts";
import { registerMap } from "./map-view.ts";
import { newLinkKey } from "./links.ts";
import { DeviceBeat, GizmoSettings, adoptOldLog, devicesSeen, otherLogs } from "./settings.ts";
import { registerShareCommands } from "./share-command.ts";
import { permissionsOf } from "./permissions.ts";
import { defaultDataPath, runsAsApp } from "./store.ts";
import { logFileParts, logFolder } from "./ledger.ts";
import { registerAuthoring } from "./suggest.ts";
import { AppView, VIEW_TYPE } from "./view.ts";

export default class GizmoPlugin extends Plugin {
  store: StoredData = { grants: {} };
  /** Shared by every open app: web cache, notes index, change notifications. */
  dataLayer!: DataLayer;
  /** Works for allowed apps while their notes are closed: records, shortcuts, status bar, alerts. */
  background: ReturnType<typeof registerBackground> | undefined;
  /** What every app changed in the vault, kept in the plugin's folder so it can be shown and undone. */
  activity!: ActivityLog;
  /** Which lenses show on which notes. */
  lenses!: LensIndex;
  /** This device, kept on it alone (see device.ts). */
  device!: Device;
  deviceStore!: DeviceStore;
  beat: DeviceBeat | undefined;
  private grantListeners = new Set<() => void>();
  /** Leaves the user switched to source view, and for which note. */
  private sourceLeaves = new WeakMap<WorkspaceLeaf, string>();
  private unloading = false;
  /** The settings as last read from or written to data.json: what a save tells this device's changes by. */
  private settingsBase: StoredData = { grants: {} };
  /** Saves and reloads of data.json, one after another. */
  private settingsQueue: Promise<unknown> = Promise.resolve();

  async onload(): Promise<void> {
    this.store = await this.readSettings();
    this.settingsBase = structuredClone(this.store);
    // A permission a later Gizmo words differently is kept in both wordings, so nothing allowed asks again.
    if (migrateGrants(this.store.grants)) await this.saveSettings();
    this.dataLayer = new DataLayer(obsidianHost(this.app, this.manifest.dir, () => this.device.id));
    this.deviceStore = { load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) };
    this.device = thisDevice(this.deviceStore, Platform);
    // Each device writes only its own log, which a sync never has to merge; it reads the others'.
    await adoptOldLog(this).catch(() => {});
    this.activity = new ActivityLog(pluginFile(this, `activity/${this.device.id}.json`), Date.now, () => otherLogs(this));
    // The device that runs background work keeps each data note's snapshot current, a few seconds after
    // a change and at most every five minutes; what's waiting is written before Obsidian quits.
    this.dataLayer.setSnapshots({
      isRunner: () => this.beat?.isRunner() ?? false,
      delayMs: 5000,
      gapMs: 5 * 60_000,
      writeNote: (path, fn) => obsidianWrites(this.app).writeFrontmatter(path, fn),
    });
    this.registerEvent(this.app.workspace.on("quit", (tasks) => tasks.add(() => this.dataLayer.flushSnapshots())));
    this.registerView(VIEW_TYPE, (leaf) => new AppView(leaf, this));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.dataLayer.fileChanged(file.path);
      // The map says when the policy note no longer matches what was applied.
      if (isPolicyPath(file.path)) this.grantsChanged();
    }));
    // Notes that change reach the data layer through the metadata event above; any other file only through here.
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension !== "md") this.dataLayer.fileChanged(file.path);
    }));
    // While a vault loads, every existing file reports as created; only later ones are news.
    this.app.workspace.onLayoutReady(() => this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.dataLayer.fileChanged(file.path);
    })));
    registerAuthoring(this);

    this.routeAppNotes();
    this.app.workspace.onLayoutReady(() => this.openAppsAsApps());
    // A delete may be half of a rename another device made, arriving by sync: what is kept for the
    // app waits (see identity.ts), and data.json isn't written for what another device did.
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.dataLayer.fileDeleted(file.path);
      if (isPolicyPath(file.path)) this.grantsChanged();
    }));
    // A rename made here: everything kept for the app follows it, data.json included.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.dataLayer.fileRenamed(file.path, oldPath);
      if (isPolicyPath(file.path) || isPolicyPath(oldPath)) this.grantsChanged();
      if (file instanceof TFile) void this.moveDataNote(file, oldPath);
      if (moveKeys(this.store, oldPath, file.path)) void this.saveSettings();
      void this.activity.rename(oldPath, file.path);
      this.background?.renamed(oldPath, file.path);
    }));
    registerEmbeds(this);
    this.lenses = registerLenses(this);
    registerInsertPanel(this);
    registerGalleryCommand(this);
    registerLinkCommand(this);
    registerCaptureCommand(this);
    registerPolicyCommand(this);
    registerShareCommands(this);
    registerActivity(this);
    registerBacktest(this);
    registerMap(this);
    registerBases(this);

    this.addCommand({
      id: "open-as-app",
      name: "Open this note as an app",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || !this.isApp(view.file)) return false;
        if (!checking) {
          this.sourceLeaves.delete(view.leaf);
          void view.leaf.setViewState({ type: VIEW_TYPE, state: { file: view.file.path } });
        }
        return true;
      },
    });
    this.background = registerBackground(this);
    this.addSettingTab(new GizmoSettings(this.app, this));
  }

  /** `data.json` changed on disk (a sync from another device): what was allowed there holds here too, and what changed here and isn't saved yet stays. */
  async onExternalSettingsChange(): Promise<void> {
    const before = this.store.policy?.hash;
    await this.queueSettings(async () => {
      const disk = await this.readSettings();
      this.store = mergeSettings(this.settingsBase, disk, this.store);
      this.settingsBase = disk;
    });
    if (this.store.policy?.hash !== before) this.background?.policyChanged();
    this.grantsChanged();
  }

  /**
   * Writes the settings to data.json: what changed here since they were last read or written, laid
   * over what is on disk now, entry by entry, so what another device saved meanwhile isn't lost.
   */
  saveSettings(): Promise<void> {
    return this.queueSettings(async () => {
      const local = structuredClone(this.store);
      const merged = mergeSettings(this.settingsBase, await this.readSettings(), local);
      await this.saveData(merged);
      this.settingsBase = structuredClone(merged);
      // What changed here while this was written stays; what came from disk comes in.
      this.store = mergeSettings(local, merged, this.store);
    });
  }

  /** data.json as it is on disk; one that can't be read (a sync caught mid-write) counts as unchanged since last read. */
  private async readSettings(): Promise<StoredData> {
    try {
      return { grants: {}, ...((await this.loadData()) as Partial<StoredData> | null) };
    } catch {
      return structuredClone(this.settingsBase);
    }
  }

  private queueSettings(fn: () => Promise<void>): Promise<void> {
    const run = this.settingsQueue.then(fn, fn);
    this.settingsQueue = run.catch(() => {});
    return run;
  }

  onunload(): void {
    this.dataLayer?.dispose();
    // Without this, open app tabs turn into empty placeholders when the plugin is turned off.
    this.unloading = true;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const file = (leaf.view as AppView).file;
      if (file) void leaf.setViewState({ type: "markdown", state: { file: file.path } });
    }
  }

  /** Undoes what's left of an entry's changes, newest first, and keeps how far it got. */
  async undo(entry: Entry): Promise<UndoResult> {
    const result = await undoEntry(entry, obsidianUndoIO(this));
    await this.activity.setUndone(entry.id, result.undone);
    return result;
  }

  /**
   * A renamed or moved app takes its default data note along; a renamed data note (or store) takes
   * the log its rows are kept in, so the app's data stays attached.
   */
  private async moveDataNote(file: TFile, oldPath: string): Promise<void> {
    const vault = this.app.vault;
    if (this.isApp(file)) {
      const data = vault.getFileByPath(defaultDataPath(oldPath));
      const target = defaultDataPath(file.path);
      if (data && data !== file && !vault.getAbstractFileByPath(target)) await this.app.fileManager.renameFile(data, target);
    }
    // Only a folder of log files: a folder of that name may be the person's own.
    const log = vault.getFolderByPath(logFolder(oldPath));
    const logTarget = logFolder(file.path);
    const holdsLogs = log?.children.some((c) => c instanceof TFile && logFileParts(c.path) !== undefined);
    if (log && holdsLogs && !vault.getAbstractFileByPath(logTarget)) {
      const parent = logTarget.slice(0, logTarget.lastIndexOf("/"));
      if (!vault.getAbstractFileByPath(parent)) await vault.createFolder(parent);
      await this.app.fileManager.renameFile(log, logTarget);
    }
  }

  /** Notes that open as apps: apps, and components (which show how to use them). */
  isApp(file: TFile): boolean {
    return runsAsApp(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  /** Whether a leaf about to show this markdown state should show the app instead. */
  private wantsApp(leaf: WorkspaceLeaf, state: ViewState): boolean {
    const path = state.state?.file;
    if (this.unloading || state.type !== "markdown" || typeof path !== "string") return false;
    const forced = this.sourceLeaves.get(leaf);
    if (forced === path) return false;
    if (forced) this.sourceLeaves.delete(leaf);
    const file = this.app.vault.getFileByPath(path);
    return !!file && this.isApp(file);
  }

  /**
   * Every way of opening a note (links, history, quick switcher, layout restore) ends in
   * setViewState, so app notes are routed to the app view there.
   */
  private routeAppNotes(): void {
    const plugin = this;
    const proto = WorkspaceLeaf.prototype;
    const original = proto.setViewState;
    const wrapper = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
      const next = plugin.wantsApp(this, state) ? { ...state, type: VIEW_TYPE } : state;
      return original.call(this, next, eState);
    };
    proto.setViewState = wrapper;
    // If another plugin wrapped setViewState after us, putting ours back would drop theirs;
    // our wrapper then stays in place and passes everything through once `unloading` is set.
    this.register(() => { if (proto.setViewState === wrapper) proto.setViewState = original; });
  }

  /** For markdown views already open when the plugin loads. */
  private openAppsAsApps(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const forced = this.sourceLeaves.get(leaf);
      if (forced === view.file.path) return;
      if (forced) this.sourceLeaves.delete(leaf);
      if (this.isApp(view.file)) {
        void leaf.setViewState({ type: VIEW_TYPE, state: { file: view.file.path }, active: leaf === this.app.workspace.getMostRecentLeaf() });
      }
    });
  }

  /** Shows the YAML as text: in Live Preview the frontmatter is a properties table, which can't edit nested `panels`. */
  async showSource(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    this.sourceLeaves.set(leaf, file.path);
    await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source", source: true }, active: true });
  }

  /**
   * Shows the note's source with the cursor at the start of a line, which is scrolled into view.
   */
  async showSourceAt(leaf: WorkspaceLeaf, file: TFile, line: number): Promise<void> {
    await this.showSource(leaf, file);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    // The editor may still be loading the note's text.
    for (let tries = 0; tries < 20 && view.editor.lineCount() <= line; tries++) await new Promise((r) => window.setTimeout(r, 50));
    const at = { line, ch: 0 };
    view.editor.setCursor(at);
    view.editor.scrollIntoView({ from: at, to: at }, true);
    view.editor.focus();
  }

  /** `opened`: the app must also have been opened in its own tab (see isAllowed); `asked`: under a policy, what it doesn't cover. */
  isGranted(path: string, wanted: string[], opened = false, asked?: string[]): boolean {
    return asked ? isAllowedUnder(this.store.grants, path, asked, opened) : isAllowed(this.store.grants, path, wanted, opened);
  }

  /** What the applied data policy says of an app running here; undefined with no policy applied. */
  verdict(
    spec: AppSpec, wanted: string[], where: FlowWhere, policy: Policy | undefined = this.store.policy?.rules,
    notes: NoteReader = vaultNotes(this.app), storePath: (store: string, from: string) => string = vaultStorePath(this.app),
  ): Verdict | undefined {
    if (!policy) return undefined;
    return checkFlows(spec, wanted, flowContext(policy, where, notes, storePath, (p) => this.dataLayer.host.tags(p)));
  }

  /** The policy note as it reads now: no note, its errors, or its rules with their fingerprint. */
  readPolicyNote(): { none: true } | { errors: string[] } | { applied: AppliedPolicy } {
    if (!this.app.vault.getFileByPath(POLICY_PATH)) return { none: true };
    const read = readPolicy(vaultFrontmatter(this.app)(POLICY_PATH));
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
    this.background?.policyChanged();
    this.grantsChanged();
  }

  granted(path: string): string[] | undefined {
    return grantedOf(this.store.grants, path);
  }

  /** The key a shortcut's copied link carries; with `create`, made and kept when there is none yet. */
  linkKey(path: string, shortcut: string, create: boolean): string | undefined {
    const keys = (this.store.linkKeys ??= {});
    const id = `${path}#${shortcut}`;
    if (!Object.hasOwn(keys, id) && create) {
      keys[id] = newLinkKey();
      void this.saveSettings();
    }
    return Object.hasOwn(keys, id) ? keys[id] : undefined;
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
   * shown. An app that asks for nothing is allowed again whenever its tab draws, so its tabs close.
   */
  async revoke(key: string): Promise<void> {
    if (!Object.hasOwn(this.store.grants, key)) return;
    delete this.store.grants[key];
    await this.saveSettings();
    this.background?.revoked(key);
    const spec = this.background?.spec(key);
    if (spec && permissionsOf(spec, key).length === 0) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if ((leaf.view as AppView).file?.path === key) leaf.detach();
    }
    this.grantsChanged();
  }

  /** A new key for a shortcut's link: links copied before it ask before they run, and send word back nowhere until allowed again. */
  async resetLinkKey(path: string, shortcut: string): Promise<void> {
    (this.store.linkKeys ??= {})[`${path}#${shortcut}`] = newLinkKey();
    // Where the old key's link was allowed to send word back goes with it.
    delete this.store.answerTo?.[`${path}#${shortcut}`];
    await this.saveSettings();
  }

  /**
   * A new key for a capture link that runs these names without asking, each only while it still
   * names the same shortcut; kept until revoked.
   */
  async newCaptureKey(targets: { name: string; path: string; shortcut: string }[]): Promise<string> {
    const key = newLinkKey();
    (this.store.captureKeys ??= {})[key] = Object.fromEntries(targets.map((t) => [t.name, `${t.path}#${t.shortcut}`]));
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

  /** Calls `cb` whenever something is allowed or taken back; returns how to stop. */
  onGrantsChange(cb: () => void): () => void {
    this.grantListeners.add(cb);
    return () => this.grantListeners.delete(cb);
  }

  grantsChanged(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as AppView).recheck();
    for (const cb of [...this.grantListeners]) cb();
  }
}
