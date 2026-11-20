import { Notice, Platform, type WorkspaceLeaf } from "obsidian";
import { actionDepsOf } from "./actions.ts";
import { Background, TICK_MS, type StatusItem } from "./background.ts";
import { obsidianAppEnv, pluginFile, vaultFrontmatter, vaultNotes } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { askToRun } from "./link-command.ts";
import { openInstall } from "./share-command.ts";
import { isApp, notePath, storeTarget } from "./store.ts";

/**
 * Obsidian glue for the background service: it starts once the layout is ready, hears about app
 * notes from the metadata cache, ticks on one interval, and stops when the plugin unloads.
 */
export function registerBackground(plugin: GizmoPlugin): Background {
  const app = plugin.app;
  const frontmatter = vaultFrontmatter(app);
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
    notes: vaultNotes(app),
    appPaths: () => app.vault.getMarkdownFiles().filter((f) => isApp(frontmatter(f.path))).map((f) => f.path),
    isGranted: (path, wanted) => plugin.isGranted(path, wanted, true),
    storePath: (store, from) => envFor(from)?.storePath(store, from) ?? notePath(storeTarget(store)),
    actionDeps(appPath, dataPath, actor) {
      const env = envFor(appPath);
      if (!env) throw new Error(`can't find ${appPath}`);
      return {
        ...actionDepsOf(env, appPath, dataPath),
        log: actor ? (what, changes) => void plugin.activity.add({ app: appPath, actor, what, changes }) : undefined,
      };
    },
    now: () => new Date(),
    triggers: pluginFile(plugin, "triggers.json"),
    linkKey: (path, shortcut, create) => plugin.linkKey(path, shortcut, create),
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
      confirm: (title, lines) => askToRun(app, title, lines),
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
