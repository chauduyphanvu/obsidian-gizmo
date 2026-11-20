import { logFolder } from "./ledger.ts";
import type { DataStore } from "./datastore.ts";
import { violationText, type FlowWhere, type Verdict } from "./flows.ts";
import type { NewEntry } from "./activity.ts";
import { editWords, renderBlocked, renderEmpty, renderErrors, renderHandEdit, renderOpenOnce, renderPermissionPrompt, renderUsage, type CardApp } from "./app-cards.ts";
import { Timers } from "./app-timers.ts";
import { AppWrites } from "./app-writes.ts";
import { asOfText } from "./responses.ts";
import { stampParts, type Row } from "./data.ts";
import type { AppFiles, DataLayer } from "./datalayer.ts";
import { fileDep, folderDep, nameDep } from "./deps.ts";
import { stableJson } from "./hash.ts";
import { typedName, type NoteReader } from "./expand.ts";
import {
  isUrl, panelIds, pickPanels, readComponentPreview, readSpec, resolvePanel, startingValues, type ComponentPreview,
  type AppSpec, type Panel, type PanelSpec, type Then,
} from "./spec.ts";
import { askersOf, permissionsOf } from "./permissions.ts";
import { thisValues } from "./sources/this.ts";
import { THIS, type InputValue } from "./template.ts";
import { renderInputBar } from "./toolbar.ts";
import { renderInspector, sourceKind, type InspectedSource } from "./inspect.ts";
import { APP_MAX, APP_PAD, HOSTED_MAX, HOSTED_PAD, MAX_COLUMNS, columnsFor, spanOn, widthFor } from "./layout.ts";
import { basename, dataPathOf, devicesFolder, isComponent } from "./store.ts";
import { mountView } from "./views/common.ts";
import { sourceOf, viewDef, type PanelCtx, type PanelHandle, type TimerState, type ViewDef } from "./views/registry.ts";
import type { AlertFeed } from "./views/alerts.ts";

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
  /** Shows the note's source with the cursor at the start of this 0-based line. */
  showSourceAt(line: number): void;
  /** The note's text as it is now, line by line. */
  sourceLines(): Promise<string[]>;
  /** Puts text on the clipboard. */
  copy(text: string): void;
  /** Keeps what the app changed in the activity log. */
  log?(entry: NewEntry): void;
  /** Runs a panel's `then`: another app's shortcut, through the background service. */
  trigger?(fromPath: string, then: Then, ctx: Row): Promise<void>;
  now(): Date;
  /** Tells the background service the app was opened, so what it records is sampled if due. */
  opened?(appPath: string): void;
  /** Alerts true now across the vault, from the background service. */
  alerts?: AlertFeed;
  /** A try before Allow: nothing it draws may reach out of Obsidian (pictures are drawn as their address). */
  preview?: boolean;
  /** Opens the app on copies of its own notes before it's allowed; absent where that can't be offered. */
  tryFirst?(): void;
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
  tab: string | undefined;
  source: string | undefined;
  deps: string[];
  /** Bumped on every load so a slow, outdated response can't overwrite a newer one. */
  seq: number;
  /** An input it uses changed: draw it afresh once its new data arrives. */
  remount: boolean;
  /** Not loaded: it waits for a value, or a value it was given can't be used. */
  idle: boolean;
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
  private grid: HTMLElement | undefined;
  private mounted = new Map<string, Mounted>();
  private spec: AppSpec | undefined;
  private definition = "";
  private dataPath = "";
  private unsubscribe: (() => void) | undefined;
  private hosting: Hosting | undefined;
  /** The card saying the data note was edited by hand, while it is. */
  private handEdit: HTMLElement | undefined;
  private grantKey: string;
  private hostPath: string;
  /** What `$this` reads, and as JSON, to tell when it changed. */
  private host: Row = {};
  private hostJson = "";
  private memory: AppMemory;
  private timers: Timers;
  private writes: AppWrites;
  private cards: CardApp;
  private refreshHandle: ReturnType<typeof setInterval> | undefined;
  private resizeHandle: ReturnType<typeof setTimeout> | undefined;
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
  /** What every panel may ask; each gets its own copy that knows which panel it is (see ctxFor). */
  private ctx: Omit<PanelCtx, "editRow">;
  /** The data inspector pane, while it is open, and which fill of it is the latest. */
  private inspector: HTMLElement | undefined;
  private inspecting = 0;

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
      appPath, hostPath: this.hostPath, dataPath: () => this.dataPath, checklistName: (key) => this.checklistName(key),
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
    const self = this;
    this.ctx = {
      get now() { return self.env.now(); },
      width: (key) => this.widthOf(key),
      runActions: (p, row) => this.writes.runActions(p, row),
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
    this.unsubscribe?.();
    this.removeBar();
    this.destroyPanels();
    this.timers.stop();
    if (this.refreshHandle) clearInterval(this.refreshHandle);
    if (this.resizeHandle) clearTimeout(this.resizeHandle);
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
    const ids = this.spec ? panelIds(this.spec.panels.map((ps) => ps.template)) : [];
    const first = new Map<string, Mounted>();
    for (const m of ids.map((id) => this.mounted.get(id))) {
      if (!m || m.idle || !m.source) continue;
      const key = JSON.stringify([m.source, m.p.from, m.p.headers, m.p.body]);
      if (!first.has(key)) first.set(key, m);
    }
    return Promise.all([...first.values()].map(async (m): Promise<InspectedSource> => {
      const found = { title: m.p.title ?? m.p.view, kind: sourceKind(m.source!, m.p.from), ...(isUrl(m.source) ? { source: m.source } : {}) };
      try {
        const data = await this.env.data.rawData(m.source, m.p, this.files(), { ttlMs: this.spec?.refreshMs ?? CACHE_MS, now: this.env.now() });
        return { ...found, data };
      } catch (e) {
        return { ...found, data: { error: (e as Error).message } };
      }
    }));
  }

  /** Shows the inspector above the panels, or takes it away. */
  async toggleInspector(): Promise<void> {
    if (this.inspector) {
      this.inspector.remove();
      this.inspector = undefined;
      return;
    }
    const pane = this.shell.createDiv({ cls: "gz-card gz-inspector" });
    this.shell.insertBefore(pane, this.bar ?? this.grid ?? null);
    this.inspector = pane;
    pane.createDiv({ cls: "gz-empty", text: "Loading…" });
    await this.fillInspector();
  }

  private async fillInspector(): Promise<void> {
    const pane = this.inspector;
    const run = ++this.inspecting;
    const sources = await this.inspect();
    if (!pane || pane !== this.inspector || run !== this.inspecting) return;
    renderInspector(pane, sources, (text) => this.env.copy(text));
  }

  resize(): void {
    if (this.resizeHandle) clearTimeout(this.resizeHandle);
    this.resizeHandle = setTimeout(() => {
      const width = this.shell.clientWidth;
      if (Math.abs(width - this.width) < 8) return;
      this.width = width;
      this.layout();
      for (const [id, m] of this.mounted) m.handle.resize?.(this.widthOf(id));
    }, 150);
  }

  /** The drawing width inside a panel, from the grid arithmetic rather than measuring it. */
  private widthOf(id: string): number {
    const m = this.mounted.get(id);
    return widthFor(m?.span ?? MAX_COLUMNS, this.columns, this.shell.clientWidth, ...this.shellBox());
  }

  /** The shell's padding and widest width: an app in an embed or a lens has neither of its own (see styles.css). */
  private shellBox(): [pad: number, max: number] {
    return this.hosting ? [HOSTED_PAD, HOSTED_MAX] : [APP_PAD, APP_MAX];
  }

  /** Sets the column count and each panel's span and visibility as classes. */
  private layout(): void {
    this.columns = columnsFor(this.shell.clientWidth, ...this.shellBox());
    if (!this.grid) return;
    this.grid.className = `gz-grid gz-cols-${this.columns}`;
    for (const m of this.mounted.values()) {
      for (const c of [...m.el.classList]) if (c.startsWith("gz-span-")) m.el.classList.remove(c);
      m.el.classList.add(`gz-span-${spanOn(m.span, this.columns)}`);
      m.el.classList.toggle("gz-off", m.tab !== undefined && m.tab !== this.activeTab);
    }
    for (const b of this.tabs?.querySelectorAll("button") ?? []) b.classList.toggle("is-active", b.textContent === this.activeTab);
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
    const dataPath = h?.dataPath ?? dataPathOf((picked?.spec ?? result?.spec)?.store, this.appPath, (store, from) => this.env.storePath(store, from));
    const lensScope = h?.kind === "lens" ? h.scope : undefined;
    const verdict = read?.spec ? this.env.verdict?.(read.spec, wanted, { appPath: this.appPath, dataPath, hostPath: this.hostPath, lensScope }) : undefined;
    const blocked = verdict?.violations.length ? verdict.violations.map(violationText) : undefined;
    const granted = !blocked && this.env.isGranted(this.grantKey, wanted, verdict?.asked);
    // The app is its own keys plus those of every component it uses, and whether it may run.
    // The blocked card says whether the policy note waits to be applied.
    const pending = blocked ? this.env.policyPending?.() ?? false : false;
    const definition = JSON.stringify([fm, result?.spec?.read ?? null, granted, blocked ?? null, verdict?.asked ?? null, pending]);
    if (definition === this.definition) {
      if (moved) this.refillHostReaders();
      return;
    }
    this.definition = definition;
    this.links = result?.spec?.links ?? [];
    this.spec = picked?.spec ?? result?.spec;
    this.dataPath = dataPath;

    for (const el of [...this.shell.children]) if (el !== this.grid && el !== this.bar && el !== this.inspector) el.remove();
    const header = createDivIn(this.shell, "gz-header");
    this.shell.prepend(header);

    if (!result) {
      // A lens whose note no longer fills its params shows nothing until it is taken away.
      if (!h) header.createDiv({ cls: "gz-card", text: "This note has no app key." });
      else if (h.kind === "app") header.createDiv({ cls: "gz-card", text: `[[${basename(this.appPath)}]] isn't an app (it has no app: line)` });
      return this.showOnly(header);
    }
    const description = this.spec?.description ?? String(fm.app ?? "");
    if (description) header.createDiv({ cls: "gz-description", text: description });
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

    // An app opened in its own tab has been seen; the background acts only for those, even when they ask for nothing.
    if (!h && !component) {
      const before = this.env.granted(this.appPath);
      // Under a policy that covers all it asks for, it is seen once; what it was allowed before stays.
      if (verdict ? verdict.asked.length === 0 && before === undefined : wanted.length === 0 && before?.length !== 0) void this.env.grant(this.appPath, []);
    }
    this.setRefresh(spec);
    for (const name of [...this.selections.keys()]) if (!spec.selections.includes(name)) this.selections.delete(name);
    if (!this.grid) this.grid = this.shell.createDiv({ cls: "gz-grid" });
    this.columns = columnsFor(this.shell.clientWidth, ...this.shellBox());
    this.syncInputs(spec);
    const ids = panelIds(spec.panels.map((ps) => ps.template));
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
      return m;
    });
    // Panels without a tab come first and stay visible; the tab bar sits between them and the rest.
    const tabNames = [...new Set(order.map((m) => m.tab).filter((t): t is string => t !== undefined))];
    if (!this.activeTab || !tabNames.includes(this.activeTab)) this.activeTab = tabNames[0];
    this.tabs?.remove();
    this.tabs = tabNames.length ? this.renderTabs(tabNames) : undefined;
    for (const m of order) if (m.tab === undefined) this.grid.appendChild(m.el);
    if (this.tabs) this.grid.appendChild(this.tabs);
    for (const m of order) if (m.tab !== undefined) this.grid.appendChild(m.el);
    this.layout();
    this.subscribe();
    if (moved) this.refillHostReaders();
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
    this.tabs = undefined;
    if (this.refreshHandle) clearInterval(this.refreshHandle);
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
    // An embed's keys are in its block, not in the note it names as its path.
    const self = this.hosting?.kind === "embed" ? "" : fileDep(this.appPath);
    this.unsubscribe = this.env.data.subscribe(deps, (changed) => {
      // Lists typed into the app note are part of its definition, so a change there is
      // handled by reconcile, which reloads the panels it keeps.
      if (definition.some((d) => changed.has(d))) this.reconcile();
      for (const m of this.mounted.values()) {
        if (m.source && m.deps.some((d) => d !== self && changed.has(d))) void this.loadPanel(m);
      }
      if (kept.some((d) => changed.has(d))) void this.checkHandEdit();
    });
    void this.checkHandEdit();
  }

  /** Says so when the data note was edited by hand since the app's log was last written into it, with Import and Discard. */
  private async checkHandEdit(): Promise<void> {
    const ledger = this.env.data.ledger;
    // Only where the app's lists are kept in the ledger; a lens keeps no data note of its own.
    if (!ledger || !this.env.store || this.hosting?.kind === "lens") return;
    const dataPath = this.dataPath;
    const appFm = this.env.frontmatter(this.appPath) ?? {};
    const state = await ledger.state(dataPath, appFm);
    const ops = state.handEdited ? await ledger.importOps(dataPath, appFm) : [];
    if (this.dataPath !== dataPath) return;
    this.handEdit?.remove();
    this.handEdit = undefined;
    const header = this.shell.querySelector(".gz-header") as HTMLElement | null;
    if (!state.handEdited || !header) return;
    this.handEdit = renderHandEdit(header, basename(dataPath), editWords(ops).length ? editWords(ops) : ["its layout only"], {
      import: async () => {
        await ledger.write(dataPath, ops);
        await this.env.data.snapshotNow(dataPath, true);
      },
      discard: () => this.env.data.snapshotNow(dataPath, true),
    });
  }

  private setRefresh(spec: AppSpec): void {
    if (this.refreshHandle) clearInterval(this.refreshHandle);
    this.refreshHandle = spec.refreshMs ? setInterval(() => this.reload(), spec.refreshMs) : undefined;
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
    setTimeout(() => {
      if (!answered && current()) void fromDisk().then((copy) => { if (copy && !answered && current()) this.show(m, copy.data, copy.at); });
    }, DISK_FIRST_MS);
    try {
      const data = await this.env.data.panelData(m.source, m.p, this.files(), {
        ttlMs: this.spec?.refreshMs ?? CACHE_MS,
        now,
      });
      answered = true;
      if (!current()) return;
      this.show(m, data);
    } catch (e) {
      answered = true;
      if (!current()) return;
      const copy = await fromDisk();
      if (!current()) return;
      if (copy) this.show(m, copy.data, copy.at);
      else this.showPanelError(m, (e as Error).message);
    }
  }

  /** `asOf`: the data is a disk copy fetched then, and says so. */
  private show(m: Mounted, data: unknown, asOf?: number): void {
    if (m.remount) {
      m.handle.destroy?.();
      m.el.empty();
      m.handle = mountView(m.def, m.el, m.p, this.ctxFor(m.id), m.id);
      m.remount = false;
    }
    m.el.removeClass("gz-loading", "gz-error", "gz-stale");
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
    m.el.removeClass("gz-loading", "gz-stale");
    m.el.addClass("gz-error");
    m.el.empty();
    m.el.createDiv({ cls: "gz-title", text: m.p.title ?? m.p.view });
    m.el.createDiv({ text: message });
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
    if (waiting === undefined) return this.showPanelError(m, errors.join("; "));
    this.markAsOf(m);
    m.el.removeClass("gz-loading", "gz-error", "gz-stale");
    m.el.empty();
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

  /** A panel's own view of the app: what every panel may ask, and edits that know whose rows they are. */
  private ctxFor(id: string): PanelCtx {
    return Object.assign(Object.create(this.ctx) as PanelCtx, {
      editRow: (row: Row, field: string, value: unknown) => this.editRow(id, row, field, value),
      setProperty: (field: string, value: unknown) => this.setProperty(id, field, value),
    });
  }

  /** A panel's edits go through only while it is drawn and loaded; a changed row reloads it. */
  private editRow(id: string, row: Row, field: string, value: unknown): Promise<void> {
    const m = this.mounted.get(id);
    if (!m || m.idle) return Promise.resolve();
    return this.writes.editRow(m, row, field, value, () => void this.loadPanel(m));
  }

  private setProperty(id: string, field: string, value: unknown): Promise<void> {
    const m = this.mounted.get(id);
    if (!m || m.idle) return Promise.resolve();
    return this.writes.setProperty(m, field, value);
  }
}

function createDivIn(parent: HTMLElement, cls: string): HTMLElement {
  return parent.createDiv({ cls });
}
