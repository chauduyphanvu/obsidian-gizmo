import { Notice, type WorkspaceLeaf } from "obsidian";
import { Background, TICK_MS } from "./background.ts";
import { obsidianAppEnv } from "./host.ts";
import type NoteAppsPlugin from "./main.ts";
import { notePath } from "./spec.ts";
import { storeTarget } from "./store.ts";

/**
 * Obsidian glue for the background service: it starts once the layout is ready, hears about app
 * notes from the metadata cache, ticks on one interval, and stops when the plugin unloads.
 */
export function registerBackground(plugin: NoteAppsPlugin): Background {
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
  let stopped = false;

  const bg: Background = new Background({
    data: plugin.dataLayer,
    frontmatter,
    notes: { resolve: (link, from) => app.metadataCache.getFirstLinkpathDest(link, from)?.path, frontmatter },
    appPaths: () => app.vault.getMarkdownFiles().filter((f) => isSet(frontmatter(f.path)?.app)).map((f) => f.path),
    isGranted: (path, wanted) => plugin.isGranted(path, wanted),
    storePath: (store, from) => envFor(from)?.storePath(store, from) ?? notePath(storeTarget(store)),
    actionDeps(appPath, dataPath) {
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
      };
    },
    now: () => new Date(),
    sink: {
      notify: (message) => { new Notice(message); },
      setCommands: () => {},
      setStatus: () => {},
      openApp,
    },
  });

  plugin.registerEvent(app.metadataCache.on("changed", (file) => bg.noteChanged(file.path)));
  plugin.registerEvent(app.vault.on("rename", (file) => bg.noteChanged(file.path)));
  app.workspace.onLayoutReady(() => {
    if (stopped) return;
    void bg.start();
    plugin.registerInterval(window.setInterval(() => void bg.tick(), TICK_MS));
  });
  plugin.register(() => {
    stopped = true;
    bg.stop();
  });
  return bg;
}
