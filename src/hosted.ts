import { AppController, newMemory, type AppEnv, type AppMemory, type Hosting } from "./app.ts";
import type { Row } from "./data.ts";
import type { DataLayer } from "./datalayer.ts";
import { basename, componentParams, linkOf, readFor } from "./expand.ts";
import { thisValues } from "./sources/this.ts";
import { isComponent } from "./spec.ts";
import { defaultDataPath } from "./store.ts";
import { isPlainObject } from "./views/common.ts";

/**
 * What a `gizmo` block holds: an app's keys, as an app note's frontmatter holds them (`embed`),
 * or a link to an app note and which of its panels to show (`app`).
 */
export type HostedBlock =
  | { kind: "embed"; definition: Record<string, unknown> }
  | { kind: "app"; link: string; panels?: string[] }
  | { error: string };

/** `app: "[[Meds]]"`, or the same without quotes (YAML for a list holding a list). */
function appLink(value: unknown): string | undefined {
  const unquoted = Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1;
  return unquoted || (typeof value === "string" && /^\s*\[\[[^\]]+\]\]\s*$/.test(value)) ? linkOf(value) : undefined;
}

/**
 * Checks a block's keys (already read as YAML). Anything an app note's frontmatter holds may go in
 * one, without the `app:` line; `app` as a link instead shows that app, with nothing beside it but
 * `panels`, a list of the titles or labels of the panels to show.
 */
export function parseHosted(value: unknown): HostedBlock {
  if (value === null || value === undefined) return { kind: "embed", definition: { app: "" } };
  if (!isPlainObject(value)) return { error: "a gizmo block holds an app's keys, e.g. view: countdown" };
  const link = appLink(value.app);
  if (link === undefined) {
    const app = value.app === undefined || value.app === null || value.app === false ? "" : value.app;
    return { kind: "embed", definition: { ...value, app } };
  }
  const others = Object.keys(value).filter((k) => k !== "app" && k !== "panels");
  if (others.length) return { error: `beside app: "[[${link}]]" only panels can go` };
  if (value.panels === undefined || value.panels === null) return { kind: "app", link };
  const panels = value.panels;
  if (!Array.isArray(panels) || panels.length === 0 || !panels.every((p) => typeof p === "string" || typeof p === "number")) {
    return { error: "panels must be a list of panel titles, e.g. panels: [Took meds]" };
  }
  return { kind: "app", link, panels: panels.map(String) };
}

/** A block's identity for grants and kept state: its note and a hash of its text, so changing the text asks again. */
export function blockKey(hostPath: string, source: string): string {
  const text = source.trimEnd();
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${hostPath}#${(h >>> 0).toString(36)}`;
}

/**
 * Whether `wanted` is allowed under a grant key: exactly these were allowed, or there are none to
 * allow. With `opened`, wanting nothing isn't enough: the app must have been opened in its own tab,
 * which leaves an entry even when it asks for nothing. The background acts only for such apps, so
 * a note that became an app without the user looking at it never runs unseen.
 */
export function isAllowed(grants: Record<string, string>, key: string, wanted: readonly string[], opened = false): boolean {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  return (wanted.length === 0 && !opened) || entry === wanted.join("\n");
}

/** The grant keys that belong to a note: its own (an app's) and its embeds' (`<path>#<hash>`). */
function grantKeysOf(grants: Record<string, string>, path: string): string[] {
  return Object.keys(grants).filter((k) => k === path || k.startsWith(`${path}#`));
}

/** Moves a renamed note's grants, its embeds' included; true when there were any. */
export function moveGrants(grants: Record<string, string>, oldPath: string, path: string): boolean {
  const keys = grantKeysOf(grants, oldPath);
  for (const key of keys) {
    const value = grants[key];
    delete grants[key];
    grants[path + key.slice(oldPath.length)] = value;
  }
  return keys.length > 0;
}

/** Drops a deleted note's grants, its embeds' included; true when there were any. */
export function dropGrants(grants: Record<string, string>, path: string): boolean {
  const keys = grantKeysOf(grants, path);
  for (const key of keys) delete grants[key];
  return keys.length > 0;
}

