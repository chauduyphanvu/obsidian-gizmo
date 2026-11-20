import { AppController, type AppEnv, type Hosting } from "./app.ts";
import type { Row } from "./data.ts";
import type { DataLayer } from "./datalayer.ts";
import { componentParams, readFor } from "./expand.ts";
import { thisValues } from "./sources/this.ts";
import { basename, defaultDataPath, isComponent, isSet, runsAsApp } from "./store.ts";

/**
 * The app a lens runs as on one note: the component, each param filled from the note's property
 * of the same name as `$this.<name>` (a value from the note, checked as one when it's filled), or
 * else its default. Undefined when a param has neither: most notes in a folder may simply lack it,
 * so the lens isn't shown there.
 */
export function lensDefinition(componentPath: string, component: Record<string, unknown> | undefined, note: Row): Record<string, unknown> | undefined {
  const given: Record<string, string> = {};
  for (const [name, fallback] of componentParams(component?.params) ?? []) {
    const value = note[name];
    if (value !== undefined && value !== null && value !== "") given[name] = `$this.${name}`;
    else if (fallback === undefined) return undefined;
  }
  return { app: "", use: `[[${componentPath.replace(/\.md$/i, "")}]]`, with: given };
}

/**
 * Which lenses show on which notes: every component note with a `for` that checks out, kept
 * current as notes change. A note is in a lens's scope when `source: notes` with that `from` would
 * list it.
 */
export class LensIndex {
  private data: DataLayer;
  /** Component path → its `for` scope; read on first use. */
  private scopes: Map<string, string> | undefined;

  constructor(data: DataLayer) {
    this.data = data;
  }

  private all(): Map<string, string> {
    if (!this.scopes) {
      this.scopes = new Map();
      for (const f of this.data.host.markdownFiles()) this.read(f.path);
    }
    return this.scopes;
  }

  private read(path: string): void {
    const fm = this.data.host.frontmatter(path);
    const lens = isComponent(fm) && isSet(fm!.for) ? readFor(fm!.for) : undefined;
    if (lens && "scope" in lens) this.scopes!.set(path, lens.scope);
    else this.scopes!.delete(path);
  }

  /** Reads a changed note again, in case it became, changed or stopped being a lens. */
  changed(path: string): void {
    if (this.scopes) this.read(path);
  }

  deleted(path: string): void {
    this.scopes?.delete(path);
  }

  renamed(path: string, oldPath: string): void {
    this.deleted(oldPath);
    this.changed(path);
  }

  /** Every lens: its component's path and its `for` scope. */
  lenses(): [string, string][] {
    return [...this.all()];
  }

  scopeOf(componentPath: string): string | undefined {
    return this.all().get(componentPath);
  }

  /** The lenses a note shows, in component-name order: none on an app, a component or another note's data note. */
  lensesFor(path: string): string[] {
    const fm = this.data.host.frontmatter(path);
    if (runsAsApp(fm)) return [];
    if (/ data\.md$/i.test(path) && this.data.host.fileInfo(path.replace(/ data\.md$/i, ".md"))) return [];
    return [...this.all()]
      .filter(([component, scope]) => this.data.notes(scope).some((r) => r.path === path) && this.definition(component, path))
      .map(([component]) => component)
      .sort((a, b) => basename(a).localeCompare(basename(b)));
  }

  /** What a lens runs as on a note (see lensDefinition); undefined once it isn't a lens. */
  definition(componentPath: string, hostPath: string): Record<string, unknown> | undefined {
    if (!this.all().has(componentPath)) return undefined;
    const host = this.data.host;
    return lensDefinition(componentPath, host.frontmatter(componentPath), thisValues(hostPath, host.frontmatter(hostPath), host.tags(hostPath)));
  }
}

/** Whether a lens is folded away; the plugin keeps this per component, across notes and restarts. */
export interface LensFolds {
  folded(componentPath: string): boolean;
  setFolded(componentPath: string, folded: boolean): void;
}

