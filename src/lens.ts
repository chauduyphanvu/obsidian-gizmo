import { MarkdownView, TFile } from "obsidian";
import type { AppEnv } from "./app.ts";
import { LensIndex, LensStack, type LensFolds } from "./lenses.ts";
import { obsidianAppEnv } from "./host.ts";
import type GizmoPlugin from "./main.ts";

/**
 * Lenses: above the content of every markdown view (reading and editing alike) whose note has
 * lenses, a `.gz-lens` element holding them (see LensStack). It sits beside the editor and the
 * preview inside the view's content, so the note's text and the editor's document are untouched and
 * switching modes keeps it. Kept in line with the open notes, their properties and the components.
 */
export function registerLenses(plugin: GizmoPlugin): LensIndex {
  const app = plugin.app;
  const index = new LensIndex(plugin.dataLayer);
  const stacks = new Map<MarkdownView, LensStack>();
  const folds: LensFolds = {
    folded: (component) => plugin.store.folded?.[component] === true,
    setFolded(component, folded) {
      const store = (plugin.store.folded ??= {});
      if (folded) store[component] = true;
      else delete store[component];
      void plugin.saveData(plugin.store);
    },
  };
  // Links and templates in a lens resolve from its component.
  const envFor = (view: MarkdownView) => (component: string): AppEnv => {
    const file = app.vault.getFileByPath(component) ?? view.file!;
    return obsidianAppEnv(plugin, undefined, file);
  };
  const drop = (view: MarkdownView, stack: LensStack) => {
    stack.dispose();
    stack.el.remove();
    stacks.delete(view);
  };

  const sync = () => {
    const views = new Set<MarkdownView>();
    app.workspace.iterateAllLeaves((leaf) => { if (leaf.view instanceof MarkdownView) views.add(leaf.view); });
    for (const [view, stack] of stacks) if (!views.has(view)) drop(view, stack);
    for (const view of views) {
      const path = view.file?.path;
      let stack = stacks.get(view);
      if (!stack) {
        if (!path || index.lensesFor(path).length === 0) continue;
        stack = new LensStack(view.contentEl.createDiv({ cls: "gz-lens" }), index, envFor(view), folds);
        stacks.set(view, stack);
      }
      stack.show(path);
      if (stack.size === 0) drop(view, stack);
      else if (view.contentEl.firstElementChild !== stack.el) view.contentEl.prepend(stack.el);
    }
  };

  app.workspace.onLayoutReady(sync);
  plugin.registerEvent(app.workspace.on("file-open", sync));
  plugin.registerEvent(app.workspace.on("layout-change", sync));
  plugin.registerEvent(app.workspace.on("active-leaf-change", () => {
    sync();
    for (const stack of stacks.values()) stack.recheck();
  }));
  // Registered after the plugin's own handlers, so the data layer already knows the change.
  plugin.registerEvent(app.metadataCache.on("changed", (file) => {
    index.changed(file.path);
    sync();
  }));
  plugin.registerEvent(app.vault.on("delete", (file) => {
    if (file instanceof TFile) index.deleted(file.path);
    sync();
  }));
  plugin.registerEvent(app.vault.on("rename", (file, oldPath) => {
    if (file instanceof TFile) index.renamed(file.path, oldPath);
    sync();
  }));
  plugin.registerEvent(app.workspace.on("resize", () => { for (const stack of stacks.values()) stack.resize(); }));
  plugin.register(plugin.onGrantsChange(() => { for (const stack of stacks.values()) stack.recheck(); }));
  plugin.register(() => { for (const [view, stack] of stacks) drop(view, stack); });
  return index;
}
