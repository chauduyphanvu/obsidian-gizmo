import { FileView, type Menu, type TFile, type WorkspaceLeaf } from "obsidian";
import { AppController } from "./app.ts";
import { obsidianAppEnv } from "./host.ts";
import { openActivity } from "./activity-view.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";

export const VIEW_TYPE = "gizmo";

/** The tab an app note opens in. All the work happens in its AppController. */
export class AppView extends FileView {
  private plugin: GizmoPlugin;
  private controller: AppController | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: GizmoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Gizmo"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    this.addAction("file-code", "Edit source", () => this.file && this.plugin.showSource(this.leaf, this.file));
    this.addAction("search-code", "Inspect data", () => void this.controller?.toggleInspector());
    this.addAction("refresh-cw", "Reload data", () => this.controller?.reload());
    this.addAction("history", "Activity", () => this.file && openActivity(this.plugin, this.file.path));
  }

  /**
   * The tab's menu offers the link to each of this app's shortcuts. A link's key is made when one
   * is copied, not when the menu opens, so opening it never writes the plugin's settings.
   */
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    const path = this.file?.path;
    const bg = this.plugin.background;
    const app = bg?.list().find((a) => a.path === path);
    for (const s of app?.shortcuts ?? []) {
      menu.addItem((item) => item.setTitle(`Copy link: ${s.label}`).setIcon("link").setSection("action").onClick(() => {
        const link = bg?.shortcutLinks().find((l) => l.path === path && l.shortcut === s.id);
        if (link) copyShortcutLink(link);
      }));
    }
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

  /** Looks again at whether the app is allowed, after a grant changed somewhere else. */
  recheck(): void {
    this.controller?.recheck();
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
