import {
  BasesView, BooleanValue, FileView, ListValue, Notice, NullValue, NumberValue, getLinkpath,
  type BasesAllOptions, type BasesPropertyId, type BasesViewConfig, type QueryController, type Value,
} from "obsidian";
import type { Change } from "./activity.ts";
import { BASES_VIEWS, basesPanel, entryIds, entryRow, optionValues, writeErrors, type BasesKind, type OptionDef } from "./bases-rows.ts";
import type { Row } from "./data.ts";
import { obsidianWrites } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { compilePipeline } from "./pipeline.ts";
import type { Panel } from "./spec.ts";
import { mountView } from "./views/common.ts";
import { viewDef, type PanelCtx, type PanelHandle } from "./views/registry.ts";

/** A Bases value as plain data, the way a note's own properties read. */
function plain(v: Value | null): unknown {
  if (v === null || v instanceof NullValue) return null;
  if (v instanceof NumberValue) return Number(v.toString());
  if (v instanceof BooleanValue) return v.isTruthy();
  if (v instanceof ListValue) return Array.from({ length: v.length() }, (_, i) => plain(v.get(i)));
  return v.toString();
}

/** What Bases keeps for an option: a property option as its property id. */
function storedOf(kind: BasesKind, config: BasesViewConfig): (key: string) => unknown {
  const properties = new Set(BASES_VIEWS[kind].options.filter((o) => o.type === "property").map((o) => o.key));
  return (key) => (properties.has(key) ? config.getAsPropertyId(key) ?? undefined : config.get(key));
}

function basesOption(o: OptionDef, kind: BasesKind, config: BasesViewConfig): BasesAllOptions {
  const { key, displayName, hidden } = o;
  const common = { key, displayName, ...(hidden ? { shouldHide: () => hidden(optionValues(kind, storedOf(kind, config))) } : {}) };
  if (o.type === "dropdown") return { ...common, type: "dropdown", options: o.choices!, default: Object.keys(o.choices!)[0] };
  // Bases writes "undefined" in an empty field that has no placeholder.
  return { ...common, type: o.type, placeholder: o.placeholder ?? (o.type === "property" ? "Choose a property" : "") };
}

/** One Gizmo view drawn under a base's toolbar, from the notes the base shows. */
class GizmoBasesView extends BasesView {
  type: string;
  private plugin: GizmoPlugin;
  private kind: BasesKind;
  private root: HTMLElement;
  /** Selections climb to the panel's element to find what else to mark (see markAll). */
  private el: HTMLElement;
  private observer: ResizeObserver | undefined;
  /** The options the view was last drawn with; data alone changing keeps the drawn view. */
  private drawnWith: string | undefined;
  private panel: Panel | undefined;
  private pipeline: ((rows: unknown) => unknown) | undefined;
  private handle: PanelHandle | undefined;
  private selections = new Map<string, Row>();

  constructor(controller: QueryController, containerEl: HTMLElement, plugin: GizmoPlugin, kind: BasesKind) {
    super(controller);
    this.type = `gizmo-${kind}`;
    this.plugin = plugin;
    this.kind = kind;
    this.root = containerEl.createDiv({ cls: "gizmo gz-bases" });
    this.el = this.root.createDiv({ cls: "gz-panel" });
  }

  onload(): void {
    this.observer = new ResizeObserver(() => this.handle?.resize?.(this.width()));
    this.observer.observe(this.el);
  }

  onunload(): void {
    this.observer?.disconnect();
    this.handle?.destroy?.();
    this.handle = undefined;
    this.root.remove();
  }

  onDataUpdated(): void {
    const stored = storedOf(this.kind, this.config);
    const options = JSON.stringify(BASES_VIEWS[this.kind].options.map((o) => stored(o.key)));
    if (options !== this.drawnWith) {
      this.drawnWith = options;
      this.build(stored);
    }
    if (this.handle && this.pipeline) this.handle.update(this.pipeline(this.rows()));
  }

