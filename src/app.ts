import { textOf } from "./text.ts";
import { pastText, shownAsNow } from "./replay.ts";
import { aheadLines, discard, keep, lookAhead, readAsNow, whatIfNotes, whatIfRows, type Ahead } from "./ahead.ts";
import { renderAheadCard, type AheadActions, type AheadCard } from "./ahead-card.ts";
import { rowIdOf } from "./ledger-store.ts";
import { logFolder } from "./ledger.ts";
import type { DataStore } from "./datastore.ts";
import { violationText, type FlowWhere, type Verdict } from "./flows.ts";
import type { Entry, NewEntry } from "./activity.ts";
import {
  editWords, findRenames, renameKey, renderBlocked, renderEmpty, renderErrors, renderHandEdit, renderKindToAllow, renderOpenOnce, renderPermissionPrompt, renderRename,
  renderUsage, renderYamlError, yamlProblem, type CardApp, type KindToAllow,
} from "./app-cards.ts";
import { Timers } from "./app-timers.ts";
import { AppWrites } from "./app-writes.ts";
import { asOfText } from "./responses.ts";
import { type Row } from "./data.ts";
import { stampParts, toTime } from "./time.ts";
import { DataLayer, WebError, type AppFiles } from "./datalayer.ts";
import { EXPLAINED, explain, waterfall, type Explanation } from "./explain.ts";
import type { ExplainSource } from "./explain-view.ts";
import { panelName, panelsOf, type DefinitionLog } from "./definitions.ts";
import { editableSource } from "./edit.ts";
import { knobsOf, solve, withProperty } from "./pull.ts";
import { reconcileOf, ruleOf } from "./match.ts";
import { renderReconcile } from "./reconcile-card.ts";
import { isPlainObject } from "./keys.ts";
import { kindFiles, kindOfPanel } from "./sources/kind.ts";
import { fileDep, folderDep, nameDep } from "./deps.ts";
import { stableJson } from "./hash.ts";
import { typedName, type NoteReader } from "./expand.ts";
import {
  isUrl, panelIds, pickPanels, readComponentPreview, readSpec, resolvePanel, startingValues, type ComponentPreview,
  type AppSpec, type Panel, type PanelSpec, type Then,
} from "./spec.ts";
import { askersOf, describePermission, permissionsOf } from "./permissions.ts";
import { fileRowIds, importable } from "./import.ts";
import { thisValues } from "./sources/this.ts";
import { THIS, type InputValue } from "./template.ts";
import { renderInputBar } from "./toolbar.ts";
import { renderInspector, sourceKind, type InspectedSource } from "./inspect.ts";
import { compilePipeline, tracePipeline } from "./pipeline.ts";
import { panelLine } from "./yamlpos.ts";
import { APP_MAX, APP_PAD, HOSTED_MAX, HOSTED_PAD, MAX_COLUMNS, TRACKS, columnsFor, composedWidth, isNarrow, rowTracks, spanOn, widthFor } from "./layout.ts";
import { compose, type Placement, type Scope } from "./compose.ts";
import { Sheet, type DrawIcon } from "./sheet.ts";
import { basename, dataPathOf, defaultDataPath, devicesFolder, isComponent } from "./store.ts";
import { mountView } from "./views/common.ts";
import { sourceOf, viewDef, type PanelCtx, type PanelHandle, type SheetPick, type TimerState, type ViewDef } from "./views/registry.ts";
import type { AlertFeed } from "./alert-keys.ts";

const CACHE_MS = 5 * 60_000;
/** How long a panel waits for the network before painting the disk copy. */
const DISK_FIRST_MS = 50;

/** What an app needs from Obsidian; the view passes the real thing, tests a fake. */
export interface AppEnv {
  data: DataLayer;
  frontmatter(path: string): Record<string, unknown> | undefined;
  /** Reads the component notes an app uses. */
  notes: NoteReader;
  /** Whether the app may run; under a data policy, `asked` is what the policy doesn't cover. */
  isGranted(path: string, wanted: string[], asked?: string[]): boolean;
  /** What the applied data policy says of the app here; undefined with no policy. */
  verdict?(spec: AppSpec, wanted: string[], where: FlowWhere): Verdict | undefined;
  /** Whether the policy note has changes that weren't applied. */
  policyPending?(): boolean;
  /** What the app was allowed last time, to mark what's new; undefined when it was never allowed or opened. */
  granted(path: string): string[] | undefined;
  grant(path: string, wanted: string[]): Promise<void>;
  /** Path of the note a `store:` value points at. */
  storePath(store: string, fromPath: string): string;
  /**
   * Changes the frontmatter of the app's data note (or its store), creating the note if needed;
   * writes to one note run in order.
   */
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Where an app's lists are kept, by its data note; without one, in the data note's properties. */
  store?(dataPath: string, appPath: string): DataStore;
  /**
   * Changes an existing note's frontmatter (a note a row or `save: this` names); false, writing
   * nothing, when there is no note at that path any more, so a renamed or deleted note isn't
   * brought back as a stub.
   */
  updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<boolean>;
  /** Adds a line at the end of a note, creating it (and its folders) when there's none; true when it created it. */
  appendLine(path: string, line: string): Promise<boolean | void>;
  /**
   * Creates a note at `path` (and its folders) with this frontmatter and body: the text it wrote
   * (or true), or false, writing nothing, when a note is already there. The note reaches the data
   * layer like any other change.
   */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<string | boolean>;
  /** The text after the frontmatter of the note a path or link names, resolved from the app as `store` is. */
  readBody(path: string): Promise<string>;
  /**
   * Ticks or unticks a task in a note, re-reading it as it writes (see tickLine); false, writing
   * nothing, when the note no longer holds that task where it can be found for sure.
   */
  setTaskDone(path: string, line: number, text: string, done: boolean): Promise<boolean>;
  notify(message: string): void;
  openNote(path: string, fromPath: string): void;
  showSource(): void;
  /** Shows the note's source with the cursor on this 0-based line, at its start or at `ch`. */
  showSourceAt(line: number, ch?: number): void;
  /** The note's text as it is now, line by line. */
  sourceLines(): Promise<string[]>;
  /**
   * Adds starter panels (each its lines, see `skeleton`) to the end of the app note's `panels:`, as
   * Insert panel adds one: where the cursor goes in the first, or why they can't be added. Only
   * where the person edits the app note itself: not in an embed, a lens, a try or a dry run.
   */
  addPanels?(panels: string[][]): Promise<{ cursor: { line: number; ch: number } } | { refusal: string }>;
  /** Puts text on the clipboard. */
  copy(text: string): void;
  /** Keeps what the app changed in the activity log; may give the entry once it is kept. */
  log?(entry: NewEntry): Promise<Entry | undefined> | void;
  /** Undoes an entry of the activity log by its id, as far as the vault allows; says how it went. */
  undo?(entryId: string): Promise<string>;
  /** Runs a panel's `then`: another app's shortcut, through the background service. */
  trigger?(fromPath: string, then: Then, ctx: Row): Promise<void>;
  now(): Date;
  /** Tells the background service the app was opened, so what it records is sampled if due. */
  opened?(appPath: string): void;
  /** In an app shown as it was, or ahead: shows it as it is now again. */
  backToNow?: () => void;
  /** The app shown at a time still to come, with what-if rows (see ahead.ts). */
  ahead?: Ahead;
  /** Alerts true now across the vault, from the background service. */
  alerts?: AlertFeed;
  /** A try before Allow: nothing it draws may reach out of Obsidian (pictures are drawn as their address). */
  preview?: boolean;
  /** Opens the app on copies of its own notes before it's allowed; absent where that can't be offered. */
  tryFirst?(): void;
  /** Opens the Explain window of a figure (see explain-view.ts); absent where there is no window to open. */
  explain?(src: ExplainSource): void;
  /** What each app's panels said when they were opened here before (see definitions.ts). */
  definitions?: DefinitionLog;
  /** A device's name, by its id, for saying where a row was written. */
  deviceName?(id: string): string | undefined;
  /** Whether the person chose to leave the saved rows of a rename as they are (see renameKey); kept across restarts. */
  leftAlone?(key: string): boolean;
  leaveAlone?(key: string): void;
}

/** What an app keeps while it is open: input values, selections, the open tab and its timers. */
export interface AppMemory {
  values: Record<string, InputValue>;
  selections: Map<string, Row>;
  activeTab?: string;
  timers: Map<string, TimerState>;
}

export function newMemory(): AppMemory {
  return { values: {}, selections: new Map(), timers: new Map() };
}

/**
 * Where an app runs when it isn't an app note opened on its own: `embed`, a `gizmo` block with
 * its keys; `app`, a block showing panels of an app note as that app; `lens`, a component shown
 * above every note in its `for` scope. The app's path (links, lists typed into it) is given apart.
 */
export interface Hosting {
  kind: "embed" | "app" | "lens";
  /** What the app's grants are kept under. */
  grantKey: string;
  /** The note `$this` and `source: this` read and `save: this` writes. */
  hostPath: string;
  /** The app's keys, read again whenever they may have changed. */
  definition(): Record<string, unknown> | undefined;
  /** The data note, when it isn't the one the app's `store` or path gives. */
  dataPath?: string;
  /** A lens's `for` scope. */
  scope?: string;
  /** Only the panels with these titles or labels are drawn. */
  panels?: string[];
  /** Kept by the caller, so a block drawn again (as the editor does freely) keeps its state. */
  memory?: AppMemory;
}

