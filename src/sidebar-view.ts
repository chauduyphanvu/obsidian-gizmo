import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { when } from "./activity-view.ts";
import { AsksCard } from "./app-asks.ts";
import { openCapture, openCaptureWith, undoNotice } from "./capture-command.ts";
import { buildMap } from "./map.ts";
import type GizmoPlugin from "./main.ts";
import { sidebarModel, type SidebarModel } from "./sidebar.ts";

export const HOME_VIEW = "gizmo-home";

/**
 * Gizmo in the sidebar: Do or find…, what needs the person (Next's asks, answered the same way),
 * and every app with where it stands, how many asks wait on it, and its latest change. Drawn again
 * 200 ms after the last change, and only while it can be seen.
 */
export class HomeView extends ItemView {
  private plugin: GizmoPlugin;
  private timer: number | undefined;
  private drawing = 0;
  /** Something changed while the sidebar was out of sight: drawn when it shows again. */
  private stale = false;
  private card: AsksCard | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: GizmoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return HOME_VIEW; }
  getDisplayText(): string { return "Gizmo"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    const later = () => this.schedule();
    this.register(this.plugin.runtime.onGrantsChange(later));
    this.register(this.plugin.runtime.activity.onChange(later));
    this.register(this.plugin.runtime.onHeadline(later));
    const bg = this.plugin.runtime.background;
    this.register(bg.onIndexChange(later));
    this.register(bg.asks.subscribe(later));
    this.registerEvent(this.app.workspace.on("layout-change", () => { if (this.stale && this.shown()) this.schedule(); }));
    void this.draw();
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.timer);
    this.card?.stop();
  }

  private shown(): boolean {
    return this.containerEl.isShown();
  }

  private schedule(): void {
    if (!this.shown()) {
      this.stale = true;
      return;
    }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.draw(), 200);
  }

  /** The model as it is now: the map's apps (as the automation map reads them) and Next's asks. */
  private async model(): Promise<SidebarModel> {
    const plugin = this.plugin;
    const activity = await plugin.runtime.activity.list();
    const map = buildMap(plugin.runtime.background.list(), plugin.runtime.store.grants, plugin.runtime.lenses.lenses(), activity);
    return sidebarModel(map, plugin.runtime.background.asks.list(), plugin.runtime.headlines);
  }

  private async draw(): Promise<void> {
    const run = ++this.drawing;
    const model = await this.model();
    if (run !== this.drawing) return;
    this.stale = false;
    const plugin = this.plugin;
    const el = this.contentEl;
    el.empty();
    this.card?.stop();
    const box = el.createDiv({ cls: "gizmo gz-home" });
    const find = box.createEl("button", { cls: "gz-home-find", text: "Do or find…", attr: { type: "button" } });
    find.addEventListener("click", () => openCapture(plugin));

    const needs = box.createDiv({ cls: "gz-home-section" });
    needs.createDiv({ cls: "gz-home-heading", text: model.asks.length ? `Needs you · ${model.asks.length}` : "Needs you" });
    const asksAt = needs.createDiv();
    const bg = plugin.runtime.background;
    if (!model.asks.length || !bg) needs.createDiv({ cls: "gz-muted gz-home-empty", text: "Nothing needs you." });
    else {
      this.card = new AsksCard({
        asks: {
          list: () => bg.asks.list(),
          subscribe: (cb) => bg.asks.subscribe(cb),
          settle: (ask, how) => bg.settleAsk(ask, how),
          skip: (id) => bg.skipAsk(id),
          run: (line) => bg.capture(line, undefined, true),
          fill: (line, cursor) => openCaptureWith(plugin, line, cursor),
          open: (path) => void this.app.workspace.openLinkText(path, "", false),
        },
        host: () => asksAt,
        said: (_at, text, entry) => undoNotice(plugin, text, entry),
        notify: (text) => new Notice(text),
      });
      this.card.draw();
    }

    const apps = box.createDiv({ cls: "gz-home-section" });
    apps.createDiv({ cls: "gz-home-heading", text: `Apps · ${model.apps.length}` });
    const ul = apps.createEl("ul", { cls: "gz-home-apps" });
    const now = new Date();
    for (const a of model.apps) {
      const li = ul.createEl("li", { cls: `gz-home-app is-${a.state}` });
      const link = li.createEl("button", { cls: "gz-home-open", attr: { type: "button", title: `Open ${a.name}` } });
      link.createSpan({ cls: `gz-status ${a.state === "allowed" ? "is-ok" : a.state === "blocked" ? "is-bad" : "is-off"}`, attr: { "aria-hidden": "true" } });
      link.createSpan({ cls: "gz-home-name", text: a.name });
      if (a.asks) link.createSpan({ cls: "gz-home-count", text: String(a.asks), attr: { "aria-label": `${a.asks} waiting` } });
      if (a.stateText) link.createSpan({ cls: "gz-home-state gz-muted", text: a.stateText });
      link.addEventListener("click", () => void this.app.workspace.openLinkText(a.path, "", false));
      if (a.headline) li.createDiv({ cls: "gz-home-last gz-home-headline", text: a.headline });
      else if (a.last) li.createDiv({ cls: "gz-home-last gz-muted", text: `${when(a.last.at, now)} · ${a.last.what}` });
    }
    if (!model.apps.length) apps.createDiv({ cls: "gz-muted gz-home-empty", text: "No apps yet: a note with an app: line is one." });
  }
}

/** Opens the Gizmo sidebar, on the left, or shows it where it already is. */
export async function openHome(plugin: GizmoPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const leaf = workspace.getLeavesOfType(HOME_VIEW)[0] ?? workspace.getLeftLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: HOME_VIEW, active: true });
  await workspace.revealLeaf(leaf);
}

export function registerHome(plugin: GizmoPlugin): void {
  plugin.registerView(HOME_VIEW, (leaf) => new HomeView(leaf, plugin));
  plugin.addCommand({ id: "open-sidebar", name: "Open sidebar", callback: () => void openHome(plugin) });
}
