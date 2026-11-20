import { isPolicyPath } from "./policy.ts";
import { ledgerStore, type DataStore } from "./datastore.ts";
import {
  Notice, TFile, getAllTags, getLinkpath, normalizePath, parseYaml, requestUrl, stringifyYaml, type App, type WorkspaceLeaf,
} from "obsidian";
import { bodyOf, noteText, withLine } from "./actions.ts";
import type { LogStore, UndoIO } from "./activity.ts";
import type { AppEnv } from "./app.ts";
import { DiskCache } from "./cache.ts";
import type { FileInfo, Host } from "./datalayer.ts";
import type { NoteReader } from "./expand.ts";
import type GizmoPlugin from "./main.ts";
import { tickLine } from "./sources/tasks.ts";
import { tryVaultApp } from "./try-modal.ts";
import { notePath, storeTarget } from "./store.ts";

/** A note's frontmatter by its path, from Obsidian's metadata cache. */
export function vaultFrontmatter(app: App): (path: string) => Record<string, unknown> | undefined {
  return (path) => {
    const f = app.vault.getFileByPath(path);
    return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
  };
}

/** Component notes and other linked notes, found as Obsidian finds a link. */
export function vaultNotes(app: App): NoteReader {
  return { resolve: (link, from) => app.metadataCache.getFirstLinkpathDest(link, from)?.path, frontmatter: vaultFrontmatter(app) };
}

/** A file in the plugin's folder, read and written whole; reading one that isn't there gives undefined. */
export function pluginFile(plugin: GizmoPlugin, name: string): LogStore {
  const path = normalizePath(`${plugin.manifest.dir ?? ""}/${name}`);
  const folder = path.slice(0, path.lastIndexOf("/"));
  const adapter = plugin.app.vault.adapter;
  return {
    read: async () => ((await adapter.exists(path)) ? adapter.read(path) : undefined),
    async write(text: string) {
      if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
      await adapter.write(path, text);
    },
  };
}

/** The texts of the `.json` files in a folder of the plugin's, by name without `.json`; none when there is no such folder. */
export async function pluginFolder(plugin: GizmoPlugin, name: string): Promise<{ name: string; text: string }[]> {
  const adapter = plugin.app.vault.adapter;
  const folder = normalizePath(`${plugin.manifest.dir ?? ""}/${name}`);
  if (!(await adapter.exists(folder))) return [];
  const { files } = await adapter.list(folder);
  const out: { name: string; text: string }[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      out.push({ name: file.slice(file.lastIndexOf("/") + 1, -".json".length), text: await adapter.read(file) });
    } catch {
      // Gone, or being written by a sync: read next time.
    }
  }
  return out;
}

/** Puts text on the clipboard, then runs `done`; says so when it can't. */
export function copyText(text: string, done?: () => void): void {
  void navigator.clipboard.writeText(text).then(done, () => { new Notice("Couldn't copy to the clipboard"); });
}

function info(f: TFile): FileInfo {
  return { path: f.path, basename: f.basename, mtime: f.stat.mtime, ctime: f.stat.ctime };
}

/** `pluginDir` (the plugin's folder) turns on the disk copy of web responses, in its `cache` folder. */
export function obsidianHost(app: App, pluginDir?: string, device?: () => string): Host {
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
    frontmatter: vaultFrontmatter(app),
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
    parseYaml: (text) => parseYaml(text) as unknown,
    cacheRead: async (key) => disk?.read(key),
    cacheWrite: async (key, entry) => disk?.write(key, entry),
    filesIn: (folder) => (app.vault.getFolderByPath(normalizePath(folder))?.children ?? []).filter((c): c is TFile => c instanceof TFile).map((f) => f.path),
    append: (path, text) => queued(normalizePath(path), async () => {
      const f = file(normalizePath(path));
      if (f) return app.vault.append(f, text);
      await ensureFolder(app, normalizePath(path));
      await app.vault.create(normalizePath(path), text);
    }),
    writeFile: (path, text) => queued(normalizePath(path), async () => {
      const f = file(normalizePath(path));
      if (f) return app.vault.modify(f, text);
      await ensureFolder(app, normalizePath(path));
      await app.vault.create(normalizePath(path), text);
    }),
    ...(device && { device }),
  };
}