interface Mounted {
  id: string;
  ps: PanelSpec;
  /** The panel's keys with the current input values filled in. */
  p: Panel;
  def: ViewDef;
  el: HTMLElement;
  handle: PanelHandle;
  /** Columns asked for, and the tab the panel sits in (none: always shown, above the tabs). */
  span: number;
  /** Twelfths of the row it was last laid out at; undefined until then. */
  tracks?: number;
  tab: string | undefined;
  source: string | undefined;
  deps: string[];
  /** Bumped on every load so a slow, outdated response can't overwrite a newer one. */
  seq: number;
  /** An input it uses changed: draw it afresh once its new data arrives. */
  remount: boolean;
  /** Not loaded: it waits for a value, or a value it was given can't be used. */
  idle: boolean;
  /**
   * What its source gave on the load it shows, before any step, and when; kept only where a panel
   * that shows nothing can say why (see canSayWhy). None for a disk copy.
   */
  raw?: { data: unknown; now: Date };
}

/** Why a source failed, in plain words: what a web request met, else the failure's own message. */
function failureText(e: unknown): string {
  if (!(e instanceof WebError)) return (e as Error).message;
  if (e.kind === "network") return `Couldn't reach ${e.host}. Check the connection.`;
  if (e.kind === "not-json") return `The answer from ${e.host} isn't JSON.`;
  return e.status === 429 ? `${e.host} answered 429: too many requests. Try again later.` : `${e.host} answered ${e.status}.`;
}

/** A panel's title as typed, when no value is filled into it. */
function plainTitle(ps: PanelSpec): string | undefined {
  return typeof ps.template.title === "string" ? ps.template.title : undefined;
}

/**
 * Runs one app note: reads its keys, asks for permissions, mounts each panel once, paints each as
 * its data arrives, and from then on updates only the panels whose inputs changed.
 */
export class AppController {
  private root: HTMLElement;
  private appPath: string;
  private env: AppEnv;
  private shell: HTMLElement;
  /** What holds the panels: the grid (`.gz-grid`), or the composed layout's scopes (`.gz-body`). */
  private grid: HTMLElement | undefined;
  /** The layout `grid` was built for; a different one builds it again. */
  private gridLayout: AppSpec["layout"] | undefined;
  /** In the composed layout, each panel's place, by id, and each tab's pane; empty on the grid. */
  private placements = new Map<string, Placement>();
  private panes = new Map<string, HTMLElement>();
  /** In the composed layout, the sheet slot each panel that waits for a pick belongs in, by id, in the order written. */
  private slots = new Map<string, HTMLElement>();
  /** In an app's own tab, the side sheet a pick opens in (see openInPlace); undefined anywhere else. */
  private sheet: Sheet | undefined;
  /** In an app's own tab, where the time rail goes; the same element while the app is open. */
  private rail: HTMLElement | undefined;
  private mounted = new Map<string, Mounted>();
  private spec: AppSpec | undefined;
  private definition = "";
  private dataPath = "";
  private unsubscribe: (() => void) | undefined;
  private hosting: Hosting | undefined;
  /** The card saying the data note was edited by hand, while it is. */
  private handEdit: HTMLElement | undefined;
  /** The card offering to bring saved rows along with a rename in the app's keys, while one is found; and which look for one is the latest. */
  private renameCard: HTMLElement | undefined;
  private renameChecks = 0;
  /** In a kind's own tab: the rows read from a file that wait to be accepted or set aside. */
  private reconcileCard: HTMLElement | undefined;
  private reconcileChecks = 0;
  /** Shown ahead: the what-if's card, which fill of it is the latest, and the fill waiting for changes to stop. */
  private aheadCard: AheadCard | undefined;
  private aheadChecks = 0;
  private aheadTimer: number | undefined;
  private grantKey: string;
  private hostPath: string;
  /** What `$this` reads, and as JSON, to tell when it changed. */
  private host: Row = {};
  private hostJson = "";
  private memory: AppMemory;
  private timers: Timers;
  private writes: AppWrites;
  private cards: CardApp;
  private refreshHandle: number | undefined;
  private resizeHandle: number | undefined;
  private width = 0;
  private columns = MAX_COLUMNS;
  private tabs: HTMLElement | undefined;
  /** The open tab; kept while the note is edited, back to the first when it's reopened. */
  private get activeTab() { return this.memory.activeTab; }
  private set activeTab(tab: string | undefined) { this.memory.activeTab = tab; }
  /** Input values; kept while the note is edited, back to their starts when it's reopened. An empty search box has none. */
  private get values() { return this.memory.values; }
  private set values(values: Record<string, InputValue>) { this.memory.values = values; }
  /** Rows panels selected, by selection name; kept while the note is edited, cleared when it's reopened. */
  private get selections() { return this.memory.selections; }
  /** The input bar, kept as drawn while the inputs stay the same so typing in it is never interrupted. */
  private bar: HTMLElement | undefined;
  private barFor = "";
  /** Names of the component notes the app links to; a change to any of them redraws it. */
  private links: string[] = [];
  /** What the app asks for, as drawn last: which kinds' rows it may change. */
  private wanted: string[] = [];
  /** What every panel may ask; each gets its own copy that knows which panel it is (see ctxFor). */
  private ctx: Omit<PanelCtx, "editRow">;
  /** The data inspector pane, while it is open, and which fill of it is the latest. */
  private inspector: HTMLElement | undefined;
  private inspecting = 0;
  /** Which read of the note's text, to say why it has no keys, is the latest (see explainNoApp). */
  private explaining = 0;
  /** The card saying the properties don't parse, above the app as last drawn, while it shows there. */
  private yamlCard: HTMLElement | undefined;

  /** Without `hosting`, the app note at `appPath` opened on its own: its own grants, data note and `$this`. */
  constructor(root: HTMLElement, appPath: string, env: AppEnv, hosting?: Hosting) {
    this.root = root;
    this.appPath = appPath;
    this.env = env;
    this.hosting = hosting;
    this.grantKey = hosting?.grantKey ?? appPath;
    this.hostPath = hosting?.hostPath ?? appPath;
    this.memory = hosting?.memory ?? newMemory();
    this.writes = new AppWrites(env, {
      appPath, hostPath: this.hostPath, dataPath: () => this.dataPath, checklistName: (key) => this.checklistName(key), expect: () => this.spec?.expect ?? [],
      writesKind: (path) => this.wanted.includes(`kind-write:${path}`),
    });
    this.timers = new Timers(this.memory.timers, {
      panel: (key) => this.mounted.get(key),
      notify: (message) => this.env.notify(message),
      runActions: (p, row) => this.writes.runActions(p, row),
      redraw: (key) => this.redraw(key),
    });
    this.cards = { env, appPath, hostPath: this.hostPath, grantKey: this.grantKey, hosted: !!hosting, scope: hosting?.kind === "lens" ? hosting.scope : undefined, load: () => this.load() };
    this.readHost();
    this.shell = root.createDiv({ cls: "gizmo" });
    if (!hosting) this.rail = this.shell.createDiv({ cls: "gz-rail-slot" });
    const current = () => this.env;
    this.ctx = {
      get now() { return current().now(); },
      get readOnly() { return current().data.at !== undefined; },
      get whatIf() { return current().ahead?.live.now(); },
      width: (key) => this.widthOf(key),
      runActions: (p, row, how) => this.writes.runActions(p, row, how),
      ...(env.undo && { undo: (entry: string) => this.env.undo!(entry) }),
      toggleChecked: (key, item) => this.writes.toggleChecked(key, item),
      clearChecked: (key) => this.writes.clearChecked(key),
      openNote: (path) => this.env.openNote(path, this.appPath),
      preview: env.preview,
      timer: (key, p) => this.timers.state(key, p),
      startTimer: (key, p) => {
        this.timers.start(key, p);
        this.redraw(key);
      },
      pauseTimer: (key) => {
        this.timers.pause(key);
        this.redraw(key);
      },
      resetTimer: (key, p) => {
        this.timers.reset(key, p);
        this.redraw(key);
      },
      select: (name, row) => this.setSelection(name, row),
      selected: (name) => this.selections.get(name),
      alerts: env.alerts,
      reconcile: (p) => this.reconcileOf(p),
    };
  }

  /** Draws the app from scratch: on open, and after the user allows its permissions. */
  load(): void {
    this.destroyPanels();
    this.definition = "";
    this.reconcile();
    this.timers.resume();
    this.env.opened?.(this.appPath);
  }

  /** Looks again at what may have changed without a note changing: whether the app is allowed now. */
  recheck(): void {
    this.reconcile();
  }

  dispose(): void {
    this.inspector = undefined;
    this.explaining++;
    this.unsubscribe?.();
    this.removeBar();
    this.destroyPanels();
    this.timers.stop();
    if (this.refreshHandle) window.clearInterval(this.refreshHandle);
    if (this.resizeHandle) window.clearTimeout(this.resizeHandle);
    window.clearTimeout(this.aheadTimer);
    this.aheadChecks++;
    this.shell.remove();
  }

  /** Refetches this app's web sources; the panels that use them update when the data arrives. */
  reload(): void {
    this.env.data.forgetUrls([...this.mounted.values()].map((m) => m.source).filter(isUrl));
  }

  // ---- Data inspector -----------------------------------------------------------------------

  /**
   * The distinct sources of the panels on screen, each with the title of the first panel that uses
   * it and what it returned before any pick, where or other step. Loads through the data layer's
   * cache, so nothing is requested twice. Web addresses keep their `{secret:…}` placeholders.
   */
  async inspect(): Promise<InspectedSource[]> {
    return Promise.all([...this.sourceReaders().values()].map(async (m): Promise<InspectedSource> => {
      const found = { title: m.p.title ?? m.p.view, kind: sourceKind(m.source!, m.p.from), ...(isUrl(m.source) ? { source: m.source } : {}) };
      try {
        const data = await this.env.data.rawData(m.source, m.p, this.files(), { ttlMs: this.spec?.refreshMs ?? CACHE_MS, now: this.env.now() });
        return { ...found, data };
      } catch (e) {
        return { ...found, data: { error: (e as Error).message } };
      }
    }));
  }

