import { FileView, type Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { AppController } from "./app.ts";
import { EditSession } from "./backtest.ts";
import { obsidianAppEnv } from "./host.ts";
import { openActivity } from "./activity-view.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";
import { AsOfModal, BacktestModal } from "./past-views.ts";
import { pastEnv } from "./replay.ts";

export const VIEW_TYPE = "gizmo";

/** The tab an app note opens in. All the work happens in its AppController. */
export class AppView extends FileView {
  private plugin: GizmoPlugin;
  private controller: AppController | undefined;
  /** Shown as it was at this time (ms), read only; undefined for now. */
  private past: number | undefined;
  private shownPast: number | undefined;
  /** The definition this editing session started from, for "Backtest this change". */
  private session = new EditSession();

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
    this.addAction("clock", "As of…", () => new AsOfModal(this.app, (at) => this.showAt(at)).open());
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (f === this.file) this.session.seen(this.app.metadataCache.getFileCache(f)?.frontmatter, Date.now());
    }));
  }

  /** A view opened with `past` in its state shows the app as it was then. It isn't kept with the workspace. */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const past = (state as { past?: unknown } | undefined)?.past;
    this.past = typeof past === "number" ? past : undefined;
    await super.setState(state, result);
    if (this.file && this.controller && this.shownPast !== this.past) this.showAt(this.past);
  }

  /** Shows the app as it was at a time, or as it is now. */
  showAt(at: number | undefined): void {
    this.past = at;
    if (!this.file) return;
    this.stop();
    this.start(this.file);
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
    if (path && this.past === undefined) {
      if (this.session.changed()) {
        const before = this.session.before;
        menu.addItem((item) => item.setTitle("Backtest this change").setIcon("history").setSection("action").onClick(() => new BacktestModal(this.plugin, path, before).open()));
      }
      menu.addItem((item) => item.setTitle("Backtest this app").setIcon("history").setSection("action").onClick(() => new BacktestModal(this.plugin, path).open()));
    }
    for (const s of app?.shortcuts ?? []) {
      menu.addItem((item) => item.setTitle(`Copy link: ${s.label}`).setIcon("link").setSection("action").onClick(() => {
        const link = bg?.shortcutLinks().find((l) => l.path === path && l.shortcut === s.id);
        if (link) copyShortcutLink(link);
      }));
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.session = new EditSession();
    this.session.seen(this.app.metadataCache.getFileCache(file)?.frontmatter, Date.now());
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
    const live = obsidianAppEnv(this.plugin, this.leaf, file);
    const env = this.past === undefined ? live : pastEnv(live, this.past, () => this.showAt(undefined));
    this.shownPast = this.past;
    this.controller = new AppController(this.contentEl, file.path, env);
    this.controller.load();
  }

  private stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.contentEl.empty();
  }
}
