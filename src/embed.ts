import { MarkdownRenderChild, MarkdownView, parseYaml } from "obsidian";
import { HostedApp, Memories, blockKey } from "./hosted.ts";
import { obsidianAppEnv } from "./host.ts";
import type GizmoPlugin from "./main.ts";

/** A block's app, started when Obsidian loads the block's element and disposed when it goes. */
class EmbedChild extends MarkdownRenderChild {
  private hosted: HostedApp;
  private live: Set<HostedApp>;

  constructor(el: HTMLElement, hosted: HostedApp, live: Set<HostedApp>) {
    super(el);
    this.hosted = hosted;
    this.live = live;
  }

  onload(): void {
    this.live.add(this.hosted);
    this.hosted.load();
    // The block is laid out once it is in the page; measure it then.
    this.hosted.resize();
  }

  onunload(): void {
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
  plugin.register(() => {
    for (const h of live) h.dispose();
    live.clear();
    memories.clear();
  });
}
