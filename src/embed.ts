import { MarkdownRenderChild, MarkdownView, parseYaml } from "obsidian";
import { HostedApp, Memories, blockKey } from "./hosted.ts";
import { obsidianAppEnv } from "./host.ts";
import type GizmoPlugin from "./main.ts";

/**
 * A block's app, started the first time the block is shown and disposed when it goes. A markdown
 * view keeps its other mode drawn out of sight (reading view behind live preview, and the other way
 * round), so every block is drawn twice; the hidden copy starts only if the view switches to it.
 */
class EmbedChild extends MarkdownRenderChild {
  private hosted: HostedApp;
  private live: Set<HostedApp>;
  private started = false;
  private shown: ResizeObserver | undefined;

  constructor(el: HTMLElement, hosted: HostedApp, live: Set<HostedApp>) {
    super(el);
    this.hosted = hosted;
    this.live = live;
  }

  onload(): void {
    // Out of sight the block has no size; it gets one when its mode is shown. The observer is the
    // block's own window's, which in a pop-out isn't the main one.
    const win = this.containerEl.win as Window & { ResizeObserver: typeof ResizeObserver };
    const shown = new win.ResizeObserver((entries) => {
      if (this.started || !entries.some((e) => e.contentRect.width > 0)) return;
      shown.disconnect();
      this.start();
    });
    shown.observe(this.containerEl);
    this.shown = shown;
  }

  private start(): void {
    this.started = true;
    this.live.add(this.hosted);
    this.hosted.load();
    this.hosted.resize();
  }

  onunload(): void {
    this.shown?.disconnect();
    this.shown = undefined;
    if (!this.started) return;
    this.hosted.dispose();
    this.live.delete(this.hosted);
  }
}

/**
 * ```gizmo blocks: an app drawn in place in any note (see HostedApp). Obsidian draws a block
 * again whenever it likes (in live preview, each time the cursor leaves it), so what a block keeps
 * (inputs, selections, tab, timers) is kept by its identity while its note is open.
 */
export function registerEmbeds(plugin: GizmoPlugin): void {
  const app = plugin.app;
  const live = new Set<HostedApp>();
  const memories = new Memories();

  plugin.registerMarkdownCodeBlockProcessor("gizmo", (source, el, ctx) => {
    el.addClass("gz-embed");
    const file = app.vault.getFileByPath(ctx.sourcePath);
    let value: unknown;
    try {
      value = parseYaml(source);
    } catch (e) {
      el.createDiv({ cls: "gizmo" }).createDiv({ cls: "gz-card gz-error", text: `This block isn't YAML Gizmo can read: ${(e as Error).message}` });
      return;
    }
    if (!file) {
      el.createDiv({ cls: "gizmo" }).createDiv({ cls: "gz-card gz-error", text: "A gizmo block runs in a note." });
      return;
    }
    const memory = memories.of(blockKey(file.path, source), file.path);
    const hosted = new HostedApp(el, value, source, file.path, obsidianAppEnv(plugin, undefined, file), memory);
    ctx.addChild(new EmbedChild(el, hosted, live));
  });

  const forgetClosed = () => {
    const open = new Set<string>();
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file) open.add(leaf.view.file.path);
    });
    memories.keepOnly(open);
  };
  plugin.registerEvent(app.workspace.on("layout-change", forgetClosed));
  plugin.registerEvent(app.workspace.on("file-open", forgetClosed));
  plugin.registerEvent(app.workspace.on("resize", () => { for (const h of live) h.resize(); }));
  // Allowing an app (or a block) in one tab shows in the others once they are looked at.
  plugin.registerEvent(app.workspace.on("active-leaf-change", () => { for (const h of live) h.recheck(); }));
  plugin.register(plugin.onGrantsChange(() => { for (const h of live) h.recheck(); }));
  plugin.register(() => {
    for (const h of live) h.dispose();
    live.clear();
    memories.clear();
  });
}
