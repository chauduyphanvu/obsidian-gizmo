/**
 * Which notes show which lenses, and what a lens runs as on a note: read from the vault through the
 * data layer, with nothing drawn, so every program that runs Gizmo keeps the same index.
 */
import type { Row } from "./data.ts";
import type { DataLayer } from "./datalayer.ts";
import { componentParams, readFor } from "./expand.ts";
import { thisValues } from "./sources/this.ts";
import { basename, isComponent, isSet, runsAsApp } from "./store.ts";

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