/** Path of the note a `store:` value points at, resolved from the note that names it. */
export function vaultStorePath(app: App): (store: string, fromPath: string) => string {
  return (store, fromPath) => {
    const target = storeTarget(store);
    return app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? notePath(normalizePath(target));
  };
}

/** Writes to one note run one after another, across every open app. */
const writeQueues = new Map<string, Promise<void>>();

function queued(path: string, write: () => Promise<void>): Promise<void> {
  // The policy says what apps may do with data, so no app may change it; a person edits it by hand.
  if (isPolicyPath(normalizePath(path))) return Promise.reject(new Error(`${path} is your Gizmo policy; apps can't change it`));
  const next = (writeQueues.get(path) ?? Promise.resolve()).then(write, write);
  writeQueues.set(path, next);
  void next.finally(() => { if (writeQueues.get(path) === next) writeQueues.delete(path); });
  return next;
}

/**
 * Whether a write failed because its note is gone from the disk although Obsidian still lists it:
 * deleted or moved by another program (a file manager, a sync) a moment before.
 */
async function vanished(app: App, path: string): Promise<boolean> {
  return !(await app.vault.adapter.exists(path));
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!folder || app.vault.getFolderByPath(folder)) return;
  try {
    await app.vault.createFolder(folder);
  } catch (e) {
    // Made a moment ago by another device or program, before Obsidian here heard of it.
    if (!(await app.vault.adapter.exists(folder))) throw e;
  }
}

/** Changes an existing note's frontmatter, after any other app's write to it; false, writing nothing, when the note is gone. */
export async function updateFrontmatterOf(app: App, path: string, fn: (fm: Record<string, unknown>) => void): Promise<boolean> {
  let written = false;
  await queued(path, async () => {
    const target = app.vault.getFileByPath(path);
    if (!target) return;
    try {
      await app.fileManager.processFrontMatter(target, fn);
    } catch (e) {
      if (await vanished(app, path)) return;
      throw e;
    }
    written = true;
  });
  return written;
}

/** Ticks or unticks a task (see tickLine); false, writing nothing, when it can't be found for sure. */
async function setTaskDoneIn(app: App, path: string, line: number, text: string, done: boolean): Promise<boolean> {
  let ticked = false;
  await queued(path, async () => {
    const target = app.vault.getFileByPath(path);
    if (!target) return;
    // process reads and writes in one step, so an edit made meanwhile isn't lost or misread.
    try {
      await app.vault.process(target, (data) => {
        const next = tickLine(data, line, text, done);
        ticked = next !== undefined;
        return next ?? data;
      });
    } catch (e) {
      if (await vanished(app, path)) return;
      throw e;
    }
  });
  return ticked;
}

/** Writing a note's frontmatter as apps do, after any other app's write to it: what snapshots are written with. */
export function obsidianAppEnvWrites(plugin: GizmoPlugin): Pick<AppEnv, "writeFrontmatter"> {
  const app = plugin.app;
  return {
    writeFrontmatter: (path, fn) => queued(path, async () => {
      let target = app.vault.getFileByPath(path);
      if (!target) {
        await ensureFolder(app, path);
        target = await app.vault.create(path, "");
      }
      await app.fileManager.processFrontMatter(target, fn);
    }),
  };
}

/** Where an app's lists are kept: the ledger, when the vault's data layer keeps one. */
export function vaultStore(plugin: GizmoPlugin): ((dataPath: string, appPath: string) => DataStore) | undefined {
  const ledger = plugin.dataLayer.ledger;
  const fm = vaultFrontmatter(plugin.app);
  return ledger && ((dataPath, appPath) => ledgerStore(ledger, dataPath, () => fm(appPath) ?? {}));
}

