import { FileView, Notice, Scope, setIcon, type Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { AppTab, type AheadAsked } from "./app-tab.ts";
import type { AppController } from "./app.ts";
import { obsidianAppEnv } from "./host.ts";
import { copyText } from "./clipboard.ts";
import { openActivity } from "./activity-view.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";
import { embedBlock } from "./open-app.ts";
import { AsOfModal, BacktestModal } from "./past-views.ts";

export const VIEW_TYPE = "gizmo";

/** The tab an app note opens in: Obsidian's side of an AppTab, where the work happens. */
export class AppView extends FileView {
  private plugin: GizmoPlugin;
  private tab: AppTab;

  constructor(leaf: WorkspaceLeaf, plugin: GizmoPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.tab = new AppTab(this.contentEl, plugin.runtime, {
      env: () => obsidianAppEnv(plugin, this.leaf, this.file!),
      icon: setIcon,
      notify: (message) => { new Notice(message); },
      historyWindow: (path) => openActivity(plugin, path),
      asOf: (show) => new AsOfModal(this.app, show).open(),
      backtest: (path, before) => new BacktestModal(plugin, path, before).open(),
    });
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Gizmo"; }
  getIcon(): string { return "layout-dashboard"; }

  /** The app's controller while it shows. */
  get controller(): AppController | undefined {
    return this.tab.controller;
  }

  async onOpen(): Promise<void> {
    // The one action in the header; the rest are in the tab's menu (onPaneMenu).
    this.addAction("file-code", "Edit source", () => this.file && this.plugin.editSource(this.leaf, this.file));
    this.addAction("history", "History", () => this.tab.showHistory());
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (f === this.file) this.tab.seen(this.app.metadataCache.getFileCache(f)?.frontmatter);
    }));
    // The view's own scope hears keys only while it is the active tab. Returning false stops a key there.
    this.scope = new Scope(this.app.scope);
    for (const key of ["[", "]", "=", "Escape"]) this.scope.register([], key, (evt) => !this.tab.key(evt));
  }

  /**
   * A view opened with `past` in its state shows the app as it was then; with `ahead`, as it would be
   * at a time still to come (`at`), saving a what-if `line` first. Neither is kept with the workspace.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as { past?: unknown; ahead?: unknown } | undefined;
    const past = typeof s?.past === "number" ? s.past : undefined;
    const a = s?.ahead !== null && typeof s?.ahead === "object" ? s.ahead as { at?: unknown; line?: unknown } : undefined;
    const ahead: AheadAsked | undefined = a && { ...(typeof a.at === "number" && { at: a.at }), ...(typeof a.line === "string" && { line: a.line }) };
    const asked = this.tab.setTime(past, ahead);
    await super.setState(state, result);
    if (this.file) this.tab.redrawIfMoved(asked);
  }

  /** Shows the app as it was at a time, or as it is now. */
  showAt(at: number | undefined): void {
    this.tab.showAt(at);
  }

  /** Shows the app as it would be at a time still to come, at first the end of the window it reads; `line` is saved as a what-if first. */
  showAhead(at?: number, line?: string): void {
    this.tab.showAhead(at, line);
  }

  /**
   * The tab's menu: the tab's own actions (see AppTab.actions), and the link to each of the app's
   * shortcuts and its embed. A link's key is made when one is copied, not when the menu opens, so
   * opening it never writes the plugin's settings.
   */
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    for (const a of this.tab.actions()) {
      menu.addItem((item) => {
        item.setTitle(a.title).setIcon(a.icon).setSection(a.section).onClick(() => a.run());
        if (a.checked !== undefined) item.setChecked(a.checked);
      });
    }
    const path = this.file?.path;
    const bg = this.plugin.runtime.background;
    const app = bg.list().find((a) => a.path === path);
    for (const s of app?.shortcuts ?? []) {
      menu.addItem((item) => item.setTitle(`Copy link: ${s.label}`).setIcon("link").setSection("action").onClick(() => {
        const link = bg.shortcutLinks().find((l) => l.path === path && l.shortcut === s.id);
        if (link) copyShortcutLink(link);
      }));
    }
    const file = this.file;
    if (file && app) {
      menu.addItem((item) => item.setTitle("Copy embed").setIcon("code").setSection("action").onClick(() => {
        copyText(embedBlock(this.app.metadataCache.fileToLinktext(file, "")), () => new Notice(`Copied the embed of ${file.basename}; paste it into any note to show the app there`));
      }));
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.tab.open(file.path, this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  async onUnloadFile(): Promise<void> {
    this.tab.close();
  }

  /** Obsidian calls this for every renamed file, not only this view's. */
  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    if (file === this.file) this.tab.renamed(file.path);
  }

  async onClose(): Promise<void> {
    this.tab.dispose();
  }

  onResize(): void {
    this.tab.resize();
  }

  /** Looks again at whether the app is allowed, after a grant changed somewhere else. */
  recheck(): void {
    this.tab.recheck();
  }
}
