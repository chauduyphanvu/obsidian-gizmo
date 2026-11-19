import { FileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { AppController } from "./app.ts";
import { obsidianAppEnv } from "./host.ts";
import type NoteAppsPlugin from "./main.ts";

export const VIEW_TYPE = "note-app";

/** The tab an app note opens in. All the work happens in its AppController. */
export class AppView extends FileView {
  private plugin: NoteAppsPlugin;
  private controller: AppController | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: NoteAppsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Note app"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    this.addAction("file-code", "Edit source", () => this.file && this.plugin.showSource(this.leaf, this.file));
    this.addAction("search-code", "Inspect data", () => void this.controller?.toggleInspector());
    this.addAction("refresh-cw", "Reload data", () => this.controller?.reload());
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.start(file);
  }

  async onUnloadFile(): Promise<void> {
    this.stop();
  }

  /** Obsidian calls this for every renamed file, not only this view's. */
  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    if (file !== this.file) return;
    this.stop();
    this.start(file);
  }

  async onClose(): Promise<void> {
    this.stop();
  }

  onResize(): void {
    this.controller?.resize();
  }

  private start(file: TFile): void {
    this.controller = new AppController(this.contentEl, file.path, obsidianAppEnv(this.plugin, this.leaf, file));
    this.controller.load();
  }

  private stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.contentEl.empty();
  }
}
