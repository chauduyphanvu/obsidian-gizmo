import { Notice, getAllTags, normalizePath, parseYaml, requestUrl, stringifyYaml, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { bodyOf } from "./actions.ts";
import type { AppEnv } from "./app.ts";
import { DiskCache } from "./cache.ts";
import type { FileInfo, Host } from "./datalayer.ts";
import type NoteAppsPlugin from "./main.ts";
import { tickLine } from "./sources/tasks.ts";
import { notePath } from "./spec.ts";
import { storeTarget } from "./store.ts";

function info(f: TFile): FileInfo {
  return { path: f.path, basename: f.basename, mtime: f.stat.mtime, ctime: f.stat.ctime };
}

/** `pluginDir` (the plugin's folder) turns on the disk copy of web responses, in its `cache` folder. */
export function obsidianHost(app: App, pluginDir?: string): Host {
  const file = (path: string) => app.vault.getFileByPath(path);
  const disk = pluginDir ? new DiskCache(app.vault.adapter, normalizePath(`${pluginDir}/cache`)) : undefined;
  return {
    async fetch(url, headers, init) {
      // requestUrl takes the content type apart from the other headers.
      const rest = { ...headers };
      let contentType: string | undefined;
      for (const name of Object.keys(rest)) {
        if (name.toLowerCase() !== "content-type") continue;
        contentType = rest[name];
        delete rest[name];
      }
      const res = await requestUrl({ url, headers: rest, method: init?.method, body: init?.body, contentType, throw: false });
      return { status: res.status, text: res.text, contentType: res.headers["content-type"] ?? "" };
    },
    markdownFiles: () => app.vault.getMarkdownFiles().map(info),
    fileInfo(path) {
      const f = file(path);
      return f && f.extension === "md" ? info(f) : undefined;
    },
    frontmatter(path) {
      const f = file(path);
      return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
    },
    tags(path) {
      const f = file(path);
      const cache = f ? app.metadataCache.getFileCache(f) : null;
      return (cache && getAllTags(cache)) ?? [];
    },
    secret: (id) => app.secretStorage.getSecret(id),
    now: () => Date.now(),
    // A short timer rather than requestAnimationFrame, which stops while the window is hidden.
    schedule: (cb) => { window.setTimeout(cb, 30); },
    async readFile(path) {
      const f = file(normalizePath(path));
      if (!f) throw new Error(`Can't find ${path}`);
      return app.vault.cachedRead(f);
    },
    resolveFile: (link, from) => (file(normalizePath(link)) ?? app.metadataCache.getFirstLinkpathDest(link, from))?.path,
    async readText(path) {
      const f = file(path);
      if (!f) throw new Error(`can't find ${path}`);
      return app.vault.cachedRead(f);
    },
    parseYaml: (text) => parseYaml(text) as unknown,
    cacheRead: async (key) => disk?.read(key),
    cacheWrite: async (key, entry) => disk?.write(key, entry),
  };
}

/** Writes to one note run one after another, across every open app. */
const writeQueues = new Map<string, Promise<void>>();

function queued(path: string, write: () => Promise<void>): Promise<void> {
  const next = (writeQueues.get(path) ?? Promise.resolve()).then(write, write);
  writeQueues.set(path, next);
  void next.finally(() => { if (writeQueues.get(path) === next) writeQueues.delete(path); });
  return next;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
}

/** Without a leaf (an embed, a lens) there is no app tab to show the source in. */
export function obsidianAppEnv(plugin: NoteAppsPlugin, leaf: WorkspaceLeaf | undefined, file: TFile): AppEnv {
  const app = plugin.app;
  return {
    data: plugin.dataLayer,
    frontmatter(path) {
      const f = app.vault.getFileByPath(path);
      return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
    },
    notes: {
      resolve: (link, from) => app.metadataCache.getFirstLinkpathDest(link, from)?.path,
      frontmatter(path) {
        const f = app.vault.getFileByPath(path);
        return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
      },
    },
    isGranted: (path, wanted) => plugin.isGranted(path, wanted),
    granted: (path) => plugin.granted(path),
    grant: (path, wanted) => plugin.grant(path, wanted),
    storePath(store, fromPath) {
      const target = storeTarget(store);
      return app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? notePath(normalizePath(target));
    },
    writeFrontmatter: (path, fn) => queued(path, async () => {
      let target = app.vault.getFileByPath(path);
      if (!target) {
        await ensureFolder(app, path);
        target = await app.vault.create(path, "");
      }
      await app.fileManager.processFrontMatter(target, fn);
    }),
    appendLine: (path, line) => queued(path, async () => {
      const target = app.vault.getFileByPath(normalizePath(path));
      if (target) {
        await app.vault.process(target, (text) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
        return;
      }
      await ensureFolder(app, path);
      await app.vault.create(normalizePath(path), `${line}\n`);
    }),
    async createNote(path, frontmatter, body) {
      const target = normalizePath(path);
      if (app.vault.getAbstractFileByPath(target)) return false;
      await ensureFolder(app, target);
      const yaml = Object.keys(frontmatter).length ? `---\n${stringifyYaml(frontmatter)}---\n` : "";
      try {
        await app.vault.create(target, `${yaml}${body}`);
      } catch (e) {
        // Created in the meantime (a double click): it already exists, as above.
        if (app.vault.getAbstractFileByPath(target)) return false;
        throw e;
      }
      return true;
    },
    async readBody(path) {
      const target = storeTarget(path);
      const f = app.metadataCache.getFirstLinkpathDest(target, file.path) ?? app.vault.getFileByPath(notePath(normalizePath(target)));
      if (!f) throw new Error(`can't find [[${target}]]`);
      return bodyOf(await app.vault.cachedRead(f));
    },
    async setTaskDone(path, line, text, done) {
      let ticked = false;
      await queued(path, async () => {
        const target = app.vault.getFileByPath(path);
        if (!target) return;
        // process reads and writes in one step, so an edit made meanwhile isn't lost or misread.
        await app.vault.process(target, (data) => {
          const next = tickLine(data, line, text, done);
          ticked = next !== undefined;
          return next ?? data;
        });
      });
      return ticked;
    },
    notify: (message) => { new Notice(message); },
    openNote: (path, fromPath) => void app.workspace.openLinkText(path, fromPath),
    showSource: () => { if (leaf) void plugin.showSource(leaf, file); },
    showSourceAt: (line) => { if (leaf) void plugin.showSourceAt(leaf, file, line); },
    sourceLines: async () => (await app.vault.cachedRead(file)).split(/\r?\n/),
    copy: (text) => { void navigator.clipboard.writeText(text).catch(() => new Notice("Couldn't copy to the clipboard")); },
    now: () => new Date(),
    opened: (path) => plugin.background?.opened(path),
    alerts: plugin.background?.alerts,
  };
}
