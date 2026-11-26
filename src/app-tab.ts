/**
 * An app opened in a tab of its own, on any host the runtime runs in: the app as it is now, as it
 * was at a time (the time rail), or ahead (What if…); its History and Explain in the side sheet;
 * the tab's keys and the actions its menu offers. The host gives the element, the app's
 * environment, and what only it can show: a window, a time picker, a backtest.
 */
import { eventsOf, undoneIn } from "./activity.ts";
import { drawActivity } from "./activity-list.ts";
import { addWhatIf, aheadEnv, branchName, defaultHorizon, parseWhatIf, whatIfNotes, whatIfRows } from "./ahead.ts";
import { AppController, type AppEnv } from "./app.ts";
import { EditSession } from "./backtest.ts";
import { DataLayer } from "./datalayer.ts";
import { TimeRail, typing } from "./rail.ts";
import { pastEnv } from "./replay.ts";
import type { GizmoRuntime } from "./runtime.ts";
import type { DrawIcon } from "./sheet.ts";
import { readSpec } from "./spec.ts";
import { basename, dataPathOf } from "./store.ts";
import { toTime } from "./time.ts";

/** What only the host of the tab can do. */
export interface TabHost {
  /** The app's environment as it is now. */
  env(path: string): AppEnv;
  icon: DrawIcon;
  notify(message: string): void;
  /** The app's History in a window, where the side sheet can't show it (the past, ahead, the grid). */
  historyWindow(path: string, seeThen: (at: number) => void): void;
  /** Asks which past time to show the app at; As of… is offered only where the host can ask. */
  asOf?: (show: (at: number) => void) => void;
  /** Backtests the app, or the change from `before`; offered only where the host can show one. */
  backtest?: (path: string, before?: Record<string, unknown>) => void;
}

/** An item of the tab's menu. */
export interface TabAction {
  id: string;
  title: string;
  icon: string;
  section: "view" | "action";
  checked?: boolean;
  run(): void;
}

/** Shown ahead: at this time, or when it first shows; and a Do… line, after `what if`, to save as a what-if row first. */
export interface AheadAsked {
  at?: number;
  line?: string;
}

export class AppTab {
  private root: HTMLElement;
  private rt: GizmoRuntime;
  private host: TabHost;
  private path: string | undefined;
  private shown: AppController | undefined;
  /** Shown as it was at this time (ms), read only; undefined for now. */
  private past: number | undefined;
  private shownPast: number | undefined;
  private ahead: AheadAsked | undefined;
  private shownAhead = false;
  /** The what-if's data layer while this app is shown ahead, and how to stop it hearing the vault. */
  private aheadData: { path: string; data: DataLayer; unfollow: () => void } | undefined;
  /** Which start is the latest, so an app shown ahead that took a while to read isn't drawn over a newer one. */
  private starts = 0;
  /** The definition this editing session started from, for "Backtest this change". */
  private session = new EditSession();
  /** The time rail, one for the tab's life: each controller started gets it in its rail slot. */
  private rail = new TimeRail((at) => this.showAt(at));
  /** How many reads of the app's activity the rail has asked for, so an overtaken one is dropped. */
  private railReads = 0;
  private unwatch: () => void;

  constructor(root: HTMLElement, rt: GizmoRuntime, host: TabHost) {
    this.root = root;
    this.rt = rt;
    this.host = host;
    this.unwatch = rt.activity.onChange(() => {
      void this.refreshRail();
      if (this.shown?.page === "history") this.showHistory();
    });
  }

  get controller(): AppController | undefined {
    return this.shown;
  }

  /** Opens an app note, starting a new editing session from its definition. */
  open(path: string, fm: Record<string, unknown> | undefined): void {
    this.stop();
    this.path = path;
    this.session = new EditSession();
    this.session.seen(fm, Date.now());
    this.start(path);
  }

  /** The note now goes by another path. */
  renamed(path: string): void {
    this.stop();
    this.path = path;
    this.start(path);
  }

  /** The app's definition as it is now, for the editing session. */
  seen(fm: Record<string, unknown> | undefined): void {
    this.session.seen(fm, Date.now());
  }

  /** Stops showing the app; `open` shows one again. */
  close(): void {
    this.stop();
    this.path = undefined;
  }

  dispose(): void {
    this.unwatch();
    this.rail.dispose();
    this.stop();
    this.dropAhead();
  }

  resize(): void {
    this.shown?.resize();
  }

  /** Looks again at whether the app is allowed, after a grant changed somewhere else. */
  recheck(): void {
    this.shown?.recheck();
  }