/** Without a leaf (an embed, a lens) there is no app tab to show the source in. */
export function obsidianAppEnv(plugin: GizmoPlugin, leaf: WorkspaceLeaf | undefined, file: TFile): AppEnv {
  const app = plugin.app;
  return {
    data: plugin.dataLayer,
    frontmatter: vaultFrontmatter(app),
    notes: vaultNotes(app),
    isGranted: (path, wanted, asked) => plugin.isGranted(path, wanted, false, asked),
    granted: (path) => plugin.granted(path),
    grant: (path, wanted) => plugin.grant(path, wanted),
    verdict: (spec, wanted, where) => plugin.verdict(spec, wanted, where),
    policyPending: () => plugin.policyPending(),
    storePath: vaultStorePath(app),
    writeFrontmatter: obsidianAppEnvWrites(plugin).writeFrontmatter,
    store: vaultStore(plugin),
    updateFrontmatter: (path, fn) => updateFrontmatterOf(app, path, fn),
    async appendLine(path, line) {
      let created = false;
      await queued(path, async () => {
        const target = app.vault.getFileByPath(normalizePath(path));
        if (target) {
          await app.vault.process(target, (text) => withLine(text, line));
          return;
        }
        await ensureFolder(app, path);
        await app.vault.create(normalizePath(path), withLine("", line));
        created = true;
      });
      return created;
    },
    async createNote(path, frontmatter, body) {
      const target = normalizePath(path);
      if (isPolicyPath(target)) throw new Error(`${path} is your Gizmo policy; apps can't change it`);
      if (app.vault.getAbstractFileByPath(target)) return false;
      await ensureFolder(app, target);
      const text = noteText(Object.keys(frontmatter).length ? stringifyYaml(frontmatter) : "", body);
      try {
        await app.vault.create(target, text);
      } catch (e) {
        // Created in the meantime (a double click): it already exists, as above.
        if (app.vault.getAbstractFileByPath(target)) return false;
        throw e;
      }
      return text;
    },
    async readBody(path) {
      const target = storeTarget(path);
      const f = app.metadataCache.getFirstLinkpathDest(target, file.path) ?? app.vault.getFileByPath(notePath(normalizePath(target)));
      if (!f) throw new Error(`can't find [[${target}]]`);
      return bodyOf(await app.vault.cachedRead(f));
    },
    setTaskDone: (path, line, text, done) => setTaskDoneIn(app, path, line, text, done),
    notify: (message) => { new Notice(message); },
    // openLinkText creates a note when nothing matches, and the text may come from a row or a link.
    openNote(path, fromPath) {
      const linkpath = getLinkpath(path);
      const target = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath) ?? app.vault.getFileByPath(normalizePath(linkpath));
      if (!target) return void new Notice(`Can't find “${path}”`);
      void app.workspace.openLinkText(path, fromPath);
    },
    showSource: () => { if (leaf) void plugin.showSource(leaf, file); },
    showSourceAt: (line) => { if (leaf) void plugin.showSourceAt(leaf, file, line); },
    sourceLines: async () => (await app.vault.cachedRead(file)).split(/\r?\n/),
    copy: (text) => copyText(text),
    log: (entry) => void plugin.activity.add(entry),
    trigger: async (from, then, ctx) => plugin.background?.runThen(from, then, ctx),
    now: () => new Date(),
    opened: (path) => plugin.background?.opened(path),
    alerts: plugin.background?.alerts,
    tryFirst: () => void tryVaultApp(plugin, file.path),
  };
}

/** Undoing in Obsidian: each write re-reads the note as it writes, in line with the app's own writes to it. */
export function obsidianUndoIO(plugin: GizmoPlugin): UndoIO {
  const app = plugin.app;
  return {
    frontmatter: vaultFrontmatter(app),
    updateFrontmatter: (path, fn) => updateFrontmatterOf(app, path, fn),
    setTaskDone: (path, line, text, done) => setTaskDoneIn(app, path, line, text, done),
    undoEvents: async (dataPath, events) => {
      const ledger = plugin.dataLayer.ledger;
      if (ledger) await ledgerStore(ledger, dataPath).undo(events);
    },
    async processText(path, fn) {
      let written = false;
      await queued(path, async () => {
        const target = app.vault.getFileByPath(path);
        if (!target) return;
        await app.vault.process(target, fn);
        written = true;
      });
      return written;
    },
    async trashIf(path, unchanged) {
      let result: "trashed" | "changed" | "gone" = "gone";
      await queued(path, async () => {
        const target = app.vault.getFileByPath(path);
        if (!target) return;
        if (!unchanged(await app.vault.read(target))) {
          result = "changed";
          return;
        }
        await app.fileManager.trashFile(target);
        result = "trashed";
      });
      return result;
    },
  };
}
