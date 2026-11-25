/**
 * What gizmod runs Gizmo's runtime with, in place of Obsidian: the vault folder as a Host, writes as
 * an app's actions make them, Gizmo's settings read from its data.json (never written: grants, keys
 * and the policy are given in Obsidian), and the files Gizmo keeps per device in its plugin folder.
 */
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { LogStore } from "../../src/activity.ts";
import { bodyOf, type ActionIO } from "../../src/actions.ts";
import type { AlertNotice, BackgroundSink } from "../../src/background.ts";
import { WebError, type Host } from "../../src/datalayer.ts";
import { ledgerStore } from "../../src/datastore.ts";
import { PRIORITY, UNSEEN_MS, type PluginFiles } from "../../src/device.ts";
import { localZone } from "../../src/time.ts";
import { clearance, rank, type AppliedPolicy } from "../../src/policy.ts";
import { ResponseHistory, type FolderAdapter } from "../../src/responses.ts";
import { GizmoRuntime } from "../../src/runtime.ts";
import { urlHost } from "../../src/sources/url.ts";
import { notePath, storeTarget, vaultPath } from "../../src/store.ts";
import type { SettingsSource, StoredData } from "../../src/stored.ts";
import { NodeVault, yamlText } from "./vault.ts";
import { vaultWrites } from "../../src/vault-ops.ts";

/**
 * data.json as Obsidian last wrote it, read again whenever it changed on disk: gizmod never writes it,
 * since what is allowed is decided where a person is. A file caught half-written reads as it was.
 */
export class DiskSettings implements SettingsSource {
  private path: string;
  private kept: StoredData = { grants: {} };
  private mtime = -1;

  constructor(pluginDir: string) {
    this.path = join(pluginDir, "data.json");
  }

  get data(): StoredData {
    try {
      const m = statSync(this.path).mtimeMs;
      if (m !== this.mtime) {
        const read = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredData>;
        this.kept = { ...read, grants: read.grants ?? {} };
        // Only once it parsed: a file caught half-written is read again next time.
        this.mtime = m;
      }
    } catch {
      // No settings yet: nothing is allowed.
    }
    return this.kept;
  }

  async reload(): Promise<void> {
    this.mtime = -1;
    void this.data;
  }
}

/** Node's fs as the history's folder adapter. */
export const fsAdapter: FolderAdapter = {
  exists: async (p) => existsSync(p),
  mkdir: async (p) => { await fs.mkdir(p, { recursive: true }); },
  list: async (p) => {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return { files: entries.filter((e) => e.isFile()).map((e) => join(p, e.name)), folders: entries.filter((e) => e.isDirectory()).map((e) => join(p, e.name)) };
  },
  read: (p) => fs.readFile(p, "utf8"),
  write: async (p, data) => { await fs.mkdir(dirname(p), { recursive: true }); await fs.writeFile(p, data); },
  append: async (p, data) => { await fs.mkdir(dirname(p), { recursive: true }); await fs.appendFile(p, data); },
  remove: (p) => fs.rm(p, { force: true }),
};

/** A file kept whole; reading one that isn't there gives undefined. */
export function fileStore(path: string): LogStore {
  return {
    read: async () => (existsSync(path) ? fs.readFile(path, "utf8") : undefined),
    write: async (text) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text); },
  };
}

/** The plugin's folder on disk, as both hosts read and write it (see device.ts). */
export function pluginFiles(pluginDir: string): PluginFiles {
  return {
    file: (name) => fileStore(join(pluginDir, name)),
    async folder(name) {
      const dir = join(pluginDir, name);
      if (!existsSync(dir)) return [];
      const out: { name: string; text: string }[] = [];
      for (const f of await fs.readdir(dir)) {
        if (!f.endsWith(".json")) continue;
        const text = await fs.readFile(join(dir, f), "utf8").catch(() => undefined);
        if (text !== undefined) out.push({ name: f.slice(0, -".json".length), text });
      }
      return out;
    },
  };
}

/** The environment variable a secret comes from: GIZMO_SECRET_<ID>, dashes as underscores. */
export const secretVar = (id: string) => `GIZMO_SECRET_${id.toUpperCase().replace(/-/g, "_")}`;

/** `{secret:id}` filled from the environment, as `op run` gives it. */
export function secretFromEnv(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[secretVar(id)] ?? null;
}

/** What gizmod pushes for an alert: its whole text when the policy clears it for that host, else only where it's from. */
export function pushText(notice: AlertNotice, policy: AppliedPolicy | undefined, host: string): string {
  const where = `${notice.app}: ${notice.panel}`;
  if (!policy || !notice.label) return where;
  const cleared = clearance(policy.rules, host);
  return cleared !== undefined && rank(notice.label) <= rank(cleared) ? notice.text : where;
}

