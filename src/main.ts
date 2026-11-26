import {
  MarkdownView, Platform, Plugin, TFile, WorkspaceLeaf, normalizePath, type ViewState,
} from "obsidian";
import { openActivity, registerActivity } from "./activity-view.ts";
import { registerBacktest, registerWhatIf } from "./past-views.ts";
import { obsidianBeat, obsidianSink, registerBackground } from "./background-glue.ts";
import { registerBases } from "./bases.ts";
import { thisDevice, type DeviceStore } from "./device.ts";
import { registerEmbeds } from "./embed.ts";
import { registerGalleryCommand } from "./gallery-command.ts";
import { SettingsFile } from "./stored.ts";
import {
  adoptOldLog, newNotesFolder, obsidianAppEnv, obsidianHost, obsidianRename, obsidianWrites, pluginFiles, vaultNotes, vaultStorePath, whenIndexed,
} from "./host.ts";
import { registerPolicyCommand } from "./policy-command.ts";
import { registerInsertPanel } from "./insert-command.ts";
import { registerLenses } from "./lens.ts";
import { registerCaptureCommand } from "./capture-command.ts";
import { openNext, registerNextCommand } from "./next-command.ts";
import { registerLinkCommand } from "./link-command.ts";
import { openMap, registerMap } from "./map-view.ts";
import { openHome, registerHome } from "./sidebar-view.ts";
import { registerNewApp } from "./new-app-command.ts";
import { registerKindCommand } from "./kind-command.ts";
import { registerExamples } from "./examples-command.ts";
import { registerSeal } from "./seal-command.ts";
import { registerRowLines } from "./row-lines-sync.ts";
import type { RowLines } from "./row-lines.ts";
import { registerImportCommand } from "./import-command.ts";
import { openAppPicker, registerOpenApp } from "./open-app-command.ts";
import { GizmoRuntime } from "./runtime.ts";
import { GizmoSettings } from "./settings.ts";
import { registerShareCommands } from "./share-command.ts";
import { registerInviteCommands } from "./invite-command.ts";
import { runsAsApp } from "./store.ts";
import { registerAuthoring } from "./suggest.ts";
import { AppView, VIEW_TYPE } from "./view.ts";

export default class GizmoPlugin extends Plugin {
  /** Gizmo itself, as every program that runs it does (see runtime.ts): settings, grants, activity, background work. */
  runtime!: GizmoRuntime;
  /** Where this device keeps its own settings: Obsidian's local storage, per vault and per device. */
  deviceStore!: DeviceStore;
  /** The lines in notes that are rows (see row-lines.ts), kept in step with them; undefined without a ledger. */
  rowLines: RowLines | undefined;
  /** Leaves the user switched to source view, and for which note. */
  private sourceLeaves = new WeakMap<WorkspaceLeaf, string>();
  /** The "Show the app" action in the header of each tab showing an app note's text. */
  private showAppActions = new WeakMap<MarkdownView, HTMLElement>();
  private unloading = false;

