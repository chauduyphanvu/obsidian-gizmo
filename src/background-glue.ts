import { Notice, Platform, normalizePath, type WorkspaceLeaf } from "obsidian";
import { Background, TICK_MS, type StatusItem } from "./background.ts";
import { obsidianAppEnv } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { openInstall } from "./share-command.ts";
import { notePath } from "./spec.ts";
import { storeTarget } from "./store.ts";

/**
 * Obsidian glue for the background service: it starts once the layout is ready, hears about app
 * notes from the metadata cache, ticks on one interval, and stops when the plugin unloads.
 */
export function registerBackground(plugin: GizmoPlugin): Background {
  const app = plugin.app;
  const frontmatter = (path: string) => {
    const f = app.vault.getFileByPath(path);
    return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
  };
  const isSet = (v: unknown) => v !== undefined && v !== null && v !== false;
  // An env without a tab: actions never ask for the source view, the only thing a leaf is for.
  const envFor = (path: string) => {
    const file = app.vault.getFileByPath(path);
    return file ? obsidianAppEnv(plugin, undefined as unknown as WorkspaceLeaf, file) : undefined;
  };
  const openApp = (path: string) => void app.workspace.openLinkText(path, "", false);
  /** Command id (without the plugin's prefix) → name, as registered. */
  const commands = new Map<string, string>();
  const bar: HTMLElement[] = [];
  let shown: StatusItem[] = [];
  let stopped = false;

  const bg: Background = new Background({
    data: plugin.dataLayer,
    frontmatter,
    notes: { resolve: (link, from) => app.metadataCache.getFirstLinkpathDest(link, from)?.path, frontmatter },
    appPaths: () => app.vault.getMarkdownFiles().filter((f) => isSet(frontmatter(f.path)?.app)).map((f) => f.path),
    isGranted: (path, wanted) => plugin.isGranted(path, wanted, true),
    storePath: (store, from) => envFor(from)?.storePath(store, from) ?? notePath(storeTarget(store)),
    actionDeps(appPath, dataPath, actor) {
      const env = envFor(appPath);
      if (!env) throw new Error(`can't find ${appPath}`);
      return {
        now: () => env.now(), dataPath, appPath,
        writeFrontmatter: (path, fn) => env.writeFrontmatter(path, fn),
        appendLine: (path, line) => env.appendLine(path, line),
        createNote: (path, fm, body) => env.createNote(path, fm, body),
        readBody: (path) => env.readBody(path),
        notify: (message) => env.notify(message),
        openNote: (path, from) => env.openNote(path, from),
        log: actor ? (what, changes) => void plugin.activity.add({ app: appPath, actor, what, changes }) : undefined,
      };
    },
    now: () => new Date(),
    triggers: (() => {
      const path = normalizePath(`${plugin.manifest.dir ?? ""}/triggers.json`);
      const adapter = app.vault.adapter;
      return { read: async () => ((await adapter.exists(path)) ? adapter.read(path) : undefined), write: (text: string) => adapter.write(path, text) };
    })(),
    sink: {
      notify: (message) => { new Notice(message); },
      // Commands come and go with the apps that declare them; a hotkey stays bound to the id.
      setCommands(list) {
        const next = new Map(list.map((c) => [c.id, c.name]));
        for (const [id, name] of commands) {
          if (next.get(id) === name) continue;
          plugin.removeCommand(id);
          commands.delete(id);
        }
        for (const [id, name] of next) {
          if (commands.has(id)) continue;
          plugin.addCommand({ id, name, callback: () => void bg.runCommand(id) });
          commands.set(id, name);
        }
      },
      // One item per pinned panel, reused in place; Obsidian has no status bar on mobile.
      setStatus(items) {
        if (Platform.isMobile) return;
        while (bar.length < items.length) {
          const el = plugin.addStatusBarItem();
          el.addClass("gz-status", "mod-clickable");
          const i = bar.length;
          el.addEventListener("click", () => { if (shown[i]) openApp(shown[i].appPath); });
          bar.push(el);
        }
        while (bar.length > items.length) bar.pop()!.remove();
        shown = items;
        items.forEach((item, i) => {
          bar[i].setText(item.text);
          bar[i].setAttr("aria-label", `Open ${item.title}`);
        });
      },
      openApp,
    },
  });

  plugin.registerEvent(app.metadataCache.on("changed", (file) => bg.noteChanged(file.path)));
  plugin.registerEvent(app.vault.on("rename", (file) => bg.noteChanged(file.path)));
  // A link may open Obsidian; it's answered once the apps are known. An install link only opens
  // the install window, which writes nothing until the person says so.
  plugin.registerObsidianProtocolHandler("gizmo", (params) => {
    app.workspace.onLayoutReady(() => {
      if (typeof params.install === "string") return openInstall(plugin, params.install);
      void bg.runUri({ ...params });
    });
  });
  app.workspace.onLayoutReady(() => {
    if (stopped) return;
    void bg.start();
    plugin.registerInterval(window.setInterval(() => void bg.tick(), TICK_MS));
  });
  plugin.register(() => {
    stopped = true;
    bg.stop();
    for (const el of bar.splice(0)) el.remove();
  });
  return bg;
}