  /** The first panel on screen that reads each distinct source, by its source (see sourceKey), in the order written. */
  private sourceReaders(): Map<string, Mounted> {
    const ids = this.spec ? panelIds(this.spec.panels.map((ps) => ps.template)) : [];
    const first = new Map<string, Mounted>();
    for (const m of ids.map((id) => this.mounted.get(id))) {
      if (!m || m.idle || !m.source) continue;
      const key = sourceKey(m);
      if (!first.has(key)) first.set(key, m);
    }
    return first;
  }

  /**
   * Where the time rail goes: an element that stays the same while the app is open, shown under the
   * app's title in the composed layout and left out on the grid. Undefined for a hosted app.
   */
  railSlot(): HTMLElement | undefined {
    return this.rail;
  }

  /**
   * Opens what is picked in the app in a side sheet beside it, as an app does in its own tab, in the
   * composed layout; `icon` draws an Obsidian icon. Call it before `load`. A hosted app keeps a pick
   * in its panel.
   */
  openInPlace(icon: DrawIcon): void {
    if (!this.hosting) this.sheet ??= new Sheet(this.shell, icon, () => this.closeSheet());
  }

  /** Closes the side sheet, taking its pick back and the focus to what was picked; false when it wasn't open. */
  closeSheet(): boolean {
    return this.shut(true);
  }

  /** Whether the inspector is showing. */
  get inspectorShown(): boolean {
    return this.inspector !== undefined;
  }

  /** Shows the inspector above the panels, or takes it away. */
  async toggleInspector(): Promise<void> {
    if (this.inspector) {
      this.inspector.remove();
      this.inspector = undefined;
      return;
    }
    this.openInspector();
    await this.fillInspector();
  }

  private openInspector(): void {
    const pane = this.shell.createDiv({ cls: "gz-card gz-inspector" });
    this.shell.insertBefore(pane, this.bar ?? this.grid ?? null);
    this.inspector = pane;
    pane.createDiv({ cls: "gz-empty", text: "Loading…" });
  }

  /** Fills the open inspector; `focus`, a panel's id, scrolls it to that panel's source. */
  private async fillInspector(focus?: string): Promise<void> {
    const pane = this.inspector;
    const run = ++this.inspecting;
    // In the order inspect gives the sources, read before it waits for any.
    const keys = [...this.sourceReaders().keys()];
    const sources = await this.inspect();
    if (!pane || pane !== this.inspector || run !== this.inspecting) return;
    const m = focus === undefined ? undefined : this.mounted.get(focus);
    const at = m?.source ? keys.indexOf(sourceKey(m)) : -1;
    renderInspector(pane, sources, (text) => this.env.copy(text), at < 0 ? undefined : at);
  }

  /** Opens Inspect data, or keeps it open, at the source of the panel with this id. */
  private async inspectPanel(id: string): Promise<void> {
    if (!this.inspector) this.openInspector();
    await this.fillInspector(id);
  }

  /** Puts the cursor on the line the panel is written on, in the note's source beside the app. */
  private async showPanelSource(id: string): Promise<void> {
    const m = this.mounted.get(id);
    if (!m) return;
    const line = panelLine(await this.env.sourceLines(), m.ps.label);
    if (line === undefined) this.env.showSource();
    else this.env.showSourceAt(line);
  }

  resize(): void {
    if (this.resizeHandle) window.clearTimeout(this.resizeHandle);
    this.resizeHandle = window.setTimeout(() => {
      const width = this.shell.clientWidth;
      if (Math.abs(width - this.width) < 8) return;
      this.width = width;
      this.layout(false);
      for (const [id, m] of this.mounted) m.handle.resize?.(this.widthOf(id));
      this.sheet?.keepUnderHeader();
    }, 150);
  }

  /** The drawing width inside a panel, from the layout's arithmetic rather than measuring it. */
  private widthOf(id: string): number {
    const width = this.shell.clientWidth;
    const m = this.mounted.get(id);
    if (this.composed) {
      if (m && this.sheet?.holds(m.el)) return this.sheet.innerWidth(width);
      return this.hosting ? composedWidth(width, HOSTED_PAD, HOSTED_MAX) : composedWidth(width);
    }
    return widthFor(m?.tracks ?? this.ownTracks(m?.span ?? MAX_COLUMNS), width, ...this.shellBox());
  }

  /** Whether the app is laid out by role in one column; the default, also before it's read. */
  private get composed(): boolean {
    return this.spec?.layout !== "grid";
  }

  /** The tracks a span takes before its row is known, as if nothing beside it grew. */
  private ownTracks(span: number): number {
    return spanOn(span, this.columns) * (TRACKS / this.columns);
  }

  /** The shell's padding and widest width: an app in an embed or a lens has neither of its own (see styles.css). */
  private shellBox(): [pad: number, max: number] {
    return this.hosting ? [HOSTED_PAD, HOSTED_MAX] : [APP_PAD, APP_MAX];
  }

  /**
   * Sets the column count, each shown panel's tracks and every panel's visibility as classes. A
   * panel whose width changed is drawn again at it, unless the caller redraws them all. In the
   * composed layout, every panel is as wide as the column, so only the open tab's pane is set, and
   * whether the app is narrow.
   */
  private layout(redraw = true): void {
    if (this.composed) {
      this.shell.classList.toggle("gz-narrow", isNarrow(this.shell.clientWidth));
      for (const [tab, pane] of this.panes) pane.classList.toggle("gz-off", tab !== this.activeTab);
    } else {
      this.layoutGrid(redraw);
    }
    for (const b of this.tabs?.querySelectorAll("button") ?? []) b.classList.toggle("is-active", b.textContent === this.activeTab);
  }

  private layoutGrid(redraw: boolean): void {
    this.columns = columnsFor(this.shell.clientWidth, ...this.shellBox());
    if (!this.grid) return;
    this.grid.className = `gz-grid gz-cols-${this.columns}`;
    for (const m of this.mounted.values()) m.el.classList.toggle("gz-off", m.tab !== undefined && m.tab !== this.activeTab);
    const byEl = new Map([...this.mounted.values()].map((m) => [m.el as Element, m]));
    const shown = [...this.grid.children].filter((el) => !el.classList.contains("gz-off")).map((el) => byEl.get(el));
    // Only a panel that asked for no span may grow into the room its row leaves.
    const tracks = rowTracks(shown.map((m) => (m ? { span: m.span, grows: m.p.span === undefined } : null)), this.columns);
    shown.forEach((m, i) => {
      if (!m) return;
      const before = m.tracks ?? this.ownTracks(m.span);
      m.tracks = tracks[i]!;
      for (const c of [...m.el.classList]) if (c.startsWith("gz-span-")) m.el.classList.remove(c);
      m.el.classList.add(`gz-span-${m.tracks}`);
      if (redraw && before !== m.tracks) m.handle.resize?.(this.widthOf(m.id));
    });
  }

  // ---- Definition ---------------------------------------------------------------------------

  /** Draws the app again if its keys changed, and fills an open inspector anew with it. */
  private reconcile(): void {
    const before = this.definition;
    this.draw();
    if (this.inspector && this.definition !== before) void this.fillInspector();
  }