  /**
   * What the next start shows: the past, or ahead (a view's saved state). True when ahead was asked
   * for, to give `redrawIfMoved` once the note is loaded.
   */
  setTime(past: number | undefined, ahead: AheadAsked | undefined): boolean {
    this.past = past;
    this.ahead = ahead;
    return ahead !== undefined;
  }

  /** Draws the app again if what it is to show isn't what it shows. */
  redrawIfMoved(asked: boolean): void {
    if (this.path && this.shown && (asked || this.shownAhead || this.shownPast !== this.past)) this.redrawAt();
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

  /**
   * What the app changed, newest first, with Undo and See it then: in the side sheet, beside the app
   * as it is now; else (the past, ahead, the grid) in a window.
   */
  showHistory(): void {
    const path = this.path;
    if (!path) return;
    const seeThen = (at: number) => this.showAt(at);
    const shown = this.shown?.openPage("history", "History", (el) => {
      el.createEl("h2", { cls: "gz-sheet-title", text: `What ${basename(path)} did` });
      void drawActivity(el.createDiv(), this.rt, (message) => this.host.notify(message), { appPath: path, seeThen });
    });
    if (!shown) this.host.historyWindow(path, seeThen);
  }

  /**
   * The tab's own keys, while nothing is being typed in: `[` and `]` step through the app's changes
   * while the rail shows; `=` asks where the first figure comes from; Escape closes an open side
   * sheet first, and only then goes back to now (or, open on now, folds the rail). True when it took the key.
   */
  key(evt: KeyboardEvent): boolean {
    if (typing(evt) || evt.metaKey || evt.ctrlKey || evt.altKey) return false;
    if (evt.key === "[" || evt.key === "]") {
      if (!this.rail.el.isConnected) return false;
      this.rail.step(evt.key === "[" ? -1 : 1);
      return true;
    }
    if (evt.key === "=") return this.shown?.explainFirst() ?? false;
    if (evt.key !== "Escape") return false;
    if (this.shown?.closeSheet()) return true;
    if (!this.rail.el.isConnected || !(this.rail.past || this.rail.open)) return false;
    if (this.rail.past) this.rail.back();
    else this.rail.fold(true);
    return true;
  }

  /**
   * The tab's menu: the app's activity, the app as of a time, ahead, its first figure explained, its
   * data, a reload, and backtests: As of… and backtests only where the host can show them.
   */
  actions(): TabAction[] {
    const path = this.path;
    const out: TabAction[] = [];
    const add = (id: string, title: string, icon: string, section: TabAction["section"], run: () => void, checked?: boolean) =>
      out.push({ id, title, icon, section, run, ...(checked !== undefined && { checked }) });
    add("activity", "Activity", "history", "view", () => this.showHistory());
    const asOf = this.host.asOf;
    if (asOf) add("as-of", "As of…", "clock", "view", () => asOf((at) => this.showAt(at)));
    if (this.rt.dataLayer.ledger) add("what-if", "What if…", "sparkles", "view", () => this.showAhead());
    add("explain", "Explain the first figure", "equal", "view", () => {
      if (!this.shown?.explainFirst()) this.host.notify("This app shows no figure worked out from rows");
    });
    add("inspect", "Inspect data", "search-code", "view", () => void this.shown?.toggleInspector(), this.shown?.inspectorShown ?? false);
    add("reload", "Reload data", "refresh-cw", "view", () => this.shown?.reload());
    const backtest = this.host.backtest;
    if (backtest && path && this.past === undefined && this.ahead === undefined) {
      if (this.session.changed()) {
        const before = this.session.before;
        add("backtest-change", "Backtest this change", "history", "action", () => backtest(path, before));
      }
      add("backtest", "Backtest this app", "history", "action", () => backtest(path));
    }
    return out;
  }

  /** Reads the app's changes for the rail again. */
  private async refreshRail(): Promise<void> {
    const path = this.path;
    if (!path) return;
    const read = ++this.railReads;
    const listed = await this.rt.activity.list(path, this.rt.sharedData(path));
    // An entry of ledger events is undone as the ledger says, whichever device undid it.
    const ledger = this.rt.dataLayer.ledger;
    const undone = new Map<string, Set<string>>();
    for (const p of new Set(listed.flatMap((e) => eventsOf(e)?.map((x) => x.path) ?? []))) {
      undone.set(p, (await ledger?.state(p).catch(() => undefined))?.undone ?? new Set());
    }
    if (read !== this.railReads) return;
    this.rail.update(listed.map((e) => ({ ...e, undone: undoneIn(e, (p) => undone.get(p) ?? new Set()) })));
  }

  /** Draws the app again at the time it is to show, keeping where the pane was scrolled. */
  private redrawAt(): void {
    if (!this.path) return;
    const top = this.root.scrollTop;
    const height = (this.root.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    this.stop();
    this.start(this.path);
    if (!top) return;
    // The app drawn again is short until its data arrives: it keeps the old height a moment, so
    // stepping through time leaves the pane scrolled where it was.
    const shell = this.root.firstElementChild as HTMLElement;
    shell.style.minHeight = `${height}px`;
    this.root.scrollTop = top;
    window.setTimeout(() => shell.style.removeProperty("min-height"), 1500);
  }

  private start(path: string): void {
    const live = this.host.env(path);
    this.starts++;
    this.shownAhead = this.ahead !== undefined;
    if (this.ahead) return void this.startAhead(path, live, this.starts);
    this.dropAhead();
    const env = this.past === undefined ? live : pastEnv(live, this.past, () => this.showAt(undefined));
    this.shownPast = this.past;
    this.mount(path, env);
    this.rail.sync(this.past);
    void this.refreshRail();
  }

  private mount(path: string, env: AppEnv): void {
    this.shown = new AppController(this.root, path, env);
    this.shown.openInPlace(this.host.icon);
    this.shown.load();
    this.shown.railSlot()?.appendChild(this.rail.el);
  }

  private stop(): void {
    this.shown?.dispose();
    this.shown = undefined;
    this.root.empty();
  }

  /**
   * Shows the app ahead: on the what-if's layer, kept while the app is shown ahead, after saving the
   * line asked for, at the time asked for or else when the app reads to (see defaultHorizon).
   */
  private async startAhead(path: string, live: AppEnv, run: number): Promise<void> {
    const request = this.ahead!;
    const line = request.line;
    delete request.line;
    this.root.createDiv({ cls: "gizmo" }).createDiv({ cls: "gz-empty", text: "Reading the what-if…" });
    const data = this.aheadLayer(path);
    const now = new Date();
    const spec = readSpec(live.frontmatter(path), { path, notes: live.notes, now })?.spec;
    const zone = this.rt.beat.whereYouAre();
    const envAt = (at: number) => aheadEnv(live, data, at, { show: (t) => this.showAhead(t), back: () => this.showAt(undefined), zone, marked: (times) => this.rail.mark(times) });
    const said = line === undefined ? undefined : await this.saveWhatIf(line, envAt(now.getTime()), now);
    const notes = spec ? whatIfNotes(spec, path, dataPathOf(spec.store, path, (s, from) => this.rt.host.storePath(s, from))) : [];
    const marks = (await whatIfRows(data.ledger!, notes, (p) => live.frontmatter(p))).map((r) => toTime(r.row.at)).filter((t): t is number => t !== undefined);
    const latest = marks.reduce((m, t) => Math.max(m, t), 0);
    const at = request.at ?? (spec ? defaultHorizon(spec, now.getTime(), latest || undefined) : now.getTime());
    if (run !== this.starts || this.path !== path) return;
    this.root.empty();
    data.setAhead(at);
    request.at = at;
    this.shownPast = undefined;
    this.mount(path, envAt(at));
    this.rail.ahead(at, marks, (t) => this.showAhead(t));
    void this.refreshRail();
    if (said) live.notify(said);
  }

  /** Saves a Do… line, after `what if`, as a what-if row through the shortcut it names; says that it did, or why not. */
  private async saveWhatIf(line: string, env: AppEnv, now: Date): Promise<string> {
    const parsed = parseWhatIf(line, this.rt.background.captureIndex(), now);
    if (!parsed.ok) return `“what if ${line}” wasn't saved: ${parsed.error}`;
    const { path, shortcut } = parsed.target;
    const spec = readSpec(env.frontmatter(path), { path, notes: env.notes, now })?.spec;
    if (!spec) return `“what if ${line}” wasn't saved: ${parsed.target.app} has a mistake in it`;
    const dataPath = dataPathOf(spec.store, path, (s, from) => this.rt.host.storePath(s, from));
    const done = await addWhatIf(env, { path, dataPath, spec, shortcut }, parsed.params ?? {}, now);
    return "error" in done ? `“what if ${line}” wasn't saved: ${done.error}` : `Added “${line}” as a what-if; nothing real changed`;
  }

  /** The what-if's data layer for this app, made the first time it is shown ahead; it hears what the vault's layer hears. */
  private aheadLayer(path: string): DataLayer {
    if (this.aheadData?.path === path) return this.aheadData.data;
    this.dropAhead();
    const live = this.rt.dataLayer;
    const data = new DataLayer(live.host, { like: live, ahead: { name: branchName(path), at: Date.now() } });
    this.aheadData = { path, data, unfollow: live.follow(data) };
    return data;
  }

  private dropAhead(): void {
    this.aheadData?.unfollow();
    this.aheadData = undefined;
  }
}
