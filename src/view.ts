import { FileView, Scope, type Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { eventsOf, undoneIn } from "./activity.ts";
import { AppController } from "./app.ts";
import { EditSession } from "./backtest.ts";
import { obsidianAppEnv } from "./host.ts";
import { openActivity } from "./activity-view.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";
import { AsOfModal, BacktestModal } from "./past-views.ts";
import { TimeRail, typing } from "./rail.ts";
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
  /** The time rail, one for the view's life: each controller started gets it in its rail slot. */
  private rail = new TimeRail((at) => this.showAt(at));
  /** How many reads of the app's activity the rail has asked for, so an overtaken one is dropped. */
  private railReads = 0;
  private unwatch: (() => void) | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: GizmoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Gizmo"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    // The one action in the header; the rest are in the tab's menu (onPaneMenu).
    this.addAction("file-code", "Edit source", () => this.file && this.plugin.showSource(this.leaf, this.file));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (f === this.file) this.session.seen(this.app.metadataCache.getFileCache(f)?.frontmatter, Date.now());
    }));
    this.unwatch = this.plugin.activity.onChange(() => void this.refreshRail());
    // The view's own scope hears keys only while it is the active tab. Returning false stops a key there.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "[", (evt) => this.railKey(evt, -1));
    this.scope.register([], "]", (evt) => this.railKey(evt, 1));
    this.scope.register([], "Escape", (evt) => {
      if (typing(evt) || !this.rail.el.isConnected || !this.rail.past) return true;
      this.rail.back();
      return false;
    });
  }

  /** `[` and `]` step through the app's changes while the rail shows and nothing is being typed in. */
  private railKey(evt: KeyboardEvent, dir: -1 | 1): boolean {
    if (typing(evt) || !this.rail.el.isConnected) return true;
    this.rail.step(dir);
    return false;
  }

  /** Reads the app's changes for the rail again. */
  private async refreshRail(): Promise<void> {
    const path = this.file?.path;
    if (!path) return;
    const read = ++this.railReads;
    const listed = await this.plugin.activity.list(path);
    // An entry of ledger events is undone as the ledger says, whichever device undid it.
    const ledger = this.plugin.dataLayer.ledger;
    const undone = new Map<string, Set<string>>();
    for (const p of new Set(listed.flatMap((e) => eventsOf(e)?.map((x) => x.path) ?? []))) {
      undone.set(p, (await ledger?.state(p).catch(() => undefined))?.undone ?? new Set());
    }
    if (read !== this.railReads) return;
    this.rail.update(listed.map((e) => ({ ...e, undone: undoneIn(e, (p) => undone.get(p) ?? new Set()) })));
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
    const top = this.contentEl.scrollTop;
    const height = (this.contentEl.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    this.stop();
    this.start(this.file);
    if (!top) return;
    // The app drawn again is short until its data arrives: it keeps the old height a moment, so
    // stepping through time leaves the pane scrolled where it was.
    const shell = this.contentEl.firstElementChild as HTMLElement;
    shell.style.minHeight = `${height}px`;
    this.contentEl.scrollTop = top;
    window.setTimeout(() => shell.style.removeProperty("min-height"), 1500);
  }

  /**
   * The tab's menu: the app's activity, the app as of a time, its data, a reload, backtests, and
   * the link to each of its shortcuts. A link's key is made when one is copied, not when the menu
   * opens, so opening it never writes the plugin's settings.
   */
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    const path = this.file?.path;
    menu.addItem((item) => item.setTitle("Activity").setIcon("history").setSection("view").onClick(() => path && openActivity(this.plugin, path)));
    menu.addItem((item) => item.setTitle("As of…").setIcon("clock").setSection("view").onClick(() => new AsOfModal(this.app, (at) => this.showAt(at)).open()));
    menu.addItem((item) => item.setTitle("Inspect data").setIcon("search-code").setChecked(this.controller?.inspectorShown ?? false).setSection("view").onClick(() => void this.controller?.toggleInspector()));
    menu.addItem((item) => item.setTitle("Reload data").setIcon("refresh-cw").setSection("view").onClick(() => this.controller?.reload()));
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
    this.unwatch?.();
    this.rail.dispose();
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
    this.controller.railSlot()?.appendChild(this.rail.el);
    this.rail.sync(this.past);
    void this.refreshRail();
  }

  private stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.contentEl.empty();
  }
}
