import { FileView, Notice, Scope, setIcon, type Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { eventsOf, undoneIn } from "./activity.ts";
import { addWhatIf, aheadEnv, branchName, defaultHorizon, parseWhatIf, whatIfNotes, whatIfRows } from "./ahead.ts";
import { AppController, type AppEnv } from "./app.ts";
import { EditSession } from "./backtest.ts";
import { DataLayer } from "./datalayer.ts";
import { copyText, obsidianAppEnv, vaultStorePath } from "./host.ts";
import { openActivity } from "./activity-view.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";
import { embedBlock } from "./open-app.ts";
import { AsOfModal, BacktestModal } from "./past-views.ts";
import { TimeRail, typing } from "./rail.ts";
import { pastEnv } from "./replay.ts";
import { readSpec } from "./spec.ts";
import { dataPathOf } from "./store.ts";
import { toTime } from "./time.ts";

export const VIEW_TYPE = "gizmo";

/** The tab an app note opens in. All the work happens in its AppController. */
export class AppView extends FileView {
  private plugin: GizmoPlugin;
  private controller: AppController | undefined;
  /** Shown as it was at this time (ms), read only; undefined for now. */
  private past: number | undefined;
  private shownPast: number | undefined;
  /**
   * Shown ahead (What if…): at this time, or when it first shows; and a Do… line, after `what if`,
   * to save as a what-if row first. Not kept with the workspace either.
   */
  private ahead: { at?: number; line?: string } | undefined;
  private shownAhead = false;
  /** The what-if's data layer while this app is shown ahead, and how to stop it hearing the vault. */
  private aheadData: { path: string; data: DataLayer; unfollow: () => void } | undefined;
  /** Which start is the latest, so an app shown ahead that took a while to read isn't drawn over a newer one. */
  private starts = 0;
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
    this.addAction("file-code", "Edit source", () => this.file && this.plugin.editSource(this.leaf, this.file));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (f === this.file) this.session.seen(this.app.metadataCache.getFileCache(f)?.frontmatter, Date.now());
    }));
    this.unwatch = this.plugin.activity.onChange(() => void this.refreshRail());
    // The view's own scope hears keys only while it is the active tab. Returning false stops a key there.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "[", (evt) => this.railKey(evt, -1));
    this.scope.register([], "]", (evt) => this.railKey(evt, 1));
    // Escape closes an open side sheet first, and only then goes back to now.
    this.scope.register([], "Escape", (evt) => {
      if (typing(evt)) return true;
      if (this.controller?.closeSheet()) return false;
      if (!this.rail.el.isConnected || !this.rail.past) return true;
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
    const listed = await this.plugin.activity.list(path, this.plugin.sharedData(path));
    // An entry of ledger events is undone as the ledger says, whichever device undid it.
    const ledger = this.plugin.dataLayer.ledger;
    const undone = new Map<string, Set<string>>();
    for (const p of new Set(listed.flatMap((e) => eventsOf(e)?.map((x) => x.path) ?? []))) {
      undone.set(p, (await ledger?.state(p).catch(() => undefined))?.undone ?? new Set());
    }
    if (read !== this.railReads) return;
    this.rail.update(listed.map((e) => ({ ...e, undone: undoneIn(e, (p) => undone.get(p) ?? new Set()) })));
  }

  /**
   * A view opened with `past` in its state shows the app as it was then; with `ahead`, as it would be
   * at a time still to come (`at`), saving a what-if `line` first. Neither is kept with the workspace.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as { past?: unknown; ahead?: unknown } | undefined;
    this.past = typeof s?.past === "number" ? s.past : undefined;
    const ahead = s?.ahead !== null && typeof s?.ahead === "object" ? s.ahead as { at?: unknown; line?: unknown } : undefined;
    this.ahead = ahead && { ...(typeof ahead.at === "number" && { at: ahead.at }), ...(typeof ahead.line === "string" && { line: ahead.line }) };
    const asked = this.ahead !== undefined;
    await super.setState(state, result);
    if (this.file && this.controller && (asked || this.shownAhead || this.shownPast !== this.past)) this.redrawAt();
  }

  /** Shows the app as it was at a time, or as it is now. */
  showAt(at: number | undefined): void {
    this.past = at;
    this.ahead = undefined;
    this.redrawAt();
  }

  /** Shows the app as it would be at a time still to come, at first the end of the window it reads; `line` is saved as a what-if first. */
  showAhead(at?: number, line?: string): void {
    this.past = undefined;
    this.ahead = { ...(at !== undefined && { at }), ...(line !== undefined && { line }) };
    this.redrawAt();
  }

  /** Draws the app again at the time it is to show, keeping where the pane was scrolled. */
  private redrawAt(): void {
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
    if (this.plugin.dataLayer.ledger) menu.addItem((item) => item.setTitle("What if…").setIcon("sparkles").setSection("view").onClick(() => this.showAhead()));
    menu.addItem((item) => item.setTitle("Inspect data").setIcon("search-code").setChecked(this.controller?.inspectorShown ?? false).setSection("view").onClick(() => void this.controller?.toggleInspector()));
    menu.addItem((item) => item.setTitle("Reload data").setIcon("refresh-cw").setSection("view").onClick(() => this.controller?.reload()));
    const bg = this.plugin.background;
    const app = bg?.list().find((a) => a.path === path);
    if (path && this.past === undefined && this.ahead === undefined) {
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
    const file = this.file;
    if (file && app) {
      menu.addItem((item) => item.setTitle("Copy embed").setIcon("code").setSection("action").onClick(() => {
        copyText(embedBlock(this.app.metadataCache.fileToLinktext(file, "")), () => new Notice(`Copied the embed of ${file.basename}; paste it into any note to show the app there`));
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
    this.dropAhead();
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
    this.starts++;
    this.shownAhead = this.ahead !== undefined;
    if (this.ahead) return void this.startAhead(file, live, this.starts);
    this.dropAhead();
    const env = this.past === undefined ? live : pastEnv(live, this.past, () => this.showAt(undefined));
    this.shownPast = this.past;
    this.controller = new AppController(this.contentEl, file.path, env);
    this.controller.openInPlace(setIcon);
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

  /**
   * Shows the app ahead: on the what-if's layer, kept while the app is shown ahead, after saving the
   * line asked for, at the time asked for or else when the app reads to (see defaultHorizon).
   */
  private async startAhead(file: TFile, live: AppEnv, run: number): Promise<void> {
    const request = this.ahead!;
    const line = request.line;
    delete request.line;
    this.contentEl.createDiv({ cls: "gizmo" }).createDiv({ cls: "gz-empty", text: "Reading the what-if…" });
    const data = this.aheadLayer(file.path);
    const now = new Date();
    const spec = readSpec(live.frontmatter(file.path), { path: file.path, notes: live.notes, now })?.spec;
    const zone = this.plugin.beat?.whereYouAre();
    const envAt = (at: number) => aheadEnv(live, data, at, { show: (t) => this.showAhead(t), back: () => this.showAt(undefined), zone, marked: (times) => this.rail.mark(times) });
    const said = line === undefined ? undefined : await this.saveWhatIf(line, envAt(now.getTime()), now);
    const notes = spec ? whatIfNotes(spec, file.path, dataPathOf(spec.store, file.path, vaultStorePath(this.app))) : [];
    const marks = (await whatIfRows(data.ledger!, notes, (path) => live.frontmatter(path))).map((r) => toTime(r.row.at)).filter((t): t is number => t !== undefined);
    const latest = marks.reduce((m, t) => Math.max(m, t), 0);
    const at = request.at ?? (spec ? defaultHorizon(spec, now.getTime(), latest || undefined) : now.getTime());
    if (run !== this.starts || this.file !== file) return;
    this.contentEl.empty();
    data.setAhead(at);
    request.at = at;
    this.shownPast = undefined;
    this.controller = new AppController(this.contentEl, file.path, envAt(at));
    this.controller.openInPlace(setIcon);
    this.controller.load();
    this.controller.railSlot()?.appendChild(this.rail.el);
    this.rail.ahead(at, marks, (t) => this.showAhead(t));
    void this.refreshRail();
    if (said) live.notify(said);
  }

  /** Saves a Do… line, after `what if`, as a what-if row through the shortcut it names; says that it did, or why not. */
  private async saveWhatIf(line: string, env: AppEnv, now: Date): Promise<string> {
    const bg = this.plugin.background;
    if (!bg) return "What if lines need Gizmo's background service";
    const parsed = parseWhatIf(line, bg.captureIndex(), now);
    if (!parsed.ok) return `“what if ${line}” wasn't saved: ${parsed.error}`;
    const { path, shortcut } = parsed.target;
    const spec = readSpec(env.frontmatter(path), { path, notes: env.notes, now })?.spec;
    if (!spec) return `“what if ${line}” wasn't saved: ${parsed.target.app} has a mistake in it`;
    const done = await addWhatIf(env, { path, dataPath: dataPathOf(spec.store, path, vaultStorePath(this.app)), spec, shortcut }, parsed.params ?? {}, now);
    return "error" in done ? `“what if ${line}” wasn't saved: ${done.error}` : `Added “${line}” as a what-if; nothing real changed`;
  }

  /** The what-if's data layer for this app, made the first time it is shown ahead; it hears what the vault's layer hears. */
  private aheadLayer(path: string): DataLayer {
    if (this.aheadData?.path === path) return this.aheadData.data;
    this.dropAhead();
    const live = this.plugin.dataLayer;
    const data = new DataLayer(live.host, { like: live, ahead: { name: branchName(path), at: Date.now() } });
    this.aheadData = { path, data, unfollow: live.follow(data) };
    return data;
  }

  private dropAhead(): void {
    this.aheadData?.unfollow();
    this.aheadData = undefined;
  }
}