export interface GizmodOptions {
  vault: string;
  configDir?: string;
  /** This gizmod's device id, named in its ledger files and beat. */
  device: string;
  /** Where alerts are pushed: a ntfy topic's URL. */
  ntfyUrl?: string;
  /** Shows alerts as macOS notices too. */
  macNotices?: boolean;
  log?: (line: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
  /** The ntfy `Actions` header of a button that runs an alert's capture line through gizmod, if the phone can reach it. */
  answerButton?: (notice: AlertNotice) => Promise<string | undefined>;
}

/** gizmod's vault and the Gizmo runtime it runs on, with what it does in place of Obsidian's windows. */
export function gizmodEnv(opts: GizmodOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const doFetch = opts.fetch ?? fetch;
  const vault = new NodeVault(opts.vault, opts.configDir);
  const pluginDir = join(opts.vault, opts.configDir ?? ".obsidian", "plugins", "gizmo");
  const files = pluginFiles(pluginDir);
  const id = opts.device;
  const settings = new DiskSettings(pluginDir);

  const host: Host = {
    async fetch(url, headers, init) {
      try {
        const res = await doFetch(url, { headers, method: init?.method, body: init?.body });
        return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
      } catch (e) {
        // An error status is an answer; this is no answer at all.
        throw new WebError("network", urlHost(url), (e as Error).message, { cause: e });
      }
    },
    markdownFiles: () => vault.notes(),
    fileInfo: (path) => (path.endsWith(".md") ? vault.file(path)?.info : undefined),
    frontmatter: (path) => vault.file(path)?.fm,
    tags: (path) => vault.file(path)?.tags ?? [],
    secret: (sid) => secretFromEnv(sid),
    whereSecrets: (sid) => `Set ${secretVar(sid)} in gizmod's environment (its run script fills it through op run).`,
    now,
    schedule: (cb) => { setTimeout(cb, 30); },
    readFile: (path) => vault.read(path),
    resolveFile: (link, from) => vault.resolve(link, from),
    parseYaml: (text) => parse(text) as unknown,
    responses: new ResponseHistory(fsAdapter, join(pluginDir, "responses"), () => id, now),
    filesIn: (folder) => vault.filesIn(folder),
    fileSize: (path) => vault.size(path),
    append: (path, text) => vault.append(path, text),
    writeFile: (path, text) => vault.write(path, text),
    device: () => id,
    async postBytes(url, body, contentType) {
      const sent = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
      const res = await doFetch(url, { method: "POST", body: sent, headers: { "content-type": contentType } });
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    },
  };
  const frontmatter = (path: string) => vault.file(path)?.fm;
  // Written as Obsidian writes them (see vault-ops.ts), each change read again just before it's written.
  const writes = vaultWrites({
    normalize: (path) => vaultPath(path) ?? path,
    exists: (path) => vault.file(path) !== undefined || existsSync(vault.abs(path)),
    read: (path) => vault.read(path),
    write: (path, text) => vault.write(path, text),
    create: (path, text) => vault.create(path, text),
    processFrontmatter: (path, fn) => vault.process(path, fn),
    append: (path, text) => vault.append(path, text),
    trash: (path) => vault.trash(path),
    vanished: async (path) => !existsSync(vault.abs(path)),
  }, yamlText);

  // Made below; a store is only asked for once the runtime runs.
  let runtime: GizmoRuntime | undefined;
  const io: ActionIO = {
    now: () => new Date(now()),
    frontmatter,
    writeFrontmatter: (path, fn) => writes.writeFrontmatter(path, fn),
    updateFrontmatter: (path, fn) => writes.updateFrontmatter(path, fn),
    store: (dataPath, appPath) => ledgerStore(runtime!.dataLayer.ledger!, dataPath, () => frontmatter(appPath) ?? {}),
    appendLine: (path, line) => writes.appendLine(path, line),
    createNote: (path, fm, body) => writes.createNote(path, fm, body),
    readBody: async (path) => {
      const target = storeTarget(path);
      const found = vault.resolve(target, "") ?? (vault.file(notePath(target)) ? notePath(target) : undefined);
      if (!found) throw new Error(`can't find [[${target}]]`);
      return bodyOf(await vault.read(found));
    },
    notify: (message) => log(message),
    openNote: () => {},
    setTaskDone: (path, line, text, done) => writes.setTaskDone(path, line, text, done),
  };

  const notices: string[] = [];
  const sink: BackgroundSink = {
    notify: (message) => { notices.push(message); log(message); },
    setCommands: () => {},
    setStatus: () => {},
    openApp: () => {},
    // Nobody is at gizmod to say Run: what would ask is refused.
    confirm: async () => false,
    choose: async () => undefined,
    openUrl: () => {},
    alert(notice) {
      if (opts.macNotices) void macNotice(notice.text);
      const url = opts.ntfyUrl;
      if (!url) return;
      const body = pushText(notice, settings.data.policy, new URL(url).host);
      void (async () => {
        // The button says nothing more than the push: it names gizmod's address and a token for the one line, never a key.
        // A button that can't be made (its token can't be kept) leaves the push without one.
        const actions = notice.answer ? await opts.answerButton?.(notice).catch((e: Error) => void log(`couldn't make a Done button (${e.message}); the push goes without it`)) : undefined;
        await doFetch(url, { method: "POST", body, headers: { Title: "Gizmo", ...(actions && { Actions: actions }) } });
      })().catch((e: Error) => log(`couldn't push an alert: ${e.message}`));
    },
  };

  runtime = new GizmoRuntime({
    host,
    settings,
    files,
    device: { id, name: "gizmod" },
    // gizmod says only on its interval; a beat it couldn't write is logged and written on the next one.
    beat: {
      mine: (t) => ({ id, name: "gizmod", host: hostname(), priority: PRIORITY.gizmod, seen: t, zone: localZone() }),
      writeFailed: (e) => log(`couldn't write gizmod's beat: ${e.message}`),
    },
    writes,
    notes: { resolve: (link, from) => vault.resolve(link, from), frontmatter },
    storePath: (s, from) => vault.resolve(storeTarget(s), from) ?? notePath(storeTarget(s)),
    // gizmod never opens an app: one runs here once it was opened and allowed in Obsidian, as in its background.
    actionIO: () => io,
    sink,
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    later: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });

  return { vault, runtime, host, io, sink, notices, settings, pluginDir, unseenMs: UNSEEN_MS };
}

/** A macOS notice, as a notification from Script Editor would show it. */
async function macNotice(text: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const quoted = JSON.stringify(text);
  execFile("osascript", ["-e", `display notification ${quoted} with title "Gizmo"`], () => {});
}
