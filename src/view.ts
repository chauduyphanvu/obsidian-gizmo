import {
  FileView, Notice, TFile, getAllTags, normalizePath, requestUrl,
  type WorkspaceLeaf,
} from "obsidian";
import {
  filterRows, getPath, parseBody, sortRows, stampParts, fillTemplate, type Row,
} from "./data.ts";
import { formatClock, isWide, renderPanel, type RenderCtx, type TimerState } from "./render.ts";
import {
  describePermission, isUrl, notePath, permissionsOf, readSpec, type AppSpec, type Panel,
} from "./spec.ts";
import type NoteAppsPlugin from "./main.ts";

export const VIEW_TYPE = "note-app";
const CACHE_MS = 5 * 60_000;

export class AppView extends FileView {
  private cache = new Map<string, { at: number; data: unknown }>();
  private timers = new Map<number, TimerState>();
  private renderToken = 0;
  private refreshHandle: number | undefined;
  private tickHandle: number | undefined;
  private renderedWidth = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: NoteAppsPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Note app"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    this.addAction("file-code", "Edit source", () => this.file && this.plugin.showSource(this.leaf, this.file));
    this.addAction("refresh-cw", "Reload data", () => { this.cache.clear(); void this.render(); });
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file === this.file) void this.render();
    }));
  }

  async onLoadFile(_file: TFile): Promise<void> {
    this.cache.clear();
    this.timers.clear();
    await this.render();
  }

  async onUnloadFile(): Promise<void> {
    this.stopRefresh();
    this.stopTicking();
    this.contentEl.empty();
  }

  /** The 1-second tick runs only while a timer is counting down. */
  private startTicking(): void {
    if (this.tickHandle === undefined) this.tickHandle = window.setInterval(() => this.tick(), 1000);
  }

  private stopTicking(): void {
    if (this.tickHandle !== undefined) window.clearInterval(this.tickHandle);
    this.tickHandle = undefined;
  }

  async onClose(): Promise<void> {
    this.stopTicking();
    this.stopRefresh();
  }

  private stopRefresh(): void {
    if (this.refreshHandle !== undefined) window.clearInterval(this.refreshHandle);
    this.refreshHandle = undefined;
  }

  private frontmatter(): Record<string, unknown> | undefined {
    return this.file ? this.app.metadataCache.getFileCache(this.file)?.frontmatter : undefined;
  }

  async render(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const token = ++this.renderToken;
    const fm = this.frontmatter() ?? {};
    const result = readSpec(fm);
    const root = createDiv({ cls: "note-app" });

    if (!result) {
      root.createDiv({ cls: "na-card", text: "This note has no app key." });
      return this.swap(root);
    }
    const description = result.spec?.description ?? String(fm.app ?? "");
    if (description) root.createDiv({ cls: "na-description", text: description });

    if (result.empty) {
      this.renderEmpty(root, file);
      return this.swap(root);
    }
    if (result.errors.length || !result.spec) {
      const card = root.createDiv({ cls: "na-card na-error" });
      card.createDiv({ cls: "na-title", text: "This app's keys have problems" });
      const ul = card.createEl("ul");
      for (const e of result.errors) ul.createEl("li", { text: e });
      if (!result.spec?.panels.length) return this.swap(root);
    }
    const spec = result.spec!;

    const wanted = permissionsOf(spec, file.path);
    if (!this.plugin.isGranted(file.path, wanted)) {
      this.renderPermissionPrompt(root, file, wanted);
      return this.swap(root);
    }

    this.setRefresh(spec);
    const grid = root.createDiv({ cls: "na-grid" });
    const now = new Date();
    const ctx = this.renderCtx(fm, now);
    const loads = spec.panels.map(async (p, i) => {
      const el = grid.createDiv({ cls: `na-panel na-view-${p.view}${isWide(p) ? " na-wide" : ""}` });
      try {
        const data = await this.loadData(p, fm, now);
        if (token !== this.renderToken) return;
        renderPanel(el, p, data, i, ctx);
      } catch (e) {
        el.addClass("na-error");
        el.createDiv({ cls: "na-title", text: p.title ?? p.view });
        el.createDiv({ text: (e as Error).message });
      }
    });
    await Promise.all(loads);
    if (token === this.renderToken) this.swap(root);
  }

  /** Replaces the content in one step so re-renders don't flash. */
  private swap(root: HTMLElement): void {
    this.contentEl.empty();
    this.contentEl.appendChild(root);
  }

  private setRefresh(spec: AppSpec): void {
    this.stopRefresh();
    if (!spec.refreshMs) return;
    this.refreshHandle = window.setInterval(() => { this.cache.clear(); void this.render(); }, spec.refreshMs);
  }

  private renderPermissionPrompt(root: HTMLElement, file: TFile, wanted: string[]): void {
    const card = root.createDiv({ cls: "na-card" });
    card.createDiv({ cls: "na-title", text: "This app needs your OK to:" });
    const ul = card.createEl("ul");
    for (const p of wanted) ul.createEl("li", { text: describePermission(p) });
    const row = card.createDiv({ cls: "na-actions" });
    row.createEl("button", { cls: "mod-cta", text: "Allow" }).addEventListener("click", async () => {
      await this.plugin.grant(file.path, wanted);
      void this.render();
    });
    row.createEl("button", { text: "Edit source" }).addEventListener("click", () => this.plugin.showSource(this.leaf, file));
  }

  private renderEmpty(root: HTMLElement, file: TFile): void {
    const card = root.createDiv({ cls: "na-card" });
    card.createDiv({ text: "No app keys yet. Add a view under the app line, for example:" });
    card.createEl("pre", { cls: "na-example", text: "view: countdown\nto: 2027-01-01\nlabel: New year" });
    card.createDiv({ cls: "na-actions" }).createEl("button", { cls: "mod-cta", text: "Edit source" })
      .addEventListener("click", () => this.plugin.showSource(this.leaf, file));
  }

  private async loadData(p: Panel, fm: Record<string, unknown>, now: Date): Promise<unknown> {
    if (!p.source) return undefined;
    let data: unknown;
    if (isUrl(p.source)) data = await this.fetchJson(p);
    else if (p.source === "notes") data = this.queryNotes(p.from!);
    else data = fm[p.source] ?? [];
    data = getPath(data, p.pick);
    if (Array.isArray(data)) {
      data = filterRows(data, p.where, now);
      data = sortRows(data as unknown[], p.sort);
      if (p.limit) data = (data as unknown[]).slice(0, p.limit);
    }
    return data;
  }

  private withSecrets(text: string): string {
    return text.replace(/\{secret:([a-z0-9-]+)\}/g, (_, id: string) => {
      const value = this.app.secretStorage.getSecret(id);
      if (!value) throw new Error(`Missing secret "${id}". Add it under Settings → Keychain.`);
      return value;
    });
  }

  private async fetchJson(p: Panel): Promise<unknown> {
    const key = `${p.source}|${JSON.stringify(p.headers ?? {})}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const headers = Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k, this.withSecrets(String(v))]));
    const res = await requestUrl({ url: this.withSecrets(p.source!), headers, throw: false });
    const host = new URL(p.source!.replace(/\{secret:[a-z0-9-]+\}/g, "x")).host;
    if (res.status >= 400) throw new Error(`${host} answered ${res.status}`);
    const data = parseBody(res.text, res.headers["content-type"] ?? "");
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  private queryNotes(from: string): Row[] {
    const scopes = from.split(",").map((s) => s.trim()).filter(Boolean);
    const rows: Row[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      const tags = (cache && getAllTags(cache)) ?? [];
      const inScope = scopes.some((s) => s.startsWith("#")
        ? tags.some((t) => t === s || t.startsWith(`${s}/`))
        : f.path.startsWith(`${normalizePath(s)}/`));
      if (!inScope) continue;
      rows.push({
        ...(cache?.frontmatter ?? {}),
        name: f.basename,
        path: f.path,
        tags,
        mtime: stampParts(new Date(f.stat.mtime)).at,
        ctime: stampParts(new Date(f.stat.ctime)).at,
      });
    }
    return rows;
  }

  /** A wide panel's inner width: the app column minus its padding and the panel's padding and border. */
  private chartWidth(): number {
    return Math.min(this.contentEl.clientWidth, 960) - 32 - 34;
  }

  onResize(): void {
    const width = this.chartWidth();
    if (Math.abs(width - this.renderedWidth) > 24) void this.render();
  }

  private renderCtx(fm: Record<string, unknown>, now: Date): RenderCtx {
    const file = this.file!;
    const process = (fn: (fm: Record<string, unknown>) => void) => this.app.fileManager.processFrontMatter(file, fn);
    this.renderedWidth = this.chartWidth();
    return {
      now,
      chartWidth: this.renderedWidth,
      fm,
      runActions: (p, row) => this.runActions(p, row),
      toggleChecked: (key, item) => process((f) => {
        const list = Array.isArray(f[key]) ? (f[key] as unknown[]).map(String) : [];
        f[key] = list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
      }),
      clearChecked: (key) => process((f) => { f[key] = []; }),
      openNote: (path) => void this.app.workspace.openLinkText(path, file.path),
      timer: (i, p) => this.timerState(i, p),
      startTimer: (i, p) => {
        const s = this.timerState(i, p);
        s.endsAt = Date.now() + s.remainingMs;
        this.startTicking();
        void this.render();
      },
      pauseTimer: (i) => {
        const s = this.timers.get(i);
        if (s?.endsAt) { s.remainingMs = s.endsAt - Date.now(); s.endsAt = undefined; }
        void this.render();
      },
      resetTimer: (i, p) => {
        this.timers.set(i, { remainingMs: p.minutes! * 60_000 });
        void this.render();
      },
    };
  }

  private timerState(i: number, p: Panel): TimerState {
    let s = this.timers.get(i);
    if (!s) this.timers.set(i, (s = { remainingMs: p.minutes! * 60_000 }));
    return s;
  }

  private tick(): void {
    if (![...this.timers.values()].some((t) => t.endsAt)) return this.stopTicking();
    const spec = readSpec(this.frontmatter() ?? {})?.spec;
    for (const [i, s] of this.timers) {
      if (!s.endsAt) continue;
      const left = s.endsAt - Date.now();
      const el = this.contentEl.querySelector(`[data-na-timer="${i}"]`);
      if (el) el.textContent = formatClock(left);
      if (left <= 0) {
        const p = spec?.panels[i];
        this.timers.set(i, { remainingMs: (p?.minutes ?? 0) * 60_000 });
        new Notice(`${p?.title ?? "Timer"} finished`);
        void (p ? this.runActions(p, { minutes: p.minutes }) : Promise.resolve()).then(() => this.render());
      }
    }
  }

  async runActions(p: Panel, row: Row): Promise<void> {
    const file = this.file;
    if (!file) return;
    const stamp = stampParts(new Date());
    const saved: Row = { ...row, at: stamp.at };
    const ctx = { ...stamp, ...row };
    try {
      if (p.append) {
        const fields = Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(", ");
        const line = fillTemplate(p.line ?? `- {date} {time}${fields ? ` ${fields}` : ""}`, ctx);
        await this.appendLine(notePath(p.append), line);
      }
      if (p.save) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const list = Array.isArray(fm[p.save!]) ? fm[p.save!] : [];
          list.push(saved);
          fm[p.save!] = list;
        });
      }
      if (p.notify) new Notice(fillTemplate(p.notify, ctx));
    } catch (e) {
      new Notice(`Couldn't save: ${(e as Error).message}`);
    }
  }

  private async appendLine(path: string, line: string): Promise<void> {
    const target = this.app.vault.getFileByPath(normalizePath(path));
    if (target) {
      await this.app.vault.process(target, (text) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
      return;
    }
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder && !this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
    await this.app.vault.create(normalizePath(path), `${line}\n`);
  }
}