  async onload(): Promise<void> {
    // data.json: the settings every device a sync reaches shares, saved by merging (see stored.ts).
    const settings = new SettingsFile({ load: () => this.loadData(), save: (data) => this.saveData(data) });
    await settings.open();
    this.deviceStore = { load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) };
    const device = thisDevice(this.deviceStore, Platform);
    // Each device writes only its own log, which a sync never has to merge; it reads the others'.
    await adoptOldLog(this, device.id).catch(() => {});
    this.runtime = new GizmoRuntime({
      host: obsidianHost(this.app, this.manifest.dir, () => device.id),
      settings,
      files: pluginFiles(this),
      device,
      beat: obsidianBeat(this, device),
      writes: obsidianWrites(this.app),
      notes: vaultNotes(this.app),
      storePath: vaultStorePath(this.app),
      // An env without a tab: actions never ask for the source view, the only thing a leaf is for.
      actionIO: (path) => {
        const file = this.app.vault.getFileByPath(path);
        return file ? obsidianAppEnv(this, undefined, file) : undefined;
      },
      rename: (from, to) => obsidianRename(this.app, from, to),
      newNotesFolder: () => newNotesFolder(this.app),
      exists: (path) => !!this.app.vault.getAbstractFileByPath(normalizePath(path)),
      whenIndexed: (path) => whenIndexed(this.app, path),
      secrets: { get: (id) => this.app.secretStorage.getSecret(id), set: (id, value) => this.app.secretStorage.setSecret(id, value) },
      sink: obsidianSink(this),
      every: (fn, ms) => {
        const id = this.registerInterval(window.setInterval(fn, ms));
        return () => window.clearInterval(id);
      },
      later: (fn, ms) => {
        const id = window.setTimeout(fn, ms);
        return () => window.clearTimeout(id);
      },
    });
    await this.runtime.open();
    // Open app tabs check again what they may do; one asking for nothing closes once taken back, as it would allow itself again.
    this.runtime.onRevoke((key, asksNothing) => {
      if (!asksNothing) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if ((leaf.view as AppView).file?.path === key) leaf.detach();
    });
    this.runtime.onGrantsChange(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as AppView).recheck();
    });
    // As Obsidian quits: what's waiting is written, and this device says it's leaving, so another takes over now.
    this.registerEvent(this.app.workspace.on("quit", (tasks) => tasks.add(() => this.runtime.quit())));
    this.registerView(VIEW_TYPE, (leaf) => new AppView(leaf, this));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.runtime.fileChanged(file.path);
      this.syncShowAppActions();
    }));
    // Notes that change reach the runtime through the metadata event above; any other file only through here.
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension !== "md") this.runtime.fileChanged(file.path);
    }));
    // While a vault loads, every existing file reports as created; only later ones are news.
    this.app.workspace.onLayoutReady(() => this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.runtime.fileChanged(file.path);
    })));
    registerAuthoring(this);

    this.routeAppNotes();
    this.app.workspace.onLayoutReady(() => this.openAppsAsApps());
    this.app.workspace.onLayoutReady(() => this.syncShowAppActions());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncShowAppActions()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncShowAppActions()));
    this.registerEvent(this.app.vault.on("delete", (file) => this.runtime.fileDeleted(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.runtime.fileRenamed(file.path, oldPath)));
    registerEmbeds(this);
    registerLenses(this);
    registerInsertPanel(this);
    registerGalleryCommand(this);
    registerLinkCommand(this);
    registerCaptureCommand(this, () => [
      { name: "Next", run: () => openNext(this) },
      { name: "Gizmo sidebar", run: () => void openHome(this) },
      { name: "Automation map", run: () => void openMap(this) },
      { name: "Activity of every app", run: () => openActivity(this) },
    ]);
    registerNextCommand(this);
    registerPolicyCommand(this);
    registerShareCommands(this);
    registerInviteCommands(this);
    registerOpenApp(this);
    registerNewApp(this);
    registerKindCommand(this);
    registerExamples(this);
    registerSeal(this);
    this.rowLines = registerRowLines(this);
    registerImportCommand(this);
    this.addRibbonIcon("layout-dashboard", "Open an app", () => openAppPicker(this));
    registerActivity(this);
    registerBacktest(this);
    registerWhatIf(this);
    registerMap(this);
    registerHome(this);
    registerBases(this);

    this.addCommand({
      id: "open-as-app",
      name: "Open this note as an app",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || !this.isApp(view.file)) return false;
        if (!checking) void this.showApp(view);
        return true;
      },
    });
    registerBackground(this);
    this.addSettingTab(new GizmoSettings(this.app, this));
  }

  /** `data.json` changed on disk (a sync from another device): what was allowed there holds here too, and what changed here and isn't saved yet stays. */
  onExternalSettingsChange(): Promise<void> {
    return this.runtime.settingsChanged();
  }

  onunload(): void {
    // Turned off: another device takes over background work now.
    void this.runtime?.beat.leave();
    this.runtime?.stop();
    // Without this, open app tabs turn into empty placeholders when the plugin is turned off.
    this.unloading = true;
    this.syncShowAppActions();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const file = (leaf.view as AppView).file;
      if (file) void leaf.setViewState({ type: "markdown", state: { file: file.path } });
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
    const wantsApp = (leaf: WorkspaceLeaf, state: ViewState) => this.wantsApp(leaf, state);
    const proto = WorkspaceLeaf.prototype;
    // Taken off the prototype unbound, as it is there: the wrapper calls it on each leaf.
    const original = Object.getOwnPropertyDescriptor(proto, "setViewState")!.value as WorkspaceLeaf["setViewState"];
    const wrapper = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
      const next = wantsApp(this, state) ? { ...state, type: VIEW_TYPE } : state;
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
   * Shows an app note's YAML as text for the app shown in `from`: in a tab already showing the
   * note's text, else in a new one beside the app, which stays in view and redraws as each edit is
   * saved. A phone has no room beside it, so there the app's own tab turns into the source; an app
   * in a sidebar gets its source in a tab of the main area. Gives the tab the source is in.
   */
  async editSource(from: WorkspaceLeaf, file: TFile): Promise<WorkspaceLeaf> {
    const { workspace } = this.app;
    const open = workspace.getLeavesOfType("markdown").find((l) => {
      const { state } = l.getViewState();
      return state?.file === file.path && state.mode === "source";
    });
    if (open) {
      await workspace.revealLeaf(open);
      if (open.getViewState().state?.source !== true) await this.showSource(open, file);
      workspace.setActiveLeaf(open, { focus: true });
      return open;
    }
    const root = from.getRoot();
    const leaf = Platform.isPhone ? from
      : root === workspace.leftSplit || root === workspace.rightSplit ? workspace.getLeaf("tab")
      : workspace.createLeafBySplit(from, "vertical");
    await this.showSource(leaf, file);
    return leaf;
  }

  /**
   * Shows the note's source for the app in `from`, as editSource does, with the cursor on a line,
   * at its start or at `ch`, scrolled into view.
   */
  async showSourceAt(from: WorkspaceLeaf, file: TFile, line: number, ch = 0): Promise<void> {
    const leaf = await this.editSource(from, file);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    // The editor may still be loading the note's text.
    for (let tries = 0; tries < 20 && view.editor.lineCount() <= line; tries++) await new Promise((r) => window.setTimeout(r, 50));
    const at = { line, ch };
    view.editor.setCursor(at);
    view.editor.scrollIntoView({ from: at, to: at }, true);
    view.editor.focus();
  }

  /**
   * From a tab showing an app note's text: back to the app when another tab shows it (beside it, as
   * Edit source leaves it), closing this one; else this tab shows the app.
   */
  private async showApp(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file || !this.isApp(file)) return;
    const { workspace } = this.app;
    const shown = workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.getViewState().state?.file === file.path);
    if (shown) {
      view.leaf.detach();
      await workspace.revealLeaf(shown);
      workspace.setActiveLeaf(shown, { focus: true });
      return;
    }
    this.sourceLeaves.delete(view.leaf);
    await view.leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
  }

  /**
   * Gives each tab showing an app note's text (Source mode, Live Preview or Reading) a "Show the app"
   * action, once, and takes it from a tab whose note isn't an app, or no longer is.
   */
  private syncShowAppActions(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const wanted = !this.unloading && !!view.file && this.isApp(view.file);
      const action = this.showAppActions.get(view);
      if (wanted && !action) {
        this.showAppActions.set(view, view.addAction("layout-dashboard", "Show the app", () => void this.showApp(view)));
      } else if (!wanted && action) {
        action.remove();
        this.showAppActions.delete(view);
      }
    }
  }
}