  /** Brings the drawn app in line with the note's keys, keeping panels whose keys didn't change. */
  private draw(): void {
    const moved = this.readHost();
    const h = this.hosting;
    const fm = (h ? h.definition() : this.env.frontmatter(this.appPath)) ?? {};
    // In an embed or a lens (not one showing an app as that app), `save: this` writes the note it sits in.
    const opts = { now: this.env.now(), notes: this.env.notes, path: this.appPath, host: h && h.kind !== "app" ? { scope: h.scope } : undefined };
    // A component note opened on its own shows how to use it, and a preview when it can.
    const component: ComponentPreview | undefined = !h && isComponent(fm) ? readComponentPreview(fm, opts) : undefined;
    const read = component?.result ?? readSpec(fm, opts);
    // An embed showing some of an app's panels asks for what the whole app asks for, as the app does.
    const picked = read?.spec && h?.panels ? pickPanels(read.spec, h.panels, `[[${basename(this.appPath)}]]`) : undefined;
    const result = read && picked ? { ...read, errors: [...read.errors, ...picked.errors] } : read;
    const wanted = read?.spec ? permissionsOf(read.spec, this.appPath) : [];
    this.wanted = wanted;
    const dataPath = h?.dataPath ?? dataPathOf((picked?.spec ?? result?.spec)?.store, this.appPath, (store, from) => this.env.storePath(store, from));
    const lensScope = h?.kind === "lens" ? h.scope : undefined;
    const verdict = read?.spec ? this.env.verdict?.(read.spec, wanted, { appPath: this.appPath, dataPath, hostPath: this.hostPath, lensScope }) : undefined;
    const blocked = verdict?.violations.length ? verdict.violations.map(violationText) : undefined;
    const granted = !blocked && this.env.isGranted(this.grantKey, wanted, verdict?.asked);
    // The kinds it reads whose own notes aren't allowed yet, said in its own tab once it is allowed itself.
    const toAllow = granted && !h && !component && read?.spec ? this.kindsToAllow(read.spec) : [];
    // The app is its own keys plus those of every component it uses, and whether it may run.
    // The blocked card says whether the policy note waits to be applied.
    const pending = blocked ? this.env.policyPending?.() ?? false : false;
    const definition = JSON.stringify([fm, result?.spec?.read ?? null, granted, blocked ?? null, verdict?.asked ?? null, pending, toAllow]);
    if (definition === this.definition) {
      if (moved) this.refillHostReaders();
      // Properties that don't parse read as no keys at every save, so the note's text is read again.
      if (!result && !h) void this.explainNoApp(definition);
      return;
    }
    this.definition = definition;
    // Properties that don't parse leave Obsidian with no keys at all, as if there were no app line:
    // the note's text tells which, and what is drawn stays as it is until then.
    if (!result && !h) return void this.explainNoApp(definition);
    this.adopt(picked?.spec ?? result?.spec, result?.spec?.links ?? [], dataPath);
    const composed = this.composed;

    const header = this.freshHeader();
    const past = this.env.data.at;
    if (past !== undefined && this.spec) {
      const now = shownAsNow(this.spec);
      const banner = header.createDiv({ cls: "gz-card gz-past" });
      // Beside the time rail, which names the moment, CSS hides the date and the banner reads "Read only."
      const said = banner.createSpan({ cls: "gz-past-text" });
      said.createSpan({ cls: "gz-past-when", text: `As of ${pastText(past)}: ` });
      said.append(`read only.${now.length ? ` Shown as they are now, since their notes keep no history: ${now.join(", ")}.` : ""}`);
      const back = this.env.backToNow;
      if (back) banner.createEl("button", { cls: "gz-past-back", text: "Back to now" }).addEventListener("click", () => back());
    }
    const ahead = this.env.ahead;
    this.aheadCard = ahead && this.spec ? renderAheadCard(header, ahead, readAsNow(this.spec), this.aheadActions()) : undefined;

    if (!result) {
      // A lens whose note no longer fills its params shows nothing until it is taken away.
      if (h?.kind === "app") header.createDiv({ cls: "gz-card", text: `[[${basename(this.appPath)}]] isn't an app (it has no app: line)` });
      return this.showOnly(header);
    }
    const description = this.spec?.description ?? textOf(fm.app ?? "");
    let railAfter: HTMLElement | undefined;
    if (composed && !h) {
      // In its own tab the app reads as a page: its name and what it's for, then the time rail.
      const head = createDivIn(header, "gz-head");
      header.prepend(head);
      head.createDiv({ cls: "gz-app-title", text: basename(this.appPath) });
      if (description) head.createDiv({ cls: "gz-description", text: description });
      railAfter = head;
    } else if (description) {
      header.createDiv({ cls: "gz-description", text: description });
    }
    if (component) renderUsage(header, component, this.cards);
    if (result.empty) {
      renderEmpty(header, this.cards);
      return this.showOnly(header);
    }
    if (result.errors.length) renderErrors(header, result.errors, this.cards);
    const spec = this.spec;
    if (!spec?.panels.length || component?.missing.length || component?.lens) return this.showOnly(header);

    if (blocked) {
      renderBlocked(header, blocked, pending, this.cards);
      return this.showOnly(header);
    }
    if (!granted) {
      if (h?.kind === "app") renderOpenOnce(header, this.cards);
      else renderPermissionPrompt(header, verdict?.asked ?? wanted, askersOf(read!.spec!, this.appPath), this.cards, verdict?.covered.length ?? 0);
      return this.showOnly(header);
    }
    // The rail goes in only once the app shows, not above an error or a question.
    if (railAfter && this.rail) header.insertBefore(this.rail, railAfter.nextSibling);
    for (const k of toAllow) renderKindToAllow(header, k, this.cards);

    // An app opened in its own tab has been seen; the background acts only for those, even when they ask for nothing.
    if (!h && !component) {
      const before = this.env.granted(this.appPath);
      // What it was allowed and no longer asks for goes, so asking for it again later asks the person again.
      const kept = before?.filter((p) => wanted.includes(p));
      if (before === undefined ? (verdict?.asked ?? wanted).length === 0 : kept!.length !== before.length) void this.env.grant(this.appPath, kept ?? []);
    }
    // Another layout draws every panel afresh in it.
    if (this.grid && this.gridLayout !== spec.layout) this.destroyPanels();
    this.setRefresh(spec);
    for (const name of [...this.selections.keys()]) if (!spec.selections.includes(name)) this.selections.delete(name);
    if (!this.grid) this.grid = this.shell.createDiv({ cls: composed ? "gz-body" : "gz-grid" });
    this.sheet?.place(composed ? this.shell : undefined);
    this.gridLayout = spec.layout;
    this.columns = columnsFor(this.shell.clientWidth, ...this.shellBox());
    this.syncInputs(spec);
    const ids = panelIds(spec.panels.map((ps) => ps.template));
    // Placed before any panel is mounted, so a view can ask for its place as it first draws.
    const composition = composed ? compose(spec.panels, spec.selections) : undefined;
    const placedBefore = this.placements;
    this.placements = new Map(composition ? ids.map((id, i) => [id, composition.placements[i]]) : []);
    const keep = new Set(ids);
    for (const [id, m] of this.mounted) {
      if (!keep.has(id)) {
        m.handle.destroy?.();
        m.el.remove();
        this.mounted.delete(id);
        this.timers.forget(id);
      }
    }
    const files = this.files();
    const order = ids.map((id, i) => {
      const existing = this.mounted.get(id);
      const m = existing ?? this.mount(id, spec.panels[i], files);
      // A kept panel may read a list typed into the app note, or the store may have moved.
      if (existing && m.source) {
        m.deps = this.env.data.depsOf(m.source, m.p, files);
        void this.loadPanel(m);
      }
      // A kept panel whose place changed is drawn again for it, once its data is there.
      if (existing && !m.idle && stableJson(placedBefore.get(id)) !== stableJson(this.placements.get(id))) {
        m.remount = true;
        if (!m.source) this.show(m, undefined);
      }
      return m;
    });
    // Panels without a tab come first and stay visible; the tab bar sits between them and the rest.
    const tabNames = [...new Set(order.map((m) => m.tab).filter((t): t is string => t !== undefined))];
    if (!this.activeTab || !tabNames.includes(this.activeTab)) this.activeTab = tabNames[0];
    this.tabs?.remove();
    // A block showing some panels of an app, all from one of its tabs, has no other tab to pick.
    const oneTab = tabNames.length === 1 && this.hosting?.panels !== undefined;
    this.tabs = tabNames.length && !oneTab ? this.renderTabs(tabNames) : undefined;
    if (composition) {
      this.arrange(composition.scopes, order);
    } else {
      for (const m of order) if (m.tab === undefined) this.grid.appendChild(m.el);
      if (this.tabs) this.grid.appendChild(this.tabs);
      for (const m of order) if (m.tab !== undefined) this.grid.appendChild(m.el);
    }
    this.layout();
    this.subscribe();
    if (moved) this.refillHostReaders();
    // Laid out again, the panels the sheet holds are back in their slots.
    if (this.sheet?.from !== undefined && !this.mounted.has(this.sheet.from)) this.closeSheet();
    else this.seat();
  }

  /**
   * The kinds this app reads or saves to whose own notes aren't allowed yet: never opened, asking for
   * more than was allowed, or blocked by the data policy. The app shows their rows, but each kind's
   * own work (its import folders, its asks in Next) waits until it is, as anything unseen does.
   */
  private kindsToAllow(spec: AppSpec): KindToAllow[] {
    if (this.env.data.at !== undefined || this.env.ahead || this.env.preview) return [];
    const paths = spec.panels.flatMap(({ panel: p }) => [p.kind?.path, p.target?.kind === "list" ? p.target.at : undefined]);
    return [...new Set(paths)].flatMap((path) => {
      const k = path === undefined || path === this.appPath ? undefined : this.kindToAllow(path);
      return k ? [k] : [];
    });
  }

  /** A kind note as kindsToAllow says it; undefined when it is allowed, or isn't a kind. */
  private kindToAllow(path: string): KindToAllow | undefined {
    const env = this.env;
    const fm = env.frontmatter(path);
    const kind = fm ? readSpec(fm, { now: env.now(), notes: env.notes, path })?.spec : undefined;
    if (!kind?.kind) return undefined;
    const wanted = permissionsOf(kind, path);
    const verdict = env.verdict?.(kind, wanted, { appPath: path, dataPath: defaultDataPath(path), hostPath: path });
    const blocked = !!verdict?.violations.length;
    // The background acts only for a note that was allowed, which an opened one is even when it asks for nothing.
    if (!blocked && env.granted(path) !== undefined && env.isGranted(path, wanted, verdict?.asked)) return undefined;
    const asked = verdict?.asked ?? wanted;
    const folders = kind.kind.imports.flatMap((m) => (m.folder === undefined ? [] : [m.folder]));
    const reads = new Set(folders.map((f) => `read:${f}`));
    const adds = [
      ...folders.map((f) => `Read each file in ${f} into its rows, now and as new ones come`),
      ...asked.filter((p) => !reads.has(p)).map(describePermission),
      `Ask in Next about a planned row whose time passed with nothing settling it${folders.length ? ", and about rows from a file to check" : ""}`,
    ];
    return { path, name: basename(path), adds, asked, blocked };
  }

  /** Takes in what the keys say now: the app, the components it links to, where its data is kept, and its layout. */
  private adopt(spec: AppSpec | undefined, links: string[], dataPath: string): void {
    this.links = links;
    this.spec = spec;
    this.dataPath = dataPath;
    // The app's own note, as it is now: not a block or a lens of it, a try, the past or a what-if.
    if (spec && !this.hosting && !this.env.preview && this.env.data.at === undefined && !this.env.ahead) void this.env.definitions?.seen(this.appPath, panelsOf(spec.panels));
    const composed = this.composed;
    this.shell.classList.toggle("gz-composed", composed);
    this.shell.classList.toggle("gz-narrow", composed && isNarrow(this.shell.clientWidth));
  }

  /** Takes away what was drawn above the panels, brings back what was faded, and puts an empty header on top. */
  private freshHeader(): HTMLElement {
    for (const el of [...this.shell.children]) if (el !== this.grid && el !== this.bar && el !== this.inspector && el !== this.sheet?.el) el.remove();
    this.yamlCard = undefined;
    this.fade(false);
    this.rail?.remove();
    const header = createDivIn(this.shell, "gz-header");
    this.shell.prepend(header);
    return header;
  }

