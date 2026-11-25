import { ledgerStore, type DataStore } from "./datastore.ts";
import {
  Notice, TFile, getAllTags, getLinkpath, normalizePath, parseYaml, requestUrl, stringifyYaml, type App, type WorkspaceLeaf,
} from "obsidian";
import { bodyOf } from "./actions.ts";
import { undoMessage, type LogStore, type UndoIO } from "./activity.ts";
import type { AppEnv } from "./app.ts";
import type { AppAsks } from "./app-asks.ts";
import { openCaptureWith } from "./capture-command.ts";
import { DEVICE_FOLDERS, deviceFile, otherLogs, type PluginFiles } from "./device.ts";
import { withPanels } from "./insert.ts";
import { ResponseHistory } from "./responses.ts";
import { urlHost } from "./sources/url.ts";
import { WebError, type FileInfo, type Host } from "./datalayer.ts";
import type { NoteReader } from "./expand.ts";
import type GizmoPlugin from "./main.ts";
import { tryVaultApp } from "./try-modal.ts";
import { ExplainModal } from "./explain-command.ts";
import { notePath, storeTarget } from "./store.ts";
import { vaultWrites, type VaultFiles, type VaultWrites } from "./vault-ops.ts";

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

/** The plugin's folder, as both hosts read and write it (see device.ts). */
export function pluginFiles(plugin: GizmoPlugin): PluginFiles {
  return { file: (name) => pluginFile(plugin, name), folder: (name) => pluginFolder(plugin, name) };
}

/** The log kept before Gizmo told devices apart becomes this device's own, unless another device already keeps one. */
export async function adoptOldLog(plugin: GizmoPlugin): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  const dir = plugin.manifest.dir ?? "";
  const old = normalizePath(`${dir}/activity.json`);
  const mine = normalizePath(`${dir}/${deviceFile(DEVICE_FOLDERS.activity, plugin.device.id)}`);
  if (!(await adapter.exists(old)) || (await adapter.exists(mine))) return;
  if ((await pluginFolder(plugin, DEVICE_FOLDERS.activity)).length) return;
  if (!(await adapter.exists(normalizePath(`${dir}/${DEVICE_FOLDERS.activity}`)))) await adapter.mkdir(normalizePath(`${dir}/${DEVICE_FOLDERS.activity}`));
  await adapter.rename(old, mine);
}

/** The other devices' logs, and an old shared one no device took, each named for its device. */
export async function obsidianOtherLogs(plugin: GizmoPlugin): Promise<{ device: string; text: string }[]> {
  const logs = await otherLogs(pluginFiles(plugin), plugin.device.id);
  const old = await pluginFile(plugin, "activity.json").read().catch(() => undefined);
  return old ? [...logs, { device: "another device", text: old }] : logs;
}

/** Puts text on the clipboard, then runs `done`; says so when it can't. */
export function copyText(text: string, done?: () => void): void {
  void navigator.clipboard.writeText(text).then(done, () => { new Notice("Couldn't copy to the clipboard"); });
}

function info(f: TFile): FileInfo {
  return { path: f.path, basename: f.basename, mtime: f.stat.mtime, ctime: f.stat.ctime };
}

