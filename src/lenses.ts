import { AppController, type AppEnv, type Hosting } from "./app.ts";
import type { LensIndex } from "./lens-index.ts";
import { basename, defaultDataPath } from "./store.ts";

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