  /** Fades all that is drawn and puts it out of reach, with no clicks and no focus; or brings it back. */
  private fade(on: boolean): void {
    for (const el of this.shell.children) {
      el.classList.toggle("gz-faded", on);
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  }

  /**
   * Says why a note opened as an app has no keys, from its text. When its properties don't parse,
   * a card says where; an app drawn before stays under it as it was, faded and out of reach, so
   * nothing jumps while the person types, and it comes back with the next save that parses.
   * Otherwise the note has no app line.
   */
  private async explainNoApp(definition: string): Promise<void> {
    const run = ++this.explaining;
    const lines = await this.env.sourceLines().catch(() => []);
    if (run !== this.explaining || definition !== this.definition) return;
    const problem = yamlProblem(lines, (text) => this.env.data.host.parseYaml(text));
    if (problem && this.grid) {
      this.unsubscribe?.();
      // The panels wait as drawn; their data is read again once the keys parse.
      this.unsubscribe = this.env.data.subscribe(this.definitionDeps(), () => this.reconcile());
      this.yamlCard?.remove();
      this.fade(true);
      this.yamlCard = createDivIn(this.shell, "gz-header");
      this.shell.prepend(this.yamlCard);
      renderYamlError(this.yamlCard, problem, this.cards);
      return;
    }
    this.adopt(undefined, [], this.dataPath);
    const header = this.freshHeader();
    if (problem) renderYamlError(header, problem, this.cards);
    else header.createDiv({ cls: "gz-card", text: "This note has no app key." });
    this.showOnly(header);
  }

  /**
   * Lays the panels out by role, scope by scope: the panels outside any tab, then the tab bar, then
   * each tab in a pane of its own. A scope is its answer, the line to add things, then the rest in
   * the order written, ending with the panels that wait for a pick; a part with no panels is left out.
   */
  private arrange(scopes: Scope[], order: Mounted[]): void {
    const body = this.grid!;
    body.empty();
    this.panes.clear();
    this.slots.clear();
    for (const m of order) placeClasses(m.el, this.placements.get(m.id)!);
    const el = (i: number) => order[i].el;
    for (const scope of scopes) {
      let into = body;
      if (scope.tab !== undefined) {
        if (this.tabs && this.tabs.parentElement !== body) body.appendChild(this.tabs);
        into = createDivIn(body, "gz-tabpane");
        this.panes.set(scope.tab, into);
      }
      const { headline, facts, meters } = scope.answer;
      if (headline !== undefined) {
        const band = into.createEl("section", { cls: "gz-answer" });
        // A meter is drawn under its number, in the same slot; panels are never put inside one another.
        const slot = (parent: HTMLElement, i: number) => {
          const s = createDivIn(parent, "gz-slot");
          s.appendChild(el(i));
          const meter = meters.get(i);
          if (meter !== undefined) {
            s.addClass("gz-metered");
            s.appendChild(el(meter));
          }
        };
        slot(band, headline);
        if (facts.length) {
          const row = createDivIn(band, "gz-facts");
          for (const i of facts) slot(row, i);
        }
      }
      if (scope.compose.length) {
        const line = into.createEl("section", { cls: "gz-compose" });
        for (const i of scope.compose) line.appendChild(el(i));
      }
      if (scope.flow.length || scope.sheet.length) {
        const flow = createDivIn(into, "gz-flow");
        for (const i of scope.flow) flow.appendChild(el(i));
        if (scope.sheet.length) {
          const sheet = createDivIn(flow, "gz-sheet-slot");
          for (const i of scope.sheet) {
            sheet.appendChild(el(i));
            this.slots.set(order[i].id, sheet);
          }
        }
      }
    }
  }

  /** Keeps each input's value while it's still allowed, starts new ones, and draws the bar. */
  private syncInputs(spec: AppSpec): void {
    const start = startingValues(spec.inputs, this.env.now());
    const kept: Record<string, InputValue> = {};
    for (const def of spec.inputs) {
      const v = this.values[def.name];
      const ok = v !== undefined && (def.kind === "choice" ? def.options.includes(v) : typeof v === "string");
      if (ok) kept[def.name] = v;
      else if (def.name in start) kept[def.name] = start[def.name];
    }
    this.values = kept;
    const barFor = JSON.stringify(spec.inputs);
    if (this.bar && barFor === this.barFor) return;
    this.removeBar();
    if (spec.inputs.length === 0) return;
    const today = () => stampParts(this.env.now()).date;
    this.bar = renderInputBar(this.shell, spec.inputs, this.values, today, (name, value) => this.setInput(name, value));
    this.barFor = barFor;
    this.shell.insertBefore(this.bar, this.grid!);
  }

  private removeBar(): void {
    this.bar?.remove();
    this.bar = undefined;
    this.barFor = "";
  }

  /** Every value a panel may read: the inputs', then the selections, and the note the app sits in. */
  private current(): Record<string, unknown> {
    return { ...this.values, ...Object.fromEntries(this.selections), [THIS]: this.host };
  }

  /** Reads `$this` again; true when it changed. */
  private readHost(): boolean {
    const host = thisValues(this.hostPath, this.env.frontmatter(this.hostPath), this.env.data.host.tags(this.hostPath));
    const json = JSON.stringify(host);
    if (json === this.hostJson) return false;
    this.host = host;
    this.hostJson = json;
    return true;
  }

  /** Fills again the panels a change to `$this` changes; one whose values stayed the same is left as it is. */
  private refillHostReaders(): void {
    const values = this.current();
    for (const m of this.mounted.values()) {
      if (!m.ps.inputs.includes(THIS)) continue;
      const r = resolvePanel(m.ps, values);
      if (!m.idle && r.panel && stableJson(r.panel) === stableJson(m.p)) continue;
      this.refill(m);
    }
    this.subscribe();
  }

  private setInput(name: string, value: InputValue): void {
    // A search box applies typing after a pause, which may end after its bar is gone.
    if (!this.bar) return;
    // An empty search box has no value, so the panels that read it wait.
    const typed = this.spec?.inputs.some((d) => d.name === name && d.kind === "text");
    const next = typed && value === "" ? undefined : value;
    if (this.values[name] === next) return;
    if (next === undefined) delete this.values[name];
    else this.values[name] = next;
    this.refillReaders(name);
  }

  /** Only names the app declares are kept; a view can't make up a selection. */
  private setSelection(name: string, row: Row | undefined): void {
    if (!this.spec?.selections.includes(name) || this.selections.get(name) === row) return;
    if (row) this.selections.set(name, row);
    else this.selections.delete(name);
    this.refillReaders(name);
  }

  private refillReaders(name: string): void {
    for (const m of this.mounted.values()) if (m.ps.inputs.includes(name)) this.refill(m);
    this.subscribe();
  }

  /** Fills a panel's inputs again; its old content stays, dimmed, until the new data arrives. */
  private refill(m: Mounted): void {
    const r = resolvePanel(m.ps, this.current());
    if (!r.panel) return this.halt(m, r.waiting, r.errors);
    m.idle = false;
    m.p = r.panel;
    m.source = sourceOf(m.p);
    m.deps = this.env.data.depsOf(m.source, m.p, this.files());
    m.remount = true;
    m.el.addClass("gz-stale");
    if (m.source) void this.loadPanel(m);
    else this.show(m, undefined);
  }

  private renderTabs(names: string[]): HTMLElement {
    const bar = this.grid!.createDiv({ cls: "gz-tabs" });
    bar.setAttr("role", "tablist");
    for (const name of names) {
      const b = bar.createEl("button", { cls: "gz-tab", text: name });
      b.setAttr("role", "tab");
      b.addEventListener("click", () => {
        // What the sheet shows was picked in the tab being left.
        if (name !== this.activeTab) this.closeSheet();
        this.activeTab = name;
        this.layout();
      });
    }
    return bar;
  }

  private showOnly(header: HTMLElement): void {
    this.destroyPanels();
    this.removeBar();
    this.unsubscribe?.();
    // Still listen to the app note and its components, so fixing their keys redraws the app.
    this.unsubscribe = this.env.data.subscribe(this.definitionDeps(), () => this.reconcile());
    if (header.parentElement !== this.shell) this.shell.prepend(header);
  }

  /**
   * The notes the app's definition comes from: its own, and each component it links to by name;
   * and the note it sits in, which `$this` reads (and a lens's params).
   */
  private definitionDeps(): string[] {
    const host = this.hostPath === this.appPath ? [] : [fileDep(this.hostPath)];
    return [fileDep(this.appPath), ...host, ...this.links.map(nameDep)];
  }

  private destroyPanels(): void {
    for (const m of this.mounted.values()) m.handle.destroy?.();
    this.mounted.clear();
    this.grid?.remove();
    this.grid = undefined;
    this.gridLayout = undefined;
    this.panes.clear();
    this.slots.clear();
    this.sheet?.reset();
    this.shell.removeClass("gz-sheet-open");
    this.tabs = undefined;
    if (this.refreshHandle) window.clearInterval(this.refreshHandle);
    this.refreshHandle = undefined;
  }

  private files(): AppFiles {
    return { appPath: this.appPath, dataPath: this.dataPath, hostPath: this.hostPath, ...(this.spec?.split && { devices: devicesFolder(this.dataPath) }) };
  }

  private subscribe(): void {
    this.unsubscribe?.();
    const definition = this.definitionDeps();
    const deps = new Set(definition);
    for (const m of this.mounted.values()) for (const d of m.deps) deps.add(d);
    const kept = [fileDep(this.dataPath), folderDep(logFolder(this.dataPath))];
    for (const d of kept) deps.add(d);
    // Shown ahead, a what-if row may go to a kind no panel reads.
    if (this.env.ahead && this.spec) for (const n of whatIfNotes(this.spec, this.appPath, this.dataPath)) deps.add(folderDep(logFolder(n.dataPath)));
    // An embed's keys are in its block, not in the note it names as its path.
    const self = this.hosting?.kind === "embed" ? "" : fileDep(this.appPath);
    this.unsubscribe = this.env.data.subscribe(deps, (changed) => {
      // Lists typed into the app note are part of its definition, so a change there is
      // handled by reconcile, which reloads the panels it keeps.
      if (definition.some((d) => changed.has(d))) this.reconcile();
      for (const m of this.mounted.values()) {
        if (m.source && m.deps.some((d) => d !== self && changed.has(d))) void this.loadPanel(m);
      }
      if (this.env.ahead) this.aheadSoon();
      if (!kept.some((d) => changed.has(d))) return;
      void this.checkHandEdit();
      void this.checkRenames();
      void this.checkReconcile();
    });
    void this.checkHandEdit();
    void this.checkRenames();
    void this.checkReconcile();
    void this.checkAhead();
  }

  /** What the what-if's card does, through the app shown ahead; Keep's Undo through the app as it is now. */
  private aheadActions(): AheadActions {
    const env = this.env;
    const live = env.ahead!.live;
    return {
      remove: async ({ note, list, row }) => {
        const done = await env.store!(note.dataPath, note.owner).delete(list, { id: rowIdOf(row), shown: row });
        if ("refused" in done) env.notify("That what-if row is gone");
      },
      keep: (rows) => keep(env, this.appPath, rows),
      discard: () => discard(env, whatIfNotes(this.spec!, this.appPath, this.dataPath)),
      ...(live.undo && { undo: (entry: string) => live.undo!(entry) }),
      ...(env.backToNow && { back: env.backToNow }),
    };
  }

  /** Fills the what-if's card again once changes stop coming. */
  private aheadSoon(): void {
    window.clearTimeout(this.aheadTimer);
    this.aheadTimer = window.setTimeout(() => void this.checkAhead(), 50);
  }

  /** Shown ahead: the what-if rows there are now, and what the app's alerts and rules would do on the way to the time shown. */
  private async checkAhead(): Promise<void> {
    const env = this.env;
    const ahead = env.ahead;
    const spec = this.spec;
    const card = this.aheadCard;
    const ledger = env.data.ledger;
    const check = ++this.aheadChecks;
    if (!ahead || !spec || !card || !ledger) return;
    const notes = whatIfNotes(spec, this.appPath, this.dataPath);
    const rows = await whatIfRows(ledger, notes, (path) => env.frontmatter(path));
    const watches = spec.panels.some((ps) => ps.panel.alert !== undefined) || spec.expect.some((r) => r.kind !== "value");
    const r = watches ? await lookAhead(env, ahead.live.data, spec, this.files(), notes).catch(() => undefined) : undefined;
    if (check !== this.aheadChecks || card !== this.aheadCard) return;
    ahead.marked?.(rows.map((r) => toTime(r.row.at)).filter((t): t is number => t !== undefined));
    card.fill({ rows, ...(r && { lines: aheadLines(r, spec, ahead.live.now(), this.current()), ...(r.cut && { cutAt: r.to }) }), errors: r?.errors ?? [] });
  }

  /**
   * In a kind's own tab, as it is now: the rows read from a file that no one accepted or set aside
   * yet, how they pair with what was logged, and a way to settle them.
   */
  private async checkReconcile(): Promise<void> {
    const ledger = this.env.data.ledger;
    const kind = this.spec?.kind;
    const check = ++this.reconcileChecks;
    if (!ledger || !this.env.store || this.hosting || this.env.preview || this.env.data.at !== undefined || this.env.ahead || !kind) return;
    const state = await ledger.state(this.dataPath, this.env.frontmatter(this.appPath) ?? {});
    if (check !== this.reconcileChecks || kind !== this.spec?.kind) return;
    this.reconcileCard?.remove();
    this.reconcileCard = undefined;
    const r = reconcileOf(state.lists.get(kind.name)?.rows ?? [], kind.match);
    const header = this.shell.querySelector<HTMLElement>(".gz-header");
    if (!r || !header) return;
    this.reconcileCard = renderReconcile(header, r, Object.keys(kind.fields), {
      accept: (open) => this.writes.settleRows(kind.name, open, false, kind.match),
      dismiss: (row) => this.writes.settleRows(kind.name, [{ row }], true),
    });
  }

  /**
   * What `view: reconcile` shows of the kind its panel reads, as the kind's own note does (see
   * checkReconcile), with Accept and Not mine writing there; undefined where nothing may be changed.
   */
  private async reconcileOf(p: Panel): Promise<Awaited<ReturnType<NonNullable<PanelCtx["reconcile"]>>>> {
    const env = this.env;
    const ledger = env.data.ledger;
    const ref = p.kind;
    if (!ledger || !ref || env.data.at !== undefined || env.ahead || env.preview) return undefined;
    const kindFm = env.frontmatter(ref.path);
    const state = await ledger.state(kindFiles(ref).dataPath, kindFm ?? {});
    const rule = ruleOf(kindFm);
    const card = reconcileOf(state.lists.get(ref.name)?.rows ?? [], rule);
    const waiting = card ? undefined : await this.unread(ref.path, state);
    return {
      card,
      ...(waiting && { waiting }),
      fields: Object.keys(isPlainObject(kindFm?.fields) ? kindFm.fields : {}),
      accept: (open) => this.writes.settleRows(ref.name, open, false, rule, p),
      dismiss: (row) => this.writes.settleRows(ref.name, [{ row }], true, {}, p),
    };
  }

  /**
   * Files in a kind's import folders that hold rows the kind doesn't have (nor had and lost to an
   * undo), while the kind isn't allowed to read them: said so; undefined when none waits.
   */
  private async unread(kindPath: string, state: { lists: Map<string, { rows: Row[] }>; gone(list: string, id: string): boolean }): Promise<string | undefined> {
    const k = this.kindToAllow(kindPath);
    const fm = this.env.frontmatter(kindPath);
    const kind = !k || k.blocked || !fm ? undefined : readSpec(fm, { now: this.env.now(), notes: this.env.notes, path: kindPath })?.spec?.kind;
    if (!k || !kind) return undefined;
    const has = new Set((state.lists.get(kind.name)?.rows ?? []).map(rowIdOf));
    const files: string[] = [];
    for (const map of kind.imports) {
      for (const path of map.folder === undefined ? [] : (this.env.data.host.filesIn?.(map.folder) ?? []).filter(importable)) {
        const text = await this.env.data.host.readFile(path).catch(() => "");
        if (fileRowIds(kind, map, { path, text }, this.env.now()).some((id) => !has.has(id) && !state.gone(kind.name, id))) files.push(path);
      }
    }
    if (!files.length) return undefined;
    const where = [...new Set(files.map((f) => f.slice(0, f.lastIndexOf("/"))))].join(" and ");
    return files.length === 1 ? `${basename(files[0])} waits in ${where}; allow ${k.name} to read it.` : `${files.length} files wait in ${where}; allow ${k.name} to read them.`;
  }

  /** Says so when the data note was edited by hand since the app's log was last written into it, with Import and Discard. */
  private async checkHandEdit(): Promise<void> {
    const ledger = this.env.data.ledger;
    // Only where the app's lists are kept in the ledger; a lens keeps no data note of its own. A what-if changes no data note.
    if (!ledger || !this.env.store || this.hosting?.kind === "lens" || this.env.ahead) return;
    const dataPath = this.dataPath;
    const appFm = this.env.frontmatter(this.appPath) ?? {};
    const state = await ledger.state(dataPath, appFm);
    const ops = state.handEdited ? await ledger.importOps(dataPath, appFm) : [];
    if (this.dataPath !== dataPath) return;
    this.handEdit?.remove();
    this.handEdit = undefined;
    const header = this.shell.querySelector<HTMLElement>(".gz-header");
    if (!state.handEdited || !header) return;
    const checklists = new Set(this.spec?.panels.filter((ps) => ps.panel.view === "checklist").map((ps) => ps.panel.save ?? "checked"));
    const words = editWords(ops, checklists);
    this.handEdit = renderHandEdit(header, basename(dataPath), words.length ? words : ["its layout only"], {
      import: async () => {
        await ledger.write(dataPath, ops);
        await this.env.data.snapshotNow(dataPath, true);
      },
      discard: () => this.env.data.snapshotNow(dataPath, true),
    });
  }

  /**
   * In the app's own tab, as it is now, says so when its keys renamed a field, a choice or a list
   * that its saved rows still use, with a way to bring the rows along; unless the person chose to
   * leave that rename as it is. Read from the ledger's lists, as the panels are.
   */
  private async checkRenames(): Promise<void> {
    const ledger = this.env.data.ledger;
    const spec = this.spec;
    const check = ++this.renameChecks;
    if (!ledger || !this.env.store || this.hosting || this.env.preview || this.env.data.at !== undefined || this.env.ahead || !spec) return;
    const dataPath = this.dataPath;
    const appFm = this.env.frontmatter(this.appPath) ?? {};
    const state = await ledger.state(dataPath, appFm);
    if (check !== this.renameChecks || spec !== this.spec) return;
    this.renameCard?.remove();
    this.renameCard = undefined;
    const rename = findRenames(spec, state.lists, appFm).find((r) => !this.env.leftAlone?.(renameKey(this.appPath, r)));
    const header = this.shell.querySelector<HTMLElement>(".gz-header");
    if (!rename || !header) return;
    this.renameCard = renderRename(header, basename(dataPath), rename, {
      fix: () => this.writes.moveRenamed(rename),
      leave: () => {
        this.env.leaveAlone?.(renameKey(this.appPath, rename));
        void this.checkRenames();
      },
    });
  }

  private setRefresh(spec: AppSpec): void {
    if (this.refreshHandle) window.clearInterval(this.refreshHandle);
    // The past doesn't change, and a what-if reads only kept answers: nothing to fetch again.
    this.refreshHandle = spec.refreshMs && this.env.data.at === undefined && !this.env.ahead ? window.setInterval(() => this.reload(), spec.refreshMs) : undefined;
  }

  // ---- Panels -------------------------------------------------------------------------------

  private mount(id: string, ps: PanelSpec, files: AppFiles): Mounted {
    const r = resolvePanel(ps, this.current());
    // Unresolved, the checked panel stands in for layout; its title may hold check-time stand-ins.
    const p = r.panel ?? { ...ps.panel, title: plainTitle(ps) };
    const def = viewDef(p.view)!;
    const el = createDivIn(this.grid!, `gz-panel gz-view-${p.view}`);
    const source = r.panel ? sourceOf(p) : undefined;
    const m = {
      id, ps, p, def, el, source, remount: false, idle: false,
      span: p.span ?? def.span,
      tab: p.tab,
      deps: this.env.data.depsOf(source, p, files),
      seq: 0,
    } as Mounted;
    // Registered before mounting, so the view can ask for its width.
    this.mounted.set(id, m);
    if (!r.panel) {
      // The view is mounted once there is something to draw.
      m.handle = { update() {} };
      this.halt(m, r.waiting, r.errors);
      return m;
    }
    m.handle = mountView(def, el, p, this.ctxFor(id), id);
    if (source) {
      el.addClass("gz-loading");
      // A view that draws itself at once (a save: this form) fills in its values in place, so a
      // stand-in added beside it would never be taken away.
      if (!el.hasChildNodes()) {
        el.createDiv({ cls: "gz-title", text: p.title ?? p.label ?? "" });
        el.createDiv({ cls: "gz-empty", text: "Loading…" });
      }
      void this.loadPanel(m);
    } else {
      m.handle.update(undefined);
    }
    return m;
  }

  private async loadPanel(m: Mounted): Promise<void> {
    const seq = ++m.seq;
    const current = () => seq === m.seq && this.mounted.get(m.id) === m;
    const now = this.env.now();
    const fromDisk = () => this.env.data.cachedPanelData(m.source, m.p, this.files(), now);
    let answered = false;
    // A web response slow to come (memory is cold after a restart) is painted from disk meanwhile.
    window.setTimeout(() => {
      if (!answered && current()) void fromDisk().then((copy) => { if (copy && !answered && current()) this.show(m, copy.data, copy.at); });
    }, DISK_FIRST_MS);
    try {
      const raw = await this.env.data.rawData(m.source, m.p, this.files(), {
        ttlMs: this.spec?.refreshMs ?? CACHE_MS,
        now,
      });
      const data = compilePipeline(m.p, now)(raw);
      answered = true;
      if (!current()) return;
      this.show(m, data, undefined, this.canSayWhy ? { data: raw, now } : undefined);
    } catch (e) {
      answered = true;
      if (!current()) return;
      const copy = await fromDisk();
      if (!current()) return;
      if (copy) this.show(m, copy.data, copy.at);
      else this.showFailure(m, e);
    }
  }

  /** `asOf`: the data is a disk copy fetched then, and says so. `raw`: what the source gave for it. */
  private show(m: Mounted, data: unknown, asOf?: number, raw?: Mounted["raw"]): void {
    m.raw = raw;
    if (m.remount) {
      m.handle.destroy?.();
      m.el.empty();
      m.handle = mountView(m.def, m.el, m.p, this.ctxFor(m.id), m.id);
      m.remount = false;
    }
    m.el.removeClass("gz-loading", "gz-error", "gz-stale", "gz-collapsed");
    m.handle.update(data);
    this.markAsOf(m, asOf);
  }

  /**
   * Marks a panel that shows a disk copy with the copy's age, or clears the mark. CSS draws it from
   * the attribute, so it stays while a view redraws itself (a chart on resize).
   */
  private markAsOf(m: Mounted, at?: number): void {
    m.el.classList.toggle("gz-asof", at !== undefined);
    if (at === undefined) m.el.removeAttribute("data-asof");
    else m.el.setAttr("data-asof", asOfText(at, this.env.now().getTime()));
  }

  private showPanelError(m: Mounted, message: string): void {
    this.markAsOf(m);
    m.el.removeClass("gz-loading", "gz-stale", "gz-collapsed", "gz-form-line", "gz-form-fields");
    m.el.addClass("gz-error");
    m.el.empty();
    // The view's own elements are gone, so what it shows next is drawn afresh.
    m.remount = true;
    m.el.createDiv({ cls: "gz-title", text: m.p.title ?? m.p.view });
    m.el.createDiv({ text: message });
  }

  /**
   * A panel whose source failed, with no disk copy to show: why, in plain words, then Try again,
   * which loads the panel again, and Show in source where the note's source is at hand.
   */
  private showFailure(m: Mounted, e: unknown): void {
    this.showPanelError(m, failureText(e));
    // The past doesn't change, nor what was kept: trying again would show the same.
    const again = this.env.data.at === undefined && !this.env.ahead;
    if (!again && !this.canSayWhy) return;
    const actions = m.el.createDiv({ cls: "gz-actions" });
    if (again) {
      const b = actions.createEl("button", { cls: "gz-small", text: "Try again" });
      b.addEventListener("click", () => {
        b.disabled = true;
        m.el.addClass("gz-loading");
        void this.loadPanel(m);
      });
    }
    if (this.canSayWhy) actions.createEl("button", { cls: "gz-small", text: "Show in source" }).addEventListener("click", () => void this.showPanelSource(m.id));
  }

  /**
   * Stops a panel that can't load as it stands: it waits for a value (a placeholder says which), or
   * a value it was given can't be used (its error shows). Nothing reloads it until its values change.
   */
  private halt(m: Mounted, waiting: string | undefined, errors: string[]): void {
    m.idle = true;
    m.source = undefined;
    m.deps = [];
    m.remount = true;
    m.seq++;
    // A panel that stops shows none of its rows, so none of them stays open in the sheet.
    if (this.sheet?.from === m.id) this.closeSheet();
    if (waiting === undefined) return this.showPanelError(m, errors.join("; "));
    this.markAsOf(m);
    m.el.removeClass("gz-loading", "gz-error", "gz-stale", "gz-form-line", "gz-form-fields");
    m.el.empty();
    // In the composed layout a panel waiting for a pick is out of sight until there is one.
    const collapse = this.placements.get(m.id)?.slot === "sheet" && !!this.spec?.selections.includes(waiting);
    m.el.classList.toggle("gz-collapsed", collapse);
    if (collapse) return;
    const title = plainTitle(m.ps);
    if (title) m.el.createDiv({ cls: "gz-title", text: title });
    m.el.createDiv({ cls: "gz-waiting", text: this.waitingFor(waiting) });
  }

  /** What a waiting panel asks for: typing in a search box, or picking a row in the panel that selects. */
  private waitingFor(name: string): string {
    if (this.spec?.inputs.some((d) => d.name === name)) return `Type in “${name}”`;
    const picker = [...this.mounted.values()].find((x) => x.p.select === name && !x.idle);
    const ps = this.spec?.panels.find((s) => s.panel.select === name);
    const title = picker?.p.title ?? (ps && (plainTitle(ps) ?? ps.panel.view)) ?? typedName(name);
    return `Pick a row in “${title}”`;
  }

  private redraw(id: string): void {
    const m = this.mounted.get(id);
    if (m && !m.source && !m.idle) m.handle.update(undefined);
  }

  /** What the activity log calls a checklist: its panel's title, else the list it ticks into. */
  private checklistName(key: string): string {
    const m = [...this.mounted.values()].find((x) => x.p.view === "checklist" && (x.p.save ?? "checked") === key);
    return m?.p.title ?? m?.p.label ?? key;
  }

  /**
   * Whether a panel that shows nothing can say why: in an app's own tab, where the note's source
   * and Inspect data are at hand; not in an embed, a lens or a try.
   */
  private get canSayWhy(): boolean {
    return !this.hosting && !this.env.preview;
  }

  /** A panel's own view of the app: what every panel may ask, and edits that know whose rows they are. */
  private ctxFor(id: string): PanelCtx {
    return Object.assign(Object.create(this.ctx) as PanelCtx, {
      place: () => this.placements.get(id),
      editRow: (row: Row, field: string, value: unknown) => this.editRow(id, row, field, value),
      deleteRow: (row: Row) => this.deleteRow(id, row),
      theirs: (row: Row) => {
        const m = this.mounted.get(id);
        return m ? this.writes.theirs(m.p, row) : undefined;
      },
      setAside: (row: Row) => this.setAside(id, row),
      rowsWritable: () => {
        const m = this.mounted.get(id);
        return !m || this.writes.mayChange(m.p);
      },
      setProperty: (field: string, value: unknown) => this.setProperty(id, field, value),
      ...(this.env.explain && EXPLAINED.includes(this.mounted.get(id)?.p.view ?? "") && { explain: () => this.explainPanel(id) }),
      ...(this.canSayWhy && {
        why: {
          hasData: () => holdsData(this.mounted.get(id)?.raw?.data),
          trace: () => {
            const m = this.mounted.get(id)!;
            return tracePipeline(m.p, m.raw?.now ?? this.env.now(), m.raw?.data);
          },
          showInSource: () => void this.showPanelSource(id),
          seeAnswer: () => void this.inspectPanel(id),
        },
      }),
      // A panel that waits for a pick is shown in the sheet, and keeps its own picks there.
      ...(this.sheet && this.composed && this.placements.get(id)?.slot !== "sheet" && {
        open: (pick: SheetPick | undefined, redrawn?: boolean) => this.openSheet(id, pick, redrawn),
      }),
    });
  }

  // ---- Explain ------------------------------------------------------------------------------

  /** Opens the Explain window of the first figure the app shows, as `=` does; false when it shows none. */
  explainFirst(): boolean {
    const m = [...this.mounted.values()].find((x) => !x.idle && x.source && EXPLAINED.includes(x.p.view) && x.p.agg !== "streak");
    if (!m || !this.env.explain) return false;
    this.explainPanel(m.id);
    return true;
  }

  /**
   * Opens the Explain window of a panel's figure: its rows as shown, as they were at any past time
   * (read as As of… reads them), where each came from and, in an app's own tab as it is now, the
   * rows it may delete and what the figure could be pulled by.
   */
  private explainPanel(id: string): void {
    const m = this.mounted.get(id);
    if (!m || m.idle || !this.env.explain) return;
    const env = this.env;
    if (!env.explain) return;
    const open = (src: ExplainSource) => env.explain!(src);
    const opts = (now: Date) => ({ ttlMs: this.spec?.refreshMs ?? CACHE_MS, now });
    const raw = () => env.data.rawData(m.source, m.p, this.files(), opts(env.now()));
    // A property Pull just set reads at its new value here, before the app has drawn it again.
    let read = m.p;
    const shown = async () => explain(read, await raw(), env.now());
    const at = async (t: number): Promise<Explanation | undefined> => {
      const past = new DataLayer(env.data.host, { at: t, like: env.data });
      try {
        return explain(read, await past.rawData(m.source, m.p, this.files(), opts(new Date(t))), new Date(t));
      } finally {
        past.dispose();
      }
    };
    const saved = editableSource(m.p) === "list";
    const ref = kindOfPanel(m.p);
    const dataPath = ref ? kindFiles(ref).dataPath : this.dataPath;
    const sourceRow = async (rowId: string) => {
      const data = await raw();
      return Array.isArray(data) ? (data as Row[]).find((r) => rowIdOf(r) === rowId) : undefined;
    };
    // Nothing is changed from the past, a what-if, a try, or a note the app is only shown in.
    const live = env.data.at === undefined && !env.ahead && !env.preview && !this.hosting;
    const undoOf = (entry: string | undefined) => (entry && env.undo ? { undo: () => env.undo!(entry) } : {});
    open({
      panel: m.p,
      now: env.now(),
      past: env.data.at !== undefined,
      shown,
      at,
      since: async (t) => {
        const [before, after] = await Promise.all([at(t), shown()]);
        return before && after ? waterfall(before, after) : undefined;
      },
      origins: async () => (saved && env.data.ledger ? env.data.ledger.origins(dataPath) : new Map()),
      keysSince: async (t) => {
        const index = this.spec?.panels.indexOf(m.ps) ?? -1;
        return index < 0 || this.hosting || !env.definitions ? [] : env.definitions.since(this.appPath, panelName(m.ps, index), t);
      },
      deviceName: (device) => env.deviceName?.(device),
      ...(live && saved && this.writes.mayChange(m.p) && {
        remove: async (part) => {
          const row = part.id === undefined ? undefined : await sourceRow(part.id);
          const done = row ? await this.writes.deleteRow(m, row, () => void this.loadPanel(m)) : undefined;
          return done ? { text: "Deleted the row.", ...undoOf(done.entry) } : { text: "The row wasn't deleted." };
        },
      }),
      ...(live && {
        pull: {
          knobs: async () => knobsOf(read, await raw(), env.now()).filter((k) => k.kind === "property" || (saved && this.writes.mayChange(m.p))),
          solve: async (knob, target) => solve(read, await raw(), env.now(), knob, target),
          keep: async (knob, value) => {
            if (knob.kind === "property") {
              const done = await this.writes.pullProperty(m, knob.name, value);
              if (!done.written) return { text: done.text };
              read = withProperty(read, knob.name, value);
              const back = undoOf(done.entry).undo;
              return {
                text: done.text,
                ...(back && { undo: async () => {
                  const said = await back();
                  read = withProperty(read, knob.name, knob.value);
                  return said;
                } }),
              };
            }
            const done = await this.writes.pullRow(m, knob.row, knob.field, value);
            return { text: done.text, ...undoOf(done.entry) };
          },
        },
      }),
    });
  }

  // ---- The side sheet -----------------------------------------------------------------------

  /**
   * What a pick in a panel does to the sheet: opens it, switching it from another panel's pick (which
   * goes, unless both panels pick into the same selection), or closes it when the pick was taken
   * back. A panel drawn again refreshes the sheet showing its pick, or closes it when the row isn't
   * shown any more.
   */
  private openSheet(id: string, pick: SheetPick | undefined, redrawn = false): void {
    const sheet = this.sheet!;
    const m = this.mounted.get(id);
    if (!m) return;
    const opened = { key: id, p: m.p, ctx: this.ctxFor(id) };
    if (redrawn) {
      if (sheet.from !== id) return;
      if (pick) sheet.refresh({ ...opened, pick });
      else this.closeSheet();
      return;
    }
    if (!pick) {
      if (sheet.from === id) this.shut(false);
      return;
    }
    const before = sheet.opened;
    if (before && before.key !== id && (before.p.select === undefined || before.p.select !== m.p.select)) {
      before.pick.clear();
      this.dropInnerPicks();
    }
    sheet.open({ ...opened, pick });
    this.shell.addClass("gz-sheet-open");
    this.seat();
  }

  /** Closes the sheet; `clear` takes its pick back (picking the element again already has). */
  private shut(clear: boolean): boolean {
    const sheet = this.sheet;
    const opened = sheet?.close();
    if (!sheet || !opened) return false;
    this.shell.removeClass("gz-sheet-open");
    if (clear) opened.pick.clear();
    this.dropInnerPicks();
    this.seat();
    const el = opened.pick.el as HTMLElement;
    if (el.isConnected) el.focus();
    return true;
  }

  /** Picks made in the panels the sheet holds go with the pick they read. */
  private dropInnerPicks(): void {
    for (const m of [...this.mounted.values()]) if (this.sheet!.holds(m.el) && m.p.select !== undefined) this.setSelection(m.p.select, undefined);
  }

  /**
   * Puts each panel that waits for a pick where it belongs: in the sheet when it reads what the sheet
   * shows, or what a panel already there selects; else in its slot at the end of the flow. Panels go
   * in the order written, and one that moves is drawn again at its new width.
   */
  private seat(): void {
    const sheet = this.sheet;
    const slots = [...this.slots].filter(([id]) => this.mounted.has(id));
    if (!sheet || !slots.length) return;
    const names = new Set<string>();
    const shown = sheet.opened?.p.select;
    if (shown !== undefined) names.add(shown);
    const inSheet = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id] of slots) {
        const m = this.mounted.get(id)!;
        if (inSheet.has(id) || !m.ps.inputs.some((n) => names.has(n))) continue;
        inSheet.add(id);
        if (m.p.select !== undefined) names.add(m.p.select);
        grew = true;
      }
    }
    const into = new Map<HTMLElement, Mounted[]>();
    for (const [id, slot] of slots) {
      const parent = inSheet.has(id) ? sheet.panels : slot;
      into.set(parent, [...(into.get(parent) ?? []), this.mounted.get(id)!]);
    }
    const moved = slots.filter(([id, slot]) => this.mounted.get(id)!.el.parentElement !== (inSheet.has(id) ? sheet.panels : slot));
    for (const [parent, ms] of into) {
      const children = [...parent.children];
      if (ms.length !== children.length || ms.some((m, i) => m.el !== children[i])) for (const m of ms) parent.appendChild(m.el);
    }
    for (const [id] of moved) {
      const m = this.mounted.get(id)!;
      if (!m.idle) m.handle.resize?.(this.widthOf(id));
    }
  }

  /** A panel's edits go through only while it is drawn and loaded; a changed row reloads it. */
  private editRow(id: string, row: Row, field: string, value: unknown): Promise<void> {
    const m = this.mounted.get(id);
    if (!m || m.idle) return Promise.resolve();
    return this.writes.editRow(m, row, field, value, () => void this.loadPanel(m));
  }

  private deleteRow(id: string, row: Row): Promise<{ entry?: string } | undefined> {
    const m = this.mounted.get(id);
    if (!m || m.idle) return Promise.resolve(undefined);
    return this.writes.deleteRow(m, row, () => void this.loadPanel(m));
  }

  private setAside(id: string, row: Row): Promise<{ entry?: string } | undefined> {
    const m = this.mounted.get(id);
    if (!m || m.idle) return Promise.resolve(undefined);
    return this.writes.setAside(m, row, () => void this.loadPanel(m));
  }

  private setProperty(id: string, field: string, value: unknown): Promise<void> {
    const m = this.mounted.get(id);
    if (!m || m.idle) return Promise.resolve();
    return this.writes.setProperty(m, field, value);
  }
}

/** What tells a panel's source apart from another's, for Inspect data: the same address with other headers or body is another. */
function sourceKey(m: Mounted): string {
  return JSON.stringify([m.source, m.p.from, m.p.headers, m.p.body]);
}

/** Whether a source gave anything: a row, or an answer with something in it. */
function holdsData(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0;
  if (data !== null && typeof data === "object") return Object.keys(data).length > 0;
  return data !== undefined && data !== null && data !== "";
}

function createDivIn(parent: HTMLElement, cls: string): HTMLElement {
  return parent.createDiv({ cls });
}

const PLACE_CLASS = /^gz-(role-.+|headline|fact|meter)$/;

/** A panel's role and, in the answer, its part of it, as classes in place of those it had. */
function placeClasses(el: HTMLElement, place: Placement): void {
  for (const c of [...el.classList]) if (PLACE_CLASS.test(c)) el.classList.remove(c);
  el.classList.add(`gz-role-${place.role}`);
  if (place.role === "answer") el.classList.add(`gz-${place.slot}`);
}