/**
 * One lens above a note: a header with the component's name (a link to it) and a toggle, and,
 * while unfolded, the component running as an app on the note. Grants are the component's, asked
 * once for every note it shows on; recorded data goes to the note's own data note.
 */
class LensItem {
  readonly el: HTMLElement;
  readonly scope: string;
  private body: HTMLElement;
  private toggle: HTMLButtonElement;
  private controller: AppController | undefined;

  constructor(parent: HTMLElement, componentPath: string, hostPath: string, scope: string, index: LensIndex, env: AppEnv, folds: LensFolds) {
    this.scope = scope;
    this.el = parent.createDiv({ cls: "gz-lens-item" });
    const head = this.el.createDiv({ cls: "gz-lens-head" });
    this.toggle = head.createEl("button", { cls: "gz-lens-toggle" });
    const name = basename(componentPath);
    const link = head.createEl("a", { cls: "internal-link gz-lens-name", text: name, href: "#" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      env.openNote(componentPath, hostPath);
    });
    this.body = this.el.createDiv({ cls: "gz-lens-body" });
    const hosting: Hosting = {
      kind: "lens", grantKey: componentPath, hostPath, dataPath: defaultDataPath(hostPath), scope,
      definition: () => index.definition(componentPath, hostPath),
    };
    const fold = (folded: boolean) => {
      this.toggle.setAttr("aria-expanded", String(!folded));
      this.toggle.setAttr("aria-label", `${folded ? "Show" : "Hide"} ${name}`);
      this.toggle.setText(folded ? "▸" : "▾");
      this.el.classList.toggle("is-folded", folded);
      if (folded) return this.stop();
      if (this.controller) return;
      this.controller = new AppController(this.body, componentPath, env, hosting);
      this.controller.load();
    };
    this.toggle.addEventListener("click", () => {
      const folded = !folds.folded(componentPath);
      folds.setFolded(componentPath, folded);
      fold(folded);
    });
    fold(folds.folded(componentPath));
  }

  resize(): void {
    this.controller?.resize();
  }

  recheck(): void {
    this.controller?.recheck();
  }

  private stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }

  dispose(): void {
    this.stop();
    this.el.remove();
  }
}

/**
 * The lenses shown above one note, stacked in component-name order. `show` brings them in line with
 * the lenses the note has now (it may have entered or left a scope, or a component changed),
 * keeping the ones that stay as they are.
 */
export class LensStack {
  readonly el: HTMLElement;
  private index: LensIndex;
  private envFor: (componentPath: string) => AppEnv;
  private folds: LensFolds;
  private hostPath: string | undefined;
  private items = new Map<string, LensItem>();

  constructor(el: HTMLElement, index: LensIndex, envFor: (componentPath: string) => AppEnv, folds: LensFolds) {
    this.el = el;
    this.index = index;
    this.envFor = envFor;
    this.folds = folds;
  }

  get size(): number {
    return this.items.size;
  }

  show(hostPath: string | undefined): void {
    if (hostPath !== this.hostPath) this.clear();
    this.hostPath = hostPath;
    const wanted = hostPath ? this.index.lensesFor(hostPath) : [];
    for (const [component, item] of this.items) {
      // A lens whose scope changed asks again for what it may change.
      if (wanted.includes(component) && item.scope === this.index.scopeOf(component)) continue;
      item.dispose();
      this.items.delete(component);
    }
    wanted.forEach((component, i) => {
      let item = this.items.get(component);
      if (!item) {
        item = new LensItem(this.el, component, hostPath!, this.index.scopeOf(component)!, this.index, this.envFor(component), this.folds);
        this.items.set(component, item);
      }
      // Moving an element takes the focus out of it, and this runs on every change to the note.
      const at = this.el.children[i];
      if (at !== item.el) this.el.insertBefore(item.el, at ?? null);
    });
  }

  resize(): void {
    for (const item of this.items.values()) item.resize();
  }

  recheck(): void {
    for (const item of this.items.values()) item.recheck();
  }

  private clear(): void {
    for (const item of this.items.values()) item.dispose();
    this.items.clear();
  }

  dispose(): void {
    this.clear();
    this.hostPath = undefined;
  }
}
