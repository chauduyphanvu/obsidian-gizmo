import {
  MarkdownView, Plugin, TFile, WorkspaceLeaf, type ViewState,
} from "obsidian";
import { DataLayer } from "./datalayer.ts";
import { obsidianHost } from "./host.ts";
import { defaultDataPath } from "./store.ts";
import { AppView, VIEW_TYPE } from "./view.ts";

interface StoredData {
  /** Note path → the permissions the user allowed, joined. */
  grants: Record<string, string>;
}

export default class NoteAppsPlugin extends Plugin {
  store: StoredData = { grants: {} };
  /** Shared by every open app: web cache, notes index, change notifications. */
  dataLayer!: DataLayer;
  /** Leaves the user switched to source view, and for which note. */
  private sourceLeaves = new WeakMap<WorkspaceLeaf, string>();
  private unloading = false;

  async onload(): Promise<void> {
    this.store = { grants: {}, ...((await this.loadData()) as Partial<StoredData> | null) };
    this.dataLayer = new DataLayer(obsidianHost(this.app));
    this.registerView(VIEW_TYPE, (leaf) => new AppView(leaf, this));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.dataLayer.fileChanged(file.path)));

    this.routeAppNotes();
    this.app.workspace.onLayoutReady(() => this.openAppsAsApps());
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.dataLayer.fileDeleted(file.path);
      if (!(file.path in this.store.grants)) return;
      delete this.store.grants[file.path];
      void this.saveData(this.store);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.dataLayer.fileRenamed(file.path, oldPath);
      if (file instanceof TFile) void this.moveDataNote(file, oldPath);
      if (!(oldPath in this.store.grants)) return;
      this.store.grants[file.path] = this.store.grants[oldPath];
      delete this.store.grants[oldPath];
      void this.saveData(this.store);
    }));

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
  }

  onunload(): void {
    // Without this, open app tabs turn into empty placeholders when the plugin is turned off.
    this.unloading = true;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const file = (leaf.view as AppView).file;
      if (file) void leaf.setViewState({ type: "markdown", state: { file: file.path } });
    }
  }

  /** A renamed or moved app takes its default data note along, so its recorded data stays attached. */
  private async moveDataNote(app: TFile, oldPath: string): Promise<void> {
    const data = this.app.vault.getFileByPath(defaultDataPath(oldPath));
    const target = defaultDataPath(app.path);
    if (!data || data === app || this.app.vault.getAbstractFileByPath(target)) return;
    await this.app.fileManager.renameFile(data, target);
  }

    isApp(file: TFile): boolean {
    const app = this.app.metadataCache.getFileCache(file)?.frontmatter?.app;
    return app !== undefined && app !== null && app !== false;
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

  async showSource(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    this.sourceLeaves.set(leaf, file.path);
    await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source" }, active: true });
  }

  isGranted(path: string, wanted: string[]): boolean {
    return wanted.length === 0 || this.store.grants[path] === wanted.join("\n");
  }

  granted(path: string): string[] {
    return this.store.grants[path]?.split("\n") ?? [];
  }

  async grant(path: string, wanted: string[]): Promise<void> {
    this.store.grants[path] = wanted.join("\n");
    await this.saveData(this.store);
  }
}