/** `pluginDir` (the plugin's folder) turns on keeping web responses, in its `responses` folder. */
export function obsidianHost(app: App, pluginDir?: string, device?: () => string): Host {
  const file = (path: string) => app.vault.getFileByPath(path);
  const responses = pluginDir ? new ResponseHistory(app.vault.adapter, normalizePath(`${pluginDir}/responses`), device ?? (() => "device"), () => Date.now()) : undefined;
  // The disk copies kept before the history: a cache, so it simply goes.
  if (pluginDir) {
    const old = normalizePath(`${pluginDir}/cache`);
    void app.vault.adapter.exists(old).then(async (there) => { if (there) await app.vault.adapter.rmdir(old, true); }).catch(() => {});
  }
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
      let res: Awaited<ReturnType<typeof requestUrl>>;
      try {
        res = await requestUrl({ url, headers: rest, method: init?.method, body: init?.body, contentType, throw: false });
      } catch (e) {
        // With throw: false an error status is an answer, so this is no answer at all.
        throw new WebError("network", urlHost(url), (e as Error).message, { cause: e });
      }
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
    responses,
    filesIn: (folder) => (app.vault.getFolderByPath(normalizePath(folder))?.children ?? []).filter((c): c is TFile => c instanceof TFile).map((f) => f.path),
    fileSize: (path) => file(normalizePath(path))?.stat.size,
    append: (path, text) => obsidianWrites(app).appendFile(path, text),
    writeFile: (path, text) => obsidianWrites(app).writeFile(path, text),
    ...(device && { device }),
    async postBytes(url, body, contentType) {
      const sent = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
      const res = await requestUrl({ url, method: "POST", body: sent, contentType, throw: false });
      return { status: res.status, bytes: new Uint8Array(res.arrayBuffer) };
    },
  };
}

/** Path of the note a `store:` value points at, resolved from the note that names it. */
export function vaultStorePath(app: App): (store: string, fromPath: string) => string {
  return (store, fromPath) => {
    const target = storeTarget(store);
    return app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? notePath(normalizePath(target));
  };
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

/** The vault's files, as the shared writes need them (see vault-ops.ts). */
function obsidianFiles(app: App): VaultFiles {
  const fileOf = (path: string) => {
    const f = app.vault.getFileByPath(path);
    if (!f) throw new Error(`Can't find ${path}`);
    return f;
  };
  return {
    normalize: normalizePath,
    exists: (path) => !!app.vault.getAbstractFileByPath(path),
    read: (path) => app.vault.read(fileOf(path)),
    write: (path, text) => app.vault.modify(fileOf(path), text),
    append: (path, text) => app.vault.append(fileOf(path), text),
    async create(path, text) {
      await ensureFolder(app, path);
      await app.vault.create(path, text);
    },
    processFrontmatter: (path, fn) => app.fileManager.processFrontMatter(fileOf(path), fn),
    // Obsidian's own keeps a note open in an editor in step.
    process: async (path, fn) => { await app.vault.process(fileOf(path), fn); },
    trash: (path) => app.fileManager.trashFile(fileOf(path)),
    // Deleted or moved by another program (a file manager, a sync) a moment before, though Obsidian still lists it.
    vanished: async (path) => !(await app.vault.adapter.exists(path)),
  };
}

/** Every write to the vault, one note at a time across every open app. */
const writesOf = new WeakMap<App, VaultWrites>();
export function obsidianWrites(app: App): VaultWrites {
  let w = writesOf.get(app);
  if (!w) {
    w = vaultWrites(obsidianFiles(app), (fm) => stringifyYaml(fm));
    writesOf.set(app, w);
  }
  return w;
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
    writeFrontmatter: (path, fn) => obsidianWrites(app).writeFrontmatter(path, fn),
    store: vaultStore(plugin),
    updateFrontmatter: (path, fn) => obsidianWrites(app).updateFrontmatter(path, fn),
    appendLine: (path, line) => obsidianWrites(app).appendLine(path, line),
    createNote: (path, frontmatter, body) => obsidianWrites(app).createNote(path, frontmatter, body),
    async readBody(path) {
      const target = storeTarget(path);
      const f = app.metadataCache.getFirstLinkpathDest(target, file.path) ?? app.vault.getFileByPath(notePath(normalizePath(target)));
      if (!f) throw new Error(`can't find [[${target}]]`);
      return bodyOf(await app.vault.cachedRead(f));
    },
    setTaskDone: (path, line, text, done) => obsidianWrites(app).setTaskDone(path, line, text, done),
    notify: (message) => { new Notice(message); },
    // openLinkText creates a note when nothing matches, and the text may come from a row or a link.
    openNote(path, fromPath) {
      const linkpath = getLinkpath(path);
      const target = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath) ?? app.vault.getFileByPath(normalizePath(linkpath));
      if (!target) return void new Notice(`Can't find “${path}”`);
      void app.workspace.openLinkText(path, fromPath);
    },
    showSource: () => { if (leaf) void plugin.editSource(leaf, file); },
    showSourceAt: (line, ch) => { if (leaf) void plugin.showSourceAt(leaf, file, line, ch); },
    sourceLines: async () => (await app.vault.cachedRead(file)).split(/\r?\n/),
    // An edit of the app note the person asks for, as Insert panel is; saving data never edits it.
    ...(leaf && {
      async addPanels(panels: string[][]) {
        let out: { cursor: { line: number; ch: number } } | { refusal: string } = { refusal: "Couldn't read the note" };
        await app.vault.process(file, (text) => {
          const found = withPanels(text, panels);
          if ("refusal" in found) {
            out = found;
            return text;
          }
          out = { cursor: found.cursor };
          return found.text;
        });
        return out;
      },
    }),
    copy: (text) => copyText(text),
    log: (entry) => plugin.activity.add(entry),
    async undo(id) {
      const entry = await plugin.activity.get(id);
      return entry ? undoMessage(await plugin.undo(entry)) : "That change is no longer in the activity log";
    },
    trigger: async (from, then, ctx) => plugin.background?.runThen(from, then, ctx),
    now: () => new Date(),
    opened: (path) => plugin.background?.opened(path),
    alerts: plugin.background?.alerts,
    asks: appAsks(plugin),
    headline: (path, text) => plugin.setHeadline(path, text),
    tryFirst: () => void tryVaultApp(plugin, file.path),
    explain: (src) => new ExplainModal(app, src).open(),
    definitions: plugin.definitions,
    deviceName: (id) => (id === plugin.device.id ? plugin.device.name : plugin.beat?.beats.find((b) => b.id === id)?.name),
    leftAlone: (key) => plugin.store.leftAlone?.[key] === true,
    leaveAlone(key) {
      (plugin.store.leftAlone ??= {})[key] = true;
      void plugin.saveSettings();
    },
  };
}

