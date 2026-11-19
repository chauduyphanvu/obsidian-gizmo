import { fillTemplate, stampParts, type Row } from "./data.ts";
import type { AppFiles, DataLayer } from "./datalayer.ts";
import {
  describePermission, isUrl, notePath, permissionsOf, readSpec, resolvePanel, startingValues,
  type AppSpec, type Panel, type PanelSpec,
} from "./spec.ts";
import type { InputValue } from "./template.ts";
import { renderInputBar } from "./toolbar.ts";
import { MAX_COLUMNS, columnsFor, spanOn, widthFor } from "./layout.ts";
import { defaultDataPath } from "./store.ts";
import { viewDef, type PanelCtx, type PanelHandle, type TimerState, type ViewDef } from "./views/registry.ts";
import { formatClock } from "./views/timer.ts";

const CACHE_MS = 5 * 60_000;

/** What an app needs from Obsidian; the view passes the real thing, tests a fake. */
export interface AppEnv {
  data: DataLayer;
  frontmatter(path: string): Record<string, unknown> | undefined;
  isGranted(path: string, wanted: string[]): boolean;
  grant(path: string, wanted: string[]): Promise<void>;
  /** Path of the note a `store:` value points at. */
  storePath(store: string, fromPath: string): string;
  /** Changes a note's frontmatter, creating the note if needed; writes to one note run in order. */
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  appendLine(path: string, line: string): Promise<void>;
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
  /** Input values; kept while the note is edited, back to their starts when it's reopened. */
  private values: Record<string, InputValue> = {};
  private ctx: PanelCtx;

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
    const definition = JSON.stringify(fm);
    if (definition === this.definition) return;
    this.definition = definition;
    const result = readSpec(fm, { now: this.env.now() });
    this.spec = result?.spec;
    this.dataPath = this.spec?.store ? this.env.storePath(this.spec.store, this.appPath) : defaultDataPath(this.appPath);

    for (const el of [...this.shell.children]) if (el !== this.grid) el.remove();
    const header = createDivIn(this.shell, "na-header");
    this.shell.prepend(header);

    if (!result) {
      header.createDiv({ cls: "na-card", text: "This note has no app key." });
      return this.showOnly(header);
    }
    const description = this.spec?.description ?? String(fm.app ?? "");
    if (description) header.createDiv({ cls: "na-description", text: description });
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
    if (!spec?.panels.length) return this.showOnly(header);

    const wanted = permissionsOf(spec, this.appPath);
    if (!this.env.isGranted(this.appPath, wanted)) {
      this.renderPermissionPrompt(header, wanted);
      return this.showOnly(header);
    }

    this.setRefresh(spec);
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
      const ok = v !== undefined && (def.kind === "date" ? typeof v === "string" : def.options.includes(v));
      kept[def.name] = ok ? v : start[def.name];
    }
    this.values = kept;
    if (spec.inputs.length === 0) return;
    const today = () => stampParts(this.env.now()).date;
    const bar = renderInputBar(this.shell, spec.inputs, this.values, today, (name, value) => this.setInput(name, value));
    this.shell.insertBefore(bar, this.grid!);
  }

  private setInput(name: string, value: InputValue): void {
    if (this.values[name] === value) return;
    this.values[name] = value;
    for (const m of this.mounted.values()) if (m.ps.inputs.includes(name)) this.refill(m);
    this.subscribe();
  }

  /** Fills a panel's inputs again; its old content stays, dimmed, until the new data arrives. */
  private refill(m: Mounted): void {
    const r = resolvePanel(m.ps, this.values);
    if (!r.panel) return this.showPanelError(m, r.errors.join("; "));
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
    this.unsubscribe?.();
    // Still listen to the app note so fixing its keys redraws the app.
    this.unsubscribe = this.env.data.subscribe([`file:${this.appPath}`], () => this.reconcile());
    if (header.parentElement !== this.shell) this.shell.prepend(header);
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
    const deps = new Set([`file:${this.appPath}`]);
    for (const m of this.mounted.values()) for (const d of m.deps) deps.add(d);
    const self = `file:${this.appPath}`;
    this.unsubscribe = this.env.data.subscribe(deps, (changed) => {
      // Lists typed into the app note are part of its definition, so a change there is
      // handled by reconcile, which reloads the panels it keeps.
      if (changed.has(self)) this.reconcile();
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
    const p = resolvePanel(ps, this.values).panel ?? ps.panel;
    const def = viewDef(p.view)!;
    const el = createDivIn(this.grid!, `na-panel na-view-${p.view}`);
    const source = p.source ?? def.implicitSource?.(p);
    const m = {
      id, ps, p, def, el, source, remount: false,
      span: p.span ?? def.span,
      tab: p.tab,
      deps: this.env.data.depsOf(source, p, files),
      seq: 0,
    } as Mounted;
    // Registered before mounting, so the view can ask for its width.
    this.mounted.set(id, m);
    m.handle = def.mount(el, p, this.ctx, id);
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
      m.handle = m.def.mount(m.el, m.p, this.ctx, m.id);
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

  private redraw(id: string): void {
    const m = this.mounted.get(id);
    if (m && !m.source) m.handle.update(undefined);
  }

  // ---- Cards --------------------------------------------------------------------------------

  private renderPermissionPrompt(header: HTMLElement, wanted: string[]): void {
    const card = header.createDiv({ cls: "na-card" });
    card.createDiv({ cls: "na-title", text: "This app needs your OK to:" });
    const ul = card.createEl("ul");
    for (const p of wanted) ul.createEl("li", { text: describePermission(p) });
    const row = card.createDiv({ cls: "na-actions" });
    row.createEl("button", { cls: "mod-cta", text: "Allow" }).addEventListener("click", async () => {
      await this.env.grant(this.appPath, wanted);
      this.load();
    });
    row.createEl("button", { text: "Edit source" }).addEventListener("click", () => this.env.showSource());
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

  async runActions(p: Panel, row: Row): Promise<void> {
    const stamp = stampParts(this.env.now());
    const saved: Row = { ...row, at: stamp.at };
    const ctx = { ...stamp, ...row };
    try {
      if (p.append) {
        const fields = Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(", ");
        const line = fillTemplate(p.line ?? `- {date} {time}${fields ? ` ${fields}` : ""}`, ctx);
        await this.env.appendLine(notePath(p.append), line);
      }
      if (p.save) {
        await this.writeData((fm) => {
          const list = fm[p.save!];
          fm[p.save!] = Array.isArray(list) ? [...list, saved] : [saved];
        });
      }
      if (p.notify) this.env.notify(fillTemplate(p.notify, ctx));
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
    }
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
