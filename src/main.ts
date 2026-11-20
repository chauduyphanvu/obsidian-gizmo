import {
  MarkdownView, Plugin, TFile, WorkspaceLeaf, type ViewState,
} from "obsidian";
import { ActivityLog, undoEntry, type Entry, type UndoResult } from "./activity.ts";
import { registerActivity } from "./activity-view.ts";
import { registerBackground } from "./background-glue.ts";
import { DataLayer } from "./datalayer.ts";
import { registerEmbeds } from "./embed.ts";
import { registerGalleryCommand } from "./gallery-command.ts";
import { dropGrants, grantedOf, isAllowed, moveGrants, setGrant } from "./grants.ts";
import { obsidianHost, obsidianUndoIO, pluginFile } from "./host.ts";
import { registerInsertPanel } from "./insert-command.ts";
import { registerLenses } from "./lens.ts";
import { registerLinkCommand } from "./link-command.ts";
import { newLinkKey } from "./links.ts";
import { registerShareCommands } from "./share-command.ts";
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
}

export default class GizmoPlugin extends Plugin {
  store: StoredData = { grants: {} };
  /** Shared by every open app: web cache, notes index, change notifications. */
  dataLayer!: DataLayer;
  /** Works for allowed apps while their notes are closed: records, shortcuts, status bar, alerts. */
  background: ReturnType<typeof registerBackground> | undefined;
  /** What every app changed in the vault, kept in the plugin's folder so it can be shown and undone. */
  activity!: ActivityLog;
  /** Leaves the user switched to source view, and for which note. */
  private sourceLeaves = new WeakMap<WorkspaceLeaf, string>();
  private unloading = false;

  async onload(): Promise<void> {
    this.store = { grants: {}, ...((await this.loadData()) as Partial<StoredData> | null) };
    this.dataLayer = new DataLayer(obsidianHost(this.app, this.manifest.dir));
    this.activity = new ActivityLog(pluginFile(this, "activity.json"));
    this.registerView(VIEW_TYPE, (leaf) => new AppView(leaf, this));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.dataLayer.fileChanged(file.path)));
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
      const dropped = dropGrants(this.store.grants, file.path);
      if (dropGrants(this.store.linkKeys ?? {}, file.path) || dropped) void this.saveData(this.store);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.dataLayer.fileRenamed(file.path, oldPath);
      if (file instanceof TFile) void this.moveDataNote(file, oldPath);
      const moved = moveGrants(this.store.grants, oldPath, file.path);
      if (moveGrants(this.store.linkKeys ?? {}, oldPath, file.path) || moved) void this.saveData(this.store);
      void this.activity.rename(oldPath, file.path);
    }));
    registerEmbeds(this);
    registerLenses(this);
    registerInsertPanel(this);
    registerGalleryCommand(this);
    registerLinkCommand(this);
    registerShareCommands(this);
    registerActivity(this);

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

  /** A renamed or moved app takes its default data note along, so its recorded data stays attached. */
  private async moveDataNote(app: TFile, oldPath: string): Promise<void> {
    const data = this.app.vault.getFileByPath(defaultDataPath(oldPath));
    const target = defaultDataPath(app.path);
    if (!data || data === app || this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(data, target);
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

  /** `opened`: the app must also have been opened in its own tab (see isAllowed). */
  isGranted(path: string, wanted: string[], opened = false): boolean {
    return isAllowed(this.store.grants, path, wanted, opened);
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
    setGrant(this.store.grants, path, wanted);
    await this.saveData(this.store);
  }
}
