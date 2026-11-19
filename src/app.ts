import { runActions as runPanelActions } from "./actions.ts";
import { stampParts, type Row } from "./data.ts";
import type { AppFiles, DataLayer } from "./datalayer.ts";
import { basename, typedName, type NoteReader } from "./expand.ts";
import {
  askersOf, describePermission, isComponent, isUrl, permissionsOf, readComponentPreview, readSpec,
  resolvePanel, startingValues, type ComponentPreview,
  type AppSpec, type Panel, type PanelSpec,
} from "./spec.ts";
import type { InputValue } from "./template.ts";
import { renderInputBar } from "./toolbar.ts";
import { MAX_COLUMNS, columnsFor, spanOn, widthFor } from "./layout.ts";
import { ROW_INDEX } from "./sources/list.ts";
import { sourceDef } from "./sources/registry.ts";
import { defaultDataPath, resolveList } from "./store.ts";
import { editErrors, editableSource } from "./views/common.ts";
import { viewDef, type PanelCtx, type PanelHandle, type TimerState, type ViewDef } from "./views/registry.ts";
import { formatClock } from "./views/timer.ts";

const CACHE_MS = 5 * 60_000;

/** What an app needs from Obsidian; the view passes the real thing, tests a fake. */
export interface AppEnv {
  data: DataLayer;
  frontmatter(path: string): Record<string, unknown> | undefined;
  /** Reads the component notes an app uses. */
  notes: NoteReader;
  isGranted(path: string, wanted: string[]): boolean;
  /** What the app was allowed last time, to mark what's new. */
  granted(path: string): string[];
  grant(path: string, wanted: string[]): Promise<void>;
  /** Path of the note a `store:` value points at. */
  storePath(store: string, fromPath: string): string;
  /** Changes a note's frontmatter, creating the note if needed; writes to one note run in order. */
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  appendLine(path: string, line: string): Promise<void>;
  /**
   * Creates a note at `path` (and its folders) with this frontmatter and body; false, writing
   * nothing, when a note is already there. The note reaches the data layer like any other change.
   */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<boolean>;
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
  now(): Date;
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

/** Whether a stored list row still holds what was shown for it, apart from the field being changed. */
function holds(stored: unknown, shown: Row, field: string): stored is Row {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return false;
  return Object.entries(stored).every(([k, v]) => k === field || JSON.stringify(v) === JSON.stringify(shown[k]));
}

/** JSON with object keys sorted, so the order keys were typed in doesn't matter. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A stable identity for a panel: its keys as written, plus a counter when two panels are identical. */
export function panelIds(templates: Record<string, unknown>[]): string[] {
  const seen = new Map<string, number>();
  return templates.map((t) => {
    const json = stableJson(t);
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    const base = (h >>> 0).toString(36);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
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
  private timers = new Map<string, TimerState>();
  private tickHandle: ReturnType<typeof setInterval> | undefined;
  private refreshHandle: ReturnType<typeof setInterval> | undefined;
  private resizeHandle: ReturnType<typeof setTimeout> | undefined;
  private width = 0;
  private columns = MAX_COLUMNS;
  private tabs: HTMLElement | undefined;
  /** The open tab; kept while the note is edited, back to the first when it's reopened. */
  private activeTab: string | undefined;
  /** Input values; kept while the note is edited, back to their starts when it's reopened. An empty search box has none. */
  private values: Record<string, InputValue> = {};
  /** Rows panels selected, by selection name; kept while the note is edited, cleared when it's reopened. */
  private selections = new Map<string, Row>();
  /** The input bar, kept as drawn while the inputs stay the same so typing in it is never interrupted. */
  private bar: HTMLElement | undefined;
  private barFor = "";
  /** Names of the component notes the app links to; a change to any of them redraws it. */
  private links: string[] = [];
  /** What every panel may ask; each gets its own copy that knows which panel it is (see ctxFor). */
  private ctx: Omit<PanelCtx, "editRow">;

  constructor(root: HTMLElement, appPath: string, env: AppEnv) {
    this.root = root;
    this.appPath = appPath;
    this.env = env;
    this.shell = root.createDiv({ cls: "note-app" });
    const self = this;
    this.ctx = {
      get now() { return self.env.now(); },
      width: (key) => this.widthOf(key),
      runActions: (p, row) => this.runActions(p, row),
      toggleChecked: (key, item) => this.writeData((fm) => {
        const list = Array.isArray(fm[key]) ? (fm[key] as unknown[]).map(String) : [];
        fm[key] = list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
      }),
      clearChecked: (key) => this.writeData((fm) => { fm[key] = []; }),
      openNote: (path) => this.env.openNote(path, this.appPath),
      timer: (key, p) => this.timerState(key, p),
      startTimer: (key, p) => {
        const s = this.timerState(key, p);
        s.endsAt = Date.now() + s.remainingMs;
        this.startTicking();
        this.redraw(key);
      },
      pauseTimer: (key) => {
        const s = this.timers.get(key);
        if (s?.endsAt) { s.remainingMs = s.endsAt - Date.now(); s.endsAt = undefined; }
        this.redraw(key);
      },
      resetTimer: (key, p) => {
        this.timers.set(key, { remainingMs: p.minutes! * 60_000 });
        this.redraw(key);
      },
      select: (name, row) => this.setSelection(name, row),
      selected: (name) => this.selections.get(name),
    };
  }

  /** Draws the app from scratch: on open, and after the user allows its permissions. */
  load(): void {
    this.destroyPanels();
    this.definition = "";
    this.reconcile();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.removeBar();
    this.destroyPanels();
    this.stopTicking();
    if (this.refreshHandle) clearInterval(this.refreshHandle);
    if (this.resizeHandle) clearTimeout(this.resizeHandle);
    this.shell.remove();
  }

  /** Refetches this app's web sources; the panels that use them update when the data arrives. */
  reload(): void {
    this.env.data.forgetUrls([...this.mounted.values()].map((m) => m.source).filter(isUrl));
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
    return widthFor(m?.span ?? MAX_COLUMNS, this.columns, this.shell.clientWidth);
  }

  /** Sets the column count and each panel's span and visibility as classes. */
  private layout(): void {
    this.columns = columnsFor(this.shell.clientWidth);
    if (!this.grid) return;
    this.grid.className = `na-grid na-cols-${this.columns}`;
    for (const m of this.mounted.values()) {
      for (const c of [...m.el.classList]) if (c.startsWith("na-span-")) m.el.classList.remove(c);
      m.el.classList.add(`na-span-${spanOn(m.span, this.columns)}`);
      m.el.classList.toggle("na-off", m.tab !== undefined && m.tab !== this.activeTab);
    }
    for (const b of this.tabs?.querySelectorAll("button") ?? []) b.classList.toggle("is-active", b.textContent === this.activeTab);
  }

  // ---- Definition ---------------------------------------------------------------------------

  /** Brings the drawn app in line with the note's keys, keeping panels whose keys didn't change. */
  private reconcile(): void {
    const fm = this.env.frontmatter(this.appPath) ?? {};
    const opts = { now: this.env.now(), notes: this.env.notes, path: this.appPath };
    // A component note opened on its own shows how to use it, and a preview when it can.
    const component: ComponentPreview | undefined = isComponent(fm) ? readComponentPreview(fm, opts) : undefined;
    const result = component?.result ?? readSpec(fm, opts);
    // The app is its own keys plus those of every component it uses.
    const definition = JSON.stringify([fm, result?.spec?.read ?? null]);
    if (definition === this.definition) return;
    this.definition = definition;
    this.links = result?.spec?.links ?? [];
    this.spec = result?.spec;
    this.dataPath = this.spec?.store ? this.env.storePath(this.spec.store, this.appPath) : defaultDataPath(this.appPath);

    for (const el of [...this.shell.children]) if (el !== this.grid && el !== this.bar) el.remove();
    const header = createDivIn(this.shell, "na-header");
    this.shell.prepend(header);

    if (!result) {
      header.createDiv({ cls: "na-card", text: "This note has no app key." });
      return this.showOnly(header);
    }
    const description = this.spec?.description ?? String(fm.app ?? "");
    if (description) header.createDiv({ cls: "na-description", text: description });
    if (component) this.renderUsage(header, component);
    if (result.empty) {
      this.renderEmpty(header);
      return this.showOnly(header);
    }
    if (result.errors.length) {
      const card = header.createDiv({ cls: "na-card na-error" });
      card.createDiv({ cls: "na-title", text: "This app's keys have problems" });
      const ul = card.createEl("ul");
      for (const e of result.errors) ul.createEl("li", { text: e });
    }
    const spec = this.spec;
    if (!spec?.panels.length || component?.missing.length) return this.showOnly(header);

    const wanted = permissionsOf(spec, this.appPath);
    if (!this.env.isGranted(this.appPath, wanted)) {
      this.renderPermissionPrompt(header, wanted, askersOf(spec, this.appPath));
      return this.showOnly(header);
    }

    this.setRefresh(spec);
    for (const name of [...this.selections.keys()]) if (!spec.selections.includes(name)) this.selections.delete(name);
    if (!this.grid) this.grid = this.shell.createDiv({ cls: "na-grid" });
    this.columns = columnsFor(this.shell.clientWidth);
    this.syncInputs(spec);
    const ids = panelIds(spec.panels.map((ps) => ps.template));
    const keep = new Set(ids);
    for (const [id, m] of this.mounted) {
      if (!keep.has(id)) {
        m.handle.destroy?.();
        m.el.remove();
        this.mounted.delete(id);
        this.timers.delete(id);
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

  /** Every value a panel may read: the inputs', then the selections. */
  private current(): Record<string, unknown> {
    return { ...this.values, ...Object.fromEntries(this.selections) };
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
    m.source = m.p.source ?? m.def.implicitSource?.(m.p);
    m.deps = this.env.data.depsOf(m.source, m.p, this.files());
    m.remount = true;
    m.el.addClass("na-stale");
    if (m.source) void this.loadPanel(m);
    else this.show(m, undefined);
  }

  private renderTabs(names: string[]): HTMLElement {
    const bar = this.grid!.createDiv({ cls: "na-tabs" });
    bar.setAttr("role", "tablist");
    for (const name of names) {
      const b = bar.createEl("button", { cls: "na-tab", text: name });
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

  /** The notes the app's definition comes from: its own, and each component it links to by name. */
  private definitionDeps(): string[] {
    return [`file:${this.appPath}`, ...this.links.map((l) => `name:${l}`)];
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
    return { appPath: this.appPath, dataPath: this.dataPath };
  }

  private subscribe(): void {
    this.unsubscribe?.();
    const definition = this.definitionDeps();
    const deps = new Set(definition);
    for (const m of this.mounted.values()) for (const d of m.deps) deps.add(d);
    const self = `file:${this.appPath}`;
    this.unsubscribe = this.env.data.subscribe(deps, (changed) => {
      // Lists typed into the app note are part of its definition, so a change there is
      // handled by reconcile, which reloads the panels it keeps.
      if (definition.some((d) => changed.has(d))) this.reconcile();
      for (const m of this.mounted.values()) {
        if (m.source && m.deps.some((d) => d !== self && changed.has(d))) void this.loadPanel(m);
      }
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
    const el = createDivIn(this.grid!, `na-panel na-view-${p.view}`);
    const source = r.panel ? p.source ?? def.implicitSource?.(p) : undefined;
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
    m.handle = def.mount(el, p, this.ctxFor(id), id);
    if (source) {
      el.addClass("na-loading");
      el.createDiv({ cls: "na-title", text: p.title ?? p.label ?? "" });
      el.createDiv({ cls: "na-empty", text: "Loading…" });
      void this.loadPanel(m);
    } else {
      m.handle.update(undefined);
    }
    return m;
  }

  private async loadPanel(m: Mounted): Promise<void> {
    const seq = ++m.seq;
    try {
      const data = await this.env.data.panelData(m.source, m.p, this.files(), {
        ttlMs: this.spec?.refreshMs ?? CACHE_MS,
        now: this.env.now(),
      });
      if (seq !== m.seq || this.mounted.get(m.id) !== m) return;
      this.show(m, data);
    } catch (e) {
      if (seq !== m.seq || this.mounted.get(m.id) !== m) return;
      this.showPanelError(m, (e as Error).message);
    }
  }

  private show(m: Mounted, data: unknown): void {
    if (m.remount) {
      m.handle.destroy?.();
      m.el.empty();
      m.handle = m.def.mount(m.el, m.p, this.ctxFor(m.id), m.id);
      m.remount = false;
    }
    m.el.removeClass("na-loading", "na-error", "na-stale");
    m.handle.update(data);
  }

  private showPanelError(m: Mounted, message: string): void {
    m.el.removeClass("na-loading", "na-stale");
    m.el.addClass("na-error");
    m.el.empty();
    m.el.createDiv({ cls: "na-title", text: m.p.title ?? m.p.view });
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
    m.el.removeClass("na-loading", "na-error", "na-stale");
    m.el.empty();
    const title = plainTitle(m.ps);
    if (title) m.el.createDiv({ cls: "na-title", text: title });
    m.el.createDiv({ cls: "na-waiting", text: this.waitingFor(waiting) });
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

  // ---- Cards --------------------------------------------------------------------------------

  private renderPermissionPrompt(header: HTMLElement, wanted: string[], askers: Map<string, Set<string>>): void {
    const card = header.createDiv({ cls: "na-card" });
    card.createDiv({ cls: "na-title", text: "This app needs your OK to:" });
    const ul = card.createEl("ul");
    const before = new Set(this.env.granted(this.appPath));
    for (const p of wanted) {
      const li = ul.createEl("li");
      if (before.size && !before.has(p)) li.createSpan({ cls: "na-new", text: "New" });
      const who = [...(askers.get(p) ?? [])];
      const others = who.filter((path) => path !== this.appPath).map((path) => `[[${basename(path)}]]`);
      const names = [...(others.length && who.includes(this.appPath) ? ["this note"] : []), ...others];
      li.createSpan({ text: describePermission(p) + (others.length ? ` — for ${names.join(", ")}` : "") });
    }
    const row = card.createDiv({ cls: "na-actions" });
    row.createEl("button", { cls: "mod-cta", text: "Allow" }).addEventListener("click", async () => {
      await this.env.grant(this.appPath, wanted);
      this.load();
    });
    row.createEl("button", { text: "Edit source" }).addEventListener("click", () => this.env.showSource());
  }

  private renderUsage(header: HTMLElement, c: ComponentPreview): void {
    const card = header.createDiv({ cls: "na-card" });
    card.createDiv({ text: "A component. Use it in an app's panels:" });
    card.createEl("pre", { cls: "na-example", text: c.usage });
    if (c.missing.length) card.createDiv({ cls: "na-label", text: "Give every param a default to preview it here." });
  }

  private renderEmpty(header: HTMLElement): void {
    const card = header.createDiv({ cls: "na-card" });
    card.createDiv({ text: "No app keys yet. Add a view under the app line, for example:" });
    card.createEl("pre", { cls: "na-example", text: "view: countdown\nto: 2027-01-01\nlabel: New year" });
    card.createDiv({ cls: "na-actions" }).createEl("button", { cls: "mod-cta", text: "Edit source" })
      .addEventListener("click", () => this.env.showSource());
  }

  // ---- Actions ------------------------------------------------------------------------------

  private writeData(fn: (fm: Record<string, unknown>) => void): Promise<void> {
    return this.env.writeFrontmatter(this.dataPath, fn);
  }

  /** A panel's own view of the app: what every panel may ask, and edits that know whose rows they are. */
  private ctxFor(id: string): PanelCtx {
    return Object.assign(Object.create(this.ctx) as PanelCtx, {
      editRow: (row: Row, field: string, value: unknown) => this.editRow(id, row, field, value),
    });
  }

  /**
   * Writes one field of a row a panel shows back where it came from, as far as the panel's checked
   * keys allow: a note in its `from` (granted as edit:<from>; any note for a base, edit:*), a task
   * line in a note in its `from` (tasks:<from>), or the row's place in the list it reads, which
   * must still hold the row that was shown.
   */
  private async editRow(id: string, row: Row, field: string, value: unknown): Promise<void> {
    const m = this.mounted.get(id);
    if (!m || m.idle || editErrors(m.p, [field]).length) return;
    try {
      if (editableSource(m.p) === "tasks") return await this.tickTask(m, row, value);
      if (editableSource(m.p) === "notes") {
        const path = row.path;
        const scope = sourceDef(m.p.source!).id === "base" ? this.env.data.allNotes() : this.env.data.notes(m.p.from ?? "");
        if (typeof path !== "string" || !scope.some((r) => r.path === path)) return;
        await this.env.writeFrontmatter(path, (fm) => { fm[field] = value; });
        return;
      }
      const index = (row as Record<symbol, unknown>)[ROW_INDEX];
      if (typeof index !== "number") return;
      const name = m.p.source!;
      let changed = false;
      await this.writeData((fm) => {
        const list = resolveList(name, fm, this.env.frontmatter(this.appPath) ?? {});
        const stored = Array.isArray(list) ? list[index] : undefined;
        if (!Array.isArray(list) || !holds(stored, row, field)) {
          changed = true;
          return;
        }
        const next = [...list];
        next[index] = { ...stored, [field]: value };
        fm[name] = next;
      });
      if (changed) {
        this.env.notify("That row has changed; reload");
        // Shows the list as it is now, putting back what the input claimed.
        void this.loadPanel(m);
      }
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
    }
  }

  /** Ticks the task a row shows, in a note of the panel's `from`; when it has moved or changed, shows the notes as they are. */
  private async tickTask(m: Mounted, row: Row, done: unknown): Promise<void> {
    const { path, line, text } = row;
    if (typeof path !== "string" || typeof line !== "number" || typeof text !== "string" || typeof done !== "boolean") return;
    if (!this.env.data.notes(m.p.from ?? "").some((r) => r.path === path)) return;
    if (await this.env.setTaskDone(path, line, text, done)) return;
    this.env.notify("That task has changed; reload");
    void this.loadPanel(m);
  }

  async runActions(p: Panel, row: Row): Promise<void> {
    const env = this.env;
    await runPanelActions(p, row, {
      now: () => env.now(),
      dataPath: this.dataPath,
      appPath: this.appPath,
      writeFrontmatter: (path, fn) => env.writeFrontmatter(path, fn),
      appendLine: (path, line) => env.appendLine(path, line),
      createNote: (path, fm, body) => env.createNote(path, fm, body),
      readBody: (path) => env.readBody(path),
      notify: (message) => env.notify(message),
      openNote: (path, from) => env.openNote(path, from),
    });
  }

  // ---- Timers -------------------------------------------------------------------------------

  private timerState(key: string, p: Panel): TimerState {
    let s = this.timers.get(key);
    if (!s) this.timers.set(key, (s = { remainingMs: p.minutes! * 60_000 }));
    return s;
  }

  /** One tick for all of this app's timers, running only while one counts down. */
  private startTicking(): void {
    this.tickHandle ??= setInterval(() => this.tick(), 1000);
  }

  private stopTicking(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = undefined;
  }

  private tick(): void {
    let running = false;
    for (const [key, s] of this.timers) {
      if (!s.endsAt) continue;
      const left = s.endsAt - Date.now();
      const m = this.mounted.get(key);
      const clock = m?.el.querySelector(`[data-na-timer="${key}"]`);
      if (clock) clock.textContent = formatClock(left);
      if (left > 0) { running = true; continue; }
      this.timers.set(key, { remainingMs: (m?.p.minutes ?? 0) * 60_000 });
      this.env.notify(`${m?.p.title ?? "Timer"} finished`);
      if (m) void this.runActions(m.p, { minutes: m.p.minutes }).then(() => this.redraw(key));
    }
    if (!running) this.stopTicking();
  }
}

function createDivIn(parent: HTMLElement, cls: string): HTMLElement {
  return parent.createDiv({ cls });
}