/**
 * What the embeds in open notes keep (input values, selections, the open tab, timers), by block,
 * so a block drawn again keeps them: the editor redraws a block whenever the cursor leaves it or it
 * scrolls back into view. Forgotten once its note is no longer open, as an app's are when closed.
 */
export class Memories {
  private kept = new Map<string, { hostPath: string; memory: AppMemory }>();

  of(key: string, hostPath: string): AppMemory {
    let entry = this.kept.get(key);
    if (!entry) this.kept.set(key, (entry = { hostPath, memory: newMemory() }));
    return entry.memory;
  }

  /** Forgets the blocks of notes that aren't open any more. */
  keepOnly(open: ReadonlySet<string>): void {
    for (const [key, entry] of this.kept) if (!open.has(entry.hostPath)) this.kept.delete(key);
  }

  clear(): void {
    this.kept.clear();
  }
}

/**
 * One `gizmo` block drawn in a note. With an app's keys it runs as its own app (grants under
 * its block key, data in the note's `<Note> data.md` unless `store` says otherwise). With a link it
 * runs that app note's keys as that app (its grants and data note), showing the panels `panels`
 * names; while the link finds no note it says so, and tries again when a note of that name appears.
 * `$this` is the note the block is in, either way.
 */
export class HostedApp {
  private root: HTMLElement;
  private block: HostedBlock;
  private key: string;
  private hostPath: string;
  private env: AppEnv;
  private memory: AppMemory;
  private controller: AppController | undefined;
  private shell: HTMLElement | undefined;
  private appPath: string | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(root: HTMLElement, value: unknown, source: string, hostPath: string, env: AppEnv, memory?: AppMemory) {
    this.root = root;
    this.block = parseHosted(value);
    this.key = blockKey(hostPath, source);
    this.hostPath = hostPath;
    this.env = env;
    this.memory = memory ?? newMemory();
  }

  load(): void {
    const block = this.block;
    if ("error" in block) return this.showError(block.error);
    if (block.kind === "embed") {
      this.start(this.hostPath, { kind: "embed", grantKey: this.key, hostPath: this.hostPath, definition: () => block.definition, memory: this.memory });
      return;
    }
    this.unsubscribe = this.env.data.subscribe([`name:${basename(block.link)}`], () => {
      if (this.env.notes.resolve(block.link, this.hostPath) !== this.appPath) this.linkApp(block.link, block.panels);
    });
    this.linkApp(block.link, block.panels);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stop();
  }

  resize(): void {
    this.controller?.resize();
  }

  /** Looks again at whether the app is allowed, which may have changed in another tab. */
  recheck(): void {
    this.controller?.recheck();
  }

  private linkApp(link: string, panels: string[] | undefined): void {
    this.stop();
    const appPath = this.env.notes.resolve(link, this.hostPath);
    this.appPath = appPath;
    if (!appPath) return this.showError(`Can't find [[${link}]]`);
    const env = this.env;
    this.start(appPath, { kind: "app", grantKey: appPath, hostPath: this.hostPath, definition: () => env.frontmatter(appPath), panels, memory: this.memory });
  }

  private start(appPath: string, hosting: Hosting): void {
    this.controller = new AppController(this.root, appPath, this.env, hosting);
    this.controller.load();
  }

  private stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.shell?.remove();
    this.shell = undefined;
  }

  private showError(text: string): void {
    this.shell = this.root.createDiv({ cls: "gizmo" });
    this.shell.createDiv({ cls: "gz-card gz-error", text });
  }
}

// ---- Lenses --------------------------------------------------------------------------------------

const isSet = (v: unknown) => v !== undefined && v !== null && v !== false;

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

  scopeOf(componentPath: string): string | undefined {
    return this.all().get(componentPath);
  }

  /** The lenses a note shows, in component-name order: none on an app, a component or another note's data note. */
  lensesFor(path: string): string[] {
    const fm = this.data.host.frontmatter(path);
    if (fm && (isSet(fm.app) || isSet(fm.component))) return [];
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