/**
 * What the person is asked, and how an app's tab answers, through the background service as it is
 * at each call (it stops and starts with the plugin's settings); undefined while it isn't running.
 */
function appAsks(plugin: GizmoPlugin): AppAsks | undefined {
  if (!plugin.background) return undefined;
  const none = { ok: false, error: "Gizmo's background service isn't running" };
  return {
    list: () => plugin.background?.asks.list() ?? [],
    subscribe: (cb) => plugin.background?.asks.subscribe(cb) ?? (() => {}),
    settle: async (ask, how) => (plugin.background ? plugin.background.settleAsk(ask, how) : none),
    skip: async (id) => plugin.background?.skipAsk(id),
    run: async (line) => (plugin.background ? plugin.background.capture(line, undefined, true) : none),
    fill: (line, cursor) => openCaptureWith(plugin, line, cursor),
  };
}

/** Undoing in Obsidian: each write re-reads the note as it writes, in line with the app's own writes to it. */
export function obsidianUndoIO(plugin: GizmoPlugin): UndoIO {
  const app = plugin.app;
  const w = obsidianWrites(app);
  return {
    frontmatter: vaultFrontmatter(app),
    updateFrontmatter: (path, fn) => w.updateFrontmatter(path, fn),
    setTaskDone: (path, line, text, done) => w.setTaskDone(path, line, text, done),
    undoEvents: async (dataPath, events) => {
      const ledger = plugin.dataLayer.ledger;
      if (ledger) await ledgerStore(ledger, dataPath).undo(events);
    },
    processText: (path, fn) => w.processText(path, fn),
    trashIf: (path, unchanged) => w.trashIf(path, unchanged),
  };
}
