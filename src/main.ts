import {
  MarkdownView, Platform, Plugin, TFile, WorkspaceLeaf, type ViewState,
} from "obsidian";
import { ActivityLog, undoEntry, type Entry, type UndoResult } from "./activity.ts";
import { registerActivity } from "./activity-view.ts";
import { registerBackground } from "./background-glue.ts";
import { registerBases } from "./bases.ts";
import { DataLayer } from "./datalayer.ts";
import { thisDevice, type Device, type DeviceStore } from "./device.ts";
import { registerEmbeds } from "./embed.ts";
import { registerGalleryCommand } from "./gallery-command.ts";
import { checkFlows, flowContext, type FlowWhere, type Verdict } from "./flows.ts";
import { dropGrants, grantedOf, isAllowed, isAllowedUnder, moveGrants, setGrant } from "./grants.ts";
import { obsidianHost, obsidianUndoIO, pluginFile, vaultFrontmatter, vaultNotes, vaultStorePath } from "./host.ts";
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
import { registerAuthoring } from "./suggest.ts";
import { AppView, VIEW_TYPE } from "./view.ts";

interface StoredData {
  /** Note path → the permissions the user allowed; empty for an app opened that asks for none. */
  grants: Record<string, string[]>;
  /** Lens component paths the user folded away. */
  folded?: Record<string, true>;
  /** `<app path>#<shortcut>` → the key that shortcut's copied link carries. */
  linkKeys?: Record<string, string>;
  /** `<app path>#<shortcut>` → the apps (`scheme://host`) its keyed link may send word back to without asking. */
  answerTo?: Record<string, string[]>;
  /** A capture link's key → each capture name it may run without asking, with the `<app path>#<shortcut>` it named then. */
  captureKeys?: Record<string, Record<string, string>>;
  /** The data policy as last applied: until Apply, an edited policy note changes nothing. */
  policy?: AppliedPolicy;
}

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

  async onload(): Promise<void> {
    this.store = { grants: {}, ...((await this.loadData()) as Partial<StoredData> | null) };
    this.dataLayer = new DataLayer(obsidianHost(this.app, this.manifest.dir));
    this.deviceStore = { load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) };
    this.device = thisDevice(this.deviceStore, Platform, (await devicesSeen(this).catch(() => [])).some((s) => s.background));
    // Each device writes only its own log, which a sync never has to merge; it reads the others'.
    await adoptOldLog(this).catch(() => {});
    this.activity = new ActivityLog(pluginFile(this, `activity/${this.device.id}.json`), Date.now, () => otherLogs(this));
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
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.dataLayer.fileDeleted(file.path);
      if (isPolicyPath(file.path)) this.grantsChanged();
      const dropped = [this.store.grants, this.store.linkKeys ?? {}, this.store.answerTo ?? {}].map((m: Record<string, unknown>) => dropGrants(m, file.path));
      if (dropped.some(Boolean)) void this.saveData(this.store);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.dataLayer.fileRenamed(file.path, oldPath);
      if (isPolicyPath(file.path) || isPolicyPath(oldPath)) this.grantsChanged();
      if (file instanceof TFile) void this.moveDataNote(file, oldPath);
      const moved = [this.store.grants, this.store.linkKeys ?? {}, this.store.answerTo ?? {}].map((m: Record<string, unknown>) => moveGrants(m, oldPath, file.path));
      if (moved.some(Boolean)) void this.saveData(this.store);
      void this.activity.rename(oldPath, file.path);
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

  /** `data.json` changed on disk (a sync from another device): what was allowed there holds here too. */
  async onExternalSettingsChange(): Promise<void> {
    const before = this.store.policy?.hash;
    this.store = { grants: {}, ...((await this.loadData()) as Partial<StoredData> | null) };
    if (this.store.policy?.hash !== before) this.background?.policyChanged();
    this.grantsChanged();
  }

  onunload(): void {
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
   * A renamed or moved app takes its default data note along, and the folder of its devices' notes
   * (devices: split), so its recorded data stays attached.
   */
  private async moveDataNote(app: TFile, oldPath: string): Promise<void> {
    const vault = this.app.vault;
    const data = vault.getFileByPath(defaultDataPath(oldPath));
    const target = defaultDataPath(app.path);
    if (data && data !== app && !vault.getAbstractFileByPath(target)) await this.app.fileManager.renameFile(data, target);
    // Only a split app's own folder of device notes: a folder of the same name may be the person's.
    const fm = this.app.metadataCache.getFileCache(app)?.frontmatter;
    if (fm?.devices !== "split" || fm.store) return;
    const folder = vault.getFolderByPath(defaultDataPath(oldPath).replace(/\.md$/i, ""));
    const folderTarget = target.replace(/\.md$/i, "");
    const holdsDevices = folder?.children.some((c) => c instanceof TFile && typeof this.app.metadataCache.getFileCache(c)?.frontmatter?.device === "string");
    if (folder && holdsDevices && !vault.getAbstractFileByPath(folderTarget)) await this.app.fileManager.renameFile(folder, folderTarget);
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
    return asked ? isAllowedUnder(this.store.grants, path, wanted, asked, opened) : isAllowed(this.store.grants, path, wanted, opened);
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
    await this.saveData(this.store);
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
      void this.saveData(this.store);
    }
    return Object.hasOwn(keys, id) ? keys[id] : undefined;
  }

  async grant(path: string, wanted: string[]): Promise<void> {
    // An app that asks for nothing is granted that each time it draws; only a change is news.
    if (isAllowed(this.store.grants, path, wanted, true)) return;
    setGrant(this.store.grants, path, wanted);
    await this.saveData(this.store);
    this.grantsChanged();
  }

  /**
   * Takes back what an app, a block or a lens was allowed: it stops now and asks again when next
   * shown. An app that asks for nothing is allowed again whenever its tab draws, so its tabs close.
   */
  async revoke(key: string): Promise<void> {
    if (!Object.hasOwn(this.store.grants, key)) return;
    delete this.store.grants[key];
    await this.saveData(this.store);
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
    await this.saveData(this.store);
  }

  /**
   * A new key for a capture link that runs these names without asking, each only while it still
   * names the same shortcut; kept until revoked.
   */
  async newCaptureKey(targets: { name: string; path: string; shortcut: string }[]): Promise<string> {
    const key = newLinkKey();
    (this.store.captureKeys ??= {})[key] = Object.fromEntries(targets.map((t) => [t.name, `${t.path}#${t.shortcut}`]));
    await this.saveData(this.store);
    this.grantsChanged();
    return key;
  }

  /** Takes back a capture link's key: lines it sends ask before they run. */
  async revokeCaptureKey(key: string): Promise<void> {
    if (!this.store.captureKeys || !Object.hasOwn(this.store.captureKeys, key)) return;
    delete this.store.captureKeys[key];
    await this.saveData(this.store);
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