  private build(stored: (key: string) => unknown): void {
    this.handle?.destroy?.();
    this.handle = undefined;
    this.el.empty();
    this.el.className = "gz-panel";
    const path = this.basePath();
    // A base written in a note's code block has no file of its own; any name ending in .base makes the rows notes.
    const { panel, errors } = basesPanel(this.kind, stored, path.endsWith(".base") ? path : `${path || "Base"}.base`);
    this.panel = panel;
    if (!panel) {
      this.el.addClass("gz-error");
      this.el.createDiv({ cls: "gz-title", text: BASES_VIEWS[this.kind].name });
      this.el.createDiv({ text: errors.join("; ") });
      return;
    }
    this.el.addClass(`gz-view-${panel.view}`);
    this.pipeline = compilePipeline(panel, new Date());
    this.handle = mountView(viewDef(panel.view)!, this.el, panel, this.ctx(), "bases");
  }

  private rows(): Row[] {
    const host = this.plugin.runtime.dataLayer.host;
    const picked = BASES_VIEWS[this.kind].options.flatMap((o) => (o.type === "property" ? [this.config.getAsPropertyId(o.key)] : []));
    // Every formula, for card text; of the file properties a notes row lacks, only those picked, since some (backlinks) are costly.
    const ids = entryIds([...this.allProperties.filter((id) => id.startsWith("formula.")), ...picked.filter((id) => id !== null)]);
    return this.data.data.map((e) => entryRow({ file: e.file, getValue: (id) => plain(e.getValue(id as BasesPropertyId)) }, ids, host));
  }

  private ctx(): PanelCtx {
    return {
      get now() { return new Date(); },
      width: () => this.width(),
      runActions: async () => {},
      toggleChecked: async () => {},
      clearChecked: async () => {},
      openNote: (path) => void this.app.workspace.openLinkText(path, ""),
      timer: () => ({ remainingMs: 0 }),
      startTimer: () => {},
      pauseTimer: () => {},
      resetTimer: () => {},
      select: (name, row) => {
        if (row) this.selections.set(name, row);
        else this.selections.delete(name);
      },
      selected: (name) => this.selections.get(name),
      editRow: (row, field, value) => this.editRow(row, field, value),
    };
  }

  /** The drawing width inside the panel. */
  private width(): number {
    const style = getComputedStyle(this.el);
    const width = this.el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    // Not laid out yet: the ResizeObserver draws it again at its real width.
    return width > 0 ? width : 600;
  }

  /** The base this view is in: its own tab's file, the file a note embeds, or the note a base block sits in. */
  private basePath(): string {
    let host: string | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (host === undefined && leaf.view instanceof FileView && leaf.view.containerEl.contains(this.root)) host = leaf.view.file?.path;
    });
    const embed = this.root.closest(".internal-embed")?.getAttribute("src");
    const linked = embed ? this.app.metadataCache.getFirstLinkpathDest(getLinkpath(embed), host ?? "")?.path : undefined;
    return linked ?? host ?? "";
  }

  /**
   * Sets one property of a note the base shows (a board's card moved), after any app's write to it,
   * and keeps the change in the activity log so it can be undone.
   */
  private async editRow(row: Row, field: string, value: unknown): Promise<void> {
    const path = row.path;
    if (!this.panel || typeof path !== "string" || !this.data.data.some((e) => e.file.path === path)) return;
    const refused = writeErrors(this.panel, field);
    if (refused.length) return void new Notice(refused.join("; "));
    try {
      let change: Change | undefined;
      const written = await obsidianWrites(this.app).updateFrontmatter(path, (fm) => {
        change = { kind: "property", path, field, from: fm[field], to: value, had: Object.hasOwn(fm, field) };
        fm[field] = value;
      });
      if (!written) return void new Notice("That note is gone");
      if (change) void this.plugin.runtime.activity.add({ app: this.basePath(), actor: "you", what: this.config.name, changes: [change] });
    } catch (e) {
      new Notice(`Couldn't save: ${(e as Error).message}`);
    }
  }
}

/** Gizmo's board, calendar, timeline, chart and number as views any base can switch to. */
export function registerBases(plugin: GizmoPlugin): void {
  for (const kind of Object.keys(BASES_VIEWS) as BasesKind[]) {
    const { name, icon, options } = BASES_VIEWS[kind];
    plugin.registerBasesView(`gizmo-${kind}`, {
      name,
      icon,
      factory: (controller, containerEl) => new GizmoBasesView(controller, containerEl, plugin, kind),
      options: (config) => options.map((o) => basesOption(o, kind, config)),
    });
  }
}
