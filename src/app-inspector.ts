import type { AppEnv, Mounted } from "./app.ts";
import type { AppFiles } from "./datalayer.ts";
import { renderInspector, sourceKind, type InspectedSource } from "./inspect.ts";
import { isUrl, panelIds, type AppSpec } from "./spec.ts";

/** What Inspect data asks of the app it is opened in, as it is at the moment it asks. */
export interface InspectedApp {
  env: AppEnv;
  shell: HTMLElement;
  /** The app's panels as drawn, by id. */
  mounted: ReadonlyMap<string, Mounted>;
  spec(): AppSpec | undefined;
  files(): AppFiles;
  /** How long a web answer is good for in this app. */
  ttlMs(): number;
  /** What the pane goes above: the input bar, else the panels. */
  below(): Element | null;
}

/** Inspect data: a pane above an app's panels showing what each of their sources returned. */
export class AppInspector {
  private app: InspectedApp;
  /** The data inspector pane, while it is open, and which fill of it is the latest. */
  private pane: HTMLElement | undefined;
  private inspecting = 0;

  constructor(app: InspectedApp) {
    this.app = app;
  }

  /** The pane, while it is open. */
  get el(): HTMLElement | undefined {
    return this.pane;
  }

  /** Forgets the pane, which goes with the app's shell. */
  drop(): void {
    this.pane = undefined;
  }

  /**
   * The distinct sources of the panels on screen, each with the title of the first panel that uses
   * it and what it returned before any pick, where or other step. Loads through the data layer's
   * cache, so nothing is requested twice. Web addresses keep their `{secret:…}` placeholders.
   */
  async inspect(): Promise<InspectedSource[]> {
    return Promise.all([...this.sourceReaders().values()].map(async (m): Promise<InspectedSource> => {
      const found = { title: m.p.title ?? m.p.view, kind: sourceKind(m.source!, m.p.from), ...(isUrl(m.source) ? { source: m.source } : {}) };
      try {
        const data = await this.app.env.data.rawData(m.source, m.p, this.app.files(), { ttlMs: this.app.ttlMs(), now: this.app.env.now() });
        return { ...found, data };
      } catch (e) {
        return { ...found, data: { error: (e as Error).message } };
      }
    }));
  }

  /** The first panel on screen that reads each distinct source, by its source (see sourceKey), in the order written. */
  private sourceReaders(): Map<string, Mounted> {
    const ids = this.app.spec() ? panelIds(this.app.spec()!.panels.map((ps) => ps.template)) : [];
    const first = new Map<string, Mounted>();
    for (const m of ids.map((id) => this.app.mounted.get(id))) {
      if (!m || m.idle || !m.source) continue;
      const key = sourceKey(m);
      if (!first.has(key)) first.set(key, m);
    }
    return first;
  }

  /** Whether the inspector is showing. */
  get shown(): boolean {
    return this.pane !== undefined;
  }

  /** Shows the inspector above the panels, or takes it away. */
  async toggle(): Promise<void> {
    if (this.pane) {
      this.pane.remove();
      this.pane = undefined;
      return;
    }
    this.open();
    await this.fill();
  }

  private open(): void {
    const pane = this.app.shell.createDiv({ cls: "gz-card gz-inspector" });
    this.app.shell.insertBefore(pane, this.app.below());
    this.pane = pane;
    pane.createDiv({ cls: "gz-empty", text: "Loading…" });
  }

  /** Fills the open inspector; `focus`, a panel's id, scrolls it to that panel's source. */
  async fill(focus?: string): Promise<void> {
    const pane = this.pane;
    const run = ++this.inspecting;
    // In the order inspect gives the sources, read before it waits for any.
    const keys = [...this.sourceReaders().keys()];
    const sources = await this.inspect();
    if (!pane || pane !== this.pane || run !== this.inspecting) return;
    const m = focus === undefined ? undefined : this.app.mounted.get(focus);
    const at = m?.source ? keys.indexOf(sourceKey(m)) : -1;
    renderInspector(pane, sources, (text) => this.app.env.copy(text), at < 0 ? undefined : at);
  }

  /** Opens Inspect data, or keeps it open, at the source of the panel with this id. */
  async inspectPanel(id: string): Promise<void> {
    if (!this.pane) this.open();
    await this.fill(id);
  }
}

/** What tells a panel's source apart from another's, for Inspect data: the same address with other headers or body is another. */
function sourceKey(m: Mounted): string {
  return JSON.stringify([m.source, m.p.from, m.p.headers, m.p.body]);
}
